import type { AgentInteractionRequestedPayload, AgentOutputPayload, RuntimeEvent, RuntimeEventTransport, RuntimeStorage, SessionPausedPayload, SessionRecord, SnapshotCreatedPayload, SnapshotPartName, StatusChangedPayload, TurnCompletedPayload, TurnFailedPayload, WorkerCommandAcceptedPayload, WorkerCommandRejectedPayload, WorkerResultAcknowledgedPayload } from '../../shared';
import { EventLogManager, InteractionManager, SessionLifecycleManager, SessionLeaseManager, SessionLifecycleReconciler, WorkerManager } from '../managers';
import { SnapshotManager } from '../persistence';

export interface AgentRuntimeEventOutcome {
  handled: boolean;
  duplicate: boolean;
}

interface SessionAppendOutcome<TPayload> {
  event: RuntimeEvent<TPayload>;
  duplicate: boolean;
  current: boolean;
}

/**
 * Handles events that originate from a running agent on a leased worker, making sure they become central-owned session history before clients see them.
 */
export class AgentRuntimeEventController {
  private readonly sessionAppendTails = new Map<string, Promise<void>>();

  constructor(
    private readonly storage: RuntimeStorage,
    private readonly eventLogManager: EventLogManager,
    private readonly sessionLifecycleManager: SessionLifecycleManager,
    private readonly sessionLeaseManager: SessionLeaseManager,
    private readonly workerManager: WorkerManager,
    private readonly sessionLifecycleReconciler: SessionLifecycleReconciler,
    private readonly snapshotManager: SnapshotManager,
    private readonly interactionManager: InteractionManager,
    private readonly eventTransport: RuntimeEventTransport
  ) {}

  async handleRuntimeEvent(event: RuntimeEvent): Promise<AgentRuntimeEventOutcome> {
    switch (event.type) {
      case 'status.changed': {
        const payload = this.parseStatusChangedPayload(event.payload);
        const appended = await this.appendSessionEvent(event, payload, { status: payload.status, statusReason: payload.reason });
        if (payload.status === 'failed' && event.sessionId) {
          await this.interactionManager.interruptForOwnerSession(event.sessionId, 'owner_session_terminal');
        }
        if (appended.current) {
          await this.eventTransport.publish({ kind: 'client-inbox' }, {
            ...appended.event,
            ackId: undefined,
            type: 'session.status.updated',
            payload: {
              sessionId: appended.event.sessionId,
              status: payload.status,
              reason: payload.reason
            }
          });
        }
        return { handled: true, duplicate: appended.duplicate };
      }
      case 'agent.output': {
        const payload = this.parseAgentOutputPayload(event.payload);
        const appended = await this.appendSessionEvent(event, payload);
        return { handled: true, duplicate: appended.duplicate };
      }
      case 'turn.completed': {
        const payload = this.parseTurnCompletedPayload(event.payload);
        const appended = await this.appendSessionEvent(event, payload);
        return { handled: true, duplicate: appended.duplicate };
      }
      case 'turn.failed': {
        const payload = this.parseTurnFailedPayload(event.payload);
        const appended = await this.appendSessionEvent(event, payload);
        if (event.sessionId) {
          await this.interactionManager.interruptForOwnerSession(event.sessionId, 'owner_turn_failed');
        }
        return { handled: true, duplicate: appended.duplicate };
      }
      case 'worker.command.rejected': {
        const payload = this.parseWorkerCommandRejectedPayload(event.payload);
        const appended = await this.appendSessionEvent(event, payload, { assertCurrentLease: false });
        return { handled: true, duplicate: appended.duplicate };
      }
      case 'worker.command.accepted': {
        const payload = this.parseWorkerCommandAcceptedPayload(event.payload);
        const appended = await this.appendSessionEvent(event, payload);
        await this.interactionManager.acknowledgeDelivery(payload.commandEventId);
        return { handled: true, duplicate: appended.duplicate };
      }
      case 'agent.interaction.requested': {
        const payload = this.parseAgentInteractionRequestedPayload(event.payload);
        await this.interactionManager.admitAgentRequest(event, payload);
        return { handled: true, duplicate: false };
      }
      case 'session.paused': {
        const payload = this.parseSessionPausedPayload(event.payload);
        const appended = await this.appendSessionEvent(event, { reason: payload.reason });
        const session = await this.requireSession(event);
        let finalSequence = appended.event.sequence;
        let finalTimestamp = appended.event.timestamp;
        let latestSnapshotRef = session.latestSnapshotRef;
        if (payload.snapshot) {
          const snapshot = await this.snapshotManager.recordCapture(session, payload.snapshot);
          if (snapshot) {
            const marker = await this.eventLogManager.append<SnapshotCreatedPayload>({
              type: 'snapshot.created',
              actor: 'central',
              payload: { snapshotId: snapshot.snapshotId, baseEventCursor: snapshot.baseEventCursor },
              sequence: session.eventCursor + 1,
              sessionId: session.sessionId
            });
            await this.sessionLifecycleManager.advanceEventCursor(session, marker.sequence);
            await this.eventTransport.publish({ kind: 'session-events', sessionId: session.sessionId }, marker);
            finalSequence = marker.sequence;
            finalTimestamp = marker.timestamp;
            latestSnapshotRef = snapshot.snapshotId;
          }
        }
        if (session.currentWorkerId) {
          await this.workerManager.releaseSessionLease(session.currentWorkerId);
        }
        await this.sessionLifecycleManager.pauseAfterEvent(session, finalSequence, finalTimestamp, payload.reason, latestSnapshotRef);
        this.triggerReconcile();
        if (!appended.duplicate) {
          await this.eventTransport.publish({ kind: 'client-inbox' }, {
            ...appended.event,
            ackId: undefined,
            type: 'session.status.updated',
            payload: {
              sessionId: appended.event.sessionId,
              status: 'paused',
              reason: payload.reason
            }
          });
        }
        return { handled: true, duplicate: appended.duplicate };
      }
      default:
        return { handled: false, duplicate: false };
    }
  }

