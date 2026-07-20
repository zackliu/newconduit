import type { RuntimeEvent, RuntimeStorage, SessionPauseCommandPayload, SessionPauseRequestedPayload, SessionRecord } from '../../../shared';
import { SnapshotManager } from '../../persistence/snapshot-manager';
import { EventLogManager } from './event-log-manager';
import type { WorkerCommandOutput } from './session-assignment-manager';
import { SessionLifecycleManager } from './session-lifecycle-manager';

export type SessionPauseReason = NonNullable<SessionPauseRequestedPayload['reason']>;

export interface PauseSessionOutcome {
  session: SessionRecord;
  pauseRequestedEvent: RuntimeEvent<SessionPauseRequestedPayload>;
  workerCommand: WorkerCommandOutput<SessionPauseCommandPayload>;
}

/** Owns the durable pause intent and the worker command derived from it. */
export class SessionPauseManager {
  constructor(
    private readonly storage: RuntimeStorage,
    private readonly sessionLifecycleManager: SessionLifecycleManager,
    private readonly eventLogManager: EventLogManager,
    private readonly snapshotManager: SnapshotManager
  ) {}

  async request(
    session: SessionRecord,
    actor: RuntimeEvent['actor'],
    reason: SessionPauseReason,
    ackId?: string
  ): Promise<PauseSessionOutcome> {
    this.assertWorkerLease(session);
    const eventId = crypto.randomUUID();
    const event = await this.eventLogManager.append<SessionPauseRequestedPayload>({
      eventId,
      type: 'session.pause.requested',
      actor,
      payload: { reason },
      ackId,
      sequence: session.eventCursor + 1,
      sessionId: session.sessionId,
      workerId: session.currentWorkerId,
      sessionLeaseId: session.sessionLeaseId
    });
    const pausing = await this.sessionLifecycleManager.transitionAfterEvent(session, 'pausing', event.sequence, event.timestamp, reason);
    return {
      session: pausing,
      pauseRequestedEvent: event,
      workerCommand: this.toWorkerCommand(pausing, event)
    };
  }

  async recover(session: SessionRecord): Promise<WorkerCommandOutput<SessionPauseCommandPayload> | undefined> {
    this.assertWorkerLease(session);
    const events = await this.storage.readEvents(session.sessionId, Math.max(0, session.eventCursor - 1));
    const event = events.find((candidate): candidate is RuntimeEvent<SessionPauseRequestedPayload> =>
      candidate.type === 'session.pause.requested'
      && candidate.sequence === session.eventCursor
      && candidate.workerId === session.currentWorkerId
      && candidate.sessionLeaseId === session.sessionLeaseId);
    return event ? this.toWorkerCommand(session, event) : undefined;
  }

  private toWorkerCommand(session: SessionRecord, event: RuntimeEvent<SessionPauseRequestedPayload>): WorkerCommandOutput<SessionPauseCommandPayload> {
    this.assertWorkerLease(session);
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
          reason: event.payload.reason,
          capture: this.snapshotManager.planCapture(session, event.eventId)
        }
      }
    };
  }

  private assertWorkerLease(session: SessionRecord): asserts session is SessionRecord & { currentWorkerId: string; sessionLeaseId: string } {
    if (!session.currentWorkerId || !session.sessionLeaseId) {
      throw new Error(`session ${session.sessionId} has no current worker lease`);
    }
  }
}