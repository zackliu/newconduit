import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FoundryHostPoolAdapter } from '../../src/central/adapters';
import { FileConfigStore } from '../../src/central/config/file-config-store';

test('scenario: copilot-poc delegates from Docker to copilot-foundry', () => {
  const store = new FileConfigStore();

  const specs = store.loadAgentSpecs();
  const spec = specs.find((candidate) => candidate.agentSpecId === 'copilot-foundry');
  assert.ok(spec, 'expected a copilot-foundry AgentSpec');
  assert.deepEqual(spec.workerSelector.matchLabels, { agent: 'copilot', storage: 'host-managed' });
  const parentSpec = specs.find((candidate) => candidate.agentSpecId === 'copilot-poc');
  assert.ok(parentSpec, 'expected a copilot-poc AgentSpec');
  assert.deepEqual(parentSpec.delegateRefs.asCaller, ['copilot-foundry']);
  const calleeSpec = specs.find((candidate) => candidate.agentSpecId === 'copilot-foundry');
  assert.ok(calleeSpec, 'expected a copilot-foundry AgentSpec');
  assert.deepEqual(calleeSpec.delegateRefs.asCallee, ['copilot-foundry']);
  const [delegate] = store.loadDelegates();
  assert.equal(delegate.toolName, 'copilot_foundry');
  assert.match(delegate.description, /copilot-foundry subagent/);

  const pools = store.loadWorkerPools({ tenantId: 'tenant-x', centralUrlForWorkers: 'http://central.example:3000' });
  const pool = pools.find((candidate) => candidate.poolId === 'foundry-copilot');
  assert.ok(pool, 'expected a foundry-copilot worker pool');
  assert.equal(pool.hostPoolControllerClass, 'foundry');
  assert.equal(pool.reuse, false);
  // the pool advertises exactly the storage capability the AgentSpec selects, so label matching resolves it
  assert.deepEqual(pool.template.labels, spec.workerSelector.matchLabels);
  const parentPool = pools.find((candidate) => candidate.poolId === 'poc-docker-copilot');
  assert.ok(parentPool, 'expected the existing local copilot WorkerPool');
  assert.equal(parentPool.hostPoolControllerClass, 'docker');
  assert.deepEqual(parentPool.template.labels, parentSpec.workerSelector.matchLabels);
  assert.deepEqual(pool.template.labels, calleeSpec.workerSelector.matchLabels);

  const controllers = store.loadHostPoolControllers();
  const controller = controllers.find((candidate) => candidate.id === 'foundry');
  assert.ok(controller, 'expected a foundry host-pool controller');
  assert.equal(controller.adapterKind, FoundryHostPoolAdapter.classId);
  assert.equal(controller.workerType, 'copilot-local');
  assert.equal(typeof controller.projectEndpoint, 'string');
  assert.equal(typeof controller.agentName, 'string');
  // a Foundry cloud sandbox needs a publicly reachable central URL, so the foundry controller declares its own
  // centralUrlForWorkers and pools bound to it inherit that override instead of the global default binding
  assert.equal(typeof controller.centralUrlForWorkers, 'string');
  assert.equal(pool.centralUrlForWorkers, controller.centralUrlForWorkers);
  assert.notEqual(pool.centralUrlForWorkers, 'http://central.example:3000');

  // the foundry controller config builds a FoundryHostPoolAdapter without throwing (no network at construction)
  const adapter = new FoundryHostPoolAdapter({
    projectEndpoint: controller.projectEndpoint as string,
    agentName: controller.agentName as string,
    workerType: controller.workerType as string
  });
  assert.ok(adapter);
});

test('scenario: Foundry diagnostic expert delegates evidence collection to a standalone local worker', () => {
  const store = new FileConfigStore();
  const specs = store.loadAgentSpecs();
  const diagnosticExpert = specs.find((candidate) => candidate.agentSpecId === 'diagnostic-expert');
  assert.ok(diagnosticExpert, 'expected a diagnostic-expert AgentSpec');
  assert.deepEqual(diagnosticExpert.workerSelector.matchLabels, { agent: 'copilot', storage: 'host-managed' });
  assert.deepEqual(diagnosticExpert.delegateRefs.asCaller, ['local-diagnostic']);
  assert.match(diagnosticExpert.instructions, /hypotheses/);
  assert.match(diagnosticExpert.instructions, /inspect_local_system/);

  const localDiagnostic = specs.find((candidate) => candidate.agentSpecId === 'local-diagnostic');
  assert.ok(localDiagnostic, 'expected a local-diagnostic AgentSpec');
  assert.deepEqual(localDiagnostic.workerSelector.matchLabels, { agent: 'local-diagnostic', storage: 'host-managed' });
  assert.deepEqual(localDiagnostic.delegateRefs.asCallee, ['local-diagnostic']);

  const delegate = store.loadDelegates().find((candidate) => candidate.id === 'local-diagnostic');
  assert.ok(delegate, 'expected a local-diagnostic Delegate');
  assert.equal(delegate.toolName, 'inspect_local_system');

  const pools = store.loadWorkerPools({ tenantId: 'tenant-x', centralUrlForWorkers: 'http://central.example:3000' });
  const foundryPool = pools.find((candidate) => candidate.poolId === 'foundry-copilot');
  assert.ok(foundryPool, 'expected the existing foundry-copilot worker pool');
  assert.deepEqual(foundryPool.template.labels, diagnosticExpert.workerSelector.matchLabels);
  assert.equal(
    pools.some((pool) => pool.template.labels.agent === 'local-diagnostic'),
    false,
    'local-diagnostic must be provided by a standalone registered Worker, not a WorkerPool'
  );
});
