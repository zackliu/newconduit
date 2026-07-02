import type { CreateSessionRequest, InteractionRespondRequestPayload, RequestContext, RuntimeEvent, RuntimeEventTransport, SessionInputRequest } from '../../shared';
import { SessionManager } from '../managers';

/**
 * Translates client-authored runtime events into durable session work, so application code talks to sessions instead of worker locations.
 */
export class ClientRuntimeEventController {
  constructor(private readonly sessionManager: SessionManager, private readonly eventTransport: RuntimeEventTransport) {}

  async handleRuntimeEvent(context: RequestContext, event: RuntimeEvent): Promise<boolean> {
    switch (event.type) {
      case 'session.create.requested': {
        const payload = this.parseCreateSessionRequestedPayload(event.payload);
        const outcome = await this.sessionManager.startSession(context, event.ackId, payload);
        await this.eventTransport.publish({ kind: 'session-events', sessionId: outcome.session.sessionId }, outcome.sessionCreatedEvent);
        await this.eventTransport.publish({ kind: 'client-private-inbox', clientConnectionId: this.requireClientConnectionId(context) }, this.toClientAckEvent(outcome.sessionCreatedEvent, 'session.created.ack', { status: outcome.session.status }));
        await this.eventTransport.publish({ kind: 'client-inbox' }, this.toClientProjectionEvent(outcome.sessionCreatedEvent, 'session.catalog.updated', { sessionId: outcome.session.sessionId, status: outcome.session.status }));
        if (outcome.workerCommand) {
          await this.eventTransport.publish({ kind: 'worker-commands', workerId: outcome.workerCommand.workerId }, outcome.workerCommand.event);
        }
        return true;
      }
      case 'input.received': {
        const sessionId = this.parseSessionCommandSessionId(event.sessionId, event.type);
        const payload = this.parseSessionInputPayload(event.payload);
        const outcome = await this.sessionManager.acceptInput(context, sessionId, event.ackId, payload);
        await this.eventTransport.publish({ kind: 'session-events', sessionId: outcome.session.sessionId }, outcome.inputAcceptedEvent);
        await this.eventTransport.publish({ kind: 'client-private-inbox', clientConnectionId: this.requireClientConnectionId(context) }, this.toClientAckEvent(outcome.inputAcceptedEvent, 'input.accepted.ack', { status: 'accepted' }));
        if (outcome.turnFailedEvent) {
          await this.eventTransport.publish({ kind: 'session-events', sessionId: outcome.session.sessionId }, outcome.turnFailedEvent);
        }
        if (outcome.workerCommand) {
          await this.eventTransport.publish({ kind: 'worker-commands', workerId: outcome.workerCommand.workerId }, outcome.workerCommand.event);
        }
        return true;
      }
      case 'session.list.requested': {
        const outcome = await this.sessionManager.listSessions(context, event.ackId);
        await this.eventTransport.publish({ kind: 'client-private-inbox', clientConnectionId: this.requireClientConnectionId(context) }, outcome.responseEvent);
        return true;
      }
      case 'session.events.requested': {
        const sessionId = this.parseSessionCommandSessionId(event.sessionId, event.type);
        const payload = this.parseSessionEventsRequestedPayload(event.payload);
        const outcome = await this.sessionManager.readSessionEvents(context, sessionId, event.ackId, payload.afterSequence);
        await this.eventTransport.publish({ kind: 'client-private-inbox', clientConnectionId: this.requireClientConnectionId(context) }, outcome.responseEvent);
        return true;
      }
      case 'session.pause.requested': {
        const sessionId = this.parseSessionCommandSessionId(event.sessionId, event.type);
        const outcome = await this.sessionManager.pauseSession(context, sessionId, event.ackId);
        await this.eventTransport.publish({ kind: 'session-events', sessionId: outcome.session.sessionId }, outcome.pauseRequestedEvent);
        await this.eventTransport.publish({ kind: 'client-inbox' }, this.toClientProjectionEvent(outcome.pauseRequestedEvent, 'session.status.updated', { sessionId: outcome.session.sessionId, status: outcome.session.status }));
        await this.eventTransport.publish({ kind: 'worker-commands', workerId: outcome.workerCommand.workerId }, outcome.workerCommand.event);
        return true;
      }
      case 'session.resume.requested': {
        const sessionId = this.parseSessionCommandSessionId(event.sessionId, event.type);
        const outcome = await this.sessionManager.resumeSession(context, sessionId, event.ackId);
        await this.eventTransport.publish({ kind: 'session-events', sessionId: outcome.session.sessionId }, outcome.resumeRequestedEvent);
        await this.eventTransport.publish({ kind: 'client-inbox' }, this.toClientProjectionEvent(outcome.resumeRequestedEvent, 'session.status.updated', { sessionId: outcome.session.sessionId, status: outcome.session.status }));
        for (const workerCommand of outcome.workerCommands) {
          await this.eventTransport.publish({ kind: 'worker-commands', workerId: workerCommand.workerId }, workerCommand.event);
        }
        return true;
      }
      case 'interaction.respond.requested': {
        const sessionId = this.parseSessionCommandSessionId(event.sessionId, event.type);
        const payload = this.parseInteractionRespondPayload(event.payload);
        const outcome = await this.sessionManager.respondInteraction(context, sessionId, event.ackId, payload);
        await this.eventTransport.publish({ kind: 'session-events', sessionId: outcome.session.sessionId }, outcome.interactionRespondedEvent);
        await this.eventTransport.publish({ kind: 'client-private-inbox', clientConnectionId: this.requireClientConnectionId(context) }, this.toClientAckEvent(outcome.interactionRespondedEvent, 'interaction.responded.ack', { interactionId: payload.interactionId, status: 'accepted' }));
        if (outcome.workerCommand) {
          await this.eventTransport.publish({ kind: 'worker-commands', workerId: outcome.workerCommand.workerId }, outcome.workerCommand.event);
        }
        return true;
      }
      default:
        return false;
    }
  }

