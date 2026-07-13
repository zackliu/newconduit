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