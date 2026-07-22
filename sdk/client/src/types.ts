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
  parentSessionId?: string;
  status: SessionStatus;
  agentSpecId: string;
  owner: string;
  /** The worker this session is currently assigned to, when running. The console matches it against a
   * {@link CaseDeviceView.workerId} to attribute a delegated scan child to the paired device it landed on. */
  currentWorkerId?: string;
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

/**
 * The operator's device-routing intent for one turn, sent as structured control metadata alongside the message —
 * never encoded in the message text. Central binds it to the accepted turn and enforces it authoritatively when the
 * parent agent's delegate tool fires: the agent may echo it but cannot widen or redirect it. `scope: 'all'` fans out
 * to every device on the case roster; `deviceRefs` names an explicit subset (e.g. a failed-only retry); `deviceRef`
 * pins one device; `scope: 'any'` is an explicit stateless pool task (only meaningful for non-device delegates).
 */
export type DelegationTarget =
  | { scope: 'all' }
  | { scope: 'any' }
  | { deviceRef: string }
  | { deviceRefs: string[] };

export interface SessionInput {
  message: string;
  /** Optional operator-authoritative delegation target for this turn. Only meaningful for a parent session that
   * delegates device scans; Central binds it to the turn and enforces it on the matching delegate call. */
  delegationTarget?: DelegationTarget;
}

export type SessionStatus = 'unknown' | 'created' | 'queued' | 'starting' | 'running' | 'pausing' | 'paused' | 'resuming' | 'completed' | 'cancelled' | 'failed';

/**
 * A one-time, short-lived pairing invite minted by {@link CaseClient.createPairingInvite}. The `inviteSecret` is
 * returned exactly once; the console places `inviteId.inviteSecret` only in the pair link's URL fragment. The
 * device redeems it (via the edge SDK) into a durable binding — the invite itself never authorizes routing.
 */
export interface PairingInvite {
  caseId: string;
  inviteId: string;
  inviteSecret: string;
  expiresAt: string;
}

/**
 * Safe, tenant- and case-scoped roster entry returned by {@link CaseClient.listDevices}. It joins a durable device
 * binding with live worker state so a paired device shows as joined the moment it registers — before any delegation
 * or observation. It exposes only the opaque `deviceRef` (never the raw deviceId or credential); the operator routes
 * a scan to a device by its `deviceRef`.
 */
export interface CaseDeviceView {
  deviceRef: string;
  deviceLabel: string;
  online: boolean;
  ready: boolean;
  busy: boolean;
  workerId?: string;
  lastHeartbeatAt?: string;
  lastRedeemedAt: string;
}

export interface TurnEventOptions {
  signal?: AbortSignal;
}

export interface WaitForResultOptions {
  signal?: AbortSignal;
}

export type InteractionKind = 'approval' | 'tool_call';

export interface DelegatedInteractionSource {
  kind: 'delegated_session';
  ownerSessionId: string;
  agentSpecId: string;
}

export interface InteractionResponseInput {
  interactionId: string;
  decision?: 'approved' | 'denied';
  scope?: 'once' | 'session';
  result?: unknown;
}

export interface InteractionResponseResult {
  status: 'resolved' | 'already_resolved';
}

export type AgentTurnEvent =
  | { type: 'turn.started'; sessionId: string; turnSeq: number }
  | { type: 'assistant.delta'; sessionId: string; turnSeq: number; text: string }
  | { type: 'agent.internal'; sessionId: string; turnSeq: number; label: string; detail?: unknown }
  | { type: 'agent.progress'; sessionId: string; turnSeq: number; message: string }
  | { type: 'tool.started'; sessionId: string; turnSeq: number; toolCallId: string; toolName: string; inputSummary?: unknown }
  | { type: 'tool.completed'; sessionId: string; turnSeq: number; toolCallId: string; toolName: string; outputSummary?: unknown }
  | { type: 'turn.completed'; sessionId: string; turnSeq: number; result: AgentTurnResult }
  | { type: 'turn.failed'; sessionId: string; turnSeq: number; error: AgentTurnError };

/**
 * SessionEvent is the single typed model for everything that happens in a session, across all turns.
 * It is the only stream a UI needs: subscribe once with session.observe() and render. assistant.delta
 * carries incremental text to append; turn.completed carries the final message for that turn.
 * interaction.requested surfaces a durable off-agent request (approval or client tool) that suspends the
 * turn until the app answers it with session.respondToInteraction(); interaction.responded marks it resolved.
 */
export type SessionEvent =
  | { type: 'user.message'; sessionId: string; turnSeq: number; text: string }
  | { type: 'status'; sessionId: string; turnSeq: number; status: SessionStatus }
  | { type: 'interaction.requested'; sessionId: string; turnSeq: number; interactionId: string; kind: InteractionKind; request: unknown; source?: DelegatedInteractionSource }
  | { type: 'interaction.responded'; sessionId: string; turnSeq: number; interactionId: string; kind: InteractionKind; response: unknown }
  | { type: 'interaction.interrupted'; sessionId: string; turnSeq: number; interactionId: string; kind: InteractionKind; reason: 'owner_lease_lost' | 'owner_turn_failed' | 'owner_session_terminal' }
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
  | 'case.pairing.mint.requested'
  | 'case.pairing.minted'
  | 'case.devices.requested'
  | 'case.devices.provided'
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
  | 'interaction.requested'
  | 'interaction.responded'
  | 'interaction.interrupted'
  | 'interaction.respond.requested'
  | 'interaction.responded.ack'
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
