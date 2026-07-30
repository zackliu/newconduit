/**
 * Worker-side runtime protocol, re-declared for the browser edge worker.
 *
 * Like the customer client SDK (which re-declares its client-visible subset instead of importing `src/`),
 * this module re-declares only the worker-facing runtime contract the edge worker actually speaks:
 * the negotiate HTTP shape, the runtime-event envelope, the worker command payloads it consumes, and the
 * event payloads it publishes. The wire shapes here MUST stay byte-compatible with the central runtime in
 * `src/shared`; the integration test drives a real `CentralService` to prove that alignment.
 */

export const EDGE_WORKER_HTTP_PATHS = {
  sidecarNegotiate: '/sidecar/negotiate',
  casePairingRedeem: '/cases/pair/redeem'
} as const;

export const EDGE_WORKER_HTTP_QUERY = {
  tenantId: 'tenantId'
} as const;

/** Channels the edge worker reads commands from and publishes results to. */
export type EdgeRuntimeChannel =
  | { kind: 'tenant-inbox' }
  | { kind: 'worker-commands'; workerId: string };

export type EdgeRuntimeActor = 'client' | 'central' | 'sidecar' | 'system';

export interface EdgeRuntimeEvent<TPayload = unknown> {
  eventId: string;
  sessionId?: string;
  workerId?: string;
  ackId?: string;
  turnSeq?: number;
  sequence: number;
  type: string;
  timestamp: string;
  actor: EdgeRuntimeActor;
  sessionLeaseId?: string;
  payload: TPayload;
}

// ---------------------------------------------------------------------------
// Registration + heartbeat (worker -> central)
// ---------------------------------------------------------------------------

export interface WorkerRegisterPayload {
  hostPoolInstanceId?: string;
  labels: Record<string, string>;
  storageClass: string;
  description?: Record<string, string>;
  capacity: number;
  allocatable: number;
  /** Present only for a browser edge worker enrolled into a case; Central mints the case/deviceRef labels from it. */
  edgeBinding?: EdgeBindingPayload;
}

/**
 * Authorization envelope a browser edge worker presents at register/reconnect. `deviceId` is self-asserted identity
 * metadata only; the Central-issued `bindingCredential` (from redeeming a one-time invite) is the actual proof.
 */
export interface EdgeBindingPayload {
  caseId: string;
  deviceId: string;
  deviceRef: string;
  bindingCredential: string;
}

/** Body of the edge enrollment POST `/cases/pair/redeem`, sent once after an explicit user action on the device. */
export interface PairingRedeemRequest {
  inviteId: string;
  inviteSecret: string;
  deviceId: string;
  deviceLabel: string;
}

/** Central's response to a successful redeem. The binding credential is returned exactly once. */
export interface PairingRedeemResult {
  caseId: string;
  deviceRef: string;
  bindingCredential: string;
}

export type WorkerCondition = 'ready' | 'busy' | 'draining' | 'disconnected';

export interface WorkerRecord {
  workerId: string;
  tenantId: string;
  labels: Record<string, string>;
  storageClass: string;
  capacity: number;
  allocatable: number;
  conditions: WorkerCondition[];
}

export interface RuntimeConnectionGrant {
  url: string;
  expiresAt?: string;
  worker?: WorkerRecord;
}

export interface WorkerHeartbeatPayload {
  workerId: string;
  capacity: number;
  allocatable: number;
  conditions: WorkerCondition[];
}

/**
 * Central -> worker notification, delivered on the worker's own command channel, that a heartbeat was
 * rejected. A `terminal-worker` / `unknown-worker` reason means this worker id is permanently dead in central
 * (its keepalive lease expired while the tab was suspended, or its record was reaped), so the edge runtime must
 * re-register a fresh worker rather than continue heartbeating a dead id.
 */
export interface WorkerHeartbeatRejectedPayload {
  reason: string;
}

/** Central confirms that the exact durable terminal result event was accepted. */
export interface WorkerResultAcknowledgedPayload {
  resultEventId: string;
}

// ---------------------------------------------------------------------------
// Commands (central -> worker)
// ---------------------------------------------------------------------------

/** Minimal view of the resolved AgentSpec the edge worker receives on assignment. */
export interface AssignedAgentSpec {
  agentSpecId: string;
  instructions?: string;
  labels?: Record<string, string>;
  [extra: string]: unknown;
}

export interface SessionAssignPayload {
  sessionId: string;
  workerId: string;
  sessionLeaseId: string;
  workspaceRef: string;
  copilotSessionStateRef: string;
  resolvedAgentSpec: AssignedAgentSpec;
  restore?: unknown;
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

export interface SessionPauseCommandPayload {
  sessionId: string;
  workerId: string;
  sessionLeaseId: string;
  reason?: 'idle_timeout' | 'client_requested' | 'parent_terminal';
  capture?: {
    snapshotId: string;
    storageClass: string;
    handle: string;
  };
}

// ---------------------------------------------------------------------------
// Results (worker -> central), published on tenant-inbox
// ---------------------------------------------------------------------------

export interface AgentOutputPayload {
  message?: string;
  delta?: string;
  progress?: string;
  output?: unknown;
  internalEvent?: {
    type: string;
    data?: unknown;
  };
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
  status: 'running' | 'failed';
  reason?: string;
}

export interface SessionPausedPayload {
  reason?: 'idle_timeout' | 'client_requested' | 'parent_terminal';
  snapshot?: {
    snapshotId: string;
    parts: string[];
  };
}

export interface WorkerCommandAcceptedPayload {
  commandEventId: string;
  turnSeq: number;
}

export interface WorkerCommandRejectedPayload {
  reason: 'stale_session_lease' | 'unknown_session' | 'agent_not_running' | 'turn_input_conflict';
  expectedSessionLeaseId?: string;
  receivedSessionLeaseId?: string;
}
