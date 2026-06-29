import { SidecarDaemon } from './sidecar-daemon';
import { resolveWorkerType } from './worker-types';

async function main(): Promise<void> {
  const centralUrl = process.env.CENTRAL_URL;
  const tenantId = process.env.TENANT_ID ?? 'poc';
  if (!centralUrl) {
    throw new Error('CENTRAL_URL is required to start sidecar');
  }
  const workerType = resolveWorkerType(process.env.WORKER_TYPE ?? 'copilot-process-wrapper');
  const daemon = new SidecarDaemon({
    runtimeTransport: workerType.createRuntimeTransport({ tenantId }),
    workspaceAdapter: workerType.createWorkspaceAdapter(),
    agentProcessAdapter: workerType.createAgentProcessAdapter()
  });
  await daemon.startStandaloneWorker({
    centralUrl,
    tenantId,
    sidecarClass: workerType.sidecarClass,
    labels: workerType.labels,
    description: sidecarDescription(),
    capacity: workerType.capacity,
    allocatable: workerType.capacity
  });
  console.log(`sidecar daemon started as worker type ${workerType.workerTypeId}`);
}

function sidecarDescription(): Record<string, string> | undefined {
  const workerPoolId = process.env.WORKER_POOL_ID;
  const workerPoolInstanceId = process.env.WORKER_POOL_INSTANCE_ID;
  if (!workerPoolId && !workerPoolInstanceId) {
    return undefined;
  }
  return {
    ...(workerPoolId ? { workerPoolId } : {}),
    ...(workerPoolInstanceId ? { workerPoolInstanceId } : {})
  };
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});