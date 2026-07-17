import type { InteractionRequestedPayload, JsonValue, RuntimeEvent, RuntimeEventTransport, RuntimeStorage, RuntimeToolRequestedPayload, SessionRecord, SessionRuntimeToolResponseCommandPayload, TurnCompletedPayload, WorkerCommandAcceptedPayload } from '../../shared';
import type { DelegationDispatcher, DelegationManager, SessionLeaseManager, SessionManager, WorkerCommandOutput } from '../managers';

export class DelegationRuntimeEventController {
  constructor(
    private readonly storage: RuntimeStorage,
    private readonly sessionLeaseManager: SessionLeaseManager,
    private readonly delegationManager: DelegationManager,
    private readonly delegationDispatcher: DelegationDispatcher,
    private readonly sessionManager: SessionManager,
    private readonly eventTransport: RuntimeEventTransport
  ) {}

  async handleRuntimeEvent(event: RuntimeEvent): Promise<boolean> {
    if (event.type === 'runtime.tool.requested') {
      await this.handleRuntimeTool(event, this.parseRuntimeToolRequest(event.payload));
      return true;
    }
    return false;
  }

  async observeAgentEvent(event: RuntimeEvent): Promise<void> {
    const session = event.sessionId ? await this.storage.readSession(event.sessionId) : undefined;
    if (!session?.delegationBinding) {
      return;
    }
    if (event.type === 'status.changed' || event.type === 'session.paused') {
      await this.progressRelation(session.delegationBinding.delegationId);
      return;
    }
    if (event.type === 'worker.command.accepted') {
      const payload = event.payload as WorkerCommandAcceptedPayload;
      await this.delegationManager.acknowledgeCommand(session.sessionId, payload.commandEventId, payload.turnSeq);
      return;
    }
    if (event.type === 'interaction.requested') {
      const delegation = await this.storage.readDelegation(session.delegationBinding.delegationId);
      const activeCall = delegation?.calls.find((call) => call.delegationCallId === delegation.activeCallId);
      if (!delegation || !activeCall) {
        throw new Error(`Delegation ${session.delegationBinding.delegationId} has no active Call for interaction`);
      }
      const interaction = this.parseInteractionRequested(event.payload);
      const projected = await this.sessionManager.projectDelegatedInteraction({
        parentSessionId: delegation.parentSessionId,
        childSessionId: session.sessionId,
        callerTurnSeq: activeCall.callerTurnSeq,
        interaction,
        requestedAt: event.timestamp
      });
      await this.eventTransport.publish({ kind: 'session-events', sessionId: delegation.parentSessionId }, projected);
      return;
    }
    if (event.type === 'turn.completed' && event.turnSeq !== undefined) {
      let callId: string | undefined;
      try {
        callId = (await this.delegationManager.completeTurn(session.sessionId, event.turnSeq, this.completedMessage(event.payload))).delegationCallId;
      } catch (error) {
        await this.delegationManager.failTurn(session.sessionId, event.turnSeq, error instanceof Error ? error.message : String(error));
        const active = (await this.storage.readDelegation(session.delegationBinding.delegationId))?.calls.find((call) => call.dispatch?.childTurnSeq === event.turnSeq);
        callId = active?.delegationCallId;
      }
      if (callId) {
        await this.progressRelation(session.delegationBinding.delegationId);
        await this.deliverAwaitResponses(callId);
      }
      return;
    }
    if (event.type === 'turn.failed' && event.turnSeq !== undefined) {
      const active = (await this.storage.readDelegation(session.delegationBinding.delegationId))?.calls.find((call) => call.dispatch?.childTurnSeq === event.turnSeq);
      await this.delegationManager.failTurn(session.sessionId, event.turnSeq, this.failureMessage(event.payload));
      if (active) {
        await this.deliverAwaitResponses(active.delegationCallId);
      }
    }
  }

  async reconcilePendingAwaitResponses(): Promise<void> {
    for (const delegation of await this.storage.readDelegations()) {
      const parent = await this.storage.readSession(delegation.parentSessionId);
      if (parent && this.isTerminalSession(parent.status)) {
        await this.delegationManager.failForParentTerminal(delegation.delegationId);
        await this.pauseChildForTerminalParent(delegation.childSessionId);
        continue;
      }
      if (delegation.status === 'open') {
        await this.progressRelation(delegation.delegationId);
      }
      for (const call of delegation.calls) {
        if ((call.awaitRequests ?? []).some((request) => request.status === 'pending')) {
          await this.deliverAwaitResponses(call.delegationCallId);
        }
      }
    }
  }

