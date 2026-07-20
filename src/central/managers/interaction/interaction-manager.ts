import type {
  AgentInteractionRequestedPayload,
  Clock,
  InteractionInterruptedPayload,
  InteractionRecord,
  InteractionRespondedPayload,
  InteractionRespondRequestPayload,
  InteractionRequestedPayload,
  InteractionView,
  RequestContext,
  RuntimeEvent,
  RuntimeEventTransport,
  RuntimeStorage,
  SessionInteractionResponseCommandPayload,
  SessionRecord
} from '../../../shared';
import { EventLogManager } from '../session/event-log-manager';
import { SessionLifecycleManager } from '../session/session-lifecycle-manager';
import { SessionLeaseManager } from '../worker/worker-lease-manager';

export interface ResolveInteractionResult {
  interactionId: string;
  status: 'resolved' | 'already_resolved';
}

export class InteractionManager {
  private readonly reconcileTails = new Map<string, Promise<void>>();
  private readonly sessionProjectionTails = new Map<string, Promise<void>>();

  constructor(
    private readonly tenantId: string,
    private readonly storage: RuntimeStorage,
    private readonly clock: Clock,
    private readonly eventLogManager: EventLogManager,
    private readonly sessionLifecycleManager: SessionLifecycleManager,
    private readonly sessionLeaseManager: SessionLeaseManager,
    private readonly eventTransport: RuntimeEventTransport
  ) {}

  async admitAgentRequest(event: RuntimeEvent, payload: AgentInteractionRequestedPayload): Promise<InteractionRecord> {
    const owner = await this.requireEventSession(event);
    this.sessionLeaseManager.assertCurrent(owner, this.requireLeaseId(event));
    const ownerTurnSeq = this.requireTurnSeq(event);
    const now = this.clock.now();
    const candidate: InteractionRecord = {
      interactionId: crypto.randomUUID(),
      tenantId: this.tenantId,
      kind: payload.kind,
      request: payload.request,
      ownerSessionId: owner.sessionId,
      ownerTurnSeq,
      adapterRequestId: payload.adapterRequestId,
      requestLeaseId: owner.sessionLeaseId!,
      views: await this.buildViews(owner, ownerTurnSeq),
      state: 'open',
      delivery: { state: 'not_ready' },
      revision: 1,
      createdAt: now,
      updatedAt: now
    };
    const created = await this.storage.createInteraction(candidate);
    this.assertDuplicateAdmission(created.interaction, candidate);
    await this.tryReconcile(created.interaction.interactionId);
    return await this.storage.readInteraction(created.interaction.interactionId) ?? created.interaction;
  }

  async resolve(context: RequestContext, addressedSessionId: string, request: InteractionRespondRequestPayload): Promise<ResolveInteractionResult> {
    for (;;) {
      const current = await this.storage.readInteraction(request.interactionId);
      if (!current || current.tenantId !== this.tenantId) {
        throw new Error(`interaction ${request.interactionId} was not found`);
      }
      await this.authorizeResponse(current, addressedSessionId, context);
      if (current.state === 'resolved') {
        return { interactionId: current.interactionId, status: 'already_resolved' };
      }
      if (current.state === 'interrupted') {
        throw new Error(`interaction ${current.interactionId} is interrupted`);
      }
      const now = this.clock.now();
      const next: InteractionRecord = {
        ...current,
        state: 'resolved',
        resolution: {
          response: this.buildResponse(current, request),
          principalId: context.principal.principalId,
          viaSessionId: addressedSessionId,
          resolvedAt: now
        },
        delivery: { state: 'pending', commandEventId: crypto.randomUUID() },
        views: current.views.map((view) => ({
          ...view,
          respondedEventId: view.respondedEventId ?? crypto.randomUUID(),
          respondedProjected: false
        })),
        revision: current.revision + 1,
        updatedAt: now
      };
      if (!await this.storage.compareAndSetInteraction(current.revision, next)) {
        continue;
      }
      await this.tryReconcile(next.interactionId);
      return { interactionId: next.interactionId, status: 'resolved' };
    }
  }

