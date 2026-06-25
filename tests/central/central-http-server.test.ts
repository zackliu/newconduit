import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemoryRuntimeTransportAdapter } from '../../src/central/adapters';
import { CentralService } from '../../src/central/central-service';
import { CentralHttpServer } from '../../src/central/http/central-http-server';
import { registerPocCentralRoutes } from '../../src/central/http/poc-routes';
import { POC_RUNTIME_HTTP_PATHS, POC_RUNTIME_HTTP_QUERY } from '../../src/shared';

test('scenario: central starts server with health and negotiate endpoints', async () => {
  const runtimeTransportAdapter = new InMemoryRuntimeTransportAdapter();
  const centralService = new CentralService({ eventTransport: runtimeTransportAdapter, connectionIssuer: runtimeTransportAdapter });
  const server = new CentralHttpServer({ port: 0 });
  registerPocCentralRoutes(server, centralService);
  const port = await server.listen();
  try {
    const healthResponse = await fetch(`http://localhost:${port}${POC_RUNTIME_HTTP_PATHS.health}`);
    assert.equal(healthResponse.status, 200);
    assert.deepEqual(await healthResponse.json(), { status: 'ok' });

    const invalidClientNegotiateResponse = await fetch(`http://localhost:${port}${POC_RUNTIME_HTTP_PATHS.clientNegotiate}?${POC_RUNTIME_HTTP_QUERY.tenantId}=wrong`, { method: 'POST' });
    assert.equal(invalidClientNegotiateResponse.status, 400);

    const missingClientConnectionIdResponse = await fetch(`http://localhost:${port}${POC_RUNTIME_HTTP_PATHS.clientNegotiate}?${POC_RUNTIME_HTTP_QUERY.tenantId}=poc`, { method: 'POST' });
    assert.equal(missingClientConnectionIdResponse.status, 400);

    const clientNegotiateResponse = await fetch(`http://localhost:${port}${POC_RUNTIME_HTTP_PATHS.clientNegotiate}?${POC_RUNTIME_HTTP_QUERY.tenantId}=poc&${POC_RUNTIME_HTTP_QUERY.clientConnectionId}=client-test-1`, { method: 'POST' });
    assert.equal(clientNegotiateResponse.status, 200);
    const clientToken = await clientNegotiateResponse.json() as { url: string };
    assert.match(clientToken.url, /principal=demo-user/);
    assert.match(clientToken.url, /connection=client-test-1/);
    assert.match(clientToken.url, /tenant-inbox/);

    const invalidSidecarNegotiateResponse = await fetch(`http://localhost:${port}${POC_RUNTIME_HTTP_PATHS.sidecarNegotiate}?${POC_RUNTIME_HTTP_QUERY.tenantId}=wrong`, { method: 'POST' });
    assert.equal(invalidSidecarNegotiateResponse.status, 400);

    const missingSidecarRegistrationResponse = await fetch(`http://localhost:${port}${POC_RUNTIME_HTTP_PATHS.sidecarNegotiate}?${POC_RUNTIME_HTTP_QUERY.tenantId}=poc`, { method: 'POST' });
    assert.equal(missingSidecarRegistrationResponse.status, 400);

    const sidecarNegotiateResponse = await fetch(`http://localhost:${port}${POC_RUNTIME_HTTP_PATHS.sidecarNegotiate}?${POC_RUNTIME_HTTP_QUERY.tenantId}=poc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sidecarClass: 'copilot-process-wrapper',
        labels: { agent: 'copilot' },
        capacity: 1,
        allocatable: 1
      })
    });
    assert.equal(sidecarNegotiateResponse.status, 200);
    const sidecarToken = await sidecarNegotiateResponse.json() as { url: string; worker: { workerId: string } };
    assert.match(sidecarToken.url, /principal=demo-sidecar/);
    assert.match(sidecarToken.url, /tenant-inbox/);
    assert.equal(typeof sidecarToken.worker.workerId, 'string');
  } finally {
    await server.close();
  }
});