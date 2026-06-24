import { CentralService } from './central-service';
import { WebPubSubTransportAdapter } from './adapters';
import { CentralHttpServer } from './http/central-http-server';
import { registerPocCentralRoutes } from './http/poc-routes';
import type { TenantContext } from '../shared';

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
  const service = new CentralService({ tenant, eventTransport: webPubSubTransportAdapter, connectionIssuer: webPubSubTransportAdapter });
  await service.start();

  const port = Number(process.env.CENTRAL_PORT ?? '3000');
  const server = new CentralHttpServer({ port });
  registerPocCentralRoutes(server, service);
  const actualPort = await server.listen();
  console.log(`central service listening on http://localhost:${actualPort}`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});