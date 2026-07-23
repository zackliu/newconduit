import { WebPubSubClientAdapter } from './adapters';
import { defaultSidecarHostClassId, resolveSidecarHostAdapter, type SidecarBootstrap } from './host';
import { SidecarDaemon } from './sidecar-daemon';
import { resolveWorkerType } from './worker-types';

async function main(): Promise<void> {
  const hostClassId = process.env.SIDECAR_HOST_CLASS ?? defaultSidecarHostClassId();
  const hostAdapter = resolveSidecarHostAdapter(hostClassId);
  await hostAdapter.run(async (bootstrap: SidecarBootstrap) => {
    const profile = resolveWorkerType(bootstrap.workerTypeId);
    const agentProcessAdapter = profile.createAgentProcessAdapter();
    // Merge the concrete runtime's non-secret identity (e.g. real Copilot process + model/provider host) into the
    // Worker registration description so Central positively records what is behind the Worker, not just its labels.
    const runtimeIdentity = agentProcessAdapter.describeRuntime?.() ?? {};
    const description = { ...bootstrap.description, ...runtimeIdentity };
    const daemon = new SidecarDaemon({
      runtimeTransport: new WebPubSubClientAdapter({ tenantId: bootstrap.tenantId }),
      workspaceAdapter: profile.createWorkspaceAdapter({ workRoot: bootstrap.workRoot }),
      agentProcessAdapter
    });
    await daemon.startStandaloneWorker({
      centralUrl: bootstrap.centralUrl,
      tenantId: bootstrap.tenantId,
      hostPoolInstanceId: bootstrap.hostPoolInstanceId,
      storageClass: profile.storageClass,
      labels: bootstrap.labels,
      description: Object.keys(description).length > 0 ? description : undefined,
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