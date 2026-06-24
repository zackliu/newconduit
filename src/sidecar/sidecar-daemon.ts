import { POC_RUNTIME_HTTP_PATHS, POC_RUNTIME_HTTP_QUERY, type RuntimeConnectionGrant, type WorkerRegisterPayload } from '../shared';
import type { SidecarAgentProcessAdapter, SidecarRuntimeTransport, SidecarWorkspaceAdapter, WorkerRegistrationEventFactory } from './contracts';

export interface StandaloneSidecarStartInput extends WorkerRegisterPayload {
  centralUrl: string;
  tenantId: string;
}

export interface SidecarDaemonOptions {
  runtimeTransport: SidecarRuntimeTransport;
  workspaceAdapter: SidecarWorkspaceAdapter;
  agentProcessAdapter: SidecarAgentProcessAdapter;
  workerRegistrationEvents: WorkerRegistrationEventFactory;
}

export class SidecarDaemon {
  constructor(private readonly options: SidecarDaemonOptions) {}

  async startStandaloneWorker(input: StandaloneSidecarStartInput): Promise<void> {
    const grant = await this.negotiateSidecarConnection(input.centralUrl, input.tenantId);
    await this.options.runtimeTransport.connect(grant.url);
    await this.options.runtimeTransport.publish({ kind: 'tenant-inbox' }, this.options.workerRegistrationEvents.createRegisterEvent({
      sidecarId: input.sidecarId,
      sidecarClass: input.sidecarClass,
      labels: input.labels,
      capacity: input.capacity,
      allocatable: input.allocatable
    }));
  }

  async startCopilot(input: { workspaceVolume: string; copilotSessionVolume: string }): Promise<void> {
    const mounted = this.options.workspaceAdapter.mount(input);
    await this.options.agentProcessAdapter.start(mounted);
  }

  async stop(): Promise<void> {
    await this.options.runtimeTransport.stop();
  }

  private async negotiateSidecarConnection(centralUrl: string, tenantId: string): Promise<RuntimeConnectionGrant> {
    const url = new URL(POC_RUNTIME_HTTP_PATHS.sidecarNegotiate, centralUrl);
    url.searchParams.set(POC_RUNTIME_HTTP_QUERY.tenantId, tenantId);
    const response = await fetch(url, { method: 'POST' });
    if (!response.ok) {
      throw new Error(`sidecar negotiate failed with HTTP ${response.status}`);
    }
    return await response.json() as RuntimeConnectionGrant;
  }
}