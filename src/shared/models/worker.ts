export type WorkerCondition = 'ready' | 'busy' | 'draining' | 'disconnected';
export type WorkerLifecycleState = 'registered' | 'active' | 'closed' | 'expired';

export interface WorkerRecord {
  workerId: string;
  tenantId: string;
  capacityScope: string;
  /** Host attempt that created this sidecar process; absent for standalone workers. */
  hostPoolInstanceId?: string;
  labels: Record<string, string>;
  storageClass: string;
  // Resolved from the owning WorkerPool at correlation. `false` = no-reuse: central binds the worker to the first
  // session placed on it (`boundSessionId`) and never places a different session on it. Absent/`true` = shared.
  reuse?: boolean;
  description?: Record<string, string>;
  capacity: number;
  allocatable: number;
  conditions: WorkerCondition[];
  lifecycleState: WorkerLifecycleState;
  heartbeatAt: string;
  expiresAt: string;
  // Wall-clock time this worker lifetime first registered; never changed by heartbeats. Used only as a
  // deterministic newest-wins tiebreak when a session is pinned to a label shared by duplicate/reloaded tabs.
  registeredAt?: string;
  currentSessionCount: number;
  // Set on a no-reuse worker when its first session is assigned. Only this session id may be (re)placed here.
  boundSessionId?: string;
  terminalReason?: string;
  updatedAt: string;
}

export interface WorkerRegisterPayload {
  hostPoolInstanceId?: string;
  labels: Record<string, string>;
  storageClass: string;
  description?: Record<string, string>;
  capacity: number;
  allocatable: number;
  /**
   * Proof a browser edge worker presents to claim a case-scoped device binding. When present, Central validates the
   * `bindingCredential` against the durable binding for (caseId, deviceRef) and MINTS the authoritative
   * `case`/`deviceRef` labels, stripping any client-supplied values for those keys. Absent for ordinary sidecars.
   */
  edgeBinding?: EdgeBindingPayload;
}

/**
 * The authorization envelope a browser edge worker sends at register/reconnect. `deviceId` is self-asserted
 * identity metadata only — it never authorizes anything on its own; the Central-issued `bindingCredential`
 * (obtained once by redeeming a one-time invite) is the proof. `deviceRef` is Central's opaque, deterministic
 * per-(tenant,case,device) id used as the device-pinned routing label.
 */
export interface EdgeBindingPayload {
  caseId: string;
  deviceId: string;
  deviceRef: string;
  bindingCredential: string;
}

export interface WorkerHeartbeatPayload {
  workerId: string;
  capacity: number;
  allocatable: number;
  conditions: WorkerCondition[];
}

export interface WorkerIdentityPayload {
  workerId: string;
}