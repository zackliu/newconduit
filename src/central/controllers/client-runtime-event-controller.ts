import type { CreateSessionRequest, RequestContext, RuntimeEvent, RuntimeEventTransport, SessionInputRequest } from '../../shared';
import { SessionManager } from '../managers';

export class ClientRuntimeEventController {
  constructor(private readonly sessionManager: SessionManager, private readonly eventTransport: RuntimeEventTransport) {}

  async handleRuntimeEvent(context: RequestContext, event: RuntimeEvent): Promise<boolean> {
    switch (event.type) {
      case 'session.create.requested': {
        const payload = this.parseCreateSessionRequestedPayload(event.payload);
        const outcome = await this.sessionManager.startSession(context, event.ackId, payload);
        await this.eventTransport.publish({ kind: 'session-events', sessionId: outcome.session.sessionId }, outcome.sessionCreatedEvent);
        await this.eventTransport.publish({ kind: 'client-inbox', principalId: context.principal.principalId }, outcome.sessionCreatedEvent);
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
        await this.eventTransport.publish({ kind: 'client-inbox', principalId: context.principal.principalId }, outcome.inputAcceptedEvent);
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

  private isCreateSessionRequestedPayload(payload: unknown): payload is CreateSessionRequest {
    if (typeof payload !== 'object' || payload === null) {
      return false;
    }
    const candidate = payload as Partial<CreateSessionRequest>;
    return typeof candidate.agent?.agentSpecId === 'string'
      && typeof candidate.input?.message === 'string'
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