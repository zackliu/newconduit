import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FileConfigStore } from '../../src/central/config/file-config-store';
import { CopilotProcessAdapter } from '../../src/sidecar/adapters';
import { resolveWorkerType } from '../../src/sidecar/worker-types';

/**
 * Production routing contract for the Remote Network Recovery browser-edge demo.
 *
 * The default/primary parent brain is a REAL Copilot worker, not the scripted offline harness. This test proves the
 * routing that makes that true is a property of the shipped config + worker-type code (label match resolves the parent
 * spec to a Copilot WorkerPool whose host-pool controller provisions a real CopilotProcessAdapter worker), so a
 * regression that pointed the parent at a non-Copilot/scripted-only path would fail here.
 */

/** The same subset semantics the WorkerSelector/pool scale-out use: every selector entry must equal a worker label. */
function selectorMatchesLabels(selector: Record<string, string>, labels: Record<string, string>): boolean {
  return Object.entries(selector).every(([key, value]) => labels[key] === value);
}

test('network-recovery-expert routes to a real Copilot WorkerPool (not the scripted harness)', () => {
  const store = new FileConfigStore();
  const specs = store.loadAgentSpecs();

  const parent = specs.find((spec) => spec.agentSpecId === 'network-recovery-expert');
  assert.ok(parent, 'expected the network-recovery-expert parent AgentSpec');
  // The parent is a Copilot agent that runs on the local Docker pool's volume-snapshot storage (a real Copilot pool shape).
  assert.deepEqual(parent.workerSelector.matchLabels, { agent: 'copilot', storage: 'volume-snapshot' });

  // A REAL Copilot WorkerPool advertises exactly that capability, so plain label matching resolves the parent to it.
  const pools = store.loadWorkerPools({ tenantId: 'tenant-x', centralUrlForWorkers: 'http://central.example:3000' });
  const copilotPools = pools.filter((pool) => selectorMatchesLabels(parent.workerSelector.matchLabels, pool.template.labels));
  assert.ok(copilotPools.length >= 1, 'expected at least one Copilot WorkerPool matching the parent selector');
  const dockerPool = copilotPools.find((pool) => pool.poolId === 'poc-docker-copilot');
  assert.ok(dockerPool, 'expected the parent selector to match the local poc-docker-copilot pool');

  // That pool is backed by a host-pool controller that provisions a concrete worker TYPE...
  const controllers = store.loadHostPoolControllers();
  const controller = controllers.find((candidate) => candidate.id === dockerPool.hostPoolControllerClass);
  assert.ok(controller, `expected a host-pool controller for ${dockerPool.hostPoolControllerClass}`);
  assert.equal(typeof controller.workerType, 'string');

  // ...and that worker type builds the REAL Copilot agent-process adapter (a reasoning agent), not a scripted double.
  const profile = resolveWorkerType(controller.workerType as string);
  assert.equal(profile.storageClass, 'volume-snapshot', 'the pool worker must use volume-snapshot storage to match the parent');
  const agentProcess = profile.createAgentProcessAdapter();
  assert.ok(
    agentProcess instanceof CopilotProcessAdapter,
    'the production parent worker must run the real CopilotProcessAdapter, not a scripted stand-in'
  );
});

test('network-recovery-expert delegates device capture to the browser-edge callee (phone), not another Copilot worker', () => {
  const store = new FileConfigStore();
  const specs = store.loadAgentSpecs();

  const parent = specs.find((spec) => spec.agentSpecId === 'network-recovery-expert');
  assert.ok(parent, 'expected the network-recovery-expert parent AgentSpec');
  assert.deepEqual(parent.delegateRefs.asCaller, ['device-scan-capture']);

  const delegate = store.loadDelegates().find((candidate) => candidate.id === 'device-scan-capture');
  assert.ok(delegate, 'expected the device-scan-capture delegate');
  assert.equal(delegate.toolName, 'scan_device_evidence');
  // Device-scoped delegate: an absent target is never silently pool-routed (see delegation enforcement).
  assert.equal(delegate.targetPolicy, 'device');

  const callee = specs.find((spec) => spec.agentSpecId === 'device-scan-probe');
  assert.ok(callee, 'expected the device-scan-probe callee AgentSpec');
  // The child scan runs on a browser-edge worker (the phone), so it must NOT be servable by a Copilot pool.
  assert.equal(callee.workerSelector.matchLabels.agent, 'browser-edge');
  assert.equal(
    store
      .loadWorkerPools({ tenantId: 'tenant-x', centralUrlForWorkers: 'http://central.example:3000' })
      .some((pool) => selectorMatchesLabels(callee.workerSelector.matchLabels, pool.template.labels)),
    false,
    'the browser-edge callee must be provided by a registered browser Worker, not a WorkerPool'
  );
});
