import { POC_RUNTIME_HTTP_PATHS, POC_RUNTIME_HTTP_QUERY, type AgentOutputPayload, type InteractionRequestedPayload, type RuntimeConnectionGrant, type RuntimeEvent, type SessionAssignPayload, type SessionInputCommandPayload, type SessionInteractionResponseCommandPayload, type SessionPauseCommandPayload, type SessionPausedPayload, type StatusChangedPayload, type TurnCompletedPayload, type TurnFailedPayload, type WorkerCommandRejectedPayload, type WorkerHeartbeatPayload, type WorkerRecord, type WorkerRegisterPayload } from '../shared';
import type { SidecarAgentProcessAdapter, SidecarRuntimeTransport, SidecarWorkspaceAdapter, SidecarWorkspaceMount } from './contracts';

export interface StandaloneSidecarStartInput extends WorkerRegisterPayload {
  centralUrl: string;
  tenantId: string;
}

export interface SidecarDaemonOptions {
  runtimeTransport: SidecarRuntimeTransport;
  workspaceAdapter: SidecarWorkspaceAdapter;
  agentProcessAdapter: SidecarAgentProcessAdapter;
}

interface ActiveAgentRunState {
  sessionId: string;
  workerId: string;
  sessionLeaseId: string;
  ready: Promise<void>;
  mount: SidecarWorkspaceMount;
}

interface HeartbeatState {
  workerId: string;
  capacity: number;
}

const HEARTBEAT_INTERVAL_MS = 10_000;

