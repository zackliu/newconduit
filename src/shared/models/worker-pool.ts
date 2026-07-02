import type { SidecarClass } from './worker';

export type HostPoolControllerClass = string;
export type HostPoolInstanceState = 'pending' | 'ready' | 'stopping' | 'stopped' | 'failed';

export interface WorkerPoolScalePolicy {
  scaleOutMaxPendingPerTick: number;
  scaleInIdleMs: number;
}

export interface WorkerPoolRecord {
  poolId: string;
  tenantId: string;
  sidecarClass: SidecarClass;
  labels: Record<string, string>;
  capacityPerWorker: number;
  hostPoolControllerClass: HostPoolControllerClass;
  scalePolicy: WorkerPoolScalePolicy;
  centralUrlForWorkers: string;
}

export interface HostPoolInstanceRecord {
  instanceId: string;
  tenantId: string;
  poolId: string;
  hostPoolControllerClass: HostPoolControllerClass;
  sidecarClass: SidecarClass;
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