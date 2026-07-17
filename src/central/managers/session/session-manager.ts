import type { AgentSpecRegistry } from '../../registries/agent-spec-registry';
import type { CreateSessionRequest, InteractionKind, InteractionRequestedPayload, InteractionRespondedPayload, InteractionRespondRequestPayload, RequestContext, RuntimeEvent, RuntimeStorage, SessionInputCommandPayload, SessionInputRequest, SessionInteractionResponseCommandPayload, SessionPauseCommandPayload, SessionPauseRequestedPayload, SessionRecord, SessionResumeRequestedPayload, TenantContext, TurnFailedPayload } from '../../../shared';
import { AgentSpecAdmissionManager } from '../admission/agent-spec-admission-manager';
import { EventLogManager } from './event-log-manager';
import type { WorkerCommandOutput } from './session-assignment-manager';
import { SessionLifecycleManager } from './session-lifecycle-manager';
import { SessionLifecycleReconciler } from './session-lifecycle-reconciler';
import { SessionStartManager, type StartSessionOutcome } from './session-start-manager';
import { SnapshotManager } from '../../persistence/snapshot-manager';

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

export interface PauseSessionOutcome {
  session: SessionRecord;
  pauseRequestedEvent: RuntimeEvent<SessionPauseRequestedPayload>;
  workerCommand: WorkerCommandOutput<SessionPauseCommandPayload>;
}

export interface RespondInteractionOutcome {
  session: SessionRecord;
  interactionRespondedEvent: RuntimeEvent<InteractionRespondedPayload>;
  routedInteractionRespondedEvent?: RuntimeEvent<InteractionRespondedPayload>;
  workerCommand?: WorkerCommandOutput<SessionInteractionResponseCommandPayload>;
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
    private readonly sessionStartManager: SessionStartManager,
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

