import type { Clock, RuntimeEvent, RuntimeEventTransport, RuntimeStorage, SessionPauseCommandPayload, SessionPausedPayload, SessionPauseRequestedPayload, SessionRecord } from '../../shared';
import { EventLogManager } from './event-log-manager';
import { SessionAssignmentManager, type WorkerCommandOutput } from './session-assignment-manager';
import { SessionLifecycleManager } from './session-lifecycle-manager';

export interface SessionLifecycleReconcileOutcome {
  workerCommands: Array<WorkerCommandOutput<SessionPauseCommandPayload> | WorkerCommandOutput>;
}

/**
 * Reconciles durable session lifecycle facts that are independent from any client connection.
 */
export class SessionLifecycleReconciler {
  constructor(
    private readonly storage: RuntimeStorage,
    private readonly clock: Clock,
    private readonly sessionLifecycleManager: SessionLifecycleManager,
    private readonly eventLogManager: EventLogManager,
    private readonly sessionAssignmentManager: SessionAssignmentManager,
    private readonly eventTransport: RuntimeEventTransport
  ) {}

  async reconcile(): Promise<SessionLifecycleReconcileOutcome> {
    const workerCommands: SessionLifecycleReconcileOutcome['workerCommands'] = [];
    const sessions = await this.storage.readSessions();
    for (const session of sessions) {
      if (session.status === 'queued') {
        const command = await this.reconcileQueuedSession(session);
        if (command) {
          workerCommands.push(command);
        }
        continue;
      }
      if (session.status === 'running' && this.isIdle(session)) {
        const command = await this.requestIdlePause(session);
        if (command) {
          workerCommands.push(command);
        }
      }
    }
    return { workerCommands };
  }

  private async reconcileQueuedSession(session: SessionRecord): Promise<WorkerCommandOutput | undefined> {
    if (this.isIdle(session)) {
      await this.pauseQueuedSession(session);
      return undefined;
    }
    const assignment = await this.sessionAssignmentManager.assignReadyWorker(session);
    if (!assignment.workerCommand) {
      return undefined;
    }
    await this.publishSessionStatus(assignment.session, 'starting');
    return assignment.workerCommand;
  }

  private async pauseQueuedSession(session: SessionRecord): Promise<void> {
    const event = await this.eventLogManager.append<SessionPausedPayload>({
      type: 'session.paused',
      actor: 'central',
      payload: { reason: 'idle_timeout' },
      sequence: session.eventCursor + 1,
      sessionId: session.sessionId
    });
    const paused = await this.sessionLifecycleManager.pauseAfterEvent(session, event.sequence, event.timestamp, 'idle_timeout');
    await this.eventTransport.publish({ kind: 'session-events', sessionId: session.sessionId }, event);
    await this.publishSessionStatus(paused, 'paused', 'idle_timeout');
  }

  private async requestIdlePause(session: SessionRecord): Promise<WorkerCommandOutput<SessionPauseCommandPayload> | undefined> {
    if (!session.currentWorkerId || !session.sessionLeaseId) {
      return undefined;
    }
    const event = await this.eventLogManager.append<SessionPauseRequestedPayload>({
      type: 'session.pause.requested',
      actor: 'central',
      payload: { reason: 'idle_timeout' },
      sequence: session.eventCursor + 1,
      sessionId: session.sessionId,
      workerId: session.currentWorkerId,
      sessionLeaseId: session.sessionLeaseId
    });
    const pausing = await this.sessionLifecycleManager.transitionAfterEvent(session, 'pausing', event.sequence, event.timestamp, 'idle_timeout');
    await this.eventTransport.publish({ kind: 'session-events', sessionId: session.sessionId }, event);
    await this.publishSessionStatus(pausing, 'pausing', 'idle_timeout');
    return {
      workerId: session.currentWorkerId,
      event: {
        eventId: crypto.randomUUID(),
        sessionId: session.sessionId,
        workerId: session.currentWorkerId,
        sequence: event.sequence,
        type: 'session.pause.requested',
        timestamp: event.timestamp,
        actor: 'central',
        sessionLeaseId: session.sessionLeaseId,
        payload: {
          sessionId: session.sessionId,
          workerId: session.currentWorkerId,
          sessionLeaseId: session.sessionLeaseId,
          reason: 'idle_timeout'
        }
      }
    };
  }

  private isIdle(session: SessionRecord): boolean {
    return Date.parse(this.clock.now()) - Date.parse(session.lastEventUpdatedAt) >= session.resolvedAgentSpec.idlePauseTimeoutMs;
  }

  private async publishSessionStatus(session: SessionRecord, status: SessionRecord['status'], reason?: string): Promise<void> {
    await this.eventTransport.publish({ kind: 'client-inbox' }, {
      eventId: crypto.randomUUID(),
      sessionId: session.sessionId,
      sequence: 0,
      type: 'session.status.updated',
      timestamp: this.clock.now(),
      actor: 'central',
      payload: {
        sessionId: session.sessionId,
        status,
        reason
      }
    } satisfies RuntimeEvent);
  }
}