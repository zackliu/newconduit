import type { CentralService } from '../central-service';
import type { CentralHttpServer } from './central-http-server';
import { POC_RUNTIME_HTTP_PATHS, POC_RUNTIME_HTTP_QUERY, type RequestContext, type WorkerRegisterPayload } from '../../shared';
import type { IncomingMessage } from 'node:http';

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

  server.registerRoute('GET', POC_RUNTIME_HTTP_PATHS.runtimeStatus, async (request) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const tenantId = url.searchParams.get(POC_RUNTIME_HTTP_QUERY.tenantId);
    try {
      return {
        statusCode: 200,
        body: await centralService.describeWorkerPoolsForTenant(tenantId)
      };
    } catch (error) {
      return {
        statusCode: 400,
        body: { error: error instanceof Error ? error.message : 'invalid runtime status request' }
      };
    }
  });

  server.registerRoute('POST', POC_RUNTIME_HTTP_PATHS.clientNegotiate, async (request) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const tenantId = url.searchParams.get(POC_RUNTIME_HTTP_QUERY.tenantId);
    const clientConnectionId = url.searchParams.get(POC_RUNTIME_HTTP_QUERY.clientConnectionId);
    if (!clientConnectionId) {
      return { statusCode: 400, body: { error: 'clientConnectionId is required' } };
    }
    try {
      return {
        statusCode: 200,
        body: await centralService.negotiateClientConnectionForTenant(tenantId, {
          ...DEMO_CLIENT_CONTEXT,
          connectionId: clientConnectionId
        })
      };
    } catch (error) {
      return {
        statusCode: 400,
        body: { error: error instanceof Error ? error.message : 'invalid client negotiate request' }
      };
    }
  });

  server.registerRoute('POST', POC_RUNTIME_HTTP_PATHS.sidecarNegotiate, async (request) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const tenantId = url.searchParams.get(POC_RUNTIME_HTTP_QUERY.tenantId);
    try {
      const registration = await readSidecarRegistrationBody(request);
      return {
        statusCode: 200,
        body: await centralService.negotiateSidecarConnectionForTenant(tenantId, DEMO_SIDECAR_CONTEXT, registration)
      };
    } catch (error) {
      return {
        statusCode: 400,
        body: { error: error instanceof Error ? error.message : 'invalid sidecar negotiate request' }
      };
    }
  });
}

async function readSidecarRegistrationBody(request: IncomingMessage): Promise<WorkerRegisterPayload> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    throw new Error('sidecar registration body is required');
  }
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  if (!isWorkerRegisterPayload(payload)) {
    throw new Error('invalid sidecar registration body');
  }
  return payload;
}

function isWorkerRegisterPayload(payload: unknown): payload is WorkerRegisterPayload {
  if (typeof payload !== 'object' || payload === null) {
    return false;
  }
  const candidate = payload as Partial<WorkerRegisterPayload>;
  return typeof candidate.sidecarClass === 'string'
    && candidate.sidecarClass.length > 0
    && isStringRecord(candidate.labels)
    && typeof candidate.capacity === 'number'
    && typeof candidate.allocatable === 'number'
    && (candidate.description === undefined || isStringRecord(candidate.description));
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.values(value).every((entry) => typeof entry === 'string');
}