  async acknowledgeDelivery(commandEventId: string): Promise<boolean> {
    const interaction = (await this.storage.readInteractions()).find((candidate) => candidate.delivery.commandEventId === commandEventId);
    if (!interaction || interaction.delivery.state === 'accepted') {
      return Boolean(interaction);
    }
    if (interaction.delivery.state !== 'pending') {
      return false;
    }
    await this.update(interaction.interactionId, (current) => current.delivery.commandEventId === commandEventId && current.delivery.state === 'pending'
      ? {
          ...current,
          delivery: { ...current.delivery, state: 'accepted' },
          revision: current.revision + 1,
          updatedAt: this.clock.now()
        }
      : undefined);
    return true;
  }

  async reconcile(): Promise<void> {
    for (const interaction of await this.storage.readInteractions()) {
      await this.reconcileInteraction(interaction.interactionId);
    }
  }

  async interruptForOwnerSession(ownerSessionId: string, reason: InteractionInterruptedPayload['reason']): Promise<void> {
    const interactions = (await this.storage.readInteractions()).filter((candidate) => candidate.ownerSessionId === ownerSessionId);
    for (const interaction of interactions) {
      await this.interrupt(interaction.interactionId, reason);
      await this.tryReconcile(interaction.interactionId);
    }
  }

  private async tryReconcile(interactionId: string): Promise<void> {
    try {
      await this.reconcileInteraction(interactionId);
    } catch (error) {
      console.error(`Interaction ${interactionId} reconciliation failed`, error);
    }
  }

  private reconcileInteraction(interactionId: string): Promise<void> {
    const previous = this.reconcileTails.get(interactionId) ?? Promise.resolve();
    const run = previous.then(() => this.reconcileInteractionOnce(interactionId));
    this.reconcileTails.set(interactionId, run.then(() => undefined, () => undefined));
    return run;
  }

  private async reconcileInteractionOnce(interactionId: string): Promise<void> {
    let interaction = await this.storage.readInteraction(interactionId);
    if (!interaction) {
      return;
    }
    interaction = await this.reconcileLease(interaction);
    for (const view of interaction.views.filter((candidate) => !candidate.requestedProjected)) {
      await this.projectRequested(interaction, view);
      interaction = await this.markViewProjected(interaction.interactionId, view.sessionId, 'requested');
    }
    if (interaction.state === 'resolved') {
      for (const view of interaction.views.filter((candidate) => !candidate.respondedProjected)) {
        await this.projectResponded(interaction, view);
        interaction = await this.markViewProjected(interaction.interactionId, view.sessionId, 'responded');
      }
      await this.deliver(interaction);
      return;
    }
    if (interaction.state === 'interrupted') {
      for (const view of interaction.views.filter((candidate) => !candidate.interruptedProjected)) {
        await this.projectInterrupted(interaction, view);
        interaction = await this.markViewProjected(interaction.interactionId, view.sessionId, 'interrupted');
      }
    }
  }

  private async reconcileLease(interaction: InteractionRecord): Promise<InteractionRecord> {
    const owner = await this.storage.readSession(interaction.ownerSessionId);
    if (owner?.sessionLeaseId === interaction.requestLeaseId
      || interaction.delivery.state === 'accepted'
      || interaction.delivery.state === 'abandoned') {
      return interaction;
    }
    if (interaction.state === 'open') {
      return this.interrupt(interaction.interactionId, 'owner_lease_lost');
    }
    if (interaction.state === 'resolved' && interaction.delivery.state === 'pending') {
      return this.update(interaction.interactionId, (current) => current.delivery.state === 'pending'
        ? {
            ...current,
            delivery: { ...current.delivery, state: 'abandoned' },
            revision: current.revision + 1,
            updatedAt: this.clock.now()
          }
        : undefined);
    }
    return interaction;
  }

  private interrupt(interactionId: string, reason: InteractionInterruptedPayload['reason']): Promise<InteractionRecord> {
    return this.update(interactionId, (current) => current.state === 'open'
      ? {
          ...current,
          state: 'interrupted',
          interruption: { reason, interruptedAt: this.clock.now() },
          delivery: { state: 'abandoned' },
          views: current.views.map((view) => ({
            ...view,
            interruptedEventId: view.interruptedEventId ?? crypto.randomUUID(),
            interruptedProjected: false
          })),
          revision: current.revision + 1,
          updatedAt: this.clock.now()
        }
      : undefined);
  }

  private projectRequested(interaction: InteractionRecord, view: InteractionView): Promise<void> {
    return this.appendViewEvent(view, view.requestedEventId, 'interaction.requested', {
      interactionId: interaction.interactionId,
      kind: interaction.kind,
      request: interaction.request,
      source: view.source ? { kind: 'delegated_session' as const, ...view.source } : undefined
    } satisfies InteractionRequestedPayload);
  }

