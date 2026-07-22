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
  // Extra worker labels this session requires, AND-composed on top of the resolved AgentSpec's base
  // workerSelector. Central-owned and narrowing-only: it can only shrink the set of eligible workers within
  // the AgentSpec floor, never widen it or reach a different tenant. Used to pin a delegated child to one
  // specific paired worker.
  requiredWorkerLabels?: Record<string, string>;
  lastEventUpdatedAt: string;
  createdAt: string;
  updatedAt: string;
}