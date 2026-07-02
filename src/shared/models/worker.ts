export type WorkerCondition = 'ready' | 'busy' | 'draining' | 'disconnected';
export type WorkerLifecycleState = 'registered' | 'active' | 'closed' | 'expired';

export interface WorkerRecord {
  workerId: string;
  tenantId: string;
  capacityScope: string;
  labels: Record<string, string>;
  storageClass: string;
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