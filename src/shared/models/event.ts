import type { ResolvedAgentSpec } from './agent-spec';
import type { DelegationTarget, JsonValue } from './delegation';
import type { InteractionKind, SessionStatus } from './session';
import type { SnapshotCaptureRef, SnapshotPartName, SnapshotRestoreRef } from './snapshot';

export type RuntimeEventType =
  | 'session.create.requested'
  | 'session.created'
  | 'session.created.ack'
  | 'session.catalog.updated'
  | 'session.status.updated'
  | 'session.list.requested'
  | 'session.listed'
  | 'session.events.requested'
  | 'session.events.replayed'
  | 'case.pairing.mint.requested'
  | 'case.pairing.minted'
  | 'case.devices.requested'
  | 'case.devices.provided'
  | 'session.assign'
  | 'session.input'
  | 'input.received'
  | 'input.accepted'
  | 'input.accepted.ack'
  | 'agent.output'
  | 'turn.completed'
  | 'turn.failed'
  | 'status.changed'
  | 'session.pause.requested'
  | 'snapshot.created'
  | 'session.paused'
  | 'session.resume.requested'
  | 'session.resumed'
  | 'session.cancel.requested'
  | 'session.cancelled'
  | 'worker.registered'
  | 'worker.heartbeat'
  | 'worker.drain.requested'
  | 'worker.draining'
  | 'worker.close.requested'
  | 'worker.closed'
  | 'worker.expired'
  | 'worker.heartbeat.rejected'
  | 'worker.command.accepted'
  | 'worker.command.rejected'
  | 'session.lease.lost'
  | 'agent.interaction.requested'
  | 'interaction.requested'
  | 'interaction.responded'
  | 'interaction.interrupted'
  | 'interaction.respond.requested'
  | 'interaction.responded.ack'
  | 'session.interaction.response'
  | 'runtime.tool.requested'
  | 'session.runtime.tool.response';

export interface RuntimeEvent<TPayload = unknown> {
  eventId: string;
  sessionId?: string;
  workerId?: string;
  ackId?: string;
  turnSeq?: number;
  sequence: number;
  type: RuntimeEventType;
  timestamp: string;
  actor: 'client' | 'central' | 'sidecar' | 'system';
  sessionLeaseId?: string;
  payload: TPayload;
}

export interface SessionAssignPayload {
  sessionId: string;
  workerId: string;
  sessionLeaseId: string;
  workspaceRef: string;
  copilotSessionStateRef: string;
  resolvedAgentSpec: ResolvedAgentSpec;
  restore?: SnapshotRestoreRef;
}

export interface SessionInputCommandPayload {
  sessionId: string;
  workerId: string;
  sessionLeaseId: string;
  turnSeq: number;
  input: {
    message: string;
    /** Operator-authoritative delegation target for this turn, forwarded verbatim so a delegating agent adapter can
     * read it as structured control metadata. Central independently enforces it — the worker's copy is not trusted. */
    delegationTarget?: DelegationTarget;
  };
}

export interface AgentOutputPayload {
  message?: string;
  delta?: string;
  progress?: string;
  toolStarted?: {
    toolCallId: string;
    toolName: string;
    inputSummary?: unknown;
  };
  toolCompleted?: {
    toolCallId: string;
    toolName: string;
    outputSummary?: unknown;
  };
  approvalRequested?: unknown;
  internalEvent?: {
    type: string;
    data?: unknown;
  };
  output?: unknown;
  error?: {
    message: string;
    code?: string;
    details?: unknown;
  };
}

export interface TurnCompletedPayload {
  result: {
    message?: string;
    output?: unknown;
  };
}

export interface TurnFailedPayload {
  error: {
    message: string;
    code?: string;
    details?: unknown;
  };
}

export interface StatusChangedPayload {
  status: Extract<SessionStatus, 'running' | 'failed'>;
  reason?: string;
}

export interface SessionPauseRequestedPayload {
  reason?: 'idle_timeout' | 'client_requested' | 'parent_terminal';
}

export interface SessionPausedPayload {
  reason?: 'idle_timeout' | 'client_requested' | 'parent_terminal';
  snapshot?: {
    snapshotId: string;
    parts: SnapshotPartName[];
  };
}

export interface SnapshotCreatedPayload {
  snapshotId: string;
  baseEventCursor: number;
}

export interface SessionResumeRequestedPayload {
  reason?: 'client_requested' | 'delegation_call';
}

export interface SessionPauseCommandPayload {
  sessionId: string;
  workerId: string;
  sessionLeaseId: string;
  reason?: 'idle_timeout' | 'client_requested' | 'parent_terminal';
  capture?: SnapshotCaptureRef;
}

export interface WorkerCommandRejectedPayload {
  reason: 'stale_session_lease' | 'unknown_session' | 'agent_not_running' | 'turn_input_conflict';
  expectedSessionLeaseId?: string;
  receivedSessionLeaseId?: string;
}

export interface WorkerCommandAcceptedPayload {
  commandEventId: string;
  turnSeq: number;
}

/** Sidecar ingress for an agent-runtime pending request. Not exposed as a public Session event. */
export interface AgentInteractionRequestedPayload {
  adapterRequestId: string;
  kind: InteractionKind;
  request: unknown;
}

/** Central-authored public Session view of a canonical off-agent request. */
export interface InteractionRequestedPayload {
  interactionId: string;
  kind: InteractionKind;
  request: unknown;
  source?: {
    kind: 'delegated_session';
    ownerSessionId: string;
    agentSpecId: string;
  };
}

/** Central-owned fact that an interaction was resolved. `response` mirrors the kind's typed answer. */
export interface InteractionRespondedPayload {
  interactionId: string;
  kind: InteractionKind;
  response: unknown;
}

export interface InteractionInterruptedPayload {
  interactionId: string;
  kind: InteractionKind;
  reason: 'owner_lease_lost' | 'owner_turn_failed' | 'owner_session_terminal';
}

/** Client-authored command asking central to resolve an open interaction. */
export interface InteractionRespondRequestPayload {
  interactionId: string;
  decision?: 'approved' | 'denied';
  scope?: 'once' | 'session';
  result?: unknown;
}

export interface InteractionRespondedAckPayload {
  interactionId: string;
  status: 'resolved' | 'already_resolved' | 'rejected';
  error?: {
    code: string;
    message: string;
  };
}

/** Worker command routing a resolved interaction back to the leased worker. */
export interface SessionInteractionResponseCommandPayload {
  sessionId: string;
  workerId: string;
  sessionLeaseId: string;
  interactionId: string;
  adapterRequestId: string;
  kind: InteractionKind;
  response: unknown;
}

export interface RuntimeToolRequestedPayload {
  requestId: string;
  toolName: string;
  input: JsonValue;
}

export interface SessionRuntimeToolResponseCommandPayload {
  sessionId: string;
  workerId: string;
  sessionLeaseId: string;
  requestId: string;
  result: string;
}