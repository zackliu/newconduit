import { CopilotProcessAdapter, DockerWorkspaceAdapter, WebPubSubClientAdapter } from './adapters';
import { SidecarDaemon } from './sidecar-daemon';
import { COPILOT_PROCESS_WRAPPER_SIDECAR_CLASS } from '../shared';

async function main(): Promise<void> {
  const centralUrl = process.env.CENTRAL_URL;
  const tenantId = process.env.TENANT_ID ?? 'poc';
  if (!centralUrl) {
    throw new Error('CENTRAL_URL is required to start sidecar');
  }
  const daemon = new SidecarDaemon({
    runtimeTransport: new WebPubSubClientAdapter({ tenantId }),
    workspaceAdapter: new DockerWorkspaceAdapter(),
    agentProcessAdapter: new CopilotProcessAdapter()
  });
  await daemon.startStandaloneWorker({
    centralUrl,
    tenantId,
    sidecarClass: COPILOT_PROCESS_WRAPPER_SIDECAR_CLASS,
    labels: { agent: 'copilot' },
    capacity: 1,
    allocatable: 1
  });
  console.log('sidecar daemon started');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});