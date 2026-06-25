import type { ResolvedAgentSpec } from './agent-spec';

export type SessionStatus = 'created' | 'queued' | 'starting' | 'running' | 'pausing' | 'paused' | 'resuming' | 'completed' | 'cancelled' | 'failed';

export interface SessionRecord {
  sessionId: string;
  tenantId: string;
  owner: string;
  resolvedAgentSpec: ResolvedAgentSpec;
  status: SessionStatus;
  currentWorkerId?: string;
  sessionLeaseId?: string;
  eventCursor: number;
  nextTurnSeq: number;
  workspaceRef: string;
  latestSnapshotRef?: string;
  lifecycleReason?: string;
  lastEventUpdatedAt: string;
  createdAt: string;
  updatedAt: string;
}