  private async handleRuntimeTool(event: RuntimeEvent, payload: RuntimeToolRequestedPayload): Promise<void> {
    const parent = await this.requireLeasedSession(event);
    const tool = parent.resolvedAgentSpec.runtimeTools.find((candidate) => candidate.name === payload.toolName);
    if (!tool || tool.binding.kind !== 'delegate') {
      throw new Error(`Runtime tool ${payload.toolName} is not registered for Session ${parent.sessionId}`);
    }
    const input = this.record(payload.input);
    if (typeof input.message !== 'string' || input.message.length === 0) {
      throw new Error(`Runtime tool ${payload.toolName} requires a non-empty message`);
    }
    const started = await this.delegationManager.startCall({
      parentSession: parent,
      callerTurnSeq: this.requireTurnSeq(event),
      callerToolRequestId: payload.requestId,
      delegateId: tool.binding.delegateId,
      input: input.message
    });
    await this.delegationManager.registerAwait(parent.sessionId, this.requireTurnSeq(event), payload.requestId, started.call.delegationCallId);
    await this.progressRelation(started.delegation.delegationId);
    await this.deliverAwaitResponses(started.call.delegationCallId);
  }

  private async deliverAwaitResponses(delegationCallId: string): Promise<void> {
    const found = await this.delegationManager.readCall(delegationCallId);
    if (!found || !this.isTerminal(found.call.status)) {
      return;
    }
    for (const request of (found.call.awaitRequests ?? []).filter((candidate) => candidate.status === 'pending')) {
      const parent = await this.storage.readSession(request.parentSessionId);
      if (!parent?.currentWorkerId || !parent.sessionLeaseId) {
        continue;
      }
      const result = found.call.status === 'completed'
        ? found.call.result ?? ''
        : `Subagent failed [${found.call.failure?.code ?? found.call.status}]: ${found.call.failure?.message ?? `DelegationCall ${found.call.status}`}`;
      await this.publishToolResponse(parent, request.requestId, result);
      await this.delegationManager.markAwaitResponded(delegationCallId, request.requestId);
    }
  }

  private async publishDispatch(dispatch: Awaited<ReturnType<DelegationDispatcher['dispatchNext']>>): Promise<void> {
    if (!dispatch) {
      return;
    }
    if (dispatch.sessionCreatedEvent) {
      await this.eventTransport.publish({ kind: 'session-events', sessionId: dispatch.delegation.childSessionId }, dispatch.sessionCreatedEvent);
    }
    if (dispatch.sessionCatalogUpdatedEvent) {
      await this.eventTransport.publish({ kind: 'client-inbox' }, dispatch.sessionCatalogUpdatedEvent);
    }
    for (const command of dispatch.workerCommands) {
      await this.publishWorkerCommand(command);
    }
    if (dispatch.sessionCreatedEvent) {
      this.sessionManager.reconcileStartedSession(dispatch.needsReconcile);
    }
  }

  private async progressRelation(delegationId: string): Promise<void> {
    const delegation = await this.storage.readDelegation(delegationId);
    if (!delegation || delegation.status !== 'open') {
      return;
    }
    const queued = delegation.calls.some((call) => call.status === 'queued');
    const child = await this.storage.readSession(delegation.childSessionId);
    if (!child) {
      return;
    }
    if (queued && child.status === 'paused') {
      const resumed = await this.sessionManager.resumeDelegatedSession(child.sessionId);
      if (resumed) {
        await this.eventTransport.publish({ kind: 'session-events', sessionId: child.sessionId }, resumed.resumeRequestedEvent);
      }
    }
    const readyForInput = await this.storage.readSession(delegation.childSessionId);
    if (queued && readyForInput?.status !== 'created' && readyForInput?.status !== 'running') {
      return;
    }
    const dispatch = await this.delegationDispatcher.dispatchNext(delegationId);
    if (dispatch) {
      await this.publishDispatch(dispatch);
    }
    // With no active or queued Call, the Child stays running and is paused only by the ordinary
    // idle_timeout path (SessionLifecycleReconciler), exactly like any other session. Delegation
    // never pauses the Child eagerly after a Call completes.
  }

  private async publishWorkerCommand(command: WorkerCommandOutput): Promise<void> {
    await this.eventTransport.publish({ kind: 'worker-commands', workerId: command.workerId }, command.event);
  }

  private async publishToolResponse(session: SessionRecord, requestId: string, result: string): Promise<void> {
    if (!session.currentWorkerId || !session.sessionLeaseId) {
      throw new Error(`Session ${session.sessionId} has no current worker for delegation tool response`);
    }
    const payload: SessionRuntimeToolResponseCommandPayload = {
      sessionId: session.sessionId,
      workerId: session.currentWorkerId,
      sessionLeaseId: session.sessionLeaseId,
      requestId,
      result
    };
    await this.eventTransport.publish({ kind: 'worker-commands', workerId: session.currentWorkerId }, {
      eventId: crypto.randomUUID(),
      sessionId: session.sessionId,
      workerId: session.currentWorkerId,
      turnSeq: undefined,
      sequence: session.eventCursor,
      type: 'session.runtime.tool.response',
      timestamp: new Date().toISOString(),
      actor: 'central',
      sessionLeaseId: session.sessionLeaseId,
      payload
    });
  }

  private async requireLeasedSession(event: RuntimeEvent): Promise<SessionRecord> {
    if (!event.sessionId || !event.sessionLeaseId) {
      throw new Error(`${event.type} requires sessionId and sessionLeaseId`);
    }
    const session = await this.storage.readSession(event.sessionId);
    if (!session) {
      throw new Error(`Session ${event.sessionId} was not found`);
    }
    this.sessionLeaseManager.assertCurrent(session, event.sessionLeaseId);
    return session;
  }

  private requireTurnSeq(event: RuntimeEvent): number {
    if (event.turnSeq === undefined) {
      throw new Error(`${event.type} requires turnSeq`);
    }
    return event.turnSeq;
  }

  private parseRuntimeToolRequest(payload: unknown): RuntimeToolRequestedPayload {
    const candidate = this.record(payload);
    if (typeof candidate.requestId !== 'string' || typeof candidate.toolName !== 'string' || !this.isJsonValue(candidate.input)) {
      throw new Error('invalid runtime.tool.requested payload');
    }
    return candidate as unknown as RuntimeToolRequestedPayload;
  }

  private record(value: unknown): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('delegation payload must be an object');
    }
    return value as Record<string, unknown>;
  }

  private isJsonValue(value: unknown): value is JsonValue {
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return true;
    }
    if (Array.isArray(value)) {
      return value.every((entry) => this.isJsonValue(entry));
    }
    return typeof value === 'object' && value !== null && Object.values(value).every((entry) => this.isJsonValue(entry));
  }

  private isTerminal(status: string): boolean {
    return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'expired';
  }

  private completedMessage(payload: unknown): string {
    const result = this.record(payload) as unknown as TurnCompletedPayload;
    if (typeof result.result?.message !== 'string' || result.result.message.length === 0) {
      throw new Error('delegated Child turn completed without a message');
    }
    return result.result.message;
  }

  private parseInteractionRequested(payload: unknown): InteractionRequestedPayload {
    const candidate = this.record(payload);
    if (typeof candidate.interactionId !== 'string'
      || (candidate.kind !== 'approval' && candidate.kind !== 'tool_call')) {
      throw new Error('invalid delegated interaction.requested payload');
    }
    return candidate as unknown as InteractionRequestedPayload;
  }

  private failureMessage(payload: unknown): string {
    const record = typeof payload === 'object' && payload !== null ? payload as { error?: { message?: unknown } } : {};
    return typeof record.error?.message === 'string' ? record.error.message : 'delegated Child turn failed';
  }

  private isTerminalSession(status: SessionRecord['status']): boolean {
    return status === 'completed' || status === 'cancelled' || status === 'failed';
  }

  private async pauseChildForTerminalParent(childSessionId: string): Promise<void> {
    const child = await this.storage.readSession(childSessionId);
    if (child?.status !== 'running') {
      return;
    }
    const paused = await this.sessionManager.pauseDelegatedSession(childSessionId);
    if (!paused) {
      return;
    }
    await this.eventTransport.publish({ kind: 'session-events', sessionId: childSessionId }, paused.pauseRequestedEvent);
    await this.publishWorkerCommand(paused.workerCommand);
  }
}