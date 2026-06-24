import type { ResolvedAgentSpec } from './agent-spec';

export type SessionStatus = 'created' | 'queued' | 'starting' | 'running' | 'pausing' | 'paused' | 'resuming' | 'failed';

export interface SessionRecord {
  sessionId: string;
  tenantId: string;
  owner: string;
  resolvedAgentSpec: ResolvedAgentSpec;
  status: SessionStatus;
  currentWorkerId?: string;
  workerLeaseGeneration: number;
  eventCursor: number;
  workspaceRef: string;
  latestSnapshotRef?: string;
  lifecycleReason?: string;
  createdAt: string;
  updatedAt: string;
}