  private projectResponded(interaction: InteractionRecord, view: InteractionView): Promise<void> {
    if (!interaction.resolution || !view.respondedEventId) {
      throw new Error(`resolved Interaction ${interaction.interactionId} is missing response projection state`);
    }
    return this.appendViewEvent(view, view.respondedEventId, 'interaction.responded', {
      interactionId: interaction.interactionId,
      kind: interaction.kind,
      response: interaction.resolution.response
    } satisfies InteractionRespondedPayload);
  }

  private projectInterrupted(interaction: InteractionRecord, view: InteractionView): Promise<void> {
    if (!interaction.interruption || !view.interruptedEventId) {
      throw new Error(`interrupted Interaction ${interaction.interactionId} is missing projection state`);
    }
    return this.appendViewEvent(view, view.interruptedEventId, 'interaction.interrupted', {
      interactionId: interaction.interactionId,
      kind: interaction.kind,
      reason: interaction.interruption.reason
    } satisfies InteractionInterruptedPayload);
  }

  private appendViewEvent(view: InteractionView, eventId: string, type: RuntimeEvent['type'], payload: unknown): Promise<void> {
    const previous = this.sessionProjectionTails.get(view.sessionId) ?? Promise.resolve();
    const run = previous.then(async () => {
      const existing = (await this.storage.readEvents(view.sessionId, 0)).find((event) => event.eventId === eventId);
      const session = await this.requireSession(view.sessionId);
      const event = existing ?? await this.eventLogManager.append({
        eventId,
        type,
        actor: 'central',
        payload,
        turnSeq: view.turnSeq,
        sequence: session.eventCursor + 1,
        sessionId: view.sessionId
      });
      if (session.eventCursor < event.sequence) {
        await this.sessionLifecycleManager.advanceEventCursor(session, event.sequence);
      }
      await this.eventTransport.publish({ kind: 'session-events', sessionId: view.sessionId }, event);
    });
    this.sessionProjectionTails.set(view.sessionId, run.then(() => undefined, () => undefined));
    return run;
  }

  private async deliver(interaction: InteractionRecord): Promise<void> {
    if (interaction.delivery.state !== 'pending' || !interaction.delivery.commandEventId || !interaction.resolution) {
      return;
    }
    const owner = await this.requireSession(interaction.ownerSessionId);
    if (!owner.currentWorkerId || owner.sessionLeaseId !== interaction.requestLeaseId) {
      await this.reconcileLease(interaction);
      return;
    }
    const command: RuntimeEvent<SessionInteractionResponseCommandPayload> = {
      eventId: interaction.delivery.commandEventId,
      sessionId: owner.sessionId,
      workerId: owner.currentWorkerId,
      sessionLeaseId: interaction.requestLeaseId,
      turnSeq: interaction.ownerTurnSeq,
      sequence: owner.eventCursor,
      type: 'session.interaction.response',
      timestamp: this.clock.now(),
      actor: 'central',
      payload: {
        sessionId: owner.sessionId,
        workerId: owner.currentWorkerId,
        sessionLeaseId: interaction.requestLeaseId,
        interactionId: interaction.interactionId,
        adapterRequestId: interaction.adapterRequestId,
        kind: interaction.kind,
        response: interaction.resolution.response
      }
    };
    await this.eventTransport.publish({ kind: 'worker-commands', workerId: owner.currentWorkerId }, command);
  }

  private async buildViews(owner: SessionRecord, ownerTurnSeq: number): Promise<InteractionView[]> {
    const views: InteractionView[] = [this.newView(owner.sessionId, ownerTurnSeq, 'owner')];
    if (!owner.delegationBinding) {
      return views;
    }
    const delegation = await this.storage.readDelegation(owner.delegationBinding.delegationId);
    const activeCall = delegation?.calls.find((call) => call.delegationCallId === delegation.activeCallId);
    if (!delegation || delegation.childSessionId !== owner.sessionId || !activeCall || activeCall.dispatch?.childTurnSeq !== ownerTurnSeq) {
      throw new Error(`delegated Session ${owner.sessionId} has no active Call for turn ${ownerTurnSeq}`);
    }
    const parent = await this.requireSession(delegation.parentSessionId);
    if (parent.owner !== owner.owner) {
      throw new Error(`delegated Session ${owner.sessionId} owner does not match Parent Session ${parent.sessionId}`);
    }
    views.push({
      ...this.newView(parent.sessionId, activeCall.callerTurnSeq, 'parent_projection'),
      source: { ownerSessionId: owner.sessionId, agentSpecId: owner.resolvedAgentSpec.agentSpecId }
    });
    return views;
  }

