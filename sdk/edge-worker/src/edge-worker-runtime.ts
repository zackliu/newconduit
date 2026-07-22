import type { EdgeAgent, EdgeAgentContext } from './edge-agent';
import {
  EDGE_WORKER_HTTP_PATHS,
  EDGE_WORKER_HTTP_QUERY,
  type AgentOutputPayload,
  type EdgeRuntimeEvent,
  type RuntimeConnectionGrant,
  type SessionAssignPayload,
  type SessionInputCommandPayload,
  type SessionPauseCommandPayload,
  type SessionPausedPayload,
  type StatusChangedPayload,
  type TurnCompletedPayload,
  type TurnFailedPayload,
  type WorkerCommandAcceptedPayload,
  type WorkerCommandRejectedPayload,
  type WorkerCondition,
  type WorkerHeartbeatPayload,
  type WorkerHeartbeatRejectedPayload,
  type WorkerRecord,
  type WorkerRegisterPayload,
  type EdgeBindingPayload
} from './protocol';
import type { EdgeWorkerSubscription, EdgeWorkerTransport } from './transport';
import { describeNegotiateFailure } from './negotiate-error';
import {
  InMemoryOutboundQueueStore,
  newQueuedResult,
  type OutboundQueueStore,
  type QueuedResult
} from './outbound-queue';

/**
 * The browser edge worker runtime. It is the browser peer of the Node `SidecarDaemon`: it registers a tab
 * as a real Worker over the identical `/sidecar/negotiate` + Web PubSub runtime protocol, heartbeats,
 * accepts `session.assign` / `session.input` / `session.pause.requested` commands, and publishes the same
 * `status.changed` / `agent.output` / `turn.completed` / `session.paused` events back to central.
 *
 * It intentionally implements only the commands a device-capture edge agent needs. Its local agent never
 * raises Central-mediated interactions (capture consent is resolved on the device, inside the turn), so
 * there is no interaction/runtime-tool branch — an unexpected command is a protocol error, not a fallback.
 */

const HEARTBEAT_INTERVAL_MS = 10_000;

export interface EdgeWorkerRegistration {
  centralUrl: string;
  tenantId: string;
  labels: Record<string, string>;
  storageClass: string;
  capacity: number;
  description?: Record<string, string>;
  /**
   * The device's case binding, presented on every register and reconnect. Its `bindingCredential` (not the
   * self-asserted `deviceId`) is what authorizes Central to mint the case/deviceRef routing labels. Absent for a
   * worker that has not enrolled into a case.
   */
  edgeBinding?: EdgeBindingPayload;
}

export type EdgeWorkerLifecycleEvent =
  | { type: 'registered'; worker: WorkerRecord }
  | { type: 'heartbeat'; allocatable: number; conditions: WorkerCondition[] }
  | { type: 'session.assigned'; sessionId: string; agentSpecId: string }
  | { type: 'session.running'; sessionId: string }
  | { type: 'turn.started'; sessionId: string; turnSeq: number; message: string }
  | { type: 'turn.progress'; sessionId: string; turnSeq: number; text: string }
  | { type: 'turn.completed'; sessionId: string; turnSeq: number; message?: string; output?: unknown }
  | { type: 'turn.failed'; sessionId: string; turnSeq: number; error: string }
  | { type: 'turn.replayed'; sessionId: string; turnSeq: number }
  | { type: 'result.queued'; sessionId: string; turnSeq: number; pending: number }
  | { type: 'result.synced'; sessionId: string; turnSeq: number; pending: number }
  | { type: 'transport'; state: 'connected' | 'disconnected' }
  | { type: 're-registering'; reason: string }
  | { type: 'session.paused'; sessionId: string; reason?: string }
  | { type: 'command.rejected'; sessionId?: string; reason: string }
  | { type: 'stopped' }
  | { type: 'error'; message: string };

export type EdgeWorkerObserver = (event: EdgeWorkerLifecycleEvent) => void;

