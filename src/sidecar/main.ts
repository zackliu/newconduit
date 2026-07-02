import { WebPubSubClientAdapter } from './adapters';
import { SidecarDaemon } from './sidecar-daemon';
import { resolveWorkerType } from './worker-types';

async function main(): Promise<void> {
  const centralUrl = process.env.CENTRAL_URL;
  const tenantId = process.env.TENANT_ID ?? 'poc';
  if (!centralUrl) {
    throw new Error('CENTRAL_URL is required to start sidecar');
  }
  const workerTypeId = process.env.WORKER_TYPE;
  if (!workerTypeId) {
    throw new Error('WORKER_TYPE is required to start sidecar');
  }
  const labelsJson = process.env.SIDECAR_LABELS_JSON;
  if (!labelsJson) {
    throw new Error('SIDECAR_LABELS_JSON is required to start sidecar');
  }
  const capacity = Number(process.env.SIDECAR_CAPACITY);
  if (!Number.isInteger(capacity) || capacity <= 0) {
    throw new Error('SIDECAR_CAPACITY must be a positive integer');
  }
  const profile = resolveWorkerType(workerTypeId);
  const daemon = new SidecarDaemon({
    runtimeTransport: new WebPubSubClientAdapter({ tenantId }),
    workspaceAdapter: profile.createWorkspaceAdapter(),
    agentProcessAdapter: profile.createAgentProcessAdapter()
  });
  await daemon.startStandaloneWorker({
    centralUrl,
    tenantId,
    storageClass: profile.storageClass,
    labels: JSON.parse(labelsJson) as Record<string, string>,
    description: sidecarDescription(),
    capacity,
    allocatable: capacity
  });
  console.log(`sidecar daemon started as worker type ${profile.workerTypeId}`);
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