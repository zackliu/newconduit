/**
 * Agent Runtime Sidecar — Customer SDK public interface.
 *
 * Single TypeSpec source of truth for the public surface exported from
 * `sdk/client/src/index.ts`. It mirrors the SDK public protocol documented in
 * `public-protocol-spec-ch.md`. Keep this file in sync whenever the exported SDK
 * types, classes, or the public protocol change.
 *
 * Representation conventions (TypeSpec describes data + operations, while the SDK
 * is an object-oriented TypeScript API, so a few constructs are mapped on purpose):
 * - Objects the caller receives and then calls methods on (handles, subscriptions)
 *   are modeled as a data `model` carrying their public readonly state plus a
 *   companion `interface ...Operations` carrying their methods. A method that
 *   returns a live handle returns that handle's data `model`.
 * - `AbortSignal`, callback handlers, and `AsyncIterable<T>` have no direct TypeSpec
 *   form. They are represented by the `AbortSignal` scalar, documented callback
 *   notes, and the element type of the stream respectively.
 * - ISO-8601 timestamp strings are modeled as `utcDateTime`; monotonic integer
 *   counters (sequence, cursor, turn) as `safeint`.
 * - Every method is asynchronous at runtime (`Promise<T>`); the resolved value is
 *   shown as the operation return type.
 */
namespace AgentRuntimeSidecar.Sdk;

// ---------------------------------------------------------------------------
// Host / representation primitives
// ---------------------------------------------------------------------------

/** Host `AbortSignal` used to cancel streaming reads and waits. */
scalar AbortSignal;

/** An object with no properties (TypeScript `Record<string, never>`). */
model EmptyObject {}

// ---------------------------------------------------------------------------
// Value taxonomies
// ---------------------------------------------------------------------------

/** Lifecycle status of a durable session. */
union SessionStatus {
  "unknown",
  "created",
  "queued",
  "starting",
  "running",
  "pausing",
  "paused",
  "resuming",
  "completed",
  "cancelled",
  "failed",
}

/** Originator of a runtime event. */
union RuntimeActor {
  "client",
  "central",
  "sidecar",
  "system",
}

/** Closed taxonomy of runtime event envelope types. */
union SdkRuntimeEventType {
  "session.create.requested",
  "session.created.ack",
  "session.catalog.updated",
  "session.status.updated",
  "session.list.requested",
  "session.listed",
  "session.events.requested",
  "session.events.replayed",
  "input.received",
  "input.accepted.ack",
  "input.accepted",
  "agent.output",
  "turn.completed",
  "turn.failed",
  "status.changed",
  "session.pause.requested",
  "session.resume.requested",
  "session.cancel.requested",
  "session.created",
  "session.assign",
  "session.paused",
  "session.resumed",
  "session.cancelled",
  "session.lease.lost",
}

// ---------------------------------------------------------------------------
// Client construction & connection
// ---------------------------------------------------------------------------

/** Options for constructing an `AgentRuntimeClient`. */
model AgentRuntimeClientOptions {
  /** Base URL of the central service used for REST negotiate. */
  centralUrl: string;

  /** Tenant the client operates within. */
  tenantId: string;
}

/** Connection grant returned by `POST /client/negotiate`. */
model RuntimeConnectionGrant {
  /** Web PubSub client access URL. */
  url: string;

  /** Optional expiry of the access URL. */
  expiresAt?: utcDateTime;

  /** Present when the tenant client-inbox projection channel is granted. */
  clientInbox?: EmptyObject;

  /** Present when a connection-private inbox is granted. */
  clientPrivateInbox?: {
    clientConnectionId: string;
  };
}

// ---------------------------------------------------------------------------
// Session inputs & summaries
// ---------------------------------------------------------------------------

/** Reference to an AgentSpec by id and optional version. */
model AgentSpecRef {
  agentSpecId: string;
  version?: string;
}

/** A single user message delivered to a session. */
model SessionInput {
  message: string;
}

/** App-facing input for `SessionClient.start`. */
model StartSessionInput {
  /** AgentSpec id, or a full `AgentSpecRef`. */
  agent: string | AgentSpecRef;

  /** Optional initial message; when omitted no first user turn is recorded. */
  input?: SessionInput;

  displayName?: string;
  description?: string;

  /** Optional app-owned external identifier. */
  externalId?: string;

  /** Initial workspace source (POC supports an empty workspace). */
  workspace?: {
    source: "empty";
  };

  metadata?: {
    labels?: Record<string>;
  };
}

