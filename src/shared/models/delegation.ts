import type { ResolvedAgentSpec } from './agent-spec';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface ResolvedDelegate {
  id: string;
  toolName: string;
  description: string;
  digest: string;
  maxInputBytes: number;
  maxResultBytes: number;
  deadlineMs: number;
  maxQueuedCalls: number;
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