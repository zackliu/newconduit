import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { InMemoryRuntimeTransportAdapter } from '../../src/central/adapters';
import { CentralService } from '../../src/central/central-service';
import { CentralHttpServer } from '../../src/central/http/central-http-server';
import { registerPocCentralRoutes } from '../../src/central/http/poc-routes';
import { LocalFileStorage } from '../../src/central/storage/local-file-storage';
import { POC_RUNTIME_HTTP_PATHS, POC_RUNTIME_HTTP_QUERY } from '../../src/shared';

test('scenario: central starts server with health and negotiate endpoints', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ars-central-http-'));
  const runtimeTransportAdapter = new InMemoryRuntimeTransportAdapter();
  const centralService = new CentralService({ storage: new LocalFileStorage(root), eventTransport: runtimeTransportAdapter, connectionIssuer: runtimeTransportAdapter });
  const server = new CentralHttpServer({ port: 0 });
  registerPocCentralRoutes(server, centralService);
  const port = await server.listen();
  try {
    const healthResponse = await fetch(`http://localhost:${port}${POC_RUNTIME_HTTP_PATHS.health}`);
    assert.equal(healthResponse.status, 200);
    assert.deepEqual(await healthResponse.json(), { status: 'ok' });

    const runtimeStatusResponse = await fetch(`http://localhost:${port}${POC_RUNTIME_HTTP_PATHS.runtimeStatus}?${POC_RUNTIME_HTTP_QUERY.tenantId}=poc`);
    assert.equal(runtimeStatusResponse.status, 200);
    const runtimeStatus = await runtimeStatusResponse.json() as { workerPools: unknown[]; hostPoolInstances: unknown[]; workers: unknown[] };
    assert.deepEqual(runtimeStatus.workerPools, []);
    assert.deepEqual(runtimeStatus.hostPoolInstances, []);
    assert.deepEqual(runtimeStatus.workers, []);

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
        labels: { agent: 'copilot', storage: 'volume-snapshot' },
        storageClass: 'volume-snapshot',
        capacity: 1,
        allocatable: 1
      })
    });
    assert.equal(sidecarNegotiateResponse.status, 200);
    const sidecarToken = await sidecarNegotiateResponse.json() as { url: string; worker: { workerId: string } };
    assert.match(sidecarToken.url, new RegExp(`principal=${sidecarToken.worker.workerId}`));
    assert.match(sidecarToken.url, new RegExp(`connection=${sidecarToken.worker.workerId}`));
    assert.match(sidecarToken.url, /tenant-inbox/);
    assert.equal(typeof sidecarToken.worker.workerId, 'string');

    const invalidInstanceClaimResponse = await fetch(`http://localhost:${port}${POC_RUNTIME_HTTP_PATHS.sidecarNegotiate}?${POC_RUNTIME_HTTP_QUERY.tenantId}=poc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hostPoolInstanceId: 42,
        labels: { agent: 'copilot', storage: 'volume-snapshot' },
        storageClass: 'volume-snapshot',
        capacity: 1,
        allocatable: 1
      })
    });
    assert.equal(invalidInstanceClaimResponse.status, 400);

    const localSidecarNegotiateResponse = await fetch(`http://localhost:${port}${POC_RUNTIME_HTTP_PATHS.sidecarNegotiate}?${POC_RUNTIME_HTTP_QUERY.tenantId}=poc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        labels: { agent: 'local', storage: 'host-managed' },
        storageClass: 'host-managed',
        capacity: 99,
        allocatable: 99
      })
    });
    assert.equal(localSidecarNegotiateResponse.status, 200);
    const localWorker = await localSidecarNegotiateResponse.json() as { worker: { storageClass: string } };
    assert.equal(localWorker.worker.storageClass, 'host-managed');

    // Regression: an untyped caller (e.g. the scripted-parent .mjs) that sends `description` as a bare
    // string instead of a Record<string,string> must be rejected with a clear 400 body, not silently
    // accepted. The daemon/edge negotiate paths surface this body so the caller sees why it failed.
    const stringDescriptionResponse = await fetch(`http://localhost:${port}${POC_RUNTIME_HTTP_PATHS.sidecarNegotiate}?${POC_RUNTIME_HTTP_QUERY.tenantId}=poc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        labels: { agent: 'local', storage: 'host-managed' },
        storageClass: 'host-managed',
        description: 'scripted-parent-dev-standin',
        capacity: 1,
        allocatable: 1
      })
    });
    assert.equal(stringDescriptionResponse.status, 400);
    assert.deepEqual(await stringDescriptionResponse.json(), { error: 'invalid sidecar registration body' });

    const structuredDescriptionResponse = await fetch(`http://localhost:${port}${POC_RUNTIME_HTTP_PATHS.sidecarNegotiate}?${POC_RUNTIME_HTTP_QUERY.tenantId}=poc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        labels: { agent: 'local', storage: 'host-managed' },
        storageClass: 'host-managed',
        description: { kind: 'scripted-parent', role: 'network-recovery-expert' },
        capacity: 1,
        allocatable: 1
      })
    });
    assert.equal(structuredDescriptionResponse.status, 200);
    const structuredWorker = await structuredDescriptionResponse.json() as { worker: { description?: Record<string, string> } };
    assert.deepEqual(structuredWorker.worker.description, { kind: 'scripted-parent', role: 'network-recovery-expert' });
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});