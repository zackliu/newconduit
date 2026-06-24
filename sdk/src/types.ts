export interface AgentRuntimeClientOptions {
  centralUrl: string;
  tenantId: string;
}

export interface RuntimeConnectionGrant {
  url: string;
  expiresAt?: string;
  clientInbox?: {
    principalId: string;
  };
}

export interface AgentSpecRef {
  agentSpecId: string;
  version?: string;
}

export interface StartSessionInput {
  agent: string | AgentSpecRef;
  input: SessionInput;
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
  | { type: 'agent.progress'; sessionId: string; turnSeq: number; message: string }
  | { type: 'tool.started'; sessionId: string; turnSeq: number; toolCallId: string; toolName: string; inputSummary?: unknown }
  | { type: 'tool.completed'; sessionId: string; turnSeq: number; toolCallId: string; toolName: string; outputSummary?: unknown }
  | { type: 'approval.requested'; sessionId: string; turnSeq: number; approval: unknown }
  | { type: 'turn.completed'; sessionId: string; turnSeq: number; result: AgentTurnResult }
  | { type: 'turn.failed'; sessionId: string; turnSeq: number; error: AgentTurnError };

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
  input: SessionInput;
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
  | 'input.received'
  | 'input.accepted'
  | 'agent.output'
  | 'session.pause.requested'
  | 'session.resume.requested'
  | 'session.cancel.requested'
  | 'session.created'
  | 'session.assign'
  | 'session.paused'
  | 'session.resumed'
  | 'session.cancelled';

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
  workerLeaseGeneration?: number;
  payload: TPayload;
}

export interface SdkSubscription {
  close(): Promise<void>;
}
