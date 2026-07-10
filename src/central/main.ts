import { join } from 'node:path';
import { CentralService } from './central-service';
import { DockerHostPoolAdapter, FoundryHostPoolAdapter, WebPubSubTransportAdapter } from './adapters';
import { FileConfigStore, type HostPoolControllerConfig } from './config/file-config-store';
import { CentralHttpServer } from './http/central-http-server';
import { registerPocCentralRoutes } from './http/poc-routes';
import type { HostPoolAdapter } from './managers';
import type { TenantContext } from '../shared';

interface HostPoolAdapterContext {
  snapshotRoot: string;
}

// Generic registry of host-pool adapter implementations keyed by each adapter's self-declared classId. Config
// names an adapterKind; this map resolves it without enumerating any specific controller-class literal. Each
// factory reads its own adapter-specific fields off the controller config, so central never branches on kind.
const HOST_POOL_ADAPTER_FACTORIES: Record<string, (controller: HostPoolControllerConfig, context: HostPoolAdapterContext) => HostPoolAdapter> = {
  [DockerHostPoolAdapter.classId]: (controller, context) => new DockerHostPoolAdapter({
    imageName: requireConfigString(controller, 'imageName'),
    workerType: requireConfigString(controller, 'workerType'),
    snapshotRoot: context.snapshotRoot
  }),
  [FoundryHostPoolAdapter.classId]: (controller) => new FoundryHostPoolAdapter({
    projectEndpoint: requireConfigString(controller, 'projectEndpoint'),
    agentName: requireConfigString(controller, 'agentName'),
    workerType: requireConfigString(controller, 'workerType')
  })
};

function requireConfigString(controller: HostPoolControllerConfig, key: string): string {
  const value = controller[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`host-pool-controller '${controller.id}' (adapterKind '${controller.adapterKind}') requires string field '${key}'`);
  }
  return value;
}

async function main(): Promise<void> {
  const webPubSubEndpoint = process.env.WEBPUBSUB_ENDPOINT;
  if (!webPubSubEndpoint) {
    throw new Error('WEBPUBSUB_ENDPOINT is required to start central');
  }
  const webPubSubHub = process.env.WEBPUBSUB_HUB ?? 'agentruntimepoc';
  const tenantId = process.env.TENANT_ID ?? 'poc';
  const tenant: TenantContext = {
    tenantId,
    storageRoot: process.env.RUNTIME_STORAGE_ROOT ?? `.runtime-poc/tenants/${tenantId}`,
    webPubSubHub
  };
  const webPubSubTransportAdapter = new WebPubSubTransportAdapter({
    tenantId: tenant.tenantId,
    endpoint: webPubSubEndpoint,
    hubName: tenant.webPubSubHub
  });
  const centralPort = Number(process.env.CENTRAL_PORT ?? '3000');
  const centralUrlForWorkers = process.env.CENTRAL_URL_FOR_WORKERS ?? `http://host.docker.internal:${centralPort}`;
  const configStore = new FileConfigStore();
  const workerPools = configStore.loadWorkerPools({ tenantId: tenant.tenantId, centralUrlForWorkers });
  const hostPoolAdapters = buildHostPoolAdapters(configStore.loadHostPoolControllers(), join(tenant.storageRoot, 'snapshots'));
  const service = new CentralService({
    tenant,
    eventTransport: webPubSubTransportAdapter,
    connectionIssuer: webPubSubTransportAdapter,
    workerPools,
    hostPoolAdapters
  });
  await service.start();

  const server = new CentralHttpServer({ port: centralPort });
  registerPocCentralRoutes(server, service);
  const actualPort = await server.listen();
  console.log(`central service listening on http://localhost:${actualPort}`);
  for (const pool of workerPools) {
    console.log(`worker pool ${pool.poolId} will connect sidecars to ${pool.centralUrlForWorkers}`);
  }
}

function buildHostPoolAdapters(controllers: HostPoolControllerConfig[], snapshotRoot: string): Record<string, HostPoolAdapter> {
  const context: HostPoolAdapterContext = { snapshotRoot };
  const adapters: Record<string, HostPoolAdapter> = {};
  for (const controller of controllers) {
    const factory = HOST_POOL_ADAPTER_FACTORIES[controller.adapterKind];
    if (!factory) {
      throw new Error(`unknown host pool adapterKind: ${controller.adapterKind}`);
    }
    adapters[controller.id] = factory(controller, context);
  }
  return adapters;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});