  async pauseSession(context: RequestContext, sessionId: string, ackId: string | undefined): Promise<PauseSessionOutcome> {
    const session = await this.storage.readSession(sessionId);
    this.assertPublicSession(session, context, sessionId);
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
    const event = await this.eventLogManager.append<SessionPauseRequestedPayload>({
      type: 'session.pause.requested',
      actor: 'central',
      payload: { reason: 'parent_terminal' },
      sequence: session.eventCursor + 1,
      sessionId,
      workerId: session.currentWorkerId,
      sessionLeaseId: session.sessionLeaseId
    });
    const pausing = await this.sessionLifecycleManager.transitionAfterEvent(session, 'pausing', event.sequence, event.timestamp, 'parent_terminal');
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
            reason: 'parent_terminal',
            capture: this.snapshotManager.planCapture(session)
          }
        }
      }
    };
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

  async respondInteraction(context: RequestContext, sessionId: string, ackId: string | undefined, request: InteractionRespondRequestPayload): Promise<RespondInteractionOutcome> {
    const session = await this.storage.readSession(sessionId);
    this.assertPublicSession(session, context, sessionId);
    const open = (session.openInteractions ?? []).find((entry) => entry.interactionId === request.interactionId);
    if (!open) {
      throw new Error(`interaction ${request.interactionId} is not open for session ${sessionId}`);
    }
    const targetSession = open.delegatedRoute
      ? await this.requireDelegatedInteractionTarget(session, open.delegatedRoute.childSessionId, open.delegatedRoute.childInteractionId)
      : session;
    const targetInteractionId = open.delegatedRoute?.childInteractionId ?? open.interactionId;
    const targetOpen = (targetSession.openInteractions ?? []).find((entry) => entry.interactionId === targetInteractionId);
    if (!targetOpen) {
      throw new Error(`interaction ${targetInteractionId} is not open for session ${targetSession.sessionId}`);
    }
    if (open.delegatedRoute && (!targetSession.currentWorkerId || !targetSession.sessionLeaseId)) {
      throw new Error(`delegated Session ${targetSession.sessionId} has no current worker for interaction response`);
    }
    const response = this.buildInteractionResponse(targetOpen.kind, request);
    const event = await this.eventLogManager.append<InteractionRespondedPayload>({
      type: 'interaction.responded',
      actor: 'client',
      payload: { interactionId: open.interactionId, kind: open.kind, response },
      ackId,
      turnSeq: open.turnSeq,
      sequence: session.eventCursor + 1,
      sessionId,
      workerId: session.currentWorkerId,
      sessionLeaseId: session.sessionLeaseId
    });
    const advanced = await this.sessionLifecycleManager.advanceEventCursor(session, event.sequence);
    const removed = await this.sessionLifecycleManager.removeOpenInteraction(advanced, open.interactionId);
    let routedInteractionRespondedEvent: RuntimeEvent<InteractionRespondedPayload> | undefined;
    let routedTarget = targetSession;
    if (open.delegatedRoute) {
      routedInteractionRespondedEvent = await this.eventLogManager.append<InteractionRespondedPayload>({
        type: 'interaction.responded',
        actor: 'client',
        payload: { interactionId: targetOpen.interactionId, kind: targetOpen.kind, response },
        turnSeq: targetOpen.turnSeq,
        sequence: targetSession.eventCursor + 1,
        sessionId: targetSession.sessionId,
        workerId: targetSession.currentWorkerId,
        sessionLeaseId: targetSession.sessionLeaseId
      });
      const advancedTarget = await this.sessionLifecycleManager.advanceEventCursor(targetSession, routedInteractionRespondedEvent.sequence);
      routedTarget = await this.sessionLifecycleManager.removeOpenInteraction(advancedTarget, targetOpen.interactionId);
    }
    const workerCommand = routedTarget.currentWorkerId && routedTarget.sessionLeaseId
      ? {
          workerId: routedTarget.currentWorkerId,
          event: {
            eventId: crypto.randomUUID(),
            sessionId: routedTarget.sessionId,
            workerId: routedTarget.currentWorkerId,
            turnSeq: targetOpen.turnSeq,
            sequence: routedInteractionRespondedEvent?.sequence ?? event.sequence,
            type: 'session.interaction.response' as const,
            timestamp: routedInteractionRespondedEvent?.timestamp ?? event.timestamp,
            actor: 'central' as const,
            sessionLeaseId: routedTarget.sessionLeaseId,
            payload: {
              sessionId: routedTarget.sessionId,
              workerId: routedTarget.currentWorkerId,
              sessionLeaseId: routedTarget.sessionLeaseId,
              interactionId: targetOpen.interactionId,
              kind: targetOpen.kind,
              response
            }
          }
        }
      : undefined;
    return { session: removed, interactionRespondedEvent: event, routedInteractionRespondedEvent, workerCommand };
  }

  async projectDelegatedInteraction(input: {
    parentSessionId: string;
    childSessionId: string;
    callerTurnSeq: number;
    interaction: InteractionRequestedPayload;
    requestedAt: string;
  }): Promise<RuntimeEvent<InteractionRequestedPayload>> {
    const parent = await this.storage.readSession(input.parentSessionId);
    if (!parent) {
      throw new Error(`Parent Session ${input.parentSessionId} was not found`);
    }
    const child = await this.requireDelegatedInteractionTarget(parent, input.childSessionId, input.interaction.interactionId);
    const childOpen = (child.openInteractions ?? []).find((entry) => entry.interactionId === input.interaction.interactionId);
    if (!childOpen) {
      throw new Error(`interaction ${input.interaction.interactionId} is not open for delegated Session ${child.sessionId}`);
    }
    const event = await this.eventLogManager.append<InteractionRequestedPayload>({
      type: 'interaction.requested',
      actor: 'central',
      payload: input.interaction,
      turnSeq: input.callerTurnSeq,
      sequence: parent.eventCursor + 1,
      sessionId: parent.sessionId
    });
    const advanced = await this.sessionLifecycleManager.advanceEventCursor(parent, event.sequence);
    await this.sessionLifecycleManager.addOpenInteraction(advanced, {
      interactionId: input.interaction.interactionId,
      kind: input.interaction.kind,
      turnSeq: input.callerTurnSeq,
      requestedAt: input.requestedAt,
      delegatedRoute: {
        childSessionId: child.sessionId,
        childInteractionId: childOpen.interactionId
      }
    });
    return event;
  }

  private buildInteractionResponse(kind: InteractionKind, request: InteractionRespondRequestPayload): unknown {
    if (kind === 'approval') {
      const decision = request.decision === 'denied' ? 'denied' : 'approved';
      const scope = request.scope === 'session' ? 'session' : 'once';
      return { decision, scope };
    }
    return { result: request.result };
  }

  private assertPublicSession(session: SessionRecord | undefined, context: RequestContext, sessionId: string): asserts session is SessionRecord {
    if (!session || session.owner !== context.principal.principalId) {
      throw new Error(`session ${sessionId} was not found`);
    }
  }

  private async requireDelegatedSession(sessionId: string): Promise<SessionRecord> {
    const session = await this.storage.readSession(sessionId);
    if (!session?.delegationBinding) {
      throw new Error(`delegated Session ${sessionId} was not found`);
    }
    return session;
  }

  private async requireDelegatedInteractionTarget(parent: SessionRecord | undefined, childSessionId: string, interactionId: string): Promise<SessionRecord> {
    if (!parent) {
      throw new Error('Parent Session was not found');
    }
    const child = await this.storage.readSession(childSessionId);
    if (!child?.delegationBinding
      || child.delegationBinding.parentSessionId !== parent.sessionId
      || child.owner !== parent.owner) {
      throw new Error(`delegated interaction ${interactionId} does not belong to Parent Session ${parent.sessionId}`);
    }
    return child;
  }
}