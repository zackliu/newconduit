import { CentralService } from './central-service';
import { WebPubSubTransportAdapter } from './adapters';
import { CentralHttpServer } from './http/central-http-server';
import { registerPocCentralRoutes } from './http/poc-routes';

async function main(): Promise<void> {
  const webPubSubTransportAdapter = new WebPubSubTransportAdapter();
  const service = new CentralService({ transport: webPubSubTransportAdapter });
  await service.start();

  const port = Number(process.env.CENTRAL_PORT ?? '3000');
  const server = new CentralHttpServer({ port });
  registerPocCentralRoutes(server, service);
  const actualPort = await server.listen();
  console.log(`central service framework listening on http://localhost:${actualPort}`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});