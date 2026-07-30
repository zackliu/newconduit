import { randomUUID } from 'node:crypto';
import type { AgentSpecAdmissionManager } from '../admission/agent-spec-admission-manager';
import { digestJson, type DelegateAdmissionManager } from '../admission/delegate-admission-manager';
import type { DelegateBindingIndex, ResolvedDelegateRegistry } from '../../registries/delegate-registry';
import type { SessionLifecycleManager } from '../session/session-lifecycle-manager';
import { EDGE_CASE_LABEL_KEY, EDGE_DEVICE_REF_LABEL_KEY } from '../case/case-pairing-manager';
import type { Clock, DelegationCallRecord, DelegationRecord, RuntimeStorage, SessionRecord } from '../../../shared';

export interface StartDelegationCallInput {
  parentSession: SessionRecord;
  callerTurnSeq: number;
  callerToolRequestId: string;
  delegateId: string;
  input: string;
  /**
   * The Central-validated device this call targets, as a case roster `deviceRef`. Absent = an explicit pool/`any`
   * target with no device pin (only valid for a stateless task). A device-pinned target opens a Delegation and
   * Child Session dedicated to that device, so targeting device A then device B produce two independent children.
   */
  targetRef?: string;
}

export interface StartDelegationCallResult {
  delegation: DelegationRecord;
  call: DelegationCallRecord;
}

export class DelegationManager {
  constructor(
    private readonly tenantId: string,
    private readonly storage: RuntimeStorage,
    private readonly clock: Clock,
    private readonly delegateRegistry: ResolvedDelegateRegistry,
    private readonly delegateBindingIndex: DelegateBindingIndex,
    private readonly delegateAdmissionManager: DelegateAdmissionManager,
    private readonly agentSpecAdmissionManager: AgentSpecAdmissionManager,
    private readonly sessionLifecycleManager: SessionLifecycleManager
  ) {}

  async startCall(input: StartDelegationCallInput): Promise<StartDelegationCallResult> {
    this.assertParent(input.parentSession, input.delegateId);
    const resolvedDelegate = this.delegateRegistry.resolve(input.delegateId);
    // A device-scoped delegate must never silently fall back to pool/random routing: an on-device diagnostic that
    // arrives with no Central-validated device target is rejected here rather than placed on an unrelated worker.
    // Fan-out/device targets always carry a `targetRef`; only an absent target (a pool/`any` request) trips this.
    if (resolvedDelegate.targetPolicy === 'device' && input.targetRef === undefined) {
      throw new Error(`delegate ${input.delegateId} requires an explicit device target ({ deviceRef }, { deviceRefs } or { scope: "all" }); pool/any routing is not allowed`);
    }
    const inputHash = digestJson(input.input);
    const retry = await this.findCallByCallerKey(input.parentSession.sessionId, input.callerTurnSeq, input.callerToolRequestId);
    if (retry) {
      if (retry.delegation.resolvedDelegate.id !== input.delegateId || retry.call.inputHash !== inputHash) {
        throw new Error('delegation call idempotency key was reused with different input');
      }
      return retry.delegation.status === 'creating_child'
        ? { delegation: await this.ensureChildAndOpen(retry.delegation, input.parentSession), call: retry.call }
        : retry;
    }

    const existing = await this.storage.readDelegationByKey(input.parentSession.sessionId, input.delegateId, input.targetRef);
    if (existing) {
      return this.appendCall(existing, input, inputHash);
    }

    await this.validateTargetRef(input.parentSession, input.targetRef);
    this.delegateAdmissionManager.validateInput(resolvedDelegate, input.input);
    const resolvedCalleeAgentSpec = this.agentSpecAdmissionManager.resolve(this.delegateBindingIndex.resolveCallee(input.delegateId));
    const now = this.clock.now();
    const delegationId = randomUUID();
    const call = this.createCall(delegationId, 1, input, inputHash, resolvedDelegate.deadlineMs, now);
    const delegation: DelegationRecord = {
      delegationId,
      tenantId: this.tenantId,
      parentSessionId: input.parentSession.sessionId,
      childSessionId: randomUUID(),
      resolvedDelegate,
      resolvedCalleeAgentSpec,
      status: 'creating_child',
      ...(input.targetRef ? { targetRef: input.targetRef } : {}),
      nextCallSeq: 2,
      calls: [call],
      revision: 1,
      createdAt: now,
      updatedAt: now
    };
    const created = await this.storage.createDelegation(delegation);
    if (!created.created) {
      return this.appendCall(created.delegation, input, inputHash);
    }
    const opened = await this.ensureChildAndOpen(delegation, input.parentSession);
    return { delegation: opened, call };
  }

