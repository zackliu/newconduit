import { POC_RUNTIME_HTTP_PATHS, POC_RUNTIME_HTTP_QUERY, type AgentOutputPayload, type RuntimeConnectionGrant, type RuntimeEvent, type SessionAssignPayload, type SessionInputCommandPayload, type SessionPauseCommandPayload, type SessionPausedPayload, type StatusChangedPayload, type TurnCompletedPayload, type TurnFailedPayload, type WorkerCommandRejectedPayload, type WorkerHeartbeatPayload, type WorkerRecord, type WorkerRegisterPayload } from '../shared';
import type { SidecarAgentProcessAdapter, SidecarRuntimeTransport, SidecarWorkspaceAdapter } from './contracts';

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
    const payload: WorkerHeartbeatPayload = {
      workerId: this.heartbeatState.workerId,
      capacity: this.heartbeatState.capacity,
      allocatable: Math.max(0, this.heartbeatState.capacity - activeRunCount),
      conditions: activeRunCount > 0 ? ['busy'] : ['ready']
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
    const ready = this.options.agentProcessAdapter.start({
      ...mounted,
      sessionId: payload.sessionId,
      workerId: payload.workerId,
      sessionLeaseId,
      resolvedAgentSpec: payload.resolvedAgentSpec
    });
    this.activeRuns.set(payload.sessionId, {
      sessionId: payload.sessionId,
      workerId: payload.workerId,
      sessionLeaseId,
      ready
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
    await this.options.agentProcessAdapter.send({
      sessionId: payload.sessionId,
      turnSeq: payload.turnSeq,
      message: payload.input.message
    }, async (output) => {
      if (output.type !== 'output') {
        return;
      }
      await this.publishTenantEvent({
        type: 'agent.output',
        sessionId: payload.sessionId,
        workerId: payload.workerId,
        sessionLeaseId: payload.sessionLeaseId,
        turnSeq: payload.turnSeq,
        payload: output.payload
      });
      await this.publishTurnTerminalEvent(payload, output.payload);
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
    this.activeRuns.delete(payload.sessionId);
    await this.publishTenantEvent<SessionPausedPayload>({
      type: 'session.paused',
      sessionId: payload.sessionId,
      workerId: payload.workerId,
      sessionLeaseId: payload.sessionLeaseId,
      payload: { reason: payload.reason }
    });
    await this.publishHeartbeat();
  }

  private async publishTurnTerminalEvent(input: SessionInputCommandPayload, output: AgentOutputPayload): Promise<void> {
    if (output.error) {
      await this.publishTenantEvent<TurnFailedPayload>({
        type: 'turn.failed',
        sessionId: input.sessionId,
        workerId: input.workerId,
        sessionLeaseId: input.sessionLeaseId,
        turnSeq: input.turnSeq,
        payload: { error: output.error }
      });
      return;
    }
    if (typeof output.message === 'string' || 'output' in output) {
      await this.publishTenantEvent<TurnCompletedPayload>({
        type: 'turn.completed',
        sessionId: input.sessionId,
        workerId: input.workerId,
        sessionLeaseId: input.sessionLeaseId,
        turnSeq: input.turnSeq,
        payload: {
          result: {
            message: output.message,
            output: output.output
          }
        }
      });
    }
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
    if (candidate.reason !== undefined && candidate.reason !== 'idle_timeout' && candidate.reason !== 'client_requested') {
      throw new Error('invalid session.pause.requested reason');
    }
    return payload as SessionPauseCommandPayload;
  }
}