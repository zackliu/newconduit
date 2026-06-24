import type { CentralService } from '../central-service';
import type { CentralHttpServer } from './central-http-server';

export function registerPocCentralRoutes(server: CentralHttpServer, centralService: CentralService): void {
  server.registerRoute('GET', '/health', async () => ({
    statusCode: 200,
    body: { status: 'ok' }
  }));

  server.registerRoute('POST', '/client/negotiate', async () => ({
    statusCode: 200,
    body: await centralService.negotiateClientConnection()
  }));

  server.registerRoute('POST', '/sidecar/negotiate', async () => ({
    statusCode: 200,
    body: await centralService.negotiateSidecarConnection()
  }));
}