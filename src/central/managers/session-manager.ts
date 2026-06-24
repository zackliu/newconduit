import type { AgentSpecRegistry } from '../registries/agent-spec-registry';
import type { CreateSessionRequest, RequestContext, RuntimeEvent, RuntimeStorage, SessionInputRequest, SessionRecord, TenantContext } from '../../shared';
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
}

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
    return {
      session: nextSession,
      inputAcceptedEvent: event
    };
  }
}