import { COPILOT_LOCAL_PROCESS_SIDECAR_CLASS, COPILOT_PROCESS_WRAPPER_SIDECAR_CLASS, type SidecarClass } from '../shared';
import { CopilotProcessAdapter, DockerWorkspaceAdapter, LocalWorkspaceAdapter, WebPubSubClientAdapter } from './adapters';
import type { SidecarAgentProcessAdapter, SidecarRuntimeTransport, SidecarWorkspaceAdapter } from './contracts';

/**
 * A worker type names which sidecarClass, labels, capacity, and adapter classes a worker runs with. A worker
 * startup only references a worker type; it does not self-report sidecarClass/labels/capacity or wire adapters.
 */
export interface WorkerType {
  workerTypeId: string;
  sidecarClass: SidecarClass;
  labels: Record<string, string>;
  capacity: number;
  createRuntimeTransport(input: { tenantId: string }): SidecarRuntimeTransport;
  createWorkspaceAdapter(): SidecarWorkspaceAdapter;
  createAgentProcessAdapter(): SidecarAgentProcessAdapter;
}

const WORKER_TYPES: ReadonlyMap<string, WorkerType> = new Map<string, WorkerType>([
  [
    'copilot-process-wrapper',
    {
      workerTypeId: 'copilot-process-wrapper',
      sidecarClass: COPILOT_PROCESS_WRAPPER_SIDECAR_CLASS,
      labels: { agent: 'copilot' },
      capacity: 1,
      createRuntimeTransport: ({ tenantId }) => new WebPubSubClientAdapter({ tenantId }),
      createWorkspaceAdapter: () => new DockerWorkspaceAdapter(),
      createAgentProcessAdapter: () => new CopilotProcessAdapter()
    }
  ],
  [
    'copilot-local',
    {
      workerTypeId: 'copilot-local',
      sidecarClass: COPILOT_LOCAL_PROCESS_SIDECAR_CLASS,
      labels: { agent: 'local' },
      capacity: 99,
      createRuntimeTransport: ({ tenantId }) => new WebPubSubClientAdapter({ tenantId }),
      createWorkspaceAdapter: () => new LocalWorkspaceAdapter(),
      createAgentProcessAdapter: () => new CopilotProcessAdapter()
    }
  ],
  [
    'dotnet-process-wrapper',
    {
      workerTypeId: 'dotnet-process-wrapper',
      sidecarClass: COPILOT_PROCESS_WRAPPER_SIDECAR_CLASS,
      labels: { agent: 'dotnet' },
      capacity: 1,
      createRuntimeTransport: ({ tenantId }) => new WebPubSubClientAdapter({ tenantId }),
      createWorkspaceAdapter: () => new DockerWorkspaceAdapter(),
      createAgentProcessAdapter: () => new CopilotProcessAdapter()
    }
  ]
]);

export function resolveWorkerType(workerTypeId: string): WorkerType {
  const workerType = WORKER_TYPES.get(workerTypeId);
  if (!workerType) {
    throw new Error(`unknown WORKER_TYPE: ${workerTypeId}`);
  }
  return workerType;
}
