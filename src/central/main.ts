import { CentralService } from './central-service';
import { DockerHostPoolAdapter, WebPubSubTransportAdapter } from './adapters';
import { CentralHttpServer } from './http/central-http-server';
import { registerPocCentralRoutes } from './http/poc-routes';
import { COPILOT_PROCESS_WRAPPER_SIDECAR_CLASS, type TenantContext, type WorkerPoolRecord } from '../shared';

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
  const workerPool: WorkerPoolRecord = {
    poolId: process.env.WORKER_POOL_ID ?? 'poc-docker-copilot',
    tenantId: tenant.tenantId,
    sidecarClass: COPILOT_PROCESS_WRAPPER_SIDECAR_CLASS,
    labels: { agent: 'copilot' },
    capacityPerWorker: 1,
    hostPoolControllerClass: 'docker',
    scalePolicy: {
      scaleOutMaxPendingPerTick: 1,
      scaleInIdleMs: Number(process.env.WORKER_POOL_SCALE_IN_IDLE_MS ?? '5000')
    },
    centralUrlForWorkers
  };
  const service = new CentralService({
    tenant,
    eventTransport: webPubSubTransportAdapter,
    connectionIssuer: webPubSubTransportAdapter,
    workerPools: [workerPool],
    hostPoolAdapters: {
      docker: new DockerHostPoolAdapter()
    }
  });
  await service.start();

  const server = new CentralHttpServer({ port: centralPort });
  registerPocCentralRoutes(server, service);
  const actualPort = await server.listen();
  console.log(`central service listening on http://localhost:${actualPort}`);
  console.log(`worker pool ${workerPool.poolId} will connect sidecars to ${workerPool.centralUrlForWorkers}`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});