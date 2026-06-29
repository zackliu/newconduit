import type { AgentSpecRegistry } from '../../registries/agent-spec-registry';
import type { CreateSessionRequest, RequestContext, RuntimeEvent, RuntimeStorage, SessionInputCommandPayload, SessionInputRequest, SessionPauseCommandPayload, SessionPauseRequestedPayload, SessionRecord, SessionResumeRequestedPayload, TenantContext, TurnFailedPayload } from '../../../shared';
import { AgentSpecAdmissionManager } from '../admission/agent-spec-admission-manager';
import { EventLogManager } from './event-log-manager';
import { SessionAssignmentManager, type WorkerCommandOutput } from './session-assignment-manager';
import { SessionLifecycleManager } from './session-lifecycle-manager';
import { SessionLifecycleReconciler } from './session-lifecycle-reconciler';
import { SnapshotManager } from '../../persistence/snapshot-manager';

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

export interface ResumeSessionOutcome {
  session: SessionRecord;
  resumeRequestedEvent: RuntimeEvent<SessionResumeRequestedPayload>;
  workerCommands: WorkerCommandOutput[];
}

export interface PauseSessionOutcome {
  session: SessionRecord;
  pauseRequestedEvent: RuntimeEvent<SessionPauseRequestedPayload>;
  workerCommand: WorkerCommandOutput<SessionPauseCommandPayload>;
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
    private readonly sessionAssignmentManager: SessionAssignmentManager,
    private readonly snapshotManager: SnapshotManager,
    private readonly sessionLifecycleReconciler?: SessionLifecycleReconciler
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
    const queuedSession = await this.sessionLifecycleManager.transitionAfterEvent(session, 'queued', event.sequence, event.timestamp, 'waiting-for-worker');
    const assignment = await this.sessionAssignmentManager.assignReadyWorker(queuedSession);
    if (!assignment.workerCommand) {
      void this.sessionLifecycleReconciler?.reconcile().catch((error: unknown) => {
        console.error('session lifecycle reconcile after create failed', error);
      });
    }
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

  async pauseSession(context: RequestContext, sessionId: string, ackId: string | undefined): Promise<PauseSessionOutcome> {
    const session = await this.storage.readSession(sessionId);
    if (!session || session.owner !== context.principal.principalId) {
      throw new Error(`session ${sessionId} was not found`);
    }
    if (session.status !== 'running') {
      throw new Error(`session ${sessionId} is not running`);
    }
    if (!session.currentWorkerId || !session.sessionLeaseId) {
      throw new Error(`session ${sessionId} has no current worker lease`);
    }
    const event = await this.eventLogManager.append<SessionPauseRequestedPayload>({
      type: 'session.pause.requested',
      actor: 'client',
      payload: { reason: 'client_requested' },
      ackId,
      sequence: session.eventCursor + 1,
      sessionId,
      workerId: session.currentWorkerId,
      sessionLeaseId: session.sessionLeaseId
    });
    const pausing = await this.sessionLifecycleManager.transitionAfterEvent(session, 'pausing', event.sequence, event.timestamp, 'client_requested');
    return {
      session: pausing,
      pauseRequestedEvent: event,
      workerCommand: {
        workerId: session.currentWorkerId,
        event: {
          eventId: crypto.randomUUID(),
          sessionId,
          workerId: session.currentWorkerId,
          sequence: event.sequence,
          type: 'session.pause.requested',
          timestamp: event.timestamp,
          actor: 'central',
          sessionLeaseId: session.sessionLeaseId,
          payload: {
            sessionId,
            workerId: session.currentWorkerId,
            sessionLeaseId: session.sessionLeaseId,
            reason: 'client_requested',
            capture: this.snapshotManager.planCapture(session)
          }
        }
      }
    };
  }

  async resumeSession(context: RequestContext, sessionId: string, ackId: string | undefined): Promise<ResumeSessionOutcome> {
    const session = await this.storage.readSession(sessionId);
    if (!session || session.owner !== context.principal.principalId) {
      throw new Error(`session ${sessionId} was not found`);
    }
    if (session.status !== 'paused') {
      throw new Error(`session ${sessionId} is not paused`);
    }
    const event = await this.eventLogManager.append<SessionResumeRequestedPayload>({
      type: 'session.resume.requested',
      actor: 'client',
      payload: { reason: 'client_requested' },
      ackId,
      sequence: session.eventCursor + 1,
      sessionId
    });
    const queued = await this.sessionLifecycleManager.transitionAfterEvent(session, 'queued', event.sequence, event.timestamp, 'resume_requested');
    const reconcileOutcome = await this.sessionLifecycleReconciler?.reconcile();
    const current = await this.storage.readSession(sessionId) ?? queued;
    return {
      session: current,
      resumeRequestedEvent: event,
      workerCommands: reconcileOutcome?.workerCommands.filter((command): command is WorkerCommandOutput => command.event.type === 'session.assign') ?? []
    };
  }
}