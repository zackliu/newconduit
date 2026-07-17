import type { RuntimeEvent, SessionRecord } from '../../../shared';
import { EventLogManager } from './event-log-manager';
import { SessionAssignmentManager, type WorkerCommandOutput } from './session-assignment-manager';
import { SessionLifecycleManager } from './session-lifecycle-manager';

export interface StartSessionOutcome {
  session: SessionRecord;
  sessionCreatedEvent: RuntimeEvent;
  sessionCatalogUpdatedEvent: RuntimeEvent;
  workerCommand?: WorkerCommandOutput;
  needsReconcile: boolean;
}

export class SessionStartManager {
  constructor(
    private readonly sessionLifecycleManager: SessionLifecycleManager,
    private readonly eventLogManager: EventLogManager,
    private readonly sessionAssignmentManager: SessionAssignmentManager
  ) {}

  async startCreatedSession(input: {
    session: SessionRecord;
    eventId?: string;
    ackId?: string;
    payload: unknown;
  }): Promise<StartSessionOutcome> {
    if (input.session.status !== 'created') {
      throw new Error(`session ${input.session.sessionId} cannot start from ${input.session.status}`);
    }
    const turnSeq = input.session.nextTurnSeq;
    const event = await this.eventLogManager.append({
      eventId: input.eventId,
      type: 'session.created',
      actor: 'central',
      payload: input.payload,
      ackId: input.ackId,
      turnSeq,
      sequence: input.session.eventCursor + 1,
      sessionId: input.session.sessionId
    });
    const queued = await this.sessionLifecycleManager.acceptTurnAfterEvent(input.session, turnSeq, event.sequence, event.timestamp, 'queued', 'waiting-for-worker');
    const assignment = await this.sessionAssignmentManager.assignReadyWorker(queued);
    return {
      session: assignment.session,
      sessionCreatedEvent: event,
      sessionCatalogUpdatedEvent: {
        ...event,
        ackId: undefined,
        turnSeq: undefined,
        type: 'session.catalog.updated',
        payload: {
          sessionId: assignment.session.sessionId,
          status: assignment.session.status,
          ...(assignment.session.delegationBinding ? { parentSessionId: assignment.session.delegationBinding.parentSessionId } : {})
        }
      },
      workerCommand: assignment.workerCommand,
      needsReconcile: !assignment.workerCommand
    };
  }
}