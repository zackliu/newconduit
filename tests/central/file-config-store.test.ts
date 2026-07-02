import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { InMemoryRuntimeTransportAdapter } from '../../src/central/adapters';
import { CentralService } from '../../src/central/central-service';
import { FileConfigStore } from '../../src/central/config/file-config-store';
import { LocalFileStorage } from '../../src/central/storage/local-file-storage';

test('scenario: central loads agent specs from the default config directory', async () => {
  const specs = new FileConfigStore().loadAgentSpecs();
  assert.deepEqual(specs.map((spec) => spec.agentSpecId).sort(), ['copilot-local', 'copilot-poc', 'dotnet-poc']);
  const copilotPoc = specs.find((spec) => spec.agentSpecId === 'copilot-poc');
  assert.ok(copilotPoc);
  assert.deepEqual(copilotPoc.workerSelector.matchLabels, { agent: 'copilot', storage: 'volume-snapshot' });

  const root = await mkdtemp(join(tmpdir(), 'ars-config-store-'));
  try {
    const transport = new InMemoryRuntimeTransportAdapter();
    const central = new CentralService({ storage: new LocalFileStorage(root), eventTransport: transport, connectionIssuer: transport });
    const status = await central.describeWorkerPoolsForTenant('poc');
    assert.deepEqual(status.agentSpecs.map((spec) => spec.agentSpecId).sort(), ['copilot-local', 'copilot-poc', 'dotnet-poc']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scenario: worker pool config binds tenant and deployment wiring at load', () => {
  const pools = new FileConfigStore().loadWorkerPools({ tenantId: 'tenant-x', centralUrlForWorkers: 'http://central.example:3000' });
  const copilotPool = pools.find((pool) => pool.poolId === 'poc-docker-copilot');
  assert.ok(copilotPool);
  assert.equal(copilotPool.tenantId, 'tenant-x');
  assert.equal(copilotPool.centralUrlForWorkers, 'http://central.example:3000');
  assert.equal(copilotPool.hostPoolControllerClass, 'docker');
  assert.deepEqual(copilotPool.template.labels, { agent: 'copilot', storage: 'volume-snapshot' });
});
