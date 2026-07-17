import type { ResolvedAgentSpec } from './agent-spec';

export type SessionStatus = 'created' | 'queued' | 'starting' | 'running' | 'pausing' | 'paused' | 'resuming' | 'completed' | 'cancelled' | 'failed';

export type InteractionKind = 'approval' | 'tool_call';

/**
 * A durable, session-owned obligation: the agent turn is suspended until an off-agent responder
 * answers. Persisted on the session record so it survives client disconnect and pause/resume.
 */
export interface OpenInteraction {
  interactionId: string;
  kind: InteractionKind;
  turnSeq: number;
  requestedAt: string;
  delegatedRoute?: {
    childSessionId: string;
    childInteractionId: string;
  };
}

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
  openInteractions?: OpenInteraction[];
  delegationBinding?: SessionDelegationBinding;
  lastEventUpdatedAt: string;
  createdAt: string;
  updatedAt: string;
}