import type { ResolvedAgentSpec } from './agent-spec';
import type { DelegateTargetPolicy } from './delegate';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/**
 * The operator's device-routing intent for a single parent turn, carried as trusted structured control metadata on
 * the session input — never encoded in the agent's natural-language message. Central durably associates it with the
 * turn it accepts and treats it as the authoritative delegation target when the matching delegate tool fires: the
 * agent's own tool `target` may repeat it but cannot widen or change it. `scope: 'all'` fans out to every device on
 * the case roster; `deviceRefs` names an explicit subset (e.g. a failed-only retry); `deviceRef` pins one device;
 * `scope: 'any'` is an explicit stateless pool task (only honoured by non-device delegates).
 */
export type DelegationTarget =
  | { scope: 'all' }
  | { scope: 'any' }
  | { deviceRef: string }
  | { deviceRefs: string[] };

export interface ResolvedDelegate {
  id: string;
  toolName: string;
  description: string;
  digest: string;
  maxInputBytes: number;
  maxResultBytes: number;
  deadlineMs: number;
  maxQueuedCalls: number;
  targetPolicy: DelegateTargetPolicy;
}

export type DelegationStatus = 'creating_child' | 'open' | 'closing' | 'closed' | 'failed';

export type DelegationCloseReason =
  | 'parent_terminal'
  | 'active_call_cancelled'
  | 'active_call_expired'
  | 'active_call_failed'
  | 'child_terminal';

export type DelegationCallStatus =
  | 'queued'
  | 'active'
  | 'cancel_requested'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired';

export interface DelegationFailure {
  code: string;
  message: string;
}

export interface DelegationCallDispatch {
  childTurnSeq: number;
  inputEventId: string;
  commandEventId: string;
  commandState: 'pending' | 'accepted';
}

export interface DelegationCallAwaitRequest {
  requestId: string;
  parentSessionId: string;
  parentTurnSeq: number;
  status: 'pending' | 'responded';
  requestedAt: string;
  respondedAt?: string;
}

export interface DelegationCallRecord {
  delegationCallId: string;
  delegationId: string;
  callSeq: number;
  callerTurnSeq: number;
  callerToolRequestId: string;
  input: string;
  inputHash: string;
  status: DelegationCallStatus;
  dispatch?: DelegationCallDispatch;
  awaitRequests?: DelegationCallAwaitRequest[];
  result?: string;
  resultDigest?: string;
  failure?: DelegationFailure;
  cancelReason?: 'caller' | 'deadline' | 'parent_terminal';
  deadlineAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface DelegationRecord {
  delegationId: string;
  tenantId: string;
  parentSessionId: string;
  childSessionId: string;
  resolvedDelegate: ResolvedDelegate;
  resolvedCalleeAgentSpec: ResolvedAgentSpec;
  status: DelegationStatus;
  // The Central-validated device this delegation is pinned to (a case roster `deviceRef`). Part of the delegation
  // key alongside (parentSessionId, delegateId), so targeting device A then device B opens two separate delegations
  // and two separate Child Sessions. Absent = an explicit pool/`any` target with no device pin.
  targetRef?: string;
  activeCallId?: string;
  nextCallSeq: number;
  closeReason?: DelegationCloseReason;
  failure?: DelegationFailure;
  calls: DelegationCallRecord[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDelegationResult {
  delegation: DelegationRecord;
  created: boolean;
}