import type { CentralService } from '../central-service';
import type { CentralHttpServer } from './central-http-server';
import type { RequestContext } from '../../shared';

const DEMO_CLIENT_CONTEXT: RequestContext = {
  principal: {
    principalId: 'demo-user',
    type: 'user'
  },
  connectionId: 'demo-connection'
};

const DEMO_SIDECAR_CONTEXT: RequestContext = {
  principal: {
    principalId: 'demo-sidecar',
    type: 'service'
  },
  connectionId: 'demo-sidecar-connection'
};

export function registerPocCentralRoutes(server: CentralHttpServer, centralService: CentralService): void {
  server.registerRoute('GET', '/health', async () => ({
    statusCode: 200,
    body: { status: 'ok' }
  }));

  server.registerRoute('POST', '/client/negotiate', async () => ({
    statusCode: 200,
    body: await centralService.negotiateClientConnection(DEMO_CLIENT_CONTEXT)
  }));

  server.registerRoute('POST', '/sidecar/negotiate', async () => ({
    statusCode: 200,
    body: await centralService.negotiateSidecarConnection(DEMO_SIDECAR_CONTEXT)
  }));
}