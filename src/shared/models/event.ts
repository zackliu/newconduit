import type { ResolvedAgentSpec } from './agent-spec';
import type { SessionStatus } from './session';

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
  | 'worker.command.rejected'
  | 'session.lease.lost';

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
}

export interface SessionInputCommandPayload {
  sessionId: string;
  workerId: string;
  sessionLeaseId: string;
  turnSeq: number;
  input: {
    message: string;
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

export interface WorkerCommandRejectedPayload {
  reason: 'stale_session_lease' | 'unknown_session' | 'agent_not_running';
  expectedSessionLeaseId?: string;
  receivedSessionLeaseId?: string;
}