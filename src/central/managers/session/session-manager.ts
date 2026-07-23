import type { AgentSpecRegistry } from '../../registries/agent-spec-registry';
import type { CreateSessionRequest, RequestContext, RuntimeEvent, RuntimeStorage, SessionInputCommandPayload, SessionInputRequest, SessionRecord, SessionResumeRequestedPayload, TenantContext, TurnFailedPayload } from '../../../shared';
import { AgentSpecAdmissionManager } from '../admission/agent-spec-admission-manager';
import { EventLogManager } from './event-log-manager';
import type { WorkerCommandOutput } from './session-assignment-manager';
import { SessionLifecycleManager } from './session-lifecycle-manager';
import { SessionLifecycleReconciler } from './session-lifecycle-reconciler';
import { SessionStartManager, type StartSessionOutcome } from './session-start-manager';
import { SessionPauseManager, type PauseSessionOutcome } from './session-pause-manager';

export type { PauseSessionOutcome } from './session-pause-manager';

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
}

/**
 * Runs the tenant's session command workflow, turning app requests into durable session facts and worker-routable commands.
 */
export class SessionManager {
  private readonly inputSequences = new Map<string, Promise<void>>();

  constructor(
    private readonly tenant: TenantContext,
    private readonly storage: RuntimeStorage,
    private readonly agentSpecRegistry: AgentSpecRegistry,
    private readonly agentSpecAdmissionManager: AgentSpecAdmissionManager,
    private readonly sessionLifecycleManager: SessionLifecycleManager,
    private readonly eventLogManager: EventLogManager,
    private readonly sessionStartManager: SessionStartManager,
    private readonly sessionPauseManager: SessionPauseManager,
    private readonly sessionLifecycleReconciler?: SessionLifecycleReconciler
  ) {}

  async startSession(context: RequestContext, ackId: string | undefined, request: CreateSessionRequest): Promise<StartSessionOutcome> {
    const agentSpec = await this.agentSpecRegistry.resolve(request.agent);
    const resolvedAgentSpec = this.agentSpecAdmissionManager.resolve(agentSpec);
    const session = await this.sessionLifecycleManager.create({
      tenantId: this.tenant.tenantId,
      owner: context.principal.principalId,
      resolvedAgentSpec,
      workspaceRef: crypto.randomUUID()
    });
    return this.sessionStartManager.startCreatedSession({
      session,
      ackId,
      payload: {
        input: request.input,
        displayName: request.displayName,
        description: request.description,
        externalId: request.externalId,
        workspace: request.workspace,
        status: 'queued',
        requestedBy: context.principal.principalId
      }
    });
  }

  reconcileStartedSession(needsReconcile: boolean): void {
    if (needsReconcile) {
      void this.sessionLifecycleReconciler?.reconcile().catch((error: unknown) => {
        console.error('session lifecycle reconcile after create failed', error);
      });
    }
  }

  async acceptInput(context: RequestContext, sessionId: string, ackId: string | undefined, request: SessionInputRequest): Promise<AcceptInputOutcome> {
    return this.serializeInput(sessionId, async () => {
      const session = await this.storage.readSession(sessionId);
      this.assertPublicSession(session, context, sessionId);
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
    });
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
            .map((session) => ({
              ...session,
              ...(session.delegationBinding ? { parentSessionId: session.delegationBinding.parentSessionId } : {})
            }))
        }
      }
    };
  }

  async readSessionEvents(context: RequestContext, sessionId: string, ackId: string | undefined, afterSequence: number): Promise<ReadSessionEventsOutcome> {
    const session = await this.storage.readSession(sessionId);
    this.assertPublicSession(session, context, sessionId);
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

  async pauseSession(context: RequestContext, sessionId: string, ackId: string | undefined): Promise<PauseSessionOutcome | undefined> {
    const session = await this.storage.readSession(sessionId);
    this.assertPublicSession(session, context, sessionId);
    if (session.status !== 'running') {
      throw new Error(`session ${sessionId} is not running`);
    }
    const hasOpenInteraction = (await this.storage.readInteractionsBySession(sessionId)).some((interaction) => interaction.state === 'open');
    if (hasOpenInteraction) {
      return undefined;
    }
    return this.sessionPauseManager.request(session, 'client', 'client_requested', ackId);
  }

  async resumeSession(context: RequestContext, sessionId: string, ackId: string | undefined): Promise<ResumeSessionOutcome> {
    const session = await this.storage.readSession(sessionId);
    this.assertPublicSession(session, context, sessionId);
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
    await this.sessionLifecycleReconciler?.reconcile();
    const current = await this.storage.readSession(sessionId) ?? queued;
    return {
      session: current,
      resumeRequestedEvent: event
    };
  }

  async pauseDelegatedSession(sessionId: string): Promise<PauseSessionOutcome | undefined> {
    const session = await this.requireDelegatedSession(sessionId);
    if (session.status === 'paused' || session.status === 'pausing') {
      return undefined;
    }
    if (session.status !== 'running' || !session.currentWorkerId || !session.sessionLeaseId) {
      throw new Error(`delegated Session ${sessionId} cannot pause from ${session.status}`);
    }
    return this.sessionPauseManager.request(session, 'central', 'parent_terminal');
  }

  async resumeDelegatedSession(sessionId: string): Promise<ResumeSessionOutcome | undefined> {
    const session = await this.requireDelegatedSession(sessionId);
    if (session.status === 'queued' || session.status === 'starting' || session.status === 'running' || session.status === 'resuming') {
      return undefined;
    }
    if (session.status !== 'paused') {
      throw new Error(`delegated Session ${sessionId} cannot resume from ${session.status}`);
    }
    const event = await this.eventLogManager.append<SessionResumeRequestedPayload>({
      type: 'session.resume.requested',
      actor: 'central',
      payload: { reason: 'delegation_call' },
      sequence: session.eventCursor + 1,
      sessionId
    });
    const queued = await this.sessionLifecycleManager.transitionAfterEvent(session, 'queued', event.sequence, event.timestamp, 'delegation_call');
    await this.sessionLifecycleReconciler?.reconcile();
    return {
      session: await this.storage.readSession(sessionId) ?? queued,
      resumeRequestedEvent: event
    };
  }

  private assertPublicSession(session: SessionRecord | undefined, context: RequestContext, sessionId: string): asserts session is SessionRecord {
    if (!session || session.owner !== context.principal.principalId) {
      throw new Error(`session ${sessionId} was not found`);
    }
  }

  private serializeInput<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.inputSequences.get(sessionId) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.inputSequences.set(sessionId, tail);
    void tail.finally(() => {
      if (this.inputSequences.get(sessionId) === tail) {
        this.inputSequences.delete(sessionId);
      }
    });
    return result;
  }

  private async requireDelegatedSession(sessionId: string): Promise<SessionRecord> {
    const session = await this.storage.readSession(sessionId);
    if (!session?.delegationBinding) {
      throw new Error(`delegated Session ${sessionId} was not found`);
    }
    return session;
  }

}