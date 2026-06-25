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
    labels: parseLabels(process.env.SIDECAR_LABELS_JSON) ?? { agent: 'copilot' },
    description: sidecarDescription(),
    capacity: Number(process.env.SIDECAR_CAPACITY ?? '1'),
    allocatable: Number(process.env.SIDECAR_CAPACITY ?? '1')
  });
  console.log('sidecar daemon started');
}

function parseLabels(value: string | undefined): Record<string, string> | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || !Object.values(parsed).every((entry) => typeof entry === 'string')) {
    throw new Error('SIDECAR_LABELS_JSON must be a JSON object with string values');
  }
  return parsed as Record<string, string>;
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