import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemoryRuntimeTransportAdapter } from '../../src/central/adapters';
import { CentralService } from '../../src/central/central-service';
import { CentralHttpServer } from '../../src/central/http/central-http-server';
import { registerPocCentralRoutes } from '../../src/central/http/poc-routes';

test('scenario: central starts server with health and negotiate endpoints', async () => {
  const runtimeTransportAdapter = new InMemoryRuntimeTransportAdapter();
  const centralService = new CentralService({ eventTransport: runtimeTransportAdapter, connectionIssuer: runtimeTransportAdapter });
  const server = new CentralHttpServer({ port: 0 });
  registerPocCentralRoutes(server, centralService);
  const port = await server.listen();
  try {
    const healthResponse = await fetch(`http://localhost:${port}/health`);
    assert.equal(healthResponse.status, 200);
    assert.deepEqual(await healthResponse.json(), { status: 'ok' });

    const clientNegotiateResponse = await fetch(`http://localhost:${port}/client/negotiate`, { method: 'POST' });
    assert.equal(clientNegotiateResponse.status, 200);
    const clientToken = await clientNegotiateResponse.json() as { url: string };
    assert.match(clientToken.url, /principal=demo-user/);
    assert.match(clientToken.url, /tenant-inbox/);

    const sidecarNegotiateResponse = await fetch(`http://localhost:${port}/sidecar/negotiate`, { method: 'POST' });
    assert.equal(sidecarNegotiateResponse.status, 200);
    const sidecarToken = await sidecarNegotiateResponse.json() as { url: string };
    assert.match(sidecarToken.url, /principal=demo-sidecar/);
    assert.match(sidecarToken.url, /tenant-inbox/);
  } finally {
    await server.close();
  }
});