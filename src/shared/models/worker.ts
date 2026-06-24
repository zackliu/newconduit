export const COPILOT_PROCESS_WRAPPER_SIDECAR_CLASS = 'copilot-process-wrapper';

export type SidecarClass = typeof COPILOT_PROCESS_WRAPPER_SIDECAR_CLASS;
export type WorkerCondition = 'ready' | 'busy' | 'draining' | 'disconnected';
export type WorkerLifecycleState = 'active' | 'closed' | 'expired';

export interface WorkerRecord {
  workerId: string;
  tenantId: string;
  capacityScope: string;
  sidecarId: string;
  sidecarClass: SidecarClass;
  labels: Record<string, string>;
  capacity: number;
  allocatable: number;
  conditions: WorkerCondition[];
  lifecycleState: WorkerLifecycleState;
  heartbeatAt: string;
  expiresAt: string;
  generation: number;
  currentSessionCount: number;
  terminalReason?: string;
  updatedAt: string;
}

export interface WorkerRegisterPayload {
  sidecarId: string;
  sidecarClass: SidecarClass;
  labels: Record<string, string>;
  capacity: number;
  allocatable: number;
}

export interface WorkerHeartbeatPayload {
  workerId: string;
  generation: number;
  capacity: number;
  allocatable: number;
  conditions: WorkerCondition[];
}

export interface WorkerIdentityPayload {
  workerId: string;
  generation: number;
}