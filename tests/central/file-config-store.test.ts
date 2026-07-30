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
  assert.deepEqual(specs.map((spec) => spec.agentSpecId).sort(), ['copilot-foundry', 'copilot-local', 'copilot-poc', 'device-scan-probe', 'diagnostic-expert', 'dotnet-poc', 'local-diagnostic', 'network-recovery-expert']);
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
  }, {
    id: 'device-scan-capture',
    toolName: 'scan_device_evidence',
    description: 'Delegate a single on-device visual scan step to the end user\'s browser edge worker (their phone). Use this when recovery needs a fresh look at the physical device: indicator lights, port and cabling state, a label or sticker, a QR or barcode, or ambient framing quality. Provide a bounded task naming the scan target, which camera to use, why the frame is needed, and which lightweight local detectors to run (led indicators, code scan). The edge worker asks the person to explicitly frame and capture one frame, analyzes it locally in the browser, and returns only structured optical observations plus a short human summary. The raw frame never leaves the device unless the user separately consents to share it.',
    maxInputBytes: 8192,
    maxResultBytes: 32768,
    deadlineMs: 300000,
    maxQueuedCalls: 1,
    targetPolicy: 'device'
  }, {
    id: 'local-diagnostic',
    toolName: 'inspect_local_system',
    description: 'Collect current evidence from the target developer machine when diagnosis requires local operating-system, process, service, port, network, filesystem, runtime, Docker, WSL, toolchain, or bounded log information. Request only specific read-only checks; the local diagnostic agent reports observed facts and does not perform remediation.',
    maxInputBytes: 8192,
    maxResultBytes: 32768,
    deadlineMs: 600000,
    maxQueuedCalls: 1
  }]);
  const generation = loadTenantConfigGeneration(store);
  assert.equal(generation.delegation.delegateBindingIndex.resolveCallee('copilot-foundry').agentSpecId, 'copilot-foundry');
  assert.deepEqual((await generation.agentSpecRegistry.resolve({ agentSpecId: 'copilot-poc' })).delegateRefs.asCaller, ['copilot-foundry']);
  assert.equal(generation.delegation.delegateBindingIndex.resolveCallee('local-diagnostic').agentSpecId, 'local-diagnostic');
  const diagnosticExpert = await generation.agentSpecRegistry.resolve({ agentSpecId: 'diagnostic-expert' });
  assert.deepEqual(diagnosticExpert.delegateRefs.asCaller, ['local-diagnostic']);
  const localDiagnosticDelegate = generation.delegation.resolvedDelegateRegistry.resolve('local-diagnostic');
  assert.equal(generation.delegation.delegateAdmissionManager.runtimeTool(localDiagnosticDelegate).name, 'inspect_local_system');

  // The browser edge worker is wired as a delegation callee routed from the network-recovery parent.
  assert.equal(generation.delegation.delegateBindingIndex.resolveCallee('device-scan-capture').agentSpecId, 'device-scan-probe');
  const recoveryExpert = await generation.agentSpecRegistry.resolve({ agentSpecId: 'network-recovery-expert' });
  assert.deepEqual(recoveryExpert.delegateRefs.asCaller, ['device-scan-capture']);
  const deviceScanDelegate = generation.delegation.resolvedDelegateRegistry.resolve('device-scan-capture');
  assert.equal(generation.delegation.delegateAdmissionManager.runtimeTool(deviceScanDelegate).name, 'scan_device_evidence');

  const root = await mkdtemp(join(tmpdir(), 'ars-config-store-'));
  try {
    const transport = new InMemoryRuntimeTransportAdapter();
    const central = new CentralService({ storage: new LocalFileStorage(root), eventTransport: transport, connectionIssuer: transport });
    const status = await central.describeWorkerPoolsForTenant('poc');
    assert.deepEqual(status.agentSpecs.map((spec) => spec.agentSpecId).sort(), ['copilot-foundry', 'copilot-local', 'copilot-poc', 'device-scan-probe', 'diagnostic-expert', 'dotnet-poc', 'local-diagnostic', 'network-recovery-expert']);
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