export interface EdgeWorkerRuntimeOptions {
  transport: EdgeWorkerTransport;
  agent: EdgeAgent;
  observer?: EdgeWorkerObserver;
  /**
   * Durable store for completed-turn results that have not yet been acknowledged by central. Defaults to a
   * process-lifetime in-memory store; the browser worker injects a `localStorage`-backed store so results
   * survive a weak-network reconnect or a tab reload.
   */
  outboundQueue?: OutboundQueueStore;
  /**
   * How to obtain a fresh connection grant for a registration. Defaults to the built-in HTTP `/sidecar/negotiate`
   * call; injectable so tests (and non-HTTP hosts) can drive registration + re-registration against a real
   * central without a network stack.
   */
  negotiator?: (input: EdgeWorkerRegistration) => Promise<RuntimeConnectionGrant>;
}

interface ActiveRun {
  sessionId: string;
  workerId: string;
  sessionLeaseId: string;
  agentSpecId: string;
  ready: Promise<void>;
  acceptedInputs: Map<number, { digest: string }>;
  currentTurn?: AbortController;
}

export class EdgeWorkerRuntime {
  private readonly transport: EdgeWorkerTransport;
  private readonly agent: EdgeAgent;
  private readonly observer?: EdgeWorkerObserver;
  private readonly outboundQueue: OutboundQueueStore;
  private readonly negotiator: (input: EdgeWorkerRegistration) => Promise<RuntimeConnectionGrant>;
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly completedPauses = new Set<string>();
  private commandSubscription: EdgeWorkerSubscription | undefined;
  private heartbeatState: { workerId: string; capacity: number } | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private connectionWired = false;
  private registration: EdgeWorkerRegistration | undefined;
  private reregistering = false;

  constructor(options: EdgeWorkerRuntimeOptions) {
    this.transport = options.transport;
    this.agent = options.agent;
    this.observer = options.observer;
    this.outboundQueue = options.outboundQueue ?? new InMemoryOutboundQueueStore();
    this.negotiator = options.negotiator ?? ((input) => this.negotiate(input));
  }

  /**
   * Browser entry point: negotiate a Worker registration over HTTP, connect the runtime transport,
   * subscribe to this worker's command channel, and start heartbeating. Returns the assigned Worker.
   */
  async register(input: EdgeWorkerRegistration): Promise<WorkerRecord> {
    this.registration = input;
    const grant = await this.negotiator(input);
    return this.connectWithGrant(grant);
  }

  /** Connect using an already-issued grant. Exposed so tests can drive a real central without HTTP. */
  async connectWithGrant(grant: RuntimeConnectionGrant): Promise<WorkerRecord> {
    const worker = this.requireGrantedWorker(grant);
    this.wireConnectionState();
    await this.transport.connect(grant.url);
    await this.activateWorker(worker);
    return worker;
  }

  /**
   * Bind this runtime to a (freshly granted) worker id: (re)subscribe to that worker's command channel and
   * (re)start heartbeating. Used by the first connect and by re-registration, where the transport is already
   * connected and only the worker identity changes.
   */
  private async activateWorker(worker: WorkerRecord): Promise<void> {
    await this.commandSubscription?.close();
    this.commandSubscription = undefined;
    await this.subscribeWorkerCommands(worker.workerId);
    await this.startHeartbeat(worker);
    this.emit({ type: 'registered', worker });
  }

  private requireGrantedWorker(grant: RuntimeConnectionGrant): WorkerRecord {
    if (!grant.worker) {
      throw new Error('negotiate response did not include a worker record');
    }
    return grant.worker;
  }

  /** Number of completed-turn results that are persisted but not yet acknowledged by central. */
  async pendingResultCount(): Promise<number> {
    return (await this.outboundQueue.list()).length;
  }

  /**
   * Try to deliver every durably-queued result for the sessions this worker is actively running, stamping
   * each with the run's current lease. Safe to call repeatedly; a result is removed only once central has
   * accepted it. Exposed so the sample can flush on an explicit "retry now".
   */
  async flushPendingResults(): Promise<void> {
    for (const run of this.activeRuns.values()) {
      await this.flushRun(run);
    }
  }

