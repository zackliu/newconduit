export type HostPoolControllerClass = string;
export type HostPoolInstanceState = 'pending' | 'ready' | 'stopping' | 'stopped' | 'failed';

export interface WorkerPoolScalePolicy {
  scaleOutMaxPendingPerTick: number;
  scaleInIdleMs: number;
}

/**
 * Worker identity (labels + capacity) is declared once on the pool template. A scaled worker registers with
 * exactly these labels and capacity; the storage capability the worker offers is one of the template labels.
 */
export interface WorkerPoolTemplate {
  labels: Record<string, string>;
  capacity: number;
}

export interface WorkerPoolRecord {
  poolId: string;
  tenantId: string;
  template: WorkerPoolTemplate;
  hostPoolControllerClass: HostPoolControllerClass;
  scalePolicy: WorkerPoolScalePolicy;
  centralUrlForWorkers: string;
  // Placement policy for this pool's workers. Absent/`true`: a worker is shared capacity any matching session may
  // use. `false` (no-reuse): central binds each worker to a single session identity — only that session may be
  // (re)placed on it, so a paused session resumes onto its own worker while it is still alive, and no other
  // session is ever queued onto it. Enforced by central at selection and scale-out.
  reuse?: boolean;
}

export interface HostPoolInstanceRecord {
  instanceId: string;
  tenantId: string;
  poolId: string;
  hostPoolControllerClass: HostPoolControllerClass;
  labels: Record<string, string>;
  capacity: number;
  state: HostPoolInstanceState;
  containerId?: string;
  workerId?: string;
  // No-reuse pools scale one instance per queued session and pin it here, so a host whose durable workspace is
  // keyed by session identity (e.g. a Foundry sandbox addressed by `workspaceRef`) is stable across pause/resume:
  // `boundSessionId` is the session the instance is dedicated to and `workspaceRef` is that session's durable
  // workspace handle. Absent on shared (reuse) pools, whose instances are fungible capacity.
  boundSessionId?: string;
  workspaceRef?: string;
  idleSince?: string;
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
  stoppedAt?: string;
}