  private parseWorkerCommandAcceptedPayload(payload: unknown): WorkerCommandAcceptedPayload {
    if (typeof payload !== 'object' || payload === null) {
      throw new Error('invalid worker.command.accepted payload');
    }
    const candidate = payload as Partial<WorkerCommandAcceptedPayload>;
    if (typeof candidate.commandEventId !== 'string' || typeof candidate.turnSeq !== 'number') {
      throw new Error('invalid worker.command.accepted payload');
    }
    return payload as WorkerCommandAcceptedPayload;
  }

  private triggerReconcile(): void {
    void this.sessionLifecycleReconciler.reconcile()
      .catch((error: unknown) => {
        console.error('runtime reconcile after agent report failed', error);
      });
  }

  private async appendSessionEvent<TPayload>(event: RuntimeEvent, payload: TPayload, options: { assertCurrentLease?: boolean; status?: Extract<SessionRecord['status'], 'running' | 'failed'>; statusReason?: string } = {}): Promise<SessionAppendOutcome<TPayload>> {
    if (!event.sessionId) {
      throw new Error(`${event.type} requires sessionId`);
    }
    const previous = this.sessionAppendTails.get(event.sessionId) ?? Promise.resolve();
    const run = previous.then(() => this.appendSessionEventOnce(event, payload, options));
    this.sessionAppendTails.set(event.sessionId, run.then(() => undefined, () => undefined));
    return run;
  }

