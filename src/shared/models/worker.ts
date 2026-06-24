export type WorkerCondition = 'ready' | 'busy' | 'draining' | 'disconnected';

export interface WorkerRecord {
  workerId: string;
  tenantId: string;
  capacityScope: string;
  sidecarId: string;
  sidecarClass: 'copilot-process-wrapper';
  labels: Record<string, string>;
  capacity: number;
  allocatable: number;
  conditions: WorkerCondition[];
  heartbeatAt: string;
  currentSessionCount: number;
  hostingRef: string;
}