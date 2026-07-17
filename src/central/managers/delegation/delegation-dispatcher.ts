import { randomUUID } from 'node:crypto';
import type { Clock, DelegationCallRecord, DelegationRecord, RuntimeStorage } from '../../../shared';
import type { WorkerCommandOutput } from '../session/session-assignment-manager';
import type { DelegatedSessionManager } from './delegated-session-manager';

export interface DispatchDelegationCallResult {
  delegation: DelegationRecord;
  call: DelegationCallRecord;
  workerCommands: WorkerCommandOutput[];
  sessionCreatedEvent?: import('../../../shared').RuntimeEvent;
  sessionCatalogUpdatedEvent?: import('../../../shared').RuntimeEvent;
  needsReconcile: boolean;
}

export class DelegationDispatcher {
  private readonly reconcileTails = new Map<string, Promise<DispatchDelegationCallResult | undefined>>();

  constructor(
    private readonly storage: RuntimeStorage,
    private readonly clock: Clock,
    private readonly delegatedSessionManager: DelegatedSessionManager
  ) {}

  dispatchNext(delegationId: string): Promise<DispatchDelegationCallResult | undefined> {
    const previous = this.reconcileTails.get(delegationId) ?? Promise.resolve(undefined);
    const run = previous.then(() => this.dispatchNextOnce(delegationId));
    this.reconcileTails.set(delegationId, run);
    return run;
  }

  private async dispatchNextOnce(delegationId: string): Promise<DispatchDelegationCallResult | undefined> {
    let delegation = await this.storage.readDelegation(delegationId);
    if (!delegation || delegation.status !== 'open') {
      return undefined;
    }
    let call = delegation.activeCallId
      ? delegation.calls.find((candidate) => candidate.delegationCallId === delegation!.activeCallId)
      : undefined;

    if (!call) {
      call = delegation.calls.filter((candidate) => candidate.status === 'queued').sort((left, right) => left.callSeq - right.callSeq)[0];
      if (!call) {
        return undefined;
      }
      const child = await this.storage.readSession(delegation.childSessionId);
      if (!child) {
        throw new Error(`Child Session ${delegation.childSessionId} was not found for dispatch`);
      }
      const now = this.clock.now();
      const activeCall: DelegationCallRecord = {
        ...call,
        status: 'active',
        dispatch: {
          childTurnSeq: child.nextTurnSeq,
          inputEventId: randomUUID(),
          commandEventId: randomUUID(),
          commandState: 'pending'
        },
        updatedAt: now
      };
      const next: DelegationRecord = {
        ...delegation,
        activeCallId: activeCall.delegationCallId,
        calls: delegation.calls.map((candidate) => candidate.delegationCallId === activeCall.delegationCallId ? activeCall : candidate),
        revision: delegation.revision + 1,
        updatedAt: now
      };
      if (!await this.storage.compareAndSetDelegation(delegation.revision, next)) {
        return this.dispatchNextOnce(delegationId);
      }
      delegation = next;
      call = activeCall;
    }

    if (call.dispatch?.commandState === 'accepted') {
      return undefined;
    }

    const prepared = await this.delegatedSessionManager.prepareCall(delegation, call);
    return {
      delegation,
      call,
      workerCommands: prepared.workerCommands,
      sessionCreatedEvent: prepared.sessionCreatedEvent,
      sessionCatalogUpdatedEvent: prepared.sessionCatalogUpdatedEvent,
      needsReconcile: prepared.needsReconcile
    };
  }
}