  private wireConnectionState(): void {
    if (this.connectionWired || !this.transport.onConnectionStateChanged) {
      return;
    }
    this.connectionWired = true;
    this.transport.onConnectionStateChanged((state) => {
      this.emit({ type: 'transport', state });
      if (state === 'connected') {
        void this.flushPendingResults().catch((error: unknown) => {
          this.emit({ type: 'error', message: error instanceof Error ? error.message : String(error) });
        });
      }
    });
  }

  async subscribeWorkerCommands(workerId: string): Promise<void> {
    this.commandSubscription = await this.transport.subscribe({ kind: 'worker-commands', workerId }, async (event) => {
      await this.handleWorkerCommand(event);
    });
  }

  async handleWorkerCommand(event: EdgeRuntimeEvent): Promise<void> {
    switch (event.type) {
      case 'session.assign':
        await this.handleAssign(event as EdgeRuntimeEvent<SessionAssignPayload>);
        return;
      case 'session.input':
        await this.handleInput(event as EdgeRuntimeEvent<SessionInputCommandPayload>);
        return;
      case 'session.pause.requested':
        await this.handlePause(event as EdgeRuntimeEvent<SessionPauseCommandPayload>);
        return;
      case 'worker.heartbeat.rejected':
        await this.handleHeartbeatRejected(event as EdgeRuntimeEvent<WorkerHeartbeatRejectedPayload>);
        return;
      default:
        throw new Error(`unexpected edge worker command: ${event.type}`);
    }
  }

  /**
   * Central rejected a heartbeat because this worker id is dead (its keepalive lease expired while the tab was
   * suspended, or its record was reaped). Re-register a fresh worker under the same labels/description — crucially
   * the same pairing label — so the device becomes routable again and its pairing keeps resolving to this tab.
   */
  private async handleHeartbeatRejected(event: EdgeRuntimeEvent<WorkerHeartbeatRejectedPayload>): Promise<void> {
    await this.reregister(this.rejectionReason(event.payload));
  }

  private rejectionReason(payload: WorkerHeartbeatRejectedPayload | undefined): string {
    return typeof payload?.reason === 'string' && payload.reason.length > 0 ? payload.reason : 'heartbeat-rejected';
  }