  async acknowledgeCommand(childSessionId: string, commandEventId: string, turnSeq: number): Promise<void> {
    for (;;) {
      const delegation = (await this.storage.readDelegations()).find((candidate) => candidate.childSessionId === childSessionId);
      if (!delegation) {
        throw new Error(`Child Session ${childSessionId} has no Delegation`);
      }
      const call = delegation.calls.find((candidate) => candidate.dispatch?.commandEventId === commandEventId && candidate.dispatch.childTurnSeq === turnSeq);
      if (!call) {
        throw new Error(`worker command ${commandEventId} does not match a DelegationCall for Child Session ${childSessionId}`);
      }
      if (call.dispatch?.commandState === 'accepted' || call.status === 'completed' || call.status === 'failed' || call.status === 'cancelled' || call.status === 'expired') {
        return;
      }
      const updatedCall = { ...call, dispatch: { ...call.dispatch!, commandState: 'accepted' as const }, updatedAt: this.clock.now() };
      const next = { ...this.replaceCall(delegation, updatedCall), revision: delegation.revision + 1, updatedAt: this.clock.now() };
      if (await this.storage.compareAndSetDelegation(delegation.revision, next)) {
        return;
      }
    }
  }

  async completeTurn(childSessionId: string, turnSeq: number, result: string): Promise<DelegationCallRecord> {
    let completed!: DelegationCallRecord;
    await this.updateByChildSession(childSessionId, (delegation, activeCall) => {
      if (activeCall.dispatch?.childTurnSeq !== turnSeq) {
        throw new Error(`turn ${turnSeq} does not match active DelegationCall ${activeCall.delegationCallId}`);
      }
      this.delegateAdmissionManager.validateResult(delegation.resolvedDelegate, result);
      completed = {
        ...activeCall,
        status: 'completed',
        result,
        resultDigest: digestJson(result),
        updatedAt: this.clock.now()
      };
      return { ...this.replaceCall(delegation, completed), activeCallId: undefined };
    });
    return completed;
  }

  async failTurn(childSessionId: string, turnSeq: number, message: string): Promise<void> {
    await this.updateByChildSession(childSessionId, (delegation, activeCall) => {
      if (activeCall.dispatch?.childTurnSeq !== turnSeq) {
        throw new Error(`turn ${turnSeq} does not match active DelegationCall ${activeCall.delegationCallId}`);
      }
      const now = this.clock.now();
      const failedCall: DelegationCallRecord = {
        ...activeCall,
        status: 'failed',
        failure: { code: 'child_turn_failed', message },
        updatedAt: now
      };
      return {
        ...this.replaceCall(delegation, failedCall),
        activeCallId: undefined,
        status: 'failed',
        closeReason: 'active_call_failed',
        failure: failedCall.failure,
        calls: delegation.calls.map((call) => call.delegationCallId === failedCall.delegationCallId
          ? failedCall
          : call.status === 'queued' ? { ...call, status: 'failed' as const, failure: { code: 'delegation_closed', message }, updatedAt: now } : call)
      };
    });
  }

  async failForParentTerminal(delegationId: string): Promise<DelegationRecord | undefined> {
    return this.closeForTerminal(delegationId, 'parent_terminal', 'parent_terminal', (delegation) =>
      delegation.closeReason === 'parent_terminal',
      (delegation) => `Parent Session ${delegation.parentSessionId} is terminal`);
  }

