import type { ResolvedAgentSpec } from './agent-spec';

export type SessionStatus = 'created' | 'queued' | 'starting' | 'running' | 'pausing' | 'paused' | 'resuming' | 'completed' | 'cancelled' | 'failed';

export type InteractionKind = 'approval' | 'tool_call';

export interface SessionDelegationBinding {
  delegationId: string;
  parentSessionId: string;
  delegateId: string;
}

export interface SessionRecord {
  sessionId: string;
  tenantId: string;
  owner: string;
  resolvedAgentSpec: ResolvedAgentSpec;
  status: SessionStatus;
  currentWorkerId?: string;
  sessionLeaseId?: string;
  storageClass?: string;
  eventCursor: number;
  nextTurnSeq: number;
  workspaceRef: string;
  latestSnapshotRef?: string;
  lifecycleReason?: string;
  delegationBinding?: SessionDelegationBinding;
  lastEventUpdatedAt: string;
  createdAt: string;
  updatedAt: string;
}