  private async reregister(reason: string): Promise<void> {
    if (this.reregistering) {
      return;
    }
    if (!this.registration) {
      // A grant-only connect (no stored registration) cannot re-negotiate; surface the honest disconnected
      // state rather than looking healthy against a dead worker id.
      this.emit({ type: 'transport', state: 'disconnected' });
      return;
    }
    this.reregistering = true;
    this.emit({ type: 're-registering', reason });
    try {
      this.stopHeartbeat();
      // The prior worker id is terminal in central; any runs leased to it are already failed by worker loss.
      // Abandon them locally so a fresh delegated child assigns cleanly onto the re-registered worker.
      this.dropActiveRuns();
      const grant = await this.negotiator(this.registration);
      const worker = this.requireGrantedWorker(grant);
      await this.activateWorker(worker);
    } catch (error) {
      this.emit({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      this.reregistering = false;
    }
  }

  private dropActiveRuns(): void {
    for (const run of this.activeRuns.values()) {
      run.currentTurn?.abort();
    }
    this.activeRuns.clear();
    this.completedPauses.clear();
  }

  async stop(): Promise<void> {
    this.stopHeartbeat();
    for (const run of this.activeRuns.values()) {
      run.currentTurn?.abort();
      await this.agent.stop?.({ sessionId: run.sessionId });
    }
    this.activeRuns.clear();
    this.completedPauses.clear();
    await this.commandSubscription?.close();
    this.commandSubscription = undefined;
    await this.transport.stop();
    this.emit({ type: 'stopped' });
  }

  private async handleAssign(event: EdgeRuntimeEvent<SessionAssignPayload>): Promise<void> {
    const payload = this.parseAssignPayload(event.payload);
    const sessionLeaseId = this.requireSessionLeaseId(event, payload.sessionLeaseId);
    const agentSpecId = payload.resolvedAgentSpec.agentSpecId;
    for (const key of [...this.completedPauses]) {
      if (key.startsWith(`${payload.sessionId}:`)) {
        this.completedPauses.delete(key);
      }
    }
    const ready = Promise.resolve(this.agent.start?.({ sessionId: payload.sessionId, agentSpecId }));
    this.activeRuns.set(payload.sessionId, {
      sessionId: payload.sessionId,
      workerId: payload.workerId,
      sessionLeaseId,
      agentSpecId,
      ready,
      acceptedInputs: new Map()
    });
    this.emit({ type: 'session.assigned', sessionId: payload.sessionId, agentSpecId });
    try {
      await ready;
    } catch (error) {
      this.activeRuns.delete(payload.sessionId);
      const message = error instanceof Error ? error.message : String(error);
      await this.publishTenantEvent<AgentOutputPayload>({
        type: 'agent.output',
        sessionId: payload.sessionId,
        workerId: payload.workerId,
        sessionLeaseId,
        payload: { error: { message } }
      });
      await this.publishTenantEvent<StatusChangedPayload>({
        type: 'status.changed',
        sessionId: payload.sessionId,
        workerId: payload.workerId,
        sessionLeaseId,
        payload: { status: 'failed', reason: message }
      });
      this.emit({ type: 'error', message });
      return;
    }
    await this.publishTenantEvent<StatusChangedPayload>({
      type: 'status.changed',
      sessionId: payload.sessionId,
      workerId: payload.workerId,
      sessionLeaseId,
      payload: { status: 'running' }
    });
    this.emit({ type: 'session.running', sessionId: payload.sessionId });
  }

  private async handleInput(event: EdgeRuntimeEvent<SessionInputCommandPayload>): Promise<void> {
    const payload = this.parseInputPayload(event.payload);
    const active = this.activeRuns.get(payload.sessionId);
    if (!active) {
      await this.publishCommandRejected(event, 'unknown_session', undefined, payload.sessionLeaseId);
      return;
    }
    if (active.sessionLeaseId !== payload.sessionLeaseId || event.sessionLeaseId !== active.sessionLeaseId) {
      await this.publishCommandRejected(event, 'stale_session_lease', active.sessionLeaseId, event.sessionLeaseId ?? payload.sessionLeaseId);
      return;
    }
    try {
      await active.ready;
    } catch {
      await this.publishCommandRejected(event, 'agent_not_running', active.sessionLeaseId, event.sessionLeaseId ?? payload.sessionLeaseId);
      return;
    }
    const digest = JSON.stringify(payload.input);
    const accepted = active.acceptedInputs.get(payload.turnSeq);
    if (accepted) {
      if (accepted.digest !== digest) {
        await this.publishCommandRejected(event, 'turn_input_conflict', active.sessionLeaseId, payload.sessionLeaseId);
        return;
      }
      await this.publishCommandAccepted(event, payload.turnSeq);
      return;
    }
    active.acceptedInputs.set(payload.turnSeq, { digest });
    await this.publishCommandAccepted(event, payload.turnSeq);
    // Weak-network replay: if this turn already completed on this device (before a disconnect or a tab
    // reload) its structured result is still durably queued. Re-deliver that saved result under the current
    // lease instead of re-capturing the device — this is exactly what central asks for when it restarts the
    // still-pending turn after the session is re-established.
    if (await this.replayQueuedResult(active, payload.turnSeq, digest)) {
      return;
    }
    await this.runTurn(active, payload);
  }

  private async runTurn(active: ActiveRun, payload: SessionInputCommandPayload): Promise<void> {
    const abort = new AbortController();
    active.currentTurn = abort;
    const digest = JSON.stringify(payload.input);
    this.emit({ type: 'turn.started', sessionId: payload.sessionId, turnSeq: payload.turnSeq, message: payload.input.message });
    const context: EdgeAgentContext = {
      progress: async (text: string) => {
        this.emit({ type: 'turn.progress', sessionId: payload.sessionId, turnSeq: payload.turnSeq, text });
        await this.publishTelemetry({
          type: 'agent.output',
          sessionId: payload.sessionId,
          workerId: payload.workerId,
          sessionLeaseId: payload.sessionLeaseId,
          turnSeq: payload.turnSeq,
          payload: { progress: text }
        });
      },
      delta: async (text: string) => {
        await this.publishTelemetry({
          type: 'agent.output',
          sessionId: payload.sessionId,
          workerId: payload.workerId,
          sessionLeaseId: payload.sessionLeaseId,
          turnSeq: payload.turnSeq,
          payload: { delta: text }
        });
      },
      signal: abort.signal
    };
    try {
      const result = await this.agent.runTurn(
        { sessionId: payload.sessionId, turnSeq: payload.turnSeq, message: payload.input.message },
        context
      );
      // Persist the structured result BEFORE attempting delivery so a disconnect between finishing the turn
      // and central acknowledging it cannot lose the observation.
      await this.enqueueResultAndFlush(active, payload.turnSeq, digest, 'turn.completed', {
        result: { message: result.message, output: result.output }
      });
      this.emit({ type: 'turn.completed', sessionId: payload.sessionId, turnSeq: payload.turnSeq, message: result.message, output: result.output });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.publishTenantEvent<AgentOutputPayload>({
        type: 'agent.output',
        sessionId: payload.sessionId,
        workerId: payload.workerId,
        sessionLeaseId: payload.sessionLeaseId,
        turnSeq: payload.turnSeq,
        payload: { error: { message } }
      });
      await this.enqueueResultAndFlush(active, payload.turnSeq, digest, 'turn.failed', { error: { message } });
      this.emit({ type: 'turn.failed', sessionId: payload.sessionId, turnSeq: payload.turnSeq, error: message });
    } finally {
      if (active.currentTurn === abort) {
        active.currentTurn = undefined;
      }
    }
  }

  /**
   * Persist a completed-turn result and try to deliver everything durably queued for this run. The result
   * is removed from the queue only once central accepts it; on a publish failure it stays queued for the
   * next reconnect/heartbeat flush.
   */
  private async enqueueResultAndFlush(
    active: ActiveRun,
    turnSeq: number,
    digest: string,
    type: 'turn.completed' | 'turn.failed',
    payload: TurnCompletedPayload | TurnFailedPayload
  ): Promise<void> {
    await this.outboundQueue.add(newQueuedResult({ sessionId: active.sessionId, turnSeq, digest, type, payload }));
    this.emit({ type: 'result.queued', sessionId: active.sessionId, turnSeq, pending: await this.pendingResultCount() });
    await this.flushRun(active);
  }

  private async flushRun(active: ActiveRun): Promise<void> {
    const pending = (await this.outboundQueue.list())
      .filter((item) => item.sessionId === active.sessionId && active.acceptedInputs.has(item.turnSeq))
      .sort((left, right) => left.turnSeq - right.turnSeq);
    for (const item of pending) {
      try {
        await this.publishTenantEvent({
          type: item.type,
          sessionId: item.sessionId,
          workerId: active.workerId,
          sessionLeaseId: active.sessionLeaseId,
          turnSeq: item.turnSeq,
          payload: item.payload
        });
      } catch (error) {
        // The link is down: keep this and every later result durably queued and retry on reconnect.
        this.emit({ type: 'error', message: error instanceof Error ? error.message : String(error) });
        return;
      }
      await this.outboundQueue.remove(item.queueId);
      this.emit({ type: 'result.synced', sessionId: item.sessionId, turnSeq: item.turnSeq, pending: await this.pendingResultCount() });
    }
  }

  private async replayQueuedResult(active: ActiveRun, turnSeq: number, digest: string): Promise<boolean> {
    const existing = (await this.outboundQueue.list()).find(
      (item) => item.sessionId === active.sessionId && item.turnSeq === turnSeq && item.digest === digest
    );
    if (!existing) {
      return false;
    }
    this.emit({ type: 'turn.replayed', sessionId: active.sessionId, turnSeq });
    await this.flushRun(active);
    return true;
  }

  private async handlePause(event: EdgeRuntimeEvent<SessionPauseCommandPayload>): Promise<void> {
    const payload = this.parsePausePayload(event.payload);
    const pauseKey = `${payload.sessionId}:${payload.sessionLeaseId}`;
    if (this.completedPauses.has(pauseKey)) {
      await this.publishPaused(payload);
      return;
    }
    const active = this.activeRuns.get(payload.sessionId);
    if (!active) {
      await this.publishCommandRejected(event, 'unknown_session', undefined, payload.sessionLeaseId);
      return;
    }
    if (active.sessionLeaseId !== payload.sessionLeaseId || event.sessionLeaseId !== active.sessionLeaseId) {
      await this.publishCommandRejected(event, 'stale_session_lease', active.sessionLeaseId, event.sessionLeaseId ?? payload.sessionLeaseId);
      return;
    }
    active.currentTurn?.abort();
    await this.agent.stop?.({ sessionId: payload.sessionId });
    this.activeRuns.delete(payload.sessionId);
    this.completedPauses.add(pauseKey);
    await this.publishPaused(payload);
    await this.publishHeartbeat();
    this.emit({ type: 'session.paused', sessionId: payload.sessionId, reason: payload.reason });
  }

  private async publishPaused(payload: SessionPauseCommandPayload): Promise<void> {
    // The browser worker registers as host-managed with a stop-on-pause policy, so pause never carries a
    // snapshot capture — continuity is the agent spec's restart-with-context, not a workspace snapshot.
    await this.publishTenantEvent<SessionPausedPayload>({
      type: 'session.paused',
      sessionId: payload.sessionId,
      workerId: payload.workerId,
      sessionLeaseId: payload.sessionLeaseId,
      payload: { reason: payload.reason }
    });
  }

  private async startHeartbeat(worker: WorkerRecord): Promise<void> {
    this.heartbeatState = { workerId: worker.workerId, capacity: worker.capacity };
    this.stopHeartbeat();
    await this.publishHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void this.publishHeartbeat().catch((error: unknown) => {
        this.emit({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      });
    }, HEARTBEAT_INTERVAL_MS);
    (this.heartbeatTimer as { unref?: () => void }).unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private async publishHeartbeat(): Promise<void> {
    if (!this.heartbeatState) {
      return;
    }
    const allocatable = Math.max(0, this.heartbeatState.capacity - this.activeRuns.size);
    const conditions: WorkerCondition[] = allocatable > 0 ? ['ready'] : ['busy'];
    const payload: WorkerHeartbeatPayload = {
      workerId: this.heartbeatState.workerId,
      capacity: this.heartbeatState.capacity,
      allocatable,
      conditions
    };
    await this.transport.publish({ kind: 'tenant-inbox' }, {
      eventId: crypto.randomUUID(),
      workerId: payload.workerId,
      sequence: 0,
      type: 'worker.heartbeat',
      timestamp: new Date().toISOString(),
      actor: 'sidecar',
      payload
    });
    this.emit({ type: 'heartbeat', allocatable, conditions });
    // A successful heartbeat proves the link is up: opportunistically drain any results that were queued
    // while it was down, even for transports that cannot report reconnects.
    if ((await this.outboundQueue.list()).length > 0) {
      await this.flushPendingResults();
    }
  }

  private async negotiate(input: EdgeWorkerRegistration): Promise<RuntimeConnectionGrant> {
    const url = new URL(EDGE_WORKER_HTTP_PATHS.sidecarNegotiate, input.centralUrl);
    url.searchParams.set(EDGE_WORKER_HTTP_QUERY.tenantId, input.tenantId);
    const registration: WorkerRegisterPayload = {
      labels: input.labels,
      storageClass: input.storageClass,
      capacity: input.capacity,
      allocatable: input.capacity,
      description: input.description,
      edgeBinding: input.edgeBinding
    };
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(registration)
    });
    if (!response.ok) {
      throw new Error(`edge worker negotiate failed with ${await describeNegotiateFailure(response)}`);
    }
    return await response.json() as RuntimeConnectionGrant;
  }

  private async publishCommandAccepted(event: EdgeRuntimeEvent, turnSeq: number): Promise<void> {
    await this.publishTenantEvent<WorkerCommandAcceptedPayload>({
      type: 'worker.command.accepted',
      sessionId: event.sessionId,
      workerId: event.workerId,
      sessionLeaseId: event.sessionLeaseId,
      turnSeq,
      payload: { commandEventId: event.eventId, turnSeq }
    });
  }

  private async publishCommandRejected(
    event: EdgeRuntimeEvent,
    reason: WorkerCommandRejectedPayload['reason'],
    expectedSessionLeaseId: string | undefined,
    receivedSessionLeaseId: string | undefined
  ): Promise<void> {
    await this.publishTenantEvent<WorkerCommandRejectedPayload>({
      type: 'worker.command.rejected',
      sessionId: event.sessionId,
      workerId: event.workerId,
      sessionLeaseId: receivedSessionLeaseId,
      turnSeq: event.turnSeq,
      payload: { reason, expectedSessionLeaseId, receivedSessionLeaseId }
    });
    this.emit({ type: 'command.rejected', sessionId: event.sessionId, reason });
  }

  private async publishTenantEvent<TPayload>(input: {
    type: string;
    sessionId?: string;
    workerId?: string;
    sessionLeaseId?: string;
    turnSeq?: number;
    payload: TPayload;
  }): Promise<void> {
    await this.transport.publish({ kind: 'tenant-inbox' }, {
      eventId: crypto.randomUUID(),
      sessionId: input.sessionId,
      workerId: input.workerId,
      sequence: 0,
      type: input.type,
      timestamp: new Date().toISOString(),
      actor: 'sidecar',
      sessionLeaseId: input.sessionLeaseId,
      turnSeq: input.turnSeq,
      payload: input.payload
    });
  }

  /**
   * Best-effort telemetry (progress / delta). Unlike a completed-turn result, a dropped progress line is not
   * worth persisting, and it must never fail the turn or block the durable result: a publish failure during a
   * weak-network blip is swallowed so the turn still completes locally and its result is durably queued.
   */
  private async publishTelemetry(input: {
    type: string;
    sessionId?: string;
    workerId?: string;
    sessionLeaseId?: string;
    turnSeq?: number;
    payload: AgentOutputPayload;
  }): Promise<void> {
    try {
      await this.publishTenantEvent(input);
    } catch (error) {
      this.emit({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }

  private emit(event: EdgeWorkerLifecycleEvent): void {
    this.observer?.(event);
  }

  private requireSessionLeaseId(event: EdgeRuntimeEvent, payloadSessionLeaseId: string): string {
    if (event.sessionLeaseId !== payloadSessionLeaseId) {
      throw new Error('session.assign sessionLeaseId must match envelope');
    }
    return payloadSessionLeaseId;
  }

  private parseAssignPayload(payload: unknown): SessionAssignPayload {
    if (!this.isRecord(payload)
      || typeof payload.sessionId !== 'string'
      || typeof payload.workerId !== 'string'
      || typeof payload.sessionLeaseId !== 'string'
      || !this.isRecord(payload.resolvedAgentSpec)
      || typeof payload.resolvedAgentSpec.agentSpecId !== 'string') {
      throw new Error('invalid session.assign payload');
    }
    return payload as unknown as SessionAssignPayload;
  }

  private parseInputPayload(payload: unknown): SessionInputCommandPayload {
    if (!this.isRecord(payload)
      || typeof payload.sessionId !== 'string'
      || typeof payload.workerId !== 'string'
      || typeof payload.sessionLeaseId !== 'string'
      || typeof payload.turnSeq !== 'number'
      || !this.isRecord(payload.input)
      || typeof payload.input.message !== 'string') {
      throw new Error('invalid session.input payload');
    }
    return payload as unknown as SessionInputCommandPayload;
  }

  private parsePausePayload(payload: unknown): SessionPauseCommandPayload {
    if (!this.isRecord(payload)
      || typeof payload.sessionId !== 'string'
      || typeof payload.workerId !== 'string'
      || typeof payload.sessionLeaseId !== 'string') {
      throw new Error('invalid session.pause.requested payload');
    }
    return payload as unknown as SessionPauseCommandPayload;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
