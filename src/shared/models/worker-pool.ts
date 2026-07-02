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
  idleSince?: string;
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
  stoppedAt?: string;
}