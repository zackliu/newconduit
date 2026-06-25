import type { AgentSpecRegistry } from '../registries/agent-spec-registry';
import type { CreateSessionRequest, RequestContext, RuntimeEvent, RuntimeStorage, SessionInputCommandPayload, SessionInputRequest, SessionRecord, TenantContext, TurnFailedPayload } from '../../shared';
import { AgentSpecAdmissionManager } from './agent-spec-admission-manager';
import { EventLogManager } from './event-log-manager';
import { SessionAssignmentManager, type WorkerCommandOutput } from './session-assignment-manager';
import { SessionLifecycleManager } from './session-lifecycle-manager';

export interface StartSessionOutcome {
  session: SessionRecord;
  sessionCreatedEvent: RuntimeEvent;
  workerCommand?: WorkerCommandOutput;
}

export interface AcceptInputOutcome {
  session: SessionRecord;
  inputAcceptedEvent: RuntimeEvent;
  workerCommand?: WorkerCommandOutput<SessionInputCommandPayload>;
  turnFailedEvent?: RuntimeEvent<TurnFailedPayload>;
}

export interface ListSessionsOutcome {
  responseEvent: RuntimeEvent<{ sessions: SessionRecord[] }>;
}

export interface ReadSessionEventsOutcome {
  responseEvent: RuntimeEvent<{ events: RuntimeEvent[] }>;
}

/**
 * Runs the tenant's session command workflow, turning app requests into durable session facts and worker-routable commands.
 */
export class SessionManager {
  constructor(
    private readonly tenant: TenantContext,
    private readonly storage: RuntimeStorage,
    private readonly agentSpecRegistry: AgentSpecRegistry,
    private readonly agentSpecAdmissionManager: AgentSpecAdmissionManager,
    private readonly sessionLifecycleManager: SessionLifecycleManager,
    private readonly eventLogManager: EventLogManager,
    private readonly sessionAssignmentManager: SessionAssignmentManager
  ) {}

  async startSession(context: RequestContext, ackId: string | undefined, request: CreateSessionRequest): Promise<StartSessionOutcome> {
    const agentSpec = await this.agentSpecRegistry.resolve(request.agent);
    const resolvedAgentSpec = this.agentSpecAdmissionManager.resolve(agentSpec);
    const session = await this.sessionLifecycleManager.create({
      tenantId: this.tenant.tenantId,
      owner: context.principal.principalId,
      resolvedAgentSpec,
      nextTurnSeq: 2,
      workspaceRef: `docker-volume:${crypto.randomUUID()}`
    });
    const event = await this.eventLogManager.append({
      type: 'session.created',
      actor: 'central',
      payload: {
        input: request.input,
        displayName: request.displayName,
        description: request.description,
        externalId: request.externalId,
        workspace: request.workspace,
        status: 'queued',
        requestedBy: context.principal.principalId
      },
      ackId,
      turnSeq: 1,
      sequence: 1,
      sessionId: session.sessionId
    });
    const queuedSession = await this.sessionLifecycleManager.transition({ ...session, eventCursor: event.sequence }, 'queued', 'waiting-for-worker');
    const assignment = await this.sessionAssignmentManager.assignReadyWorker(queuedSession);
    return {
      session: assignment.session,
      sessionCreatedEvent: event,
      workerCommand: assignment.workerCommand
    };
  }

  async acceptInput(context: RequestContext, sessionId: string, ackId: string | undefined, request: SessionInputRequest): Promise<AcceptInputOutcome> {
    const session = await this.storage.readSession(sessionId);
    if (!session) {
      throw new Error(`session ${sessionId} was not found for input.received`);
    }
    const allocation = await this.sessionLifecycleManager.allocateNextTurn(session);
    const event = await this.eventLogManager.append({
      type: 'input.accepted',
      actor: 'central',
      payload: {
        input: request.input,
        status: 'accepted',
        acceptedBy: context.principal.principalId
      },
      ackId,
      turnSeq: allocation.turnSeq,
      sequence: allocation.session.eventCursor + 1,
      sessionId
    });
    const nextSession = await this.sessionLifecycleManager.advanceEventCursor(allocation.session, event.sequence);
    if (!nextSession.currentWorkerId) {
      const failedEvent = await this.eventLogManager.append<TurnFailedPayload>({
        type: 'turn.failed',
        actor: 'central',
        payload: {
          error: {
            message: `session ${sessionId} has no current worker for input.received`,
            code: 'no_current_worker'
          }
        },
        turnSeq: allocation.turnSeq,
        sequence: nextSession.eventCursor + 1,
        sessionId
      });
      const failedSession = await this.sessionLifecycleManager.advanceEventCursor(nextSession, failedEvent.sequence);
      return {
        session: failedSession,
        inputAcceptedEvent: event,
        turnFailedEvent: failedEvent
      };
    }
    const workerCommand = {
      workerId: nextSession.currentWorkerId,
      event: {
        eventId: crypto.randomUUID(),
        sessionId,
        workerId: nextSession.currentWorkerId,
        turnSeq: allocation.turnSeq,
        sequence: event.sequence,
        type: 'session.input' as const,
        timestamp: event.timestamp,
        actor: 'central' as const,
        sessionLeaseId: nextSession.sessionLeaseId,
        payload: {
          sessionId,
          workerId: nextSession.currentWorkerId,
          sessionLeaseId: nextSession.sessionLeaseId!,
          turnSeq: allocation.turnSeq,
          input: request.input
        }
      }
    };
    return {
      session: nextSession,
      inputAcceptedEvent: event,
      workerCommand
    };
  }

  async listSessions(context: RequestContext, ackId: string | undefined): Promise<ListSessionsOutcome> {
    const sessions = await this.storage.readSessions();
    return {
      responseEvent: {
        eventId: crypto.randomUUID(),
        ackId,
        sequence: 0,
        type: 'session.listed',
        timestamp: new Date().toISOString(),
        actor: 'central',
        payload: {
          sessions: sessions
            .filter((session) => session.owner === context.principal.principalId)
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        }
      }
    };
  }

  async readSessionEvents(context: RequestContext, sessionId: string, ackId: string | undefined, afterSequence: number): Promise<ReadSessionEventsOutcome> {
    const session = await this.storage.readSession(sessionId);
    if (!session || session.owner !== context.principal.principalId) {
      throw new Error(`session ${sessionId} was not found`);
    }
    return {
      responseEvent: {
        eventId: crypto.randomUUID(),
        sessionId,
        ackId,
        sequence: 0,
        type: 'session.events.replayed',
        timestamp: new Date().toISOString(),
        actor: 'central',
        payload: {
          events: await this.storage.readEvents(sessionId, afterSequence)
        }
      }
    };
  }
}