  private parseCreateSessionRequestedPayload(payload: unknown): CreateSessionRequest {
    if (!this.isCreateSessionRequestedPayload(payload)) {
      throw new Error('invalid session.create.requested payload');
    }
    return payload;
  }

  private toClientAckEvent<TPayload>(event: RuntimeEvent, type: RuntimeEvent['type'], payload: TPayload): RuntimeEvent<TPayload> {
    return {
      ...event,
      type,
      payload
    };
  }

  private toClientProjectionEvent<TPayload>(event: RuntimeEvent, type: RuntimeEvent['type'], payload: TPayload): RuntimeEvent<TPayload> {
    return {
      ...event,
      ackId: undefined,
      turnSeq: undefined,
      type,
      payload
    };
  }

  private requireClientConnectionId(context: RequestContext): string {
    if (!context.connectionId) {
      throw new Error('client request context requires connectionId for private acknowledgement routing');
    }
    return context.connectionId;
  }

  private parseSessionCommandSessionId(sessionId: string | undefined, eventType: string): string {
    if (typeof sessionId !== 'string' || !sessionId) {
      throw new Error(`${eventType} requires sessionId in the runtime event envelope`);
    }
    return sessionId;
  }

  private parseSessionInputPayload(payload: unknown): SessionInputRequest {
    if (!this.isSessionInputPayload(payload)) {
      throw new Error('invalid input.received payload');
    }
    return payload;
  }

  private parseInteractionRespondPayload(payload: unknown): InteractionRespondRequestPayload {
    if (typeof payload !== 'object' || payload === null) {
      throw new Error('invalid interaction.respond.requested payload');
    }
    const candidate = payload as Partial<InteractionRespondRequestPayload>;
    if (typeof candidate.interactionId !== 'string' || !candidate.interactionId) {
      throw new Error('invalid interaction.respond.requested payload');
    }
    if (candidate.decision !== undefined && candidate.decision !== 'approved' && candidate.decision !== 'denied') {
      throw new Error('invalid interaction.respond.requested decision');
    }
    if (candidate.scope !== undefined && candidate.scope !== 'once' && candidate.scope !== 'session') {
      throw new Error('invalid interaction.respond.requested scope');
    }
    return {
      interactionId: candidate.interactionId,
      decision: candidate.decision,
      scope: candidate.scope,
      result: candidate.result
    };
  }

  private parseSessionEventsRequestedPayload(payload: unknown): { afterSequence: number } {
    if (typeof payload !== 'object' || payload === null) {
      throw new Error('invalid session.events.requested payload');
    }
    const candidate = payload as Partial<{ afterSequence: unknown }>;
    if (typeof candidate.afterSequence !== 'number' || !Number.isInteger(candidate.afterSequence) || candidate.afterSequence < 0) {
      throw new Error('invalid session.events.requested payload');
    }
    return { afterSequence: candidate.afterSequence };
  }

  private isCreateSessionRequestedPayload(payload: unknown): payload is CreateSessionRequest {
    if (typeof payload !== 'object' || payload === null) {
      return false;
    }
    const candidate = payload as Partial<CreateSessionRequest>;
    return typeof candidate.agent?.agentSpecId === 'string'
      && (candidate.input === undefined || typeof candidate.input.message === 'string')
      && candidate.workspace?.source === 'empty';
  }

  private isSessionInputPayload(payload: unknown): payload is SessionInputRequest {
    if (typeof payload !== 'object' || payload === null) {
      return false;
    }
    const candidate = payload as Partial<SessionInputRequest>;
    return typeof candidate.input?.message === 'string';
  }
}