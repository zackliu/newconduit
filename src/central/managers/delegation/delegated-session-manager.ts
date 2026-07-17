import type { DelegationCallRecord, DelegationRecord, RuntimeEvent, RuntimeStorage, SessionInputCommandPayload, SessionRecord } from '../../../shared';
import type { EventLogManager } from '../session/event-log-manager';
import type { WorkerCommandOutput } from '../session/session-assignment-manager';
import type { SessionLifecycleManager } from '../session/session-lifecycle-manager';
import type { SessionStartManager } from '../session/session-start-manager';

export interface PreparedDelegatedCall {
  session: SessionRecord;
  workerCommands: WorkerCommandOutput[];
  sessionCreatedEvent?: RuntimeEvent;
  sessionCatalogUpdatedEvent?: RuntimeEvent;
  needsReconcile: boolean;
}

export class DelegatedSessionManager {
  constructor(
    private readonly storage: RuntimeStorage,
    private readonly eventLogManager: EventLogManager,
    private readonly sessionLifecycleManager: SessionLifecycleManager,
    private readonly sessionStartManager: SessionStartManager
  ) {}

  async prepareCall(delegation: DelegationRecord, call: DelegationCallRecord): Promise<PreparedDelegatedCall> {
    if (!call.dispatch) {
      throw new Error(`DelegationCall ${call.delegationCallId} has no dispatch binding`);
    }
    let session = await this.requireChildSession(delegation);
    const existingInputEvent = (await this.storage.readEvents(session.sessionId, 0)).find((event) => event.eventId === call.dispatch!.inputEventId);
    let assignmentCommand: WorkerCommandOutput | undefined;
    let sessionCreatedEvent: RuntimeEvent | undefined;
    let sessionCatalogUpdatedEvent: RuntimeEvent | undefined;
    let needsReconcile = false;

    if (!existingInputEvent) {
      const firstTurn = session.status === 'created';
      if (!firstTurn && session.status !== 'running') {
        throw new Error(`delegated Session ${session.sessionId} is ${session.status}; cannot dispatch Call ${call.delegationCallId}`);
      }
      if (firstTurn) {
        const started = await this.sessionStartManager.startCreatedSession({
          session,
          eventId: call.dispatch.inputEventId,
          payload: {
            input: this.agentInput(delegation, call),
            status: 'accepted',
            delegationCallId: call.delegationCallId
          }
        });
        session = started.session;
        assignmentCommand = started.workerCommand;
        sessionCreatedEvent = started.sessionCreatedEvent;
        sessionCatalogUpdatedEvent = started.sessionCatalogUpdatedEvent;
        needsReconcile = started.needsReconcile;
      } else {
        const event = await this.eventLogManager.append({
          eventId: call.dispatch.inputEventId,
          type: 'input.accepted',
          actor: 'central',
          payload: {
            input: this.agentInput(delegation, call),
            status: 'accepted',
            delegationCallId: call.delegationCallId
          },
          turnSeq: call.dispatch.childTurnSeq,
          sequence: session.eventCursor + 1,
          sessionId: session.sessionId
        });
        session = await this.sessionLifecycleManager.acceptTurnAfterEvent(session, call.dispatch.childTurnSeq, event.sequence, event.timestamp, 'running');
      }
    } else {
      session = await this.requireChildSession(delegation);
    }

    const inputCommand = this.inputCommand(delegation, call, session, existingInputEvent?.sequence ?? session.eventCursor);
    return {
      session,
      workerCommands: [assignmentCommand, inputCommand].filter((command): command is WorkerCommandOutput => command !== undefined),
      sessionCreatedEvent,
      sessionCatalogUpdatedEvent,
      needsReconcile
    };
  }

  private async requireChildSession(delegation: DelegationRecord): Promise<SessionRecord> {
    const session = await this.storage.readSession(delegation.childSessionId);
    if (!session || session.delegationBinding?.delegationId !== delegation.delegationId) {
      throw new Error(`delegated Child Session ${delegation.childSessionId} was not found for Delegation ${delegation.delegationId}`);
    }
    return session;
  }

  private agentInput(_delegation: DelegationRecord, call: DelegationCallRecord): SessionInputCommandPayload['input'] {
    return { message: call.input };
  }

  private inputCommand(delegation: DelegationRecord, call: DelegationCallRecord, session: SessionRecord, sequence: number): WorkerCommandOutput<SessionInputCommandPayload> | undefined {
    if (!session.currentWorkerId || !session.sessionLeaseId) {
      return undefined;
    }
    return {
      workerId: session.currentWorkerId,
      event: {
        eventId: call.dispatch!.commandEventId,
        sessionId: session.sessionId,
        workerId: session.currentWorkerId,
        turnSeq: call.dispatch!.childTurnSeq,
        sequence,
        type: 'session.input',
        timestamp: call.updatedAt,
        actor: 'central',
        sessionLeaseId: session.sessionLeaseId,
        payload: {
          sessionId: session.sessionId,
          workerId: session.currentWorkerId,
          sessionLeaseId: session.sessionLeaseId,
          turnSeq: call.dispatch!.childTurnSeq,
          input: this.agentInput(delegation, call)
        }
      }
    };
  }
}