/** Wire payload central receives for `session.create.requested`. */
model CreateSessionInput {
  agent: AgentSpecRef;
  input?: SessionInput;
  displayName?: string;
  description?: string;
  externalId?: string;

  workspace: {
    source: "empty";
  };

  metadata?: {
    labels?: Record<string>;
  };
}

/** Catalog summary of a durable session. */
model SessionSummary {
  sessionId: string;
  status: SessionStatus;
  agentSpecId: string;
  owner: string;

  /** Highest event sequence persisted for the session. */
  eventCursor: safeint;

  createdAt: utcDateTime;
  updatedAt: utcDateTime;
}

/** Result of starting a session: a live session handle and its first turn. */
model StartSessionResult {
  /** Live session handle; methods are described by `SessionHandleOperations`. */
  session: SessionHandle;

  /** Live first-turn handle; methods are described by `AgentTurnOperations`. */
  turn: AgentTurn;
}

// ---------------------------------------------------------------------------
// Turn result & error
// ---------------------------------------------------------------------------

/** Final result of an agent turn. */
model AgentTurnResult {
  sessionId: string;
  turnSeq: safeint;
  message?: string;
  output?: unknown;
}

/** Failure detail for an agent turn. */
model AgentTurnError {
  message: string;
  code?: string;
  details?: unknown;
}

// ---------------------------------------------------------------------------
// Runtime event envelope
// ---------------------------------------------------------------------------

/** Envelope for every runtime event delivered over a runtime channel. */
model SdkRuntimeEvent<TPayload = unknown> {
  eventId: string;
  sessionId?: string;
  workerId?: string;

  /** Correlates a request with its acknowledgement / response. */
  ackId?: string;

  turnSeq?: safeint;

  /** Per-session monotonic sequence (0 on client-published requests). */
  sequence: safeint;

  type: SdkRuntimeEventType;
  timestamp: utcDateTime;
  actor: RuntimeActor;
  sessionLeaseId?: string;
  payload: TPayload;
}

// ---------------------------------------------------------------------------
// Typed session & turn events
// ---------------------------------------------------------------------------

model TurnStartedEvent {
  type: "turn.started";
  sessionId: string;
  turnSeq: safeint;
}

model AssistantDeltaEvent {
  type: "assistant.delta";
  sessionId: string;
  turnSeq: safeint;

  /** Incremental assistant text to append. */
  text: string;
}

model AgentInternalEvent {
  type: "agent.internal";
  sessionId: string;
  turnSeq: safeint;
  label: string;
  detail?: unknown;
}

model AgentProgressEvent {
  type: "agent.progress";
  sessionId: string;
  turnSeq: safeint;
  message: string;
}

model ToolStartedEvent {
  type: "tool.started";
  sessionId: string;
  turnSeq: safeint;
  toolCallId: string;
  toolName: string;
  inputSummary?: unknown;
}

model ToolCompletedEvent {
  type: "tool.completed";
  sessionId: string;
  turnSeq: safeint;
  toolCallId: string;
  toolName: string;
  outputSummary?: unknown;
}

model ApprovalRequestedEvent {
  type: "approval.requested";
  sessionId: string;
  turnSeq: safeint;
  approval: unknown;
}

model TurnCompletedEvent {
  type: "turn.completed";
  sessionId: string;
  turnSeq: safeint;
  result: AgentTurnResult;
}

model TurnFailedEvent {
  type: "turn.failed";
  sessionId: string;
  turnSeq: safeint;
  error: AgentTurnError;
}

/** Typed event covering one agent turn, discriminated by `type`. */
union AgentTurnEvent {
  turnStarted: TurnStartedEvent,
  assistantDelta: AssistantDeltaEvent,
  agentInternal: AgentInternalEvent,
  agentProgress: AgentProgressEvent,
  toolStarted: ToolStartedEvent,
  toolCompleted: ToolCompletedEvent,
  approvalRequested: ApprovalRequestedEvent,
  turnCompleted: TurnCompletedEvent,
  turnFailed: TurnFailedEvent,
}

model UserMessageEvent {
  type: "user.message";
  sessionId: string;
  turnSeq: safeint;
  text: string;
}

model SessionStatusEvent {
  type: "status";
  sessionId: string;
  turnSeq: safeint;
  status: SessionStatus;
}

/**
 * The single typed model for everything in a session across all turns; the only
 * stream a UI needs (`SessionHandleOperations.observe`). Every variant carries a
 * `type` discriminator: `user.message`, `status`, or any `AgentTurnEvent`.
 */
union SessionEvent {
  UserMessageEvent,
  SessionStatusEvent,
  AgentTurnEvent,
}

// ---------------------------------------------------------------------------
// Streaming option bags
// ---------------------------------------------------------------------------