  private async appendSessionEventOnce<TPayload>(event: RuntimeEvent, payload: TPayload, options: { assertCurrentLease?: boolean; status?: Extract<SessionRecord['status'], 'running' | 'failed'>; statusReason?: string }): Promise<SessionAppendOutcome<TPayload>> {
    const session = await this.requireSession(event);
    const existing = (await this.storage.readEvents(session.sessionId, 0)).find((candidate) => candidate.eventId === event.eventId);
    if (existing) {
      if (existing.type !== event.type
        || existing.turnSeq !== event.turnSeq
        || JSON.stringify(existing.payload) !== JSON.stringify(payload)) {
        throw new Error(`runtime event ${event.eventId} conflicts with an existing session event`);
      }
      const current = existing.sequence >= session.eventCursor;
      if (session.eventCursor < existing.sequence) {
        if (options.status) {
          await this.sessionLifecycleManager.transitionAfterEvent(
            session,
            options.status,
            existing.sequence,
            existing.timestamp,
            options.statusReason
          );
        } else {
          await this.sessionLifecycleManager.advanceEventCursor(session, existing.sequence);
        }
        await this.eventTransport.publish({ kind: 'session-events', sessionId: session.sessionId }, existing);
      } else if (session.eventCursor === existing.sequence && options.status) {
        if (session.status !== options.status || session.lifecycleReason !== options.statusReason) {
          await this.sessionLifecycleManager.transitionAfterEvent(
            session,
            options.status,
            existing.sequence,
            existing.timestamp,
            options.statusReason
          );
        } else {
          await this.sessionLifecycleManager.reconcileTerminalHook(session);
        }
        await this.eventTransport.publish({ kind: 'session-events', sessionId: session.sessionId }, existing);
      }
      return { event: existing as RuntimeEvent<TPayload>, duplicate: true, current };
    }
    if (options.assertCurrentLease !== false) {
      this.sessionLeaseManager.assertCurrent(session, this.requireSessionLeaseId(event));
    }
    const appended = await this.eventLogManager.append({
      eventId: event.eventId,
      type: event.type,
      actor: event.actor,
      payload,
      sequence: session.eventCursor + 1,
      sessionId: session.sessionId,
      workerId: event.workerId,
      turnSeq: event.turnSeq,
      sessionLeaseId: event.sessionLeaseId
    });
    if (options.status) {
      await this.sessionLifecycleManager.transitionAfterEvent(
        session,
        options.status,
        appended.sequence,
        appended.timestamp,
        options.statusReason
      );
    } else {
      await this.sessionLifecycleManager.advanceEventCursor(session, appended.sequence);
    }
    await this.eventTransport.publish({ kind: 'session-events', sessionId: session.sessionId }, appended);
    return { event: appended, duplicate: false, current: true };
  }

  async acknowledgeWorkerResultIfNeeded(event: RuntimeEvent): Promise<void> {
    if (event.type !== 'turn.completed' && event.type !== 'turn.failed') {
      return;
    }
    if (!event.workerId || !event.sessionId || typeof event.turnSeq !== 'number') {
      throw new Error(`${event.type} requires workerId, sessionId, and turnSeq`);
    }
    const payload: WorkerResultAcknowledgedPayload = { resultEventId: event.eventId };
    await this.eventTransport.publish({ kind: 'worker-commands', workerId: event.workerId }, {
      eventId: crypto.randomUUID(),
      type: 'worker.result.acknowledged',
      actor: 'central',
      payload,
      sequence: 0,
      timestamp: new Date().toISOString(),
      sessionId: event.sessionId,
      workerId: event.workerId,
      sessionLeaseId: event.sessionLeaseId,
      turnSeq: event.turnSeq
    });
  }

  private async requireSession(event: RuntimeEvent): Promise<SessionRecord> {
    if (!event.sessionId) {
      throw new Error(`${event.type} requires sessionId`);
    }
    const session = await this.storage.readSession(event.sessionId);
    if (!session) {
      throw new Error(`session ${event.sessionId} was not found for ${event.type}`);
    }
    return session;
  }

  private requireSessionLeaseId(event: RuntimeEvent): string {
    if (typeof event.sessionLeaseId !== 'string') {
      throw new Error(`${event.type} requires sessionLeaseId`);
    }
    return event.sessionLeaseId;
  }

  private parseStatusChangedPayload(payload: unknown): StatusChangedPayload {
    if (!this.isRecord(payload) || (payload.status !== 'running' && payload.status !== 'failed')) {
      throw new Error('invalid status.changed payload');
    }
    return {
      status: payload.status,
      reason: typeof payload.reason === 'string' ? payload.reason : undefined
    };
  }

