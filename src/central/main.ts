import { join } from 'node:path';
import { CentralService } from './central-service';
import { DockerHostPoolAdapter, WebPubSubTransportAdapter } from './adapters';
import { FileConfigStore, type HostPoolControllerConfig } from './config/file-config-store';
import { CentralHttpServer } from './http/central-http-server';
import { registerPocCentralRoutes } from './http/poc-routes';
import type { HostPoolAdapter } from './managers';
import type { TenantContext } from '../shared';

// Generic registry of host-pool adapter implementations keyed by each adapter's self-declared classId. Config
// names an adapterKind; this map resolves it without enumerating any specific controller-class literal.
const HOST_POOL_ADAPTER_FACTORIES: Record<string, (options: { imageName: string; dockerfilePath: string; workerType: string; snapshotRoot: string }) => HostPoolAdapter> = {
  [DockerHostPoolAdapter.classId]: (options) => new DockerHostPoolAdapter(options)
};

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
  const adapters: Record<string, HostPoolAdapter> = {};
  for (const controller of controllers) {
    const factory = HOST_POOL_ADAPTER_FACTORIES[controller.adapterKind];
    if (!factory) {
      throw new Error(`unknown host pool adapterKind: ${controller.adapterKind}`);
    }
    adapters[controller.id] = factory({
      imageName: controller.imageName,
      dockerfilePath: controller.dockerfilePath,
      workerType: controller.workerType,
      snapshotRoot
    });
  }
  return adapters;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});