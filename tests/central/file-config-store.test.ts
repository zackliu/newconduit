import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { InMemoryRuntimeTransportAdapter } from '../../src/central/adapters';
import { CentralService } from '../../src/central/central-service';
import { FileConfigStore } from '../../src/central/config/file-config-store';
import { loadTenantConfigGeneration } from '../../src/central/config/tenant-config-generation';
import { LocalFileStorage } from '../../src/central/storage/local-file-storage';

test('scenario: central loads agent specs from the default config directory', async () => {
  const store = new FileConfigStore();
  const specs = store.loadAgentSpecs();
  assert.deepEqual(specs.map((spec) => spec.agentSpecId).sort(), ['copilot-foundry', 'copilot-local', 'copilot-poc', 'dotnet-poc']);
  const copilotPoc = specs.find((spec) => spec.agentSpecId === 'copilot-poc');
  assert.ok(copilotPoc);
  assert.deepEqual(copilotPoc.workerSelector.matchLabels, { agent: 'copilot', storage: 'volume-snapshot' });

  const delegates = store.loadDelegates();
  assert.deepEqual(delegates, [{
    id: 'copilot-foundry',
    toolName: 'copilot_foundry',
    description: 'Ask the copilot-foundry subagent to handle the request. Use this when the user asks copilot-foundry to answer or when its hosted agent should perform the task.',
    maxInputBytes: 8192,
    maxResultBytes: 16384,
    deadlineMs: 120000,
    maxQueuedCalls: 2
  }]);
  const generation = loadTenantConfigGeneration(store);
  assert.equal(generation.delegation.delegateBindingIndex.resolveCallee('copilot-foundry').agentSpecId, 'copilot-foundry');
  assert.deepEqual((await generation.agentSpecRegistry.resolve({ agentSpecId: 'copilot-poc' })).delegateRefs.asCaller, ['copilot-foundry']);

  const root = await mkdtemp(join(tmpdir(), 'ars-config-store-'));
  try {
    const transport = new InMemoryRuntimeTransportAdapter();
    const central = new CentralService({ storage: new LocalFileStorage(root), eventTransport: transport, connectionIssuer: transport });
    const status = await central.describeWorkerPoolsForTenant('poc');
    assert.deepEqual(status.agentSpecs.map((spec) => spec.agentSpecId).sort(), ['copilot-foundry', 'copilot-local', 'copilot-poc', 'dotnet-poc']);
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
  assert.equal(copilotPool.reuse, false);
  assert.deepEqual(copilotPool.template.labels, { agent: 'copilot', storage: 'volume-snapshot' });
});