  private parseAgentOutputPayload(payload: unknown): AgentOutputPayload {
    if (!this.isRecord(payload)) {
      throw new Error('invalid agent.output payload');
    }
    const error = this.isRecord(payload.error)
      ? {
          message: typeof payload.error.message === 'string' ? payload.error.message : 'agent turn failed',
          code: typeof payload.error.code === 'string' ? payload.error.code : undefined,
          details: payload.error.details
        }
      : undefined;
    return {
      message: typeof payload.message === 'string' ? payload.message : undefined,
      delta: typeof payload.delta === 'string' ? payload.delta : undefined,
      progress: typeof payload.progress === 'string' ? payload.progress : undefined,
      toolStarted: this.isRecord(payload.toolStarted) && typeof payload.toolStarted.toolCallId === 'string' && typeof payload.toolStarted.toolName === 'string'
        ? {
            toolCallId: payload.toolStarted.toolCallId,
            toolName: payload.toolStarted.toolName,
            inputSummary: payload.toolStarted.inputSummary
          }
        : undefined,
      toolCompleted: this.isRecord(payload.toolCompleted) && typeof payload.toolCompleted.toolCallId === 'string' && typeof payload.toolCompleted.toolName === 'string'
        ? {
            toolCallId: payload.toolCompleted.toolCallId,
            toolName: payload.toolCompleted.toolName,
            outputSummary: payload.toolCompleted.outputSummary
          }
        : undefined,
      approvalRequested: payload.approvalRequested,
      internalEvent: this.isRecord(payload.internalEvent) && typeof payload.internalEvent.type === 'string'
        ? {
            type: payload.internalEvent.type,
            data: payload.internalEvent.data
          }
        : undefined,
      output: 'output' in payload ? payload.output : undefined,
      error
    };
  }

  private parseWorkerCommandRejectedPayload(payload: unknown): WorkerCommandRejectedPayload {
    if (!this.isRecord(payload)) {
      throw new Error('invalid worker.command.rejected payload');
    }
    if (payload.reason !== 'stale_session_lease' && payload.reason !== 'unknown_session' && payload.reason !== 'agent_not_running') {
      throw new Error('invalid worker.command.rejected reason');
    }
    return {
      reason: payload.reason,
      expectedSessionLeaseId: typeof payload.expectedSessionLeaseId === 'string' ? payload.expectedSessionLeaseId : undefined,
      receivedSessionLeaseId: typeof payload.receivedSessionLeaseId === 'string' ? payload.receivedSessionLeaseId : undefined
    };
  }

  private parseAgentInteractionRequestedPayload(payload: unknown): AgentInteractionRequestedPayload {
    if (!this.isRecord(payload) || typeof payload.adapterRequestId !== 'string' || !payload.adapterRequestId) {
      throw new Error('invalid agent.interaction.requested payload');
    }
    if (payload.kind !== 'approval' && payload.kind !== 'tool_call') {
      throw new Error('invalid agent.interaction.requested kind');
    }
    return {
      adapterRequestId: payload.adapterRequestId,
      kind: payload.kind,
      request: payload.request
    };
  }

  private parseTurnCompletedPayload(payload: unknown): TurnCompletedPayload {
    if (!this.isRecord(payload) || !this.isRecord(payload.result)) {
      throw new Error('invalid turn.completed payload');
    }
    return {
      result: {
        message: typeof payload.result.message === 'string' ? payload.result.message : undefined,
        output: 'output' in payload.result ? payload.result.output : undefined
      }
    };
  }

  private parseTurnFailedPayload(payload: unknown): TurnFailedPayload {
    if (!this.isRecord(payload) || !this.isRecord(payload.error)) {
      throw new Error('invalid turn.failed payload');
    }
    return {
      error: {
        message: typeof payload.error.message === 'string' ? payload.error.message : 'agent turn failed',
        code: typeof payload.error.code === 'string' ? payload.error.code : undefined,
        details: payload.error.details
      }
    };
  }

  private parseSessionPausedPayload(payload: unknown): SessionPausedPayload {
    if (!this.isRecord(payload)) {
      throw new Error('invalid session.paused payload');
    }
    if (payload.reason !== undefined && payload.reason !== 'idle_timeout' && payload.reason !== 'client_requested' && payload.reason !== 'parent_terminal') {
      throw new Error('invalid session.paused reason');
    }
    return {
      reason: payload.reason,
      snapshot: this.parseSnapshotReport(payload.snapshot)
    };
  }

  private parseSnapshotReport(value: unknown): SessionPausedPayload['snapshot'] {
    if (value === undefined) {
      return undefined;
    }
    if (!this.isRecord(value) || typeof value.snapshotId !== 'string' || !Array.isArray(value.parts)) {
      throw new Error('invalid session.paused snapshot');
    }
    const parts = value.parts.map((part): SnapshotPartName => {
      if (part !== 'workspace' && part !== 'agent-state') {
        throw new Error('invalid session.paused snapshot part');
      }
      return part;
    });
    return { snapshotId: value.snapshotId, parts };
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
