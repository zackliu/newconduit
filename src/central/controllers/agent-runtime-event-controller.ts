import type { AgentOutputPayload, InteractionRequestedPayload, RuntimeEvent, RuntimeEventTransport, RuntimeStorage, SessionPausedPayload, SessionRecord, SnapshotCreatedPayload, SnapshotPartName, StatusChangedPayload, TurnCompletedPayload, TurnFailedPayload, WorkerCommandRejectedPayload } from '../../shared';
import { EventLogManager, SessionLifecycleManager, SessionLeaseManager, SessionLifecycleReconciler, WorkerManager } from '../managers';
import { SnapshotManager } from '../persistence';

/**
 * Handles events that originate from a running agent on a leased worker, making sure they become central-owned session history before clients see them.
 */
export class AgentRuntimeEventController {
  constructor(
    private readonly storage: RuntimeStorage,
    private readonly eventLogManager: EventLogManager,
    private readonly sessionLifecycleManager: SessionLifecycleManager,
    private readonly sessionLeaseManager: SessionLeaseManager,
    private readonly workerManager: WorkerManager,
    private readonly sessionLifecycleReconciler: SessionLifecycleReconciler,
    private readonly snapshotManager: SnapshotManager,
    private readonly eventTransport: RuntimeEventTransport
  ) {}

  async handleRuntimeEvent(event: RuntimeEvent): Promise<boolean> {
    switch (event.type) {
      case 'status.changed': {
        const payload = this.parseStatusChangedPayload(event.payload);
        const appended = await this.appendSessionEvent(event, payload);
        const session = await this.requireSession(event);
        this.sessionLeaseManager.assertCurrent(session, this.requireSessionLeaseId(event));
        if (payload.status === 'running') {
          await this.sessionLifecycleManager.transition(session, 'running', payload.reason);
        } else if (payload.status === 'failed') {
          await this.sessionLifecycleManager.transition(session, 'failed', payload.reason);
        }
        await this.eventTransport.publish({ kind: 'client-inbox' }, {
          ...appended,
          ackId: undefined,
          type: 'session.status.updated',
          payload: {
            sessionId: appended.sessionId,
            status: payload.status,
            reason: payload.reason
          }
        });
        return true;
      }
      case 'agent.output': {
        const payload = this.parseAgentOutputPayload(event.payload);
        await this.appendSessionEvent(event, payload);
        return true;
      }
      case 'turn.completed': {
        const payload = this.parseTurnCompletedPayload(event.payload);
        await this.appendSessionEvent(event, payload);
        return true;
      }
      case 'turn.failed': {
        const payload = this.parseTurnFailedPayload(event.payload);
        await this.appendSessionEvent(event, payload);
        return true;
      }
      case 'worker.command.rejected': {
        const payload = this.parseWorkerCommandRejectedPayload(event.payload);
        await this.appendSessionEvent(event, payload, { assertCurrentLease: false });
        return true;
      }
      case 'interaction.requested': {
        const payload = this.parseInteractionRequestedPayload(event.payload);
        const appended = await this.appendSessionEvent(event, payload);
        const session = await this.requireSession(event);
        await this.sessionLifecycleManager.addOpenInteraction(session, {
          interactionId: payload.interactionId,
          kind: payload.kind,
          turnSeq: event.turnSeq ?? session.nextTurnSeq,
          requestedAt: appended.timestamp
        });
        return true;
      }
      case 'session.paused': {
        const payload = this.parseSessionPausedPayload(event.payload);
        const appended = await this.appendSessionEvent(event, { reason: payload.reason });
        const session = await this.requireSession(event);
        let finalSequence = appended.sequence;
        let finalTimestamp = appended.timestamp;
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
        const reconcileOutcome = await this.sessionLifecycleReconciler.reconcile();
        for (const workerCommand of reconcileOutcome.workerCommands) {
          await this.eventTransport.publish({ kind: 'worker-commands', workerId: workerCommand.workerId }, workerCommand.event);
        }
        await this.eventTransport.publish({ kind: 'client-inbox' }, {
          ...appended,
          ackId: undefined,
          type: 'session.status.updated',
          payload: {
            sessionId: appended.sessionId,
            status: 'paused',
            reason: payload.reason
          }
        });
        return true;
      }
      default:
        return false;
    }
  }

  private async appendSessionEvent<TPayload>(event: RuntimeEvent, payload: TPayload, options: { assertCurrentLease?: boolean } = {}): Promise<RuntimeEvent<TPayload>> {
    const session = await this.requireSession(event);
    if (options.assertCurrentLease !== false) {
      this.sessionLeaseManager.assertCurrent(session, this.requireSessionLeaseId(event));
    }
    const appended = await this.eventLogManager.append({
      type: event.type,
      actor: event.actor,
      payload,
      sequence: session.eventCursor + 1,
      sessionId: session.sessionId,
      workerId: event.workerId,
      turnSeq: event.turnSeq,
      sessionLeaseId: event.sessionLeaseId
    });
    await this.sessionLifecycleManager.advanceEventCursor(session, appended.sequence);
    await this.eventTransport.publish({ kind: 'session-events', sessionId: session.sessionId }, appended);
    return appended;
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

  private parseInteractionRequestedPayload(payload: unknown): InteractionRequestedPayload {
    if (!this.isRecord(payload) || typeof payload.interactionId !== 'string') {
      throw new Error('invalid interaction.requested payload');
    }
    if (payload.kind !== 'approval' && payload.kind !== 'tool_call') {
      throw new Error('invalid interaction.requested kind');
    }
    return {
      interactionId: payload.interactionId,
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
    if (payload.reason !== undefined && payload.reason !== 'idle_timeout' && payload.reason !== 'client_requested') {
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