  private newView(sessionId: string, turnSeq: number, role: InteractionView['role']): InteractionView {
    return {
      sessionId,
      turnSeq,
      role,
      requestedEventId: crypto.randomUUID(),
      requestedProjected: false,
      respondedProjected: false,
      interruptedProjected: false
    };
  }

  private markViewProjected(interactionId: string, sessionId: string, projection: 'requested' | 'responded' | 'interrupted'): Promise<InteractionRecord> {
    return this.update(interactionId, (current) => ({
      ...current,
      views: current.views.map((view) => view.sessionId === sessionId
        ? {
            ...view,
            requestedProjected: projection === 'requested' ? true : view.requestedProjected,
            respondedProjected: projection === 'responded' ? true : view.respondedProjected,
            interruptedProjected: projection === 'interrupted' ? true : view.interruptedProjected
          }
        : view),
      revision: current.revision + 1,
      updatedAt: this.clock.now()
    }));
  }

  private async update(interactionId: string, mutate: (current: InteractionRecord) => InteractionRecord | undefined): Promise<InteractionRecord> {
    for (;;) {
      const current = await this.storage.readInteraction(interactionId);
      if (!current) {
        throw new Error(`Interaction ${interactionId} was not found`);
      }
      const next = mutate(current);
      if (!next) {
        return current;
      }
      if (await this.storage.compareAndSetInteraction(current.revision, next)) {
        return next;
      }
    }
  }

  private async authorizeResponse(interaction: InteractionRecord, addressedSessionId: string, context: RequestContext): Promise<void> {
    if (!interaction.views.some((view) => view.sessionId === addressedSessionId)) {
      throw new Error(`interaction ${interaction.interactionId} is not visible in Session ${addressedSessionId}`);
    }
    const addressed = await this.requireSession(addressedSessionId);
    const owner = addressedSessionId === interaction.ownerSessionId ? addressed : await this.requireSession(interaction.ownerSessionId);
    if (addressed.owner !== context.principal.principalId || owner.owner !== context.principal.principalId) {
      throw new Error(`interaction ${interaction.interactionId} was not found`);
    }
  }

  private buildResponse(interaction: InteractionRecord, request: InteractionRespondRequestPayload): unknown {
    if (interaction.kind === 'approval') {
      if (request.decision !== 'approved' && request.decision !== 'denied') {
        throw new Error(`approval interaction ${interaction.interactionId} requires decision`);
      }
      return { decision: request.decision, scope: request.scope === 'session' ? 'session' : 'once' };
    }
    return { result: request.result };
  }

  private assertDuplicateAdmission(actual: InteractionRecord, candidate: InteractionRecord): void {
    if (actual.ownerSessionId !== candidate.ownerSessionId
      || actual.requestLeaseId !== candidate.requestLeaseId
      || actual.adapterRequestId !== candidate.adapterRequestId
      || actual.ownerTurnSeq !== candidate.ownerTurnSeq
      || actual.kind !== candidate.kind
      || JSON.stringify(actual.request) !== JSON.stringify(candidate.request)) {
      throw new Error(`adapter request ${candidate.adapterRequestId} was reused with different interaction input`);
    }
  }

  private async requireEventSession(event: RuntimeEvent): Promise<SessionRecord> {
    if (!event.sessionId) {
      throw new Error(`${event.type} requires sessionId`);
    }
    return this.requireSession(event.sessionId);
  }

  private async requireSession(sessionId: string): Promise<SessionRecord> {
    const session = await this.storage.readSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} was not found`);
    }
    return session;
  }

  private requireLeaseId(event: RuntimeEvent): string {
    if (!event.sessionLeaseId) {
      throw new Error(`${event.type} requires sessionLeaseId`);
    }
    return event.sessionLeaseId;
  }

  private requireTurnSeq(event: RuntimeEvent): number {
    if (event.turnSeq === undefined) {
      throw new Error(`${event.type} requires turnSeq`);
    }
    return event.turnSeq;
  }
}