export class SidecarDaemon {
  private readonly activeRuns = new Map<string, ActiveAgentRunState>();
  private heartbeatState: HeartbeatState | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: SidecarDaemonOptions) {}

  async startStandaloneWorker(input: StandaloneSidecarStartInput): Promise<WorkerRecord> {
    const grant = await this.negotiateSidecarConnection(input);
    if (!grant.worker) {
      throw new Error('sidecar negotiate response did not include worker');
    }
    await this.options.runtimeTransport.connect(grant.url);
    await this.subscribeWorkerCommands(grant.worker.workerId);
    await this.startHeartbeat(grant.worker);
    return grant.worker;
  }

  async subscribeWorkerCommands(workerId: string): Promise<void> {
    await this.options.runtimeTransport.subscribe({ kind: 'worker-commands', workerId }, async (envelope) => {
      await this.handleWorkerCommand(envelope.event);
    });
  }

  async handleWorkerCommand(event: RuntimeEvent): Promise<void> {
    switch (event.type) {
      case 'session.assign':
        await this.handleAssign(event as RuntimeEvent<SessionAssignPayload>);
        return;
      case 'session.input':
        await this.handleInput(event as RuntimeEvent<SessionInputCommandPayload>);
        return;
      case 'session.pause.requested':
        await this.handlePause(event as RuntimeEvent<SessionPauseCommandPayload>);
        return;
      case 'session.interaction.response':
        await this.handleInteractionResponse(event as RuntimeEvent<SessionInteractionResponseCommandPayload>);
        return;
      default:
        throw new Error(`unexpected sidecar command: ${event.type}`);
    }
  }

  async stop(): Promise<void> {
    this.stopHeartbeat();
    if (this.options.agentProcessAdapter.stop) {
      await Promise.all([...this.activeRuns.values()].map((run) => this.options.agentProcessAdapter.stop?.({ sessionId: run.sessionId })));
    }
    this.activeRuns.clear();
    await this.options.runtimeTransport.stop();
  }

  private async startHeartbeat(worker: WorkerRecord): Promise<void> {
    this.heartbeatState = {
      workerId: worker.workerId,
      capacity: worker.capacity
    };
    this.stopHeartbeat();
    await this.publishHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void this.publishHeartbeat().catch((error: unknown) => {
        console.error('sidecar heartbeat failed', error);
      });
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
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
    const activeRunCount = this.activeRuns.size;
    const allocatable = Math.max(0, this.heartbeatState.capacity - activeRunCount);
    const payload: WorkerHeartbeatPayload = {
      workerId: this.heartbeatState.workerId,
      capacity: this.heartbeatState.capacity,
      allocatable,
      conditions: allocatable > 0 ? ['ready'] : ['busy']
    };
    await this.options.runtimeTransport.publish({ kind: 'tenant-inbox' }, {
      eventId: crypto.randomUUID(),
      workerId: payload.workerId,
      sequence: 0,
      type: 'worker.heartbeat',
      timestamp: new Date().toISOString(),
      actor: 'sidecar',
      payload
    });
  }

  private async negotiateSidecarConnection(input: StandaloneSidecarStartInput): Promise<RuntimeConnectionGrant> {
    const url = new URL(POC_RUNTIME_HTTP_PATHS.sidecarNegotiate, input.centralUrl);
    url.searchParams.set(POC_RUNTIME_HTTP_QUERY.tenantId, input.tenantId);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sidecarClass: input.sidecarClass,
        labels: input.labels,
        description: input.description,
        capacity: input.capacity,
        allocatable: input.allocatable
      })
    });
    if (!response.ok) {
      throw new Error(`sidecar negotiate failed with HTTP ${response.status}`);
    }
    return await response.json() as RuntimeConnectionGrant;
  }

  private async handleAssign(event: RuntimeEvent<SessionAssignPayload>): Promise<void> {
    const payload = this.parseAssignPayload(event.payload);
    const sessionLeaseId = this.requireSessionLeaseId(event, payload.sessionLeaseId);
    const mounted = this.options.workspaceAdapter.mount({
      workspacePath: payload.workspaceRef,
      copilotSessionStatePath: payload.copilotSessionStateRef
    });
    const ready = (async () => {
      if (payload.restore) {
        await this.options.workspaceAdapter.restore({
          mount: mounted,
          location: payload.restore.location,
          parts: payload.restore.parts
        });
      }
      await this.options.agentProcessAdapter.start({
        ...mounted,
        sessionId: payload.sessionId,
        workerId: payload.workerId,
        sessionLeaseId,
        resolvedAgentSpec: payload.resolvedAgentSpec
      });
    })();
    this.activeRuns.set(payload.sessionId, {
      sessionId: payload.sessionId,
      workerId: payload.workerId,
      sessionLeaseId,
      ready,
      mount: mounted
    });
    try {
      await ready;
    } catch (error) {
      this.activeRuns.delete(payload.sessionId);
      const message = error instanceof Error ? error.message : String(error);
      await this.publishTenantEvent({
        type: 'agent.output',
        sessionId: payload.sessionId,
        workerId: payload.workerId,
        sessionLeaseId,
        payload: {
          error: { message }
        }
      });
      await this.publishTenantEvent<StatusChangedPayload>({
        type: 'status.changed',
        sessionId: payload.sessionId,
        workerId: payload.workerId,
        sessionLeaseId,
        payload: { status: 'failed', reason: message }
      });
      return;
    }
    await this.publishTenantEvent<StatusChangedPayload>({
      type: 'status.changed',
      sessionId: payload.sessionId,
      workerId: payload.workerId,
      sessionLeaseId,
      payload: { status: 'running' }
    });
  }

  private async handleInput(event: RuntimeEvent<SessionInputCommandPayload>): Promise<void> {
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
    // Await the turn only until it completes or suspends on its first interaction. A suspended turn
    // keeps running in the background so the interaction response can arrive on this same command loop.
    await this.runTurn(payload);
  }

  private async runTurn(payload: SessionInputCommandPayload): Promise<void> {
    let settled = false;
    let resolveSettled!: () => void;
    const settledPromise = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const settle = (): void => {
      if (!settled) {
        settled = true;
        resolveSettled();
      }
    };
    const run = (async () => {
      try {
        const result = await this.options.agentProcessAdapter.send({
          sessionId: payload.sessionId,
          turnSeq: payload.turnSeq,
          message: payload.input.message
        }, async (event) => {
          if (event.type === 'interaction') {
            await this.publishTenantEvent<InteractionRequestedPayload>({
              type: 'interaction.requested',
              sessionId: payload.sessionId,
              workerId: payload.workerId,
              sessionLeaseId: payload.sessionLeaseId,
              turnSeq: payload.turnSeq,
              payload: event.payload
            });
            settle();
            return;
          }
          await this.publishTenantEvent({
            type: 'agent.output',
            sessionId: payload.sessionId,
            workerId: payload.workerId,
            sessionLeaseId: payload.sessionLeaseId,
            turnSeq: payload.turnSeq,
            payload: event.payload
          });
        });
        await this.publishTenantEvent<TurnCompletedPayload>({
          type: 'turn.completed',
          sessionId: payload.sessionId,
          workerId: payload.workerId,
          sessionLeaseId: payload.sessionLeaseId,
          turnSeq: payload.turnSeq,
          payload: { result: { message: result.message, output: result.output } }
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.publishTenantEvent({
          type: 'agent.output',
          sessionId: payload.sessionId,
          workerId: payload.workerId,
          sessionLeaseId: payload.sessionLeaseId,
          turnSeq: payload.turnSeq,
          payload: { error: { message } }
        });
        await this.publishTenantEvent<TurnFailedPayload>({
          type: 'turn.failed',
          sessionId: payload.sessionId,
          workerId: payload.workerId,
          sessionLeaseId: payload.sessionLeaseId,
          turnSeq: payload.turnSeq,
          payload: { error: { message } }
        });
      } finally {
        settle();
      }
    })();
    run.catch((error: unknown) => {
      console.error('sidecar turn runner failed', error);
    });
    await settledPromise;
  }

  private async handleInteractionResponse(event: RuntimeEvent<SessionInteractionResponseCommandPayload>): Promise<void> {
    const payload = this.parseInteractionResponsePayload(event.payload);
    const active = this.activeRuns.get(payload.sessionId);
    if (!active) {
      await this.publishCommandRejected(event, 'unknown_session', undefined, payload.sessionLeaseId);
      return;
    }
    if (active.sessionLeaseId !== payload.sessionLeaseId || event.sessionLeaseId !== active.sessionLeaseId) {
      await this.publishCommandRejected(event, 'stale_session_lease', active.sessionLeaseId, event.sessionLeaseId ?? payload.sessionLeaseId);
      return;
    }
    await this.options.agentProcessAdapter.respondToInteraction?.({
      sessionId: payload.sessionId,
      interactionId: payload.interactionId,
      kind: payload.kind,
      response: payload.response
    });
  }

  private async handlePause(event: RuntimeEvent<SessionPauseCommandPayload>): Promise<void> {
    const payload = this.parsePausePayload(event.payload);
    const active = this.activeRuns.get(payload.sessionId);
    if (!active) {
      await this.publishCommandRejected(event, 'unknown_session', undefined, payload.sessionLeaseId);
      return;
    }
    if (active.sessionLeaseId !== payload.sessionLeaseId || event.sessionLeaseId !== active.sessionLeaseId) {
      await this.publishCommandRejected(event, 'stale_session_lease', active.sessionLeaseId, event.sessionLeaseId ?? payload.sessionLeaseId);
      return;
    }
    await active.ready;
    await this.options.agentProcessAdapter.pauseAtTurnBoundary?.({ sessionId: payload.sessionId });
    await this.options.agentProcessAdapter.stop?.({ sessionId: payload.sessionId });
    const snapshot = payload.capture
      ? { snapshotId: payload.capture.snapshotId, parts: await this.options.workspaceAdapter.capture({ mount: active.mount, location: payload.capture.location }) }
      : undefined;
    this.activeRuns.delete(payload.sessionId);
    await this.publishTenantEvent<SessionPausedPayload>({
      type: 'session.paused',
      sessionId: payload.sessionId,
      workerId: payload.workerId,
      sessionLeaseId: payload.sessionLeaseId,
      payload: {
        reason: payload.reason,
        ...(snapshot ? { snapshot } : {})
      }
    });
    await this.publishHeartbeat();
  }

  private async publishCommandRejected(
    event: RuntimeEvent,
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
      payload: {
        reason,
        expectedSessionLeaseId,
        receivedSessionLeaseId
      }
    });
  }

  private async publishTenantEvent<TPayload>(input: {
    type: RuntimeEvent<TPayload>['type'];
    sessionId?: string;
    workerId?: string;
    sessionLeaseId?: string;
    turnSeq?: number;
    payload: TPayload;
  }): Promise<void> {
    await this.options.runtimeTransport.publish({ kind: 'tenant-inbox' }, {
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

  private requireSessionLeaseId(event: RuntimeEvent, payloadSessionLeaseId: string): string {
    if (event.sessionLeaseId !== payloadSessionLeaseId) {
      throw new Error('session.assign sessionLeaseId must match envelope');
    }
    return payloadSessionLeaseId;
  }

  private parseAssignPayload(payload: unknown): SessionAssignPayload {
    if (typeof payload !== 'object' || payload === null) {
      throw new Error('invalid session.assign payload');
    }
    const candidate = payload as Partial<SessionAssignPayload>;
    if (typeof candidate.sessionId !== 'string'
      || typeof candidate.workerId !== 'string'
      || typeof candidate.sessionLeaseId !== 'string'
      || typeof candidate.workspaceRef !== 'string'
      || typeof candidate.copilotSessionStateRef !== 'string'
      || typeof candidate.resolvedAgentSpec?.agentSpecId !== 'string') {
      throw new Error('invalid session.assign payload');
    }
    if (candidate.restore !== undefined
      && (typeof candidate.restore.snapshotId !== 'string'
        || typeof candidate.restore.location !== 'string'
        || !Array.isArray(candidate.restore.parts))) {
      throw new Error('invalid session.assign restore ref');
    }
    return payload as SessionAssignPayload;
  }

  private parseInputPayload(payload: unknown): SessionInputCommandPayload {
    if (typeof payload !== 'object' || payload === null) {
      throw new Error('invalid session.input payload');
    }
    const candidate = payload as Partial<SessionInputCommandPayload>;
    if (typeof candidate.sessionId !== 'string'
      || typeof candidate.workerId !== 'string'
      || typeof candidate.sessionLeaseId !== 'string'
      || typeof candidate.turnSeq !== 'number'
      || typeof candidate.input?.message !== 'string') {
      throw new Error('invalid session.input payload');
    }
    return payload as SessionInputCommandPayload;
  }

  private parsePausePayload(payload: unknown): SessionPauseCommandPayload {
    if (typeof payload !== 'object' || payload === null) {
      throw new Error('invalid session.pause.requested payload');
    }
    const candidate = payload as Partial<SessionPauseCommandPayload>;
    if (typeof candidate.sessionId !== 'string'
      || typeof candidate.workerId !== 'string'
      || typeof candidate.sessionLeaseId !== 'string') {
      throw new Error('invalid session.pause.requested payload');
    }
    if (candidate.capture !== undefined && (typeof candidate.capture.snapshotId !== 'string' || typeof candidate.capture.location !== 'string')) {
      throw new Error('invalid session.pause.requested capture ref');
    }
    if (candidate.reason !== undefined && candidate.reason !== 'idle_timeout' && candidate.reason !== 'client_requested') {
      throw new Error('invalid session.pause.requested reason');
    }
    return payload as SessionPauseCommandPayload;
  }

  private parseInteractionResponsePayload(payload: unknown): SessionInteractionResponseCommandPayload {
    if (typeof payload !== 'object' || payload === null) {
      throw new Error('invalid session.interaction.response payload');
    }
    const candidate = payload as Partial<SessionInteractionResponseCommandPayload>;
    if (typeof candidate.sessionId !== 'string'
      || typeof candidate.workerId !== 'string'
      || typeof candidate.sessionLeaseId !== 'string'
      || typeof candidate.interactionId !== 'string'
      || (candidate.kind !== 'approval' && candidate.kind !== 'tool_call')) {
      throw new Error('invalid session.interaction.response payload');
    }
    return payload as SessionInteractionResponseCommandPayload;
  }
}