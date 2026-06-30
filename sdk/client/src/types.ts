export interface AgentRuntimeClientOptions {
  centralUrl: string;
  tenantId: string;
}

export interface RuntimeConnectionGrant {
  url: string;
  expiresAt?: string;
  clientInbox?: Record<string, never>;
  clientPrivateInbox?: {
    clientConnectionId: string;
  };
}

export interface SessionSummary {
  sessionId: string;
  status: SessionStatus;
  agentSpecId: string;
  owner: string;
  eventCursor: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentSpecRef {
  agentSpecId: string;
  version?: string;
}

export interface StartSessionInput {
  agent: string | AgentSpecRef;
  input?: SessionInput;
  displayName?: string;
  description?: string;
  externalId?: string;
  workspace?: {
    source: 'empty';
  };
  metadata?: {
    labels?: Record<string, string>;
  };
}

export interface SessionInput {
  message: string;
}

export type SessionStatus = 'unknown' | 'created' | 'queued' | 'starting' | 'running' | 'pausing' | 'paused' | 'resuming' | 'completed' | 'cancelled' | 'failed';

export interface TurnEventOptions {
  signal?: AbortSignal;
}

export interface WaitForResultOptions {
  signal?: AbortSignal;
}

export type AgentTurnEvent =
  | { type: 'turn.started'; sessionId: string; turnSeq: number }
  | { type: 'assistant.delta'; sessionId: string; turnSeq: number; text: string }
  | { type: 'agent.internal'; sessionId: string; turnSeq: number; label: string; detail?: unknown }
  | { type: 'agent.progress'; sessionId: string; turnSeq: number; message: string }
  | { type: 'tool.started'; sessionId: string; turnSeq: number; toolCallId: string; toolName: string; inputSummary?: unknown }
  | { type: 'tool.completed'; sessionId: string; turnSeq: number; toolCallId: string; toolName: string; outputSummary?: unknown }
  | { type: 'approval.requested'; sessionId: string; turnSeq: number; approval: unknown }
  | { type: 'turn.completed'; sessionId: string; turnSeq: number; result: AgentTurnResult }
  | { type: 'turn.failed'; sessionId: string; turnSeq: number; error: AgentTurnError };

/**
 * SessionEvent is the single typed model for everything that happens in a session, across all turns.
 * It is the only stream a UI needs: subscribe once with session.observe() and render. assistant.delta
 * carries incremental text to append; turn.completed carries the final message for that turn.
 */
export type SessionEvent =
  | { type: 'user.message'; sessionId: string; turnSeq: number; text: string }
  | { type: 'status'; sessionId: string; turnSeq: number; status: SessionStatus }
  | AgentTurnEvent;

export interface SessionObserveOptions {
  signal?: AbortSignal;
  includeHistory?: boolean;
}


export interface AgentTurnResult {
  sessionId: string;
  turnSeq: number;
  message?: string;
  output?: unknown;
}

export interface AgentTurnError {
  message: string;
  code?: string;
  details?: unknown;
}

export interface CreateSessionInput {
  agent: AgentSpecRef;
  input?: SessionInput;
  displayName?: string;
  description?: string;
  externalId?: string;
  workspace: {
    source: 'empty';
  };
  metadata?: {
    labels?: Record<string, string>;
  };
}

export type SdkRuntimeEventType =
  | 'session.create.requested'
  | 'session.created.ack'
  | 'session.catalog.updated'
  | 'session.status.updated'
  | 'session.list.requested'
  | 'session.listed'
  | 'session.events.requested'
  | 'session.events.replayed'
  | 'input.received'
  | 'input.accepted.ack'
  | 'input.accepted'
  | 'agent.output'
  | 'turn.completed'
  | 'turn.failed'
  | 'status.changed'
  | 'session.pause.requested'
  | 'session.resume.requested'
  | 'session.cancel.requested'
  | 'session.created'
  | 'session.assign'
  | 'session.paused'
  | 'session.resumed'
  | 'session.cancelled'
  | 'session.lease.lost';

export interface SdkRuntimeEvent<TPayload = unknown> {
  eventId: string;
  sessionId?: string;
  workerId?: string;
  ackId?: string;
  turnSeq?: number;
  sequence: number;
  type: SdkRuntimeEventType;
  timestamp: string;
  actor: 'client' | 'central' | 'sidecar' | 'system';
  sessionLeaseId?: string;
  payload: TPayload;
}

export interface SdkSubscription {
  close(): Promise<void>;
}