model SessionObserveOptions {
  signal?: AbortSignal;

  /** Replay persisted history before live events (default true). */
  includeHistory?: boolean;
}

model TurnEventOptions {
  signal?: AbortSignal;
}

model WaitForResultOptions {
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Runtime channels (SdkWebPubSubRuntimeChannelMapper input)
// ---------------------------------------------------------------------------

model TenantInboxChannel {
  kind: "tenant-inbox";
}

model ClientInboxChannel {
  kind: "client-inbox";
}

model ClientPrivateInboxChannel {
  kind: "client-private-inbox";
  clientConnectionId: string;
}

model SessionEventsChannel {
  kind: "session-events";
  sessionId: string;
}

/** Logical runtime channel mapped to a Web PubSub group name, discriminated by `kind`. */
union SdkRuntimeChannel {
  tenantInbox: TenantInboxChannel,
  clientInbox: ClientInboxChannel,
  clientPrivateInbox: ClientPrivateInboxChannel,
  sessionEvents: SessionEventsChannel,
}

// ---------------------------------------------------------------------------
// Handle / subscription state (data carried by live objects)
// ---------------------------------------------------------------------------

/** Public readonly state of a live session handle. Methods: `SessionHandleOperations`. */
model SessionHandle {
  id: string;
}

/** Public readonly state of a live agent turn. Methods: `AgentTurnOperations`. */
model AgentTurn {
  id: string;

  /** Session-scoped monotonic turn identity. */
  sequence: safeint;
}

/** A live subscription handle. Methods: `SdkSubscriptionOperations`. */
model SdkSubscription {}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * Top-level SDK client. Construct with `AgentRuntimeClientOptions`. Exposes a
 * `sessions: SessionClient` accessor (modeled as the `SessionClient` interface).
 */
interface AgentRuntimeClient {
  /** Negotiate with central and start the Web PubSub client connection. */
  connect(): void;

  /**
   * Subscribe to tenant client-inbox projection events. At runtime takes a handler
   * callback `(event: SdkRuntimeEvent) => void` and returns a subscription.
   */
  subscribeClientEvents(): SdkSubscription;

  /** Close the connection and reject pending acknowledgements. */
  close(): void;
}

/** Session collection accessor (`AgentRuntimeClient.sessions`). */
interface SessionClient {
  /** List tenant-visible sessions from the central catalog. */
  list(): SessionSummary[];

  /** Start a new durable session and its first turn. */
  start(input: StartSessionInput): StartSessionResult;

  /** Open a local handle to an existing session (no lifecycle change). */
  open(sessionId: string): SessionHandle;
}

/** Methods of a live `SessionHandle`. */
interface SessionHandleOperations {
  /** Send a user message, starting the next turn. */
  send(input: SessionInput): AgentTurn;

  /** Read persisted session events after a sequence cursor. */
  history(afterSequence?: safeint): SdkRuntimeEvent<unknown>[];

  /** Current locally-known session status. */
  status(): SessionStatus;

  /**
   * Observe the full typed session event stream. Delivered at runtime as an
   * `AsyncIterable<SessionEvent>`; history is replayed first unless
   * `includeHistory` is false.
   */
  observe(options?: SessionObserveOptions): SessionEvent[];

  /** Request a pause of the session. */
  pause(): void;

  /** Request a resume of the session. */
  resume(): void;

  /** Request cancellation of the session. */
  cancel(reason?: string): void;
}

/** Methods of a live `AgentTurn`. */
interface AgentTurnOperations {
  /**
   * Observe the typed events for this turn. Delivered at runtime as an
   * `AsyncIterable<AgentTurnEvent>` ending with `turn.completed` or `turn.failed`.
   */
  events(options?: TurnEventOptions): AgentTurnEvent[];

  /** Await the terminal result, throwing on `turn.failed`. */
  waitForResult(options?: WaitForResultOptions): AgentTurnResult;
}

/** Methods of a live `SdkSubscription`. */
interface SdkSubscriptionOperations {
  /** Stop delivering events for this subscription. */
  close(): void;
}

/**
 * Maps logical runtime channels to Web PubSub group names
 * (`SdkWebPubSubRuntimeChannelMapper`). Construct with a `tenantId`.
 */
interface ChannelMapper {
  /** Resolve the Web PubSub group name for a runtime channel. */
  toGroup(channel: SdkRuntimeChannel): string;
}

/**
 * Map a raw runtime event into the typed `SessionEvent` model. Returns no value
 * (TypeScript `undefined`) when the event does not map to a session event.
 */
op mapSessionEvent(event: SdkRuntimeEvent<unknown>): SessionEvent;