  /**
   * Settle a Delegation whose Child Session was lost (its worker expired / disconnected) before the active Call
   * completed. Nothing routes the synthetic worker-loss `turn.failed` through the agent inbox, so without this
   * the Parent's tool await would hang forever and the Parent turn would stay `working`. Failing the active Call
   * here lets `deliverAwaitResponses` return an error to the Parent, which can then retry (opening a fresh
   * Delegation onto the rejoined paired device).
   */
  async failForChildLost(childSessionId: string, message: string): Promise<DelegationRecord | undefined> {
    const delegation = (await this.storage.readDelegations()).find((candidate) => candidate.childSessionId === childSessionId);
    if (!delegation) {
      return undefined;
    }
    return this.closeForTerminal(delegation.delegationId, 'child_terminal', 'child_session_lost',
      (current) => current.closeReason === 'child_terminal',
      () => message);
  }

  private async closeForTerminal(
    delegationId: string,
    closeReason: DelegationRecord['closeReason'],
    failureCode: string,
    alreadyClosed: (delegation: DelegationRecord) => boolean,
    message: (delegation: DelegationRecord) => string
  ): Promise<DelegationRecord | undefined> {
    for (;;) {
      const delegation = await this.storage.readDelegation(delegationId);
      if (!delegation) {
        return undefined;
      }
      if (alreadyClosed(delegation)) {
        return delegation;
      }
      const now = this.clock.now();
      const failure = { code: failureCode, message: message(delegation) };
      const next: DelegationRecord = {
        ...delegation,
        status: 'failed',
        activeCallId: undefined,
        closeReason,
        failure,
        calls: delegation.calls.map((call) => this.isTerminalCall(call.status)
          ? call
          : { ...call, status: 'failed' as const, failure, updatedAt: now }),
        revision: delegation.revision + 1,
        updatedAt: now
      };
      if (await this.storage.compareAndSetDelegation(delegation.revision, next)) {
        return next;
      }
    }
  }

  async readCall(delegationCallId: string): Promise<{ delegation: DelegationRecord; call: DelegationCallRecord } | undefined> {
    for (const delegation of await this.storage.readDelegations()) {
      const call = delegation.calls.find((candidate) => candidate.delegationCallId === delegationCallId);
      if (call) {
        return { delegation, call };
      }
    }
    return undefined;
  }

  async registerAwait(parentSessionId: string, parentTurnSeq: number, requestId: string, delegationCallId: string): Promise<DelegationCallRecord> {
    for (;;) {
      const found = await this.readCall(delegationCallId);
      if (!found || found.delegation.parentSessionId !== parentSessionId) {
        throw new Error(`DelegationCall ${delegationCallId} was not found for Parent Session ${parentSessionId}`);
      }
      if ((found.call.awaitRequests ?? []).some((request) => request.requestId === requestId)) {
        return found.call;
      }
      const now = this.clock.now();
      const updatedCall: DelegationCallRecord = {
        ...found.call,
        awaitRequests: [...(found.call.awaitRequests ?? []), {
          requestId,
          parentSessionId,
          parentTurnSeq,
          status: 'pending',
          requestedAt: now
        }],
        updatedAt: now
      };
      const next = { ...this.replaceCall(found.delegation, updatedCall), revision: found.delegation.revision + 1, updatedAt: now };
      if (await this.storage.compareAndSetDelegation(found.delegation.revision, next)) {
        return updatedCall;
      }
    }
  }

  async markAwaitResponded(delegationCallId: string, requestId: string): Promise<void> {
    for (;;) {
      const found = await this.readCall(delegationCallId);
      if (!found) {
        throw new Error(`DelegationCall ${delegationCallId} was not found`);
      }
      const requests = found.call.awaitRequests ?? [];
      const request = requests.find((candidate) => candidate.requestId === requestId);
      if (!request || request.status === 'responded') {
        return;
      }
      const now = this.clock.now();
      const updatedCall: DelegationCallRecord = {
        ...found.call,
        awaitRequests: requests.map((candidate) => candidate.requestId === requestId
          ? { ...candidate, status: 'responded' as const, respondedAt: now }
          : candidate),
        updatedAt: now
      };
      const next = { ...this.replaceCall(found.delegation, updatedCall), revision: found.delegation.revision + 1, updatedAt: now };
      if (await this.storage.compareAndSetDelegation(found.delegation.revision, next)) {
        return;
      }
    }
  }

