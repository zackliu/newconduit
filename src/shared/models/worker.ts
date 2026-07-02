export type SidecarClass = string;
export type WorkerCondition = 'ready' | 'busy' | 'draining' | 'disconnected';
export type WorkerLifecycleState = 'registered' | 'active' | 'closed' | 'expired';

export interface WorkerRecord {
  workerId: string;
  tenantId: string;
  capacityScope: string;
  sidecarClass: SidecarClass;
  labels: Record<string, string>;
  description?: Record<string, string>;
  capacity: number;
  allocatable: number;
  conditions: WorkerCondition[];
  lifecycleState: WorkerLifecycleState;
  heartbeatAt: string;
  expiresAt: string;
  currentSessionCount: number;
  terminalReason?: string;
  updatedAt: string;
}

export interface WorkerRegisterPayload {
  sidecarClass: SidecarClass;
  labels: Record<string, string>;
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