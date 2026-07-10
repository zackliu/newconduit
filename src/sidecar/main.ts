import { WebPubSubClientAdapter } from './adapters';
import { defaultSidecarHostClassId, resolveSidecarHostAdapter, type SidecarBootstrap } from './host';
import { SidecarDaemon } from './sidecar-daemon';
import { resolveWorkerType } from './worker-types';

async function main(): Promise<void> {
  const hostClassId = process.env.SIDECAR_HOST_CLASS ?? defaultSidecarHostClassId();
  const hostAdapter = resolveSidecarHostAdapter(hostClassId);
  await hostAdapter.run(async (bootstrap: SidecarBootstrap) => {
    const profile = resolveWorkerType(bootstrap.workerTypeId);
    const daemon = new SidecarDaemon({
      runtimeTransport: new WebPubSubClientAdapter({ tenantId: bootstrap.tenantId }),
      workspaceAdapter: profile.createWorkspaceAdapter({ workRoot: bootstrap.workRoot }),
      agentProcessAdapter: profile.createAgentProcessAdapter()
    });
    await daemon.startStandaloneWorker({
      centralUrl: bootstrap.centralUrl,
      tenantId: bootstrap.tenantId,
      storageClass: profile.storageClass,
      labels: bootstrap.labels,
      description: bootstrap.description,
      capacity: bootstrap.capacity,
      allocatable: bootstrap.capacity
    });
    console.log(`sidecar daemon started as worker type ${profile.workerTypeId} via host ${hostClassId}`);
  });
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});