  private async appendCall(delegation: DelegationRecord, input: StartDelegationCallInput, inputHash: string): Promise<StartDelegationCallResult> {
    if (delegation.status !== 'open' && delegation.status !== 'creating_child') {
      throw new Error(`Delegation ${delegation.delegationId} is ${delegation.status}`);
    }
    this.delegateAdmissionManager.validateInput(delegation.resolvedDelegate, input.input);
    const queuedCount = delegation.calls.filter((call) => call.status === 'queued').length;
    if (queuedCount >= delegation.resolvedDelegate.maxQueuedCalls) {
      throw new Error(`Delegation ${delegation.delegationId} call queue is full`);
    }
    const now = this.clock.now();
    const call = this.createCall(delegation.delegationId, delegation.nextCallSeq, input, inputHash, delegation.resolvedDelegate.deadlineMs, now);
    const next: DelegationRecord = {
      ...delegation,
      calls: [...delegation.calls, call],
      nextCallSeq: delegation.nextCallSeq + 1,
      revision: delegation.revision + 1,
      updatedAt: now
    };
    if (!await this.storage.compareAndSetDelegation(delegation.revision, next)) {
      const latest = await this.storage.readDelegation(delegation.delegationId);
      if (!latest) {
        throw new Error(`Delegation ${delegation.delegationId} disappeared during call append`);
      }
      const retry = latest.calls.find((candidate) => candidate.callerTurnSeq === input.callerTurnSeq && candidate.callerToolRequestId === input.callerToolRequestId);
      if (retry) {
        if (retry.inputHash !== inputHash) {
          throw new Error('delegation call idempotency key was reused with different input');
        }
        return { delegation: latest, call: retry };
      }
      return this.appendCall(latest, input, inputHash);
    }
    if (next.status === 'creating_child') {
      return { delegation: await this.ensureChildAndOpen(next, input.parentSession), call };
    }
    return { delegation: next, call };
  }

  private async ensureChildAndOpen(delegation: DelegationRecord, parentSession: SessionRecord): Promise<DelegationRecord> {
    await this.ensureChildSession(delegation, parentSession);
    let current = await this.storage.readDelegation(delegation.delegationId) ?? delegation;
    while (current.status === 'creating_child') {
      const opened = { ...current, status: 'open' as const, revision: current.revision + 1, updatedAt: this.clock.now() };
      if (await this.storage.compareAndSetDelegation(current.revision, opened)) {
        return opened;
      }
      const latest = await this.storage.readDelegation(delegation.delegationId);
      if (!latest) {
        throw new Error(`Delegation ${delegation.delegationId} disappeared while opening`);
      }
      current = latest;
    }
    if (current.status !== 'open') {
      throw new Error(`Delegation ${current.delegationId} became ${current.status} while opening`);
    }
    return current;
  }

  private async ensureChildSession(delegation: DelegationRecord, parentSession: SessionRecord): Promise<void> {
    await this.sessionLifecycleManager.create({
      sessionId: delegation.childSessionId,
      tenantId: this.tenantId,
      owner: parentSession.owner,
      resolvedAgentSpec: delegation.resolvedCalleeAgentSpec,
      workspaceRef: delegation.childSessionId,
      // The delegated scan routes to exactly one Central-authoritative device on the case roster. `case` = the
      // parent recovery session id and `deviceRef` = the validated target; both are minted by Central onto the
      // paired worker (never client-supplied), so this narrows within the callee AgentSpec's base workerSelector
      // and can only pin to a device already bound to THIS parent's case and tenant — never redirect or widen.
      // A call with no target is an explicit stateless pool/`any` task: it imposes no extra labels and is placed
      // by ordinary least-loaded routing within the callee AgentSpec's base selector. There is no client-supplied
      // worker-label pinning — device routing identity comes only from the Central-validated deviceRef.
      requiredWorkerLabels: delegation.targetRef
        ? { [EDGE_CASE_LABEL_KEY]: parentSession.sessionId, [EDGE_DEVICE_REF_LABEL_KEY]: delegation.targetRef }
        : undefined,
      delegationBinding: {
        delegationId: delegation.delegationId,
        parentSessionId: parentSession.sessionId,
        delegateId: delegation.resolvedDelegate.id
      }
    });
  }

  /**
   * A device-pinned target must resolve to an active binding on THIS parent's case roster (`caseId` = the parent
   * recovery session id) within this tenant. This is the authorization seam that prevents a caller from escaping the
   * case/tenant boundary: even though the tool payload can name any `deviceRef`, Central only pins the child to a
   * device the operator has actually paired into this case. An absent target is a pool task and is not validated here.
   */
  private async validateTargetRef(parentSession: SessionRecord, targetRef: string | undefined): Promise<void> {
    if (!targetRef) {
      return;
    }
    const binding = await this.storage.readCaseDeviceBinding(parentSession.sessionId, targetRef);
    if (!binding || binding.tenantId !== this.tenantId || binding.caseId !== parentSession.sessionId) {
      throw new Error(`target device ${targetRef} is not paired to case ${parentSession.sessionId}`);
    }
    if (binding.status !== 'active') {
      throw new Error(`target device ${targetRef} binding is ${binding.status}`);
    }
  }

  private assertParent(parent: SessionRecord, delegateId: string): void {
    if (parent.tenantId !== this.tenantId) {
      throw new Error(`Parent Session ${parent.sessionId} belongs to tenant ${parent.tenantId}`);
    }
    if (parent.delegationBinding) {
      throw new Error(`delegated Child Session ${parent.sessionId} cannot start delegation`);
    }
    if (!parent.resolvedAgentSpec.delegateRefs.asCaller.includes(delegateId)) {
      throw new Error(`AgentSpec ${parent.resolvedAgentSpec.agentSpecId} cannot call Delegate ${delegateId}`);
    }
  }

  private async findCallByCallerKey(parentSessionId: string, callerTurnSeq: number, callerToolRequestId: string): Promise<StartDelegationCallResult | undefined> {
    const delegation = (await this.storage.readDelegations()).find((candidate) => candidate.parentSessionId === parentSessionId && candidate.calls.some((call) => call.callerTurnSeq === callerTurnSeq && call.callerToolRequestId === callerToolRequestId));
    const call = delegation?.calls.find((candidate) => candidate.callerTurnSeq === callerTurnSeq && candidate.callerToolRequestId === callerToolRequestId);
    return delegation && call ? { delegation, call } : undefined;
  }

  private async updateByChildSession(childSessionId: string, update: (delegation: DelegationRecord, activeCall: DelegationCallRecord) => DelegationRecord): Promise<DelegationRecord> {
    for (;;) {
      const delegation = (await this.storage.readDelegations()).find((candidate) => candidate.childSessionId === childSessionId);
      if (!delegation || !delegation.activeCallId) {
        throw new Error(`Child Session ${childSessionId} has no active DelegationCall`);
      }
      const activeCall = delegation.calls.find((call) => call.delegationCallId === delegation.activeCallId);
      if (!activeCall) {
        throw new Error(`Delegation ${delegation.delegationId} active Call ${delegation.activeCallId} was not found`);
      }
      const candidate = update(delegation, activeCall);
      const next = { ...candidate, revision: delegation.revision + 1, updatedAt: this.clock.now() };
      if (await this.storage.compareAndSetDelegation(delegation.revision, next)) {
        return next;
      }
    }
  }

  private replaceCall(delegation: DelegationRecord, replacement: DelegationCallRecord): DelegationRecord {
    return {
      ...delegation,
      calls: delegation.calls.map((call) => call.delegationCallId === replacement.delegationCallId ? replacement : call)
    };
  }

  private createCall(delegationId: string, callSeq: number, input: StartDelegationCallInput, inputHash: string, deadlineMs: number, now: string): DelegationCallRecord {
    return {
      delegationCallId: randomUUID(),
      delegationId,
      callSeq,
      callerTurnSeq: input.callerTurnSeq,
      callerToolRequestId: input.callerToolRequestId,
      input: input.input,
      inputHash,
      status: 'queued',
      deadlineAt: new Date(Date.parse(now) + deadlineMs).toISOString(),
      createdAt: now,
      updatedAt: now
    };
  }

  private isTerminalCall(status: DelegationCallRecord['status']): boolean {
    return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'expired';
  }
}