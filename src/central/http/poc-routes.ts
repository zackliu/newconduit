import type { CentralService } from '../central-service';
import type { CentralHttpServer } from './central-http-server';
import { POC_RUNTIME_HTTP_PATHS, POC_RUNTIME_HTTP_QUERY, type RequestContext } from '../../shared';

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
  server.registerRoute('GET', POC_RUNTIME_HTTP_PATHS.health, async () => ({
    statusCode: 200,
    body: { status: 'ok' }
  }));

  server.registerRoute('POST', POC_RUNTIME_HTTP_PATHS.clientNegotiate, async (request) => {
    const tenantId = new URL(request.url ?? '/', 'http://localhost').searchParams.get(POC_RUNTIME_HTTP_QUERY.tenantId);
    try {
      return {
        statusCode: 200,
        body: await centralService.negotiateClientConnectionForTenant(tenantId, DEMO_CLIENT_CONTEXT)
      };
    } catch (error) {
      return {
        statusCode: 400,
        body: { error: error instanceof Error ? error.message : 'invalid client negotiate request' }
      };
    }
  });

  server.registerRoute('POST', POC_RUNTIME_HTTP_PATHS.sidecarNegotiate, async (request) => {
    const tenantId = new URL(request.url ?? '/', 'http://localhost').searchParams.get(POC_RUNTIME_HTTP_QUERY.tenantId);
    try {
      return {
        statusCode: 200,
        body: await centralService.negotiateSidecarConnectionForTenant(tenantId, DEMO_SIDECAR_CONTEXT)
      };
    } catch (error) {
      return {
        statusCode: 400,
        body: { error: error instanceof Error ? error.message : 'invalid sidecar negotiate request' }
      };
    }
  });
}