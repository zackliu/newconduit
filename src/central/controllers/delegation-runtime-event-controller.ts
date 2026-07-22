import type { DelegationTarget, JsonValue, RuntimeEvent, RuntimeEventTransport, RuntimeStorage, RuntimeToolRequestedPayload, SessionRecord, SessionRuntimeToolResponseCommandPayload, TurnCompletedPayload, WorkerCommandAcceptedPayload } from '../../shared';
import type { DelegationDispatcher, DelegationManager, FanoutManager, SessionLeaseManager, SessionManager, WorkerCommandOutput } from '../managers';

/** A caller's resolved `target`: an explicit stateless pool task, one pinned device, or a fan-out to many devices. */
type TargetSpec =
  | { kind: 'pool' }
  | { kind: 'device'; deviceRef: string }
  | { kind: 'fanout'; all?: boolean; deviceRefs?: string[] };

export class DelegationRuntimeEventController {
  constructor(
    private readonly storage: RuntimeStorage,
    private readonly sessionLeaseManager: SessionLeaseManager,
    private readonly delegationManager: DelegationManager,
    private readonly delegationDispatcher: DelegationDispatcher,
    private readonly sessionManager: SessionManager,
    private readonly eventTransport: RuntimeEventTransport,
    private readonly fanoutManager: FanoutManager
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
      const delegation = await this.storage.readDelegation(session.delegationBinding.delegationId);
      const activeCall = delegation?.calls.find((call) => call.delegationCallId === delegation.activeCallId);
      if (activeCall?.dispatch?.commandEventId === payload.commandEventId) {
        await this.delegationManager.acknowledgeCommand(session.sessionId, payload.commandEventId, payload.turnSeq);
      }
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
        await this.deliverFanoutMember(callId);
      }
      return;
    }
    if (event.type === 'turn.failed' && event.turnSeq !== undefined) {
      const active = (await this.storage.readDelegation(session.delegationBinding.delegationId))?.calls.find((call) => call.dispatch?.childTurnSeq === event.turnSeq);
      await this.delegationManager.failTurn(session.sessionId, event.turnSeq, this.failureMessage(event.payload));
      if (active) {
        await this.deliverAwaitResponses(active.delegationCallId);
        await this.deliverFanoutMember(active.delegationCallId);
      }
    }
  }

  async reconcilePendingAwaitResponses(): Promise<void> {
    for (const delegation of await this.storage.readDelegations()) {
      const parent = await this.storage.readSession(delegation.parentSessionId);
      if (parent && this.isTerminalSession(parent.status)) {
        // The case (parent recovery session) is closed. Device-binding revocation is owned authoritatively by the
        // session terminal hook (see TenantRuntime); here we only settle this delegation's own child/call state so the
        // parent tool await cannot hang on a finished case.
        await this.delegationManager.failForParentTerminal(delegation.delegationId);
        await this.pauseChildForTerminalParent(delegation.childSessionId);
        continue;
      }
      // The Child Session was failed (its paired device/worker was lost) while the Parent is still active. The
      // worker-loss `turn.failed` never flows through the agent inbox, so the active Call is otherwise never
      // settled and the Parent tool await hangs. Fail the Call deterministically so the Parent unblocks and can
      // retry onto the rejoined device.
      if (this.isOpenDelegation(delegation.status)) {
        const child = await this.storage.readSession(delegation.childSessionId);
        if (child && this.isTerminalSession(child.status)) {
          await this.delegationManager.failForChildLost(
            delegation.childSessionId,
            `Child Session ${delegation.childSessionId} was lost before the scan completed (${child.lifecycleReason ?? child.status})`
          );
        }
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
    // Recover fan-out members whose terminal outcome (including a lost paired device) never reached the group — e.g.
    // after a central restart mid-fan-out — so the parent's one aggregated tool response is still delivered exactly
    // once when every member has settled.
    for (const group of await this.storage.readFanoutGroups()) {
      if (group.status === 'settled') {
        continue;
      }
      for (const member of group.members) {
        if (member.status === 'pending') {
          await this.deliverFanoutMember(member.delegationCallId);
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
    const turnSeq = this.requireTurnSeq(event);
    let targetSpec: TargetSpec;
    try {
      targetSpec = await this.resolveEnforcedTargetSpec(parent.sessionId, turnSeq, input.target);
    } catch (error) {
      await this.publishToolResponse(
        parent,
        payload.requestId,
        `Subagent failed [delegation_rejected]: ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }
    if (targetSpec.kind === 'fanout') {
      await this.handleFanoutTool(event, payload, parent, tool.binding.delegateId, input.message, targetSpec);
      return;
    }
    let started: Awaited<ReturnType<DelegationManager['startCall']>>;
    try {
      const targetRef = targetSpec.kind === 'device' ? targetSpec.deviceRef : undefined;
      started = await this.delegationManager.startCall({
        parentSession: parent,
        callerTurnSeq: turnSeq,
        callerToolRequestId: payload.requestId,
        delegateId: tool.binding.delegateId,
        input: input.message,
        ...(targetRef ? { targetRef } : {})
      });
    } catch (error) {
      // A malformed target or a rejected admission/targeting check (e.g. a device not paired to this case) is a
      // deterministic routing failure. Fail the tool call back to the parent explicitly so the turn unblocks with an
      // honest error, instead of leaving it hung — and never silently fall back to pool routing for a device target.
      await this.publishToolResponse(
        parent,
        payload.requestId,
        `Subagent failed [delegation_rejected]: ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }
    await this.delegationManager.registerAwait(parent.sessionId, turnSeq, payload.requestId, started.call.delegationCallId);
    await this.progressRelation(started.delegation.delegationId);
    await this.deliverAwaitResponses(started.call.delegationCallId);
  }

  /**
   * Fan a single parent tool request out to one delegated Child per targeted device, then hold the parent's tool
   * interaction pending under a durable {@link FanoutManager} group until every member terminalizes. Each member is
   * an independent delegation keyed `(parent, delegate, deviceRef)` with its own idempotency key, so a lost device
   * fails on its own (`child_session_lost`) and shows up as a partial failure in the one aggregated result — sibling
   * devices still complete. The unrelated pool is never used for a device-specific fan-out.
   */
  private async handleFanoutTool(
    event: RuntimeEvent,
    payload: RuntimeToolRequestedPayload,
    parent: SessionRecord,
    delegateId: string,
    message: string,
    targetSpec: Extract<TargetSpec, { kind: 'fanout' }>
  ): Promise<void> {
    const turnSeq = this.requireTurnSeq(event);
    let deviceRefs: string[];
    try {
      deviceRefs = await this.resolveFanoutDeviceRefs(parent, targetSpec);
    } catch (error) {
      await this.publishToolResponse(parent, payload.requestId, `Subagent failed [delegation_rejected]: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (deviceRefs.length === 0) {
      await this.publishToolResponse(parent, payload.requestId, 'Subagent failed [delegation_rejected]: no devices are paired to this case to scan');
      return;
    }
    const members: { deviceRef: string; delegationCallId: string }[] = [];
    const preFailed: { deviceRef: string; delegationCallId: string; message: string }[] = [];
    const startedDelegationIds = new Set<string>();
    for (const deviceRef of deviceRefs) {
      try {
        const started = await this.delegationManager.startCall({
          parentSession: parent,
          callerTurnSeq: turnSeq,
          callerToolRequestId: `${payload.requestId}#${deviceRef}`,
          delegateId,
          input: message,
          targetRef: deviceRef
        });
        members.push({ deviceRef, delegationCallId: started.call.delegationCallId });
        startedDelegationIds.add(started.delegation.delegationId);
      } catch (error) {
        preFailed.push({ deviceRef, delegationCallId: `prefail:${payload.requestId}#${deviceRef}`, message: error instanceof Error ? error.message : String(error) });
      }
    }
    await this.fanoutManager.openGroup({
      parentSessionId: parent.sessionId,
      parentTurnSeq: turnSeq,
      parentRequestId: payload.requestId,
      caseId: parent.sessionId,
      members: [...members, ...preFailed.map((entry) => ({ deviceRef: entry.deviceRef, delegationCallId: entry.delegationCallId }))]
    });
    for (const entry of preFailed) {
      await this.settleFanoutMember(entry.delegationCallId, { status: 'failed', code: 'delegation_rejected', message: entry.message });
    }
    for (const delegationId of startedDelegationIds) {
      await this.progressRelation(delegationId);
    }
    for (const member of members) {
      await this.deliverFanoutMember(member.delegationCallId);
    }
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

  /**
   * A fan-out member call has no per-call await request; its outcome flows into the durable group instead. When the
   * group's last member terminalizes, publish the one aggregated result to the parent's tool request. Idempotent: a
   * redelivered completion or a post-restart reconcile never answers the parent twice (the group settles once).
   */
  private async deliverFanoutMember(delegationCallId: string): Promise<void> {
    const found = await this.delegationManager.readCall(delegationCallId);
    if (!found || !this.isTerminal(found.call.status)) {
      return;
    }
    const outcome = found.call.status === 'completed'
      ? { status: 'completed' as const, result: found.call.result ?? '' }
      : { status: 'failed' as const, code: found.call.failure?.code ?? found.call.status, message: found.call.failure?.message ?? `DelegationCall ${found.call.status}` };
    await this.settleFanoutMember(delegationCallId, outcome);
  }

  private async settleFanoutMember(delegationCallId: string, outcome: Parameters<FanoutManager['recordOutcome']>[1]): Promise<void> {
    const settled = await this.fanoutManager.recordOutcome(delegationCallId, outcome);
    if (!settled?.settledAggregate) {
      return;
    }
    const parent = await this.storage.readSession(settled.group.parentSessionId);
    if (parent?.currentWorkerId && parent.sessionLeaseId) {
      await this.publishToolResponse(parent, settled.group.parentRequestId, settled.settledAggregate);
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

  /**
   * Resolve the delegate call's target under Central authority. The operator's device selection for this turn is
   * durably bound to the turn's `input.accepted` event (see {@link readTurnDelegationTarget}); it — not whatever the
   * LLM or scripted agent placed in the tool arguments — decides where the scan runs. When a turn is bound, an agent
   * may echo the same target but any different `target` is rejected (`delegation_rejected`): the agent can never
   * widen or redirect the operator's selection. When a turn is not bound (ordinary non-device delegates), the agent's
   * explicit target is honoured and the per-delegate `targetPolicy` still guards a device delegate from pool routing.
   */
  private async resolveEnforcedTargetSpec(parentSessionId: string, turnSeq: number, toolTarget: unknown): Promise<TargetSpec> {
    const bound = await this.readTurnDelegationTarget(parentSessionId, turnSeq);
    if (bound === undefined) {
      return this.resolveTargetSpec(toolTarget);
    }
    const boundSpec = this.resolveTargetSpec(bound);
    if (toolTarget !== undefined && toolTarget !== null) {
      const requested = this.resolveTargetSpec(toolTarget);
      if (!this.targetSpecEquals(boundSpec, requested)) {
        throw new Error('the delegated scan target is fixed by the operator selection for this turn and cannot be changed by the agent');
      }
    }
    return boundSpec;
  }

  /**
   * Read the operator-authoritative delegation target Central bound to a parent turn. The binding lives on the turn's
   * durable `input.accepted` event, so it is turn-scoped and cannot leak across concurrent or queued inputs, and it
   * survives a restart. The worker's forwarded copy is deliberately not trusted — only this durable record is.
   */
  private async readTurnDelegationTarget(sessionId: string, turnSeq: number): Promise<DelegationTarget | undefined> {
    const events = await this.storage.readEvents(sessionId, 0);
    const accepted = events.find((event) => event.type === 'input.accepted' && event.turnSeq === turnSeq);
    const target = (accepted?.payload as { input?: { delegationTarget?: DelegationTarget } } | undefined)?.input?.delegationTarget;
    return target ?? undefined;
  }

  /** Structural equality of two resolved targets, so an agent-supplied target is accepted only if it does not widen
   * or redirect the operator's bound selection. Fan-out device sets compare order-independently. */
  private targetSpecEquals(a: TargetSpec, b: TargetSpec): boolean {
    if (a.kind !== b.kind) {
      return false;
    }
    if (a.kind === 'device' && b.kind === 'device') {
      return a.deviceRef === b.deviceRef;
    }
    if (a.kind === 'fanout' && b.kind === 'fanout') {
      if (Boolean(a.all) !== Boolean(b.all)) {
        return false;
      }
      const left = [...(a.deviceRefs ?? [])].sort();
      const right = [...(b.deviceRefs ?? [])].sort();
      return left.length === right.length && left.every((value, index) => value === right[index]);
    }
    return true;
  }

  /**
   * Resolve the caller's explicit `target` into a routing spec. A device-specific target must never silently fall
   * back to pool routing, so an unrecognized shape is rejected rather than dropped:
   * - absent / `{ scope: 'any' }` → `pool` (an explicit stateless task; ordinary least-loaded routing).
   * - `{ deviceRef }` → a single device (Central re-validates it against the case roster before pinning the child).
   * - `{ scope: 'all' }` → fan-out to every active device on the case roster.
   * - `{ deviceRefs: [...] }` → fan-out to exactly those devices (each re-validated against the roster).
   */
  private resolveTargetSpec(target: unknown): TargetSpec {
    if (target === undefined || target === null) {
      return { kind: 'pool' };
    }
    if (typeof target !== 'object' || Array.isArray(target)) {
      throw new Error('runtime tool target must be an object');
    }
    const candidate = target as Record<string, unknown>;
    if (candidate.scope === 'any') {
      return { kind: 'pool' };
    }
    if (candidate.scope === 'all') {
      return { kind: 'fanout', all: true };
    }
    if (Array.isArray(candidate.deviceRefs)) {
      const deviceRefs = candidate.deviceRefs;
      if (deviceRefs.length === 0 || !deviceRefs.every((entry) => typeof entry === 'string' && entry.length > 0)) {
        throw new Error('target deviceRefs must be a non-empty list of deviceRef strings');
      }
      return { kind: 'fanout', deviceRefs: [...new Set(deviceRefs as string[])] };
    }
    if (typeof candidate.deviceRef === 'string' && candidate.deviceRef.length > 0) {
      return { kind: 'device', deviceRef: candidate.deviceRef };
    }
    throw new Error('runtime tool target must be { deviceRef }, { deviceRefs }, { scope: "all" } or { scope: "any" }');
  }

  /**
   * Resolve a fan-out target to the concrete set of Central-authoritative `deviceRef` values, always constrained to
   * the parent case's active roster. `scope: 'all'` expands to every active device; an explicit `deviceRefs` list is
   * validated so a caller cannot fan out to a device that is not paired to this case.
   */
  private async resolveFanoutDeviceRefs(parent: SessionRecord, targetSpec: Extract<TargetSpec, { kind: 'fanout' }>): Promise<string[]> {
    const active = (await this.storage.readCaseDeviceBindings(parent.sessionId)).filter((binding) => binding.status === 'active');
    const activeRefs = new Set(active.map((binding) => binding.deviceRef));
    if (targetSpec.all) {
      return [...activeRefs];
    }
    const requested = targetSpec.deviceRefs ?? [];
    const unknown = requested.filter((ref) => !activeRefs.has(ref));
    if (unknown.length > 0) {
      throw new Error(`device(s) not paired to this case: ${unknown.join(', ')}`);
    }
    return requested;
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

  private failureMessage(payload: unknown): string {
    const record = typeof payload === 'object' && payload !== null ? payload as { error?: { message?: unknown } } : {};
    return typeof record.error?.message === 'string' ? record.error.message : 'delegated Child turn failed';
  }

  private isTerminalSession(status: SessionRecord['status']): boolean {
    return status === 'completed' || status === 'cancelled' || status === 'failed';
  }

  private isOpenDelegation(status: string): boolean {
    return status !== 'failed' && status !== 'closed';
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