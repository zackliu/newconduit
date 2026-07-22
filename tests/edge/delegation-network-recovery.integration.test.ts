import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { InMemoryRuntimeTransportAdapter } from '../../src/central/adapters';
import { CentralService } from '../../src/central/central-service';
import { CasePairingManager } from '../../src/central/managers';
import { LocalFileStorage } from '../../src/central/storage/local-file-storage';
import type {
  RuntimeChannel,
  RuntimeEvent,
  RuntimeEventHandler,
  RuntimeEventTransport,
  RuntimeSubscription,
  SessionRecord,
  WorkerRegisterPayload
} from '../../src/shared';
import type {
  SidecarAgentProcessAdapter,
  SidecarAgentProcessEventHandler,
  SidecarAgentProcessInput,
  SidecarAgentTurnResult,
  SidecarInteractionResponseInput,
  SidecarRuntimeTransport,
  SidecarWorkspaceAdapter,
  SidecarWorkspaceCaptureInput,
  SidecarWorkspaceHandles,
  SidecarWorkspaceMount,
  SidecarWorkspaceRestoreInput
} from '../../src/sidecar/contracts';
import { SidecarDaemon } from '../../src/sidecar/sidecar-daemon';
import type { SnapshotPartName } from '../../src/shared';
import {
  BrowserBarcodeScanner,
  CameraDiagnosticAgent,
  CanvasHeuristicAnalyzer,
  EdgeWorkerRuntime,
  LedIndicatorAnalyzer,
  createAnalyzerCaptureProvider,
  createCodeObserver,
  type EdgeDeviceManifest,
  type EdgeFrame,
  type EdgeRuntimeChannel,
  type EdgeRuntimeEvent,
  type EdgeRuntimeEventHandler,
  type EdgeWorkerLifecycleEvent,
  type EdgeWorkerSubscription,
  type EdgeWorkerTransport
} from '../../sdk/edge-worker/src/index';

/**
 * End-to-end delegation proof over a REAL `CentralService`. A durable cloud recovery agent (a real
 * `SidecarDaemon` running the `network-recovery-expert` spec) calls the Central-defined delegate tool
 * `scan_device_evidence`. Central resolves the delegate to the `device-scan-probe` callee, creates a
 * child session, and — purely by capability labels — routes it to the browser edge worker (`EdgeWorkerRuntime`
 * running on the user's "phone"). The phone captures and analyzes one frame locally and returns ONLY a
 * structured observation, which Central hands back to the parent as the tool result. The raw frame never
 * appears in any persisted event, and the honest `BarcodeDetector` degradation is reported, not faked.
 */

// --- Parent side: a real SidecarDaemon whose agent calls the delegate tool ---------------------------------

class SidecarInMemoryTransport implements SidecarRuntimeTransport {
  constructor(private readonly transport: RuntimeEventTransport, readonly publishedEvents: RuntimeEvent[] = []) {}
  async connect(): Promise<void> {}
  async publish(channel: RuntimeChannel, event: RuntimeEvent): Promise<void> {
    this.publishedEvents.push(event);
    await this.transport.publish(channel, event, {
      principal: { principalId: event.workerId ?? 'test-sidecar', type: 'service' }
    });
  }
  async subscribe(channel: RuntimeChannel, handler: RuntimeEventHandler): Promise<RuntimeSubscription> {
    return this.transport.subscribe(channel, handler);
  }
  async stop(): Promise<void> {}
}

class PassthroughWorkspaceAdapter implements SidecarWorkspaceAdapter {
  mount(input: SidecarWorkspaceHandles): SidecarWorkspaceMount {
    return { workspacePath: input.workspaceRef, copilotSessionStatePath: input.agentStateRef };
  }
  async capture(_input: SidecarWorkspaceCaptureInput): Promise<SnapshotPartName[]> {
    return ['workspace', 'agent-state'];
  }
  async restore(_input: SidecarWorkspaceRestoreInput): Promise<void> {}
}

/**
 * Stands in for the cloud Copilot agent's tool-calling behavior: on its recovery turn it invokes the
 * `scan_device_evidence` delegate tool with a bounded task, waits for the structured observation, and
 * summarizes. It never sees an image — only the structured tool result Central returns.
 */
class CaptureDelegatingAgentProcessAdapter implements SidecarAgentProcessAdapter {
  private resolveResponse!: (response: unknown) => void;
  readonly toolResponse = new Promise<unknown>((resolve) => {
    this.resolveResponse = resolve;
  });

  constructor(private readonly task: unknown) {}

  /** The Central-validated device target for the scan; set after enrollment, before the parent turn fires. */
  target: unknown;

  async start(): Promise<void> {}

  async send(_input: SidecarAgentProcessInput, emit: SidecarAgentProcessEventHandler): Promise<SidecarAgentTurnResult> {
    await emit({
      type: 'interaction',
      payload: {
        interactionId: 'capture-request-1',
        kind: 'tool_call',
        request: { toolName: 'scan_device_evidence', arguments: { message: JSON.stringify(this.task), ...(this.target !== undefined ? { target: this.target } : {}) } }
      }
    });
    const response = await this.toolResponse;
    return { message: 'Diagnosis updated from on-device observations.', output: { toolResult: response } };
  }

  async respondToInteraction(input: SidecarInteractionResponseInput): Promise<void> {
    this.resolveResponse(input.response);
  }
}

// --- Edge side: the browser callee runtime over the same in-memory runtime transport -----------------------

class InMemoryEdgeWorkerTransport implements EdgeWorkerTransport {
  constructor(private readonly transport: RuntimeEventTransport) {}
  async connect(): Promise<void> {}
  async publish(channel: EdgeRuntimeChannel, event: EdgeRuntimeEvent): Promise<void> {
    await this.transport.publish(channel as RuntimeChannel, event as unknown as RuntimeEvent, {
      principal: { principalId: event.workerId ?? 'edge-worker', type: 'service' }
    });
  }
  async subscribe(channel: EdgeRuntimeChannel, handler: EdgeRuntimeEventHandler): Promise<EdgeWorkerSubscription> {
    const subscription = await this.transport.subscribe(channel as RuntimeChannel, async ({ event }) => {
      await handler(event as unknown as EdgeRuntimeEvent);
    });
    return { close: () => subscription.close() };
  }
  async stop(): Promise<void> {}
}

const BROWSER_MANIFEST: EdgeDeviceManifest = {
  deviceLabel: 'Field Phone (Chromium)',
  runtime: 'browser-edge-worker',
  captureSources: ['environment', 'user'],
  analyzers: [{ id: 'canvas-heuristic-v1', displayName: 'Canvas heuristic analyzer' }],
  detectors: [
    { id: 'led-indicator-v1', kind: 'led-indicator', displayName: 'LED indicator analyzer' },
    { id: 'barcode-detector-v1', kind: 'code', displayName: 'Barcode/QR scanner' }
  ],
  secureContext: true,
  privacy: { rawMediaLeavesDevice: false, returns: 'structured-analysis-only' }
};

function frameWithRedBlob(): EdgeFrame {
  const width = 48;
  const height = 48;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inBlob = x >= 18 && x < 30 && y >= 18 && y < 30;
      const idx = (y * width + x) * 4;
      data[idx] = inBlob ? 235 : 15;
      data[idx + 1] = inBlob ? 25 : 15;
      data[idx + 2] = inBlob ? 25 : 15;
      data[idx + 3] = 255;
    }
  }
  return { data, width, height };
}

function parentWorkerRegistration(): WorkerRegisterPayload {
  return {
    labels: { agent: 'copilot', tier: 'foundry', role: 'network-recovery-expert', storage: 'host-managed' },
    storageClass: 'host-managed',
    capacity: 1,
    allocatable: 1
  };
}

function sessionCreateEvent(agentSpecId: string, message: string): RuntimeEvent {
  return {
    eventId: 'evt-create-parent-session',
    ackId: 'ack-create-parent',
    sequence: 0,
    type: 'session.create.requested',
    timestamp: new Date().toISOString(),
    actor: 'client',
    payload: { agent: { agentSpecId }, input: { message }, workspace: { source: 'empty' } }
  };
}

function inputReceivedEvent(sessionId: string, ackId: string, message: string, delegationTarget?: unknown): RuntimeEvent {
  return {
    eventId: `evt-${ackId}`,
    sessionId,
    ackId,
    sequence: 0,
    type: 'input.received',
    timestamp: new Date().toISOString(),
    actor: 'client',
    payload: { input: { message, ...(delegationTarget !== undefined ? { delegationTarget } : {}) } }
  };
}

function workerHeartbeatEvent(workerId: string): RuntimeEvent {
  return {
    eventId: `evt-heartbeat-${workerId}`,
    workerId,
    sequence: 0,
    type: 'worker.heartbeat',
    timestamp: new Date().toISOString(),
    actor: 'sidecar',
    payload: { workerId, capacity: 1, allocatable: 1, conditions: ['ready'] }
  };
}

const clientContext = { principal: { principalId: 'diagnostics-console', type: 'user' as const }, connectionId: 'console-conn' };
const parentContext = { principal: { principalId: 'parent-sidecar', type: 'service' as const } };

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

async function waitFor(check: () => Promise<boolean>, label: string, drive?: () => Promise<void>): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await check()) {
      return;
    }
    if (drive) {
      await drive();
    }
    await settle();
  }
  throw new Error(`condition never held: ${label}`);
}

/**
 * Simulate a browser worker whose tab was suspended past its keepalive TTL: force its durable record's
 * `expiresAt` into the past so the next reconcile expires it (there is no injectable clock on the full
 * CentralService path). This is the exact durable state central would reach after the phone stopped heartbeating.
 */
async function forceExpireWorker(storage: LocalFileStorage, workerId: string): Promise<void> {
  const worker = await storage.readWorker(workerId);
  assert.ok(worker, `worker ${workerId} should exist to expire`);
  await storage.writeWorker({ ...worker, expiresAt: new Date(Date.now() - 60_000).toISOString() });
}

function structuredObservation(message: string): Record<string, unknown> {
  const marker = 'structured-observation:';
  const at = message.indexOf(marker);
  assert.ok(at >= 0, 'the tool result must carry a structured-observation payload');
  return JSON.parse(message.slice(message.indexOf('{', at))) as Record<string, unknown>;
}

test('scenario: a cloud recovery agent delegates a scan step to the browser edge worker and gets structured evidence back', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ars-delegation-edge-'));
  try {
    const runtimeTransport = new InMemoryRuntimeTransportAdapter();
    const storage = new LocalFileStorage(root);
    const central = new CentralService({ storage, eventTransport: runtimeTransport, connectionIssuer: runtimeTransport });
    await central.start();

    // The parent cloud agent worker (network-recovery-expert) registers and is driven by a real SidecarDaemon.
    const parentGrant = await central.negotiateSidecarConnectionForTenant('poc', parentContext, parentWorkerRegistration());
    const parentWorker = parentGrant.worker;
    assert.ok(parentWorker);
    await runtimeTransport.publish(
      { kind: 'tenant-inbox' },
      workerHeartbeatEvent(parentWorker.workerId),
      { principal: { principalId: parentWorker.workerId, type: 'service' as const } }
    );

    const captureTask = { task: 'capture', target: 'model and serial label', source: 'environment', detect: ['code'] };
    const parentAgent = new CaptureDelegatingAgentProcessAdapter(captureTask);
    const parentSidecar = new SidecarDaemon({
      runtimeTransport: new SidecarInMemoryTransport(runtimeTransport),
      workspaceAdapter: new PassthroughWorkspaceAdapter(),
      agentProcessAdapter: parentAgent
    });
    await parentSidecar.subscribeWorkerCommands(parentWorker.workerId);

    // The browser edge worker (the phone) enrolls into THIS case: mint a one-time invite, redeem it into a durable
    // binding, and register presenting only the binding credential. Central mints the `{ case, deviceRef }` labels.
    // Enrollment needs the case, so the parent recovery session is created first.
    await runtimeTransport.publish(
      { kind: 'tenant-inbox' },
      sessionCreateEvent('network-recovery-expert', 'Open a recovery ticket: the home router WAN light is red.'),
      clientContext
    );
    const parentCreated = (await storage.readSessions()).find((s) => s.resolvedAgentSpec.agentSpecId === 'network-recovery-expert');
    assert.ok(parentCreated, 'the durable recovery parent session should be created');

    const enrolled = await enrollBoundDevice(central, storage, runtimeTransport, parentCreated.sessionId, 'device-phone', 'iOS device', 'edge-principal');
    const edgeWorker = enrolled.grant.worker;
    assert.ok(edgeWorker);
    const captureProvider = createAnalyzerCaptureProvider(
      new CanvasHeuristicAnalyzer(),
      async (request) => ({
        status: 'captured',
        captured: { frame: frameWithRedBlob(), source: request.source, sampleSource: 'simulated', facingMode: request.source }
      }),
      { observers: [new LedIndicatorAnalyzer(), createCodeObserver(new BrowserBarcodeScanner())] }
    );
    const edgeEvents: EdgeWorkerLifecycleEvent[] = [];
    const edgeRuntime = new EdgeWorkerRuntime({
      transport: new InMemoryEdgeWorkerTransport(runtimeTransport),
      agent: new CameraDiagnosticAgent({ captureProvider, manifestProvider: () => BROWSER_MANIFEST }),
      observer: (event) => edgeEvents.push(event)
    });
    await edgeRuntime.connectWithGrant(enrolled.grant);

    // The console sends the operator's device target as the turn's structured `delegationTarget` (durable, turn-scoped
    // control metadata). Here the agent does NOT echo a tool target, proving Central applies its own durable constraint
    // authoritatively rather than depending on the model to reproduce it — a device-scoped delegate never pool-routes.
    await runtimeTransport.publish(
      { kind: 'tenant-inbox' },
      inputReceivedEvent(parentCreated.sessionId, 'diagnose-1', 'The WAN light is solid red — look at the device to narrow it down.', { deviceRef: enrolled.deviceRef }),
      clientContext
    );
    const toolResponse = await withTimeout(parentAgent.toolResponse, 5000, 'delegate tool response');
    await settle();
    await settle();

    // Two sessions exist: the durable parent and the delegated browser-scan child.
    const sessions = await storage.readSessions();
    const parent = sessions.find((s) => s.resolvedAgentSpec.agentSpecId === 'network-recovery-expert');
    const child = sessions.find((s) => s.resolvedAgentSpec.agentSpecId === 'device-scan-probe');
    assert.ok(parent, 'the durable recovery parent session should exist');
    assert.ok(child, 'a delegated browser-scan child session should exist');

    // The delegate tool was produced from the parent spec's asCaller wiring.
    const tool = parent.resolvedAgentSpec.runtimeTools.find((candidate) => candidate.name === 'scan_device_evidence');
    assert.ok(tool, 'the parent must expose the scan_device_evidence delegate tool');
    assert.equal(tool.binding.kind, 'delegate');

    // Capability-labeled routing: the child is bound to the parent by delegation and runs on the browser worker.
    assert.equal(child.delegationBinding?.parentSessionId, parent.sessionId);
    assert.equal(child.delegationBinding?.delegateId, 'device-scan-capture');
    assert.equal(child.currentWorkerId, edgeWorker.workerId);

    // The child received the parent's exact task string as its turn input.
    const started = edgeEvents.find((event) => event.type === 'turn.started');
    assert.ok(started && started.type === 'turn.started');
    assert.equal(started.message, JSON.stringify(captureTask));

    // The parent's tool result is the child's structured observation (only the message is forwarded).
    const resultMessage = (toolResponse as { result?: unknown }).result;
    assert.equal(typeof resultMessage, 'string');
    const observation = structuredObservation(resultMessage as string);
    assert.equal(observation.status, 'captured');
    assert.equal(observation.target, 'model and serial label');
    assert.ok(observation.signals, 'structured optical signals must be present');

    // Detect scoping + honest degradation: only the requested `code` detector ran, and it reports unsupported
    // (no BarcodeDetector in this runtime) instead of fabricating a decode. The LED detector was not requested.
    assert.deepEqual(observation.detectors, { led: 'not-run', code: 'unsupported' });

    // Privacy invariant: no raw RGBA buffer appears in any persisted event of either session.
    const parentEvents = await storage.readEvents(parent.sessionId, 0);
    const childEvents = await storage.readEvents(child.sessionId, 0);
    const serialized = JSON.stringify([...parentEvents, ...childEvents]);
    assert.ok(!serialized.includes('"data"'), 'raw frame pixels must never appear in the runtime event log');

    // The child persisted the full structured evidence output (retained device-side privacy flag).
    const childCompleted = childEvents.find((event) => event.type === 'turn.completed');
    const childOutput = (childCompleted?.payload as { result?: { output?: Record<string, unknown> } } | undefined)?.result?.output;
    assert.equal(childOutput?.kind, 'device-evidence');
    assert.equal(childOutput?.privacy, 'raw-frame-retained-on-device');
    assert.equal(childOutput?.imageShared, false);

    await edgeRuntime.stop();
    await parentSidecar.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- Multi-device foundation: one case roster, per-device targeted routing ---------------------------------

/**
 * A parent recovery agent that calls the scan delegate tool once per turn, carrying an explicit `target` per turn.
 * `turnSpecs` is read at turn time, so the test can enroll devices and learn their Central-authoritative `deviceRef`
 * values AFTER the parent session (the case) exists but BEFORE the first turn fires.
 */
class MultiTargetCaptureAgentProcessAdapter implements SidecarAgentProcessAdapter {
  private pending: ((response: unknown) => void) | undefined;
  private turn = 0;
  private readonly settleTurn: ((response: unknown) => void)[] = [];
  readonly toolResponses: Promise<unknown>[];

  constructor(private readonly turnSpecs: { task: unknown; target?: unknown }[], expectedTurns: number) {
    this.toolResponses = Array.from({ length: expectedTurns }, (_, index) =>
      new Promise<unknown>((resolve) => { this.settleTurn[index] = resolve; }));
  }

  async start(): Promise<void> {}

  async send(_input: SidecarAgentProcessInput, emit: SidecarAgentProcessEventHandler): Promise<SidecarAgentTurnResult> {
    const index = this.turn++;
    const spec = this.turnSpecs[index];
    if (!spec) {
      throw new Error(`no turn spec configured for turn ${index}`);
    }
    const response = new Promise<unknown>((resolve) => { this.pending = resolve; });
    await emit({
      type: 'interaction',
      payload: {
        interactionId: `capture-request-${index + 1}`,
        kind: 'tool_call',
        request: {
          toolName: 'scan_device_evidence',
          arguments: { message: JSON.stringify(spec.task), ...(spec.target !== undefined ? { target: spec.target } : {}) }
        }
      }
    });
    const resolved = await response;
    this.settleTurn[index]?.(resolved);
    return { message: `Recovery turn ${index + 1} recorded.`, output: { toolResult: resolved } };
  }

  async respondToInteraction(input: SidecarInteractionResponseInput): Promise<void> {
    const resolve = this.pending;
    this.pending = undefined;
    resolve?.(input.response);
  }
}

interface EnrolledDevice {
  deviceRef: string;
  deviceId: string;
  deviceLabel: string;
  caseId: string;
  bindingCredential: string;
  principalId: string;
  workerId: string;
  grant: Awaited<ReturnType<CentralService['negotiateSidecarConnectionForTenant']>>;
}

/**
 * Drive the REAL enrollment chain for one device on a case: mint a one-time invite, redeem it through Central into a
 * durable binding, then register the browser worker presenting only its binding credential. Central mints the
 * authoritative `{ case, deviceRef }` routing labels — the test never self-declares them.
 */
async function enrollBoundDevice(
  central: CentralService,
  storage: LocalFileStorage,
  runtimeTransport: InMemoryRuntimeTransportAdapter,
  caseId: string,
  deviceId: string,
  deviceLabel: string,
  principalId: string
): Promise<EnrolledDevice> {
  const pairing = new CasePairingManager('poc', storage, { now: () => new Date().toISOString() });
  const invite = await pairing.mintPairingInvite(caseId);
  const redeemed = await central.redeemPairingInviteForTenant('poc', clientContext, {
    inviteId: invite.inviteId,
    inviteSecret: invite.inviteSecret,
    deviceId,
    deviceLabel
  });
  const grant = await registerBoundWorker(central, runtimeTransport, {
    caseId: redeemed.caseId,
    deviceId,
    deviceRef: redeemed.deviceRef,
    bindingCredential: redeemed.bindingCredential
  }, principalId);
  assert.ok(grant.worker);
  return {
    deviceRef: redeemed.deviceRef,
    deviceId,
    deviceLabel,
    caseId: redeemed.caseId,
    bindingCredential: redeemed.bindingCredential,
    principalId,
    workerId: grant.worker.workerId,
    grant
  };
}

/**
 * Reconnect an already-enrolled device after its previous worker lifetime was lost (tab suspended past keepalive,
 * transport dropped). The phone re-registers presenting ONLY its stored binding credential + opaque deviceId — never
 * the one-time invite — so Central re-mints the SAME authoritative `deviceRef` label onto a fresh worker record.
 */
async function reconnectBoundDevice(
  central: CentralService,
  runtimeTransport: InMemoryRuntimeTransportAdapter,
  device: EnrolledDevice,
  principalId: string
): Promise<Awaited<ReturnType<CentralService['negotiateSidecarConnectionForTenant']>>> {
  const grant = await registerBoundWorker(central, runtimeTransport, {
    caseId: device.caseId,
    deviceId: device.deviceId,
    deviceRef: device.deviceRef,
    bindingCredential: device.bindingCredential
  }, principalId);
  assert.ok(grant.worker);
  return grant;
}

async function registerBoundWorker(
  central: CentralService,
  runtimeTransport: InMemoryRuntimeTransportAdapter,
  edgeBinding: { caseId: string; deviceId: string; deviceRef: string; bindingCredential: string },
  principalId: string
): Promise<Awaited<ReturnType<CentralService['negotiateSidecarConnectionForTenant']>>> {
  const registration: WorkerRegisterPayload = {
    labels: { agent: 'browser-edge', tier: 'edge', role: 'device-scan-probe', storage: 'host-managed' },
    storageClass: 'host-managed',
    capacity: 1,
    allocatable: 1,
    edgeBinding
  };
  const grant = await central.negotiateSidecarConnectionForTenant('poc', { principal: { principalId, type: 'service' } }, registration);
  assert.ok(grant.worker);
  await runtimeTransport.publish(
    { kind: 'tenant-inbox' },
    workerHeartbeatEvent(grant.worker.workerId),
    { principal: { principalId: grant.worker.workerId, type: 'service' as const } }
  );
  return grant;
}

function edgeRuntimeFor(runtimeTransport: InMemoryRuntimeTransportAdapter): EdgeWorkerRuntime {
  const captureProvider = createAnalyzerCaptureProvider(
    new CanvasHeuristicAnalyzer(),
    async (request) => ({
      status: 'captured',
      captured: { frame: frameWithRedBlob(), source: request.source, sampleSource: 'simulated', facingMode: request.source }
    }),
    { observers: [new LedIndicatorAnalyzer(), createCodeObserver(new BrowserBarcodeScanner())] }
  );
  return new EdgeWorkerRuntime({
    transport: new InMemoryEdgeWorkerTransport(runtimeTransport),
    agent: new CameraDiagnosticAgent({ captureProvider, manifestProvider: () => BROWSER_MANIFEST }),
    observer: () => undefined
  });
}

test('scenario: a targeted device lost mid-scan fails the child deterministically, unblocks the parent, and a retry routes to the same rejoined device', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ars-delegation-reconnect-'));
  try {
    const runtimeTransport = new InMemoryRuntimeTransportAdapter();
    const storage = new LocalFileStorage(root);
    const central = new CentralService({ storage, eventTransport: runtimeTransport, connectionIssuer: runtimeTransport });
    await central.start();

    const parentGrant = await central.negotiateSidecarConnectionForTenant('poc', parentContext, parentWorkerRegistration());
    const parentWorker = parentGrant.worker;
    assert.ok(parentWorker);
    await runtimeTransport.publish(
      { kind: 'tenant-inbox' },
      workerHeartbeatEvent(parentWorker.workerId),
      { principal: { principalId: parentWorker.workerId, type: 'service' as const } }
    );

    const captureTask = { task: 'capture', target: 'model and serial label', source: 'environment', detect: ['code'] };
    const turnSpecs: { task: unknown; target?: unknown }[] = [];
    const parentAgent = new MultiTargetCaptureAgentProcessAdapter(turnSpecs, 2);
    const parentSidecar = new SidecarDaemon({
      runtimeTransport: new SidecarInMemoryTransport(runtimeTransport),
      workspaceAdapter: new PassthroughWorkspaceAdapter(),
      agentProcessAdapter: parentAgent
    });
    await parentSidecar.subscribeWorkerCommands(parentWorker.workerId);

    await runtimeTransport.publish(
      { kind: 'tenant-inbox' },
      sessionCreateEvent('network-recovery-expert', 'A device dropped mid-scan — open a recovery ticket.'),
      clientContext
    );
    const parentCreated = (await storage.readSessions()).find((s) => s.resolvedAgentSpec.agentSpecId === 'network-recovery-expert');
    assert.ok(parentCreated, 'the durable recovery parent session should be created');
    const caseId = parentCreated.sessionId;

    // The targeted phone enrolls and heartbeats ready but runs NO live runtime yet, so its assigned scan child will
    // sit unprocessed — exactly a phone that received the task and then dropped before capturing. A Windows decoy on
    // the same case is enrolled too; it is never targeted and must never receive the phone's scan.
    const phone = await enrollBoundDevice(central, storage, runtimeTransport, caseId, 'device-phone', 'iOS device', 'edge-phone');
    const windows = await enrollBoundDevice(central, storage, runtimeTransport, caseId, 'device-windows', 'Windows device', 'edge-windows');
    assert.notEqual(phone.deviceRef, windows.deviceRef);

    // Turn 1 targets the phone explicitly; its child is assigned to the phone's worker and then the phone is lost.
    turnSpecs.push({ task: captureTask, target: { deviceRef: phone.deviceRef } });
    await runtimeTransport.publish(
      { kind: 'tenant-inbox' },
      inputReceivedEvent(caseId, 'diagnose-phone', 'Scan the phone-facing device.', { deviceRef: phone.deviceRef }),
      clientContext
    );

    await waitFor(
      async () => {
        const child = (await storage.readSessions()).find((s) =>
          s.resolvedAgentSpec.agentSpecId === 'device-scan-probe'
          && s.delegationBinding?.parentSessionId === caseId
          && s.requiredWorkerLabels?.deviceRef === phone.deviceRef);
        return child?.currentWorkerId === phone.workerId;
      },
      'phone scan child assigned to the phone worker',
      () => central.reconcileSessionsForTenant('poc')
    );

    const lostChild = (await storage.readSessions()).find((s) =>
      s.resolvedAgentSpec.agentSpecId === 'device-scan-probe' && s.delegationBinding?.parentSessionId === caseId);
    assert.ok(lostChild);
    assert.equal(lostChild.currentWorkerId, phone.workerId);

    // Lose the phone past its keepalive TTL. One reconcile expires the worker, fails its leased child deterministically,
    // and unblocks the parent tool await with an honest child-loss error instead of spinning `working` forever.
    await forceExpireWorker(storage, phone.workerId);
    await central.reconcileSessionsForTenant('poc');
    await settle();

    const failedResult = await withTimeout(parentAgent.toolResponses[0], 8000, 'phone-loss child failure surfaced to parent');
    assert.match((failedResult as { result?: string }).result ?? '', /Subagent failed \[child_session_lost\]/);

    // The phone rejoins by re-registering with its STORED binding credential (not a fresh invite) and now runs a live
    // runtime. Central re-mints the same deviceRef onto the new worker record.
    const rejoinGrant = await reconnectBoundDevice(central, runtimeTransport, phone, 'edge-phone-2');
    const rejoinedWorkerId = rejoinGrant.worker!.workerId;
    assert.notEqual(rejoinedWorkerId, phone.workerId);
    const rejoinedRuntime = edgeRuntimeFor(runtimeTransport);
    await rejoinedRuntime.connectWithGrant(rejoinGrant);
    await settle();

    // Turn 2 retries the SAME device target. Because the failed delegation key is excluded, a FRESH delegation + child
    // opens and routes only to the rejoined phone worker, which completes the scan.
    turnSpecs.push({ task: captureTask, target: { deviceRef: phone.deviceRef } });
    await runtimeTransport.publish(
      { kind: 'tenant-inbox' },
      inputReceivedEvent(caseId, 'diagnose-phone-retry', 'Retry the phone scan now that it rejoined.', { deviceRef: phone.deviceRef }),
      clientContext
    );
    const retryResult = await withTimeout(parentAgent.toolResponses[1], 8000, 'phone retry scan result');
    await settle();
    await settle();
    assert.equal(structuredObservation((retryResult as { result?: string }).result ?? '').status, 'captured');

    // The retry child is a DISTINCT session pinned to the same deviceRef and ran on the REJOINED phone worker.
    const retryChild = (await storage.readSessions()).find((s) =>
      s.resolvedAgentSpec.agentSpecId === 'device-scan-probe'
      && s.delegationBinding?.parentSessionId === caseId
      && s.sessionId !== lostChild.sessionId);
    assert.ok(retryChild, 'a fresh scan child should open for the retry');
    assert.deepEqual(retryChild.requiredWorkerLabels, { case: caseId, deviceRef: phone.deviceRef });
    assert.equal(retryChild.currentWorkerId, rejoinedWorkerId);
    const retryChildEvents = await storage.readEvents(retryChild.sessionId, 0);
    assert.ok(retryChildEvents.some((event) => event.type === 'turn.completed' && event.workerId === rejoinedWorkerId));

    // The untargeted Windows decoy never received the phone's scan across the whole loss/retry cycle.
    const windowsAfter = await storage.readWorker(windows.workerId);
    assert.equal(windowsAfter?.currentSessionCount, 0);

    await rejoinedRuntime.stop();
    await parentSidecar.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scenario: with three devices on one case roster, each targeted scan routes only to its own device', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ars-delegation-multidevice-'));
  try {
    const runtimeTransport = new InMemoryRuntimeTransportAdapter();
    const storage = new LocalFileStorage(root);
    const central = new CentralService({ storage, eventTransport: runtimeTransport, connectionIssuer: runtimeTransport });
    await central.start();

    // Durable parent recovery agent worker, driven across two turns (one per targeted device).
    const parentGrant = await central.negotiateSidecarConnectionForTenant('poc', parentContext, parentWorkerRegistration());
    const parentWorker = parentGrant.worker;
    assert.ok(parentWorker);
    await runtimeTransport.publish(
      { kind: 'tenant-inbox' },
      workerHeartbeatEvent(parentWorker.workerId),
      { principal: { principalId: parentWorker.workerId, type: 'service' as const } }
    );

    const captureTask = { task: 'capture', target: 'model and serial label', source: 'environment', detect: ['code'] };
    const turnSpecs: { task: unknown; target?: unknown }[] = [];
    const parentAgent = new MultiTargetCaptureAgentProcessAdapter(turnSpecs, 2);
    const parentSidecar = new SidecarDaemon({
      runtimeTransport: new SidecarInMemoryTransport(runtimeTransport),
      workspaceAdapter: new PassthroughWorkspaceAdapter(),
      agentProcessAdapter: parentAgent
    });
    await parentSidecar.subscribeWorkerCommands(parentWorker.workerId);

    // The console opens the durable recovery ticket; the parent session id IS the case id used to mint invites.
    await runtimeTransport.publish(
      { kind: 'tenant-inbox' },
      sessionCreateEvent('network-recovery-expert', 'Two devices reported at this address — open a recovery ticket.'),
      clientContext
    );
    const parentCreated = (await storage.readSessions()).find((s) => s.resolvedAgentSpec.agentSpecId === 'network-recovery-expert');
    assert.ok(parentCreated, 'the durable recovery parent session should be created');
    const caseId = parentCreated.sessionId;

    // Three devices redeem into ONE case roster. A and B will be targeted; C is an enrolled-but-untargeted decoy
    // that shares the base browser selector and the same case — it must never receive another device's scan.
    const deviceA = await enrollBoundDevice(central, storage, runtimeTransport, caseId, 'device-A', 'iOS device', 'edge-A');
    const deviceB = await enrollBoundDevice(central, storage, runtimeTransport, caseId, 'device-B', 'Android device', 'edge-B');
    const deviceC = await enrollBoundDevice(central, storage, runtimeTransport, caseId, 'device-C', 'Windows device', 'edge-C');
    assert.notEqual(deviceA.deviceRef, deviceB.deviceRef);
    assert.notEqual(deviceA.deviceRef, deviceC.deviceRef);

    // A and B run live edge runtimes that can actually complete a scan. C stays registered but idle.
    const runtimeA = edgeRuntimeFor(runtimeTransport);
    const runtimeB = edgeRuntimeFor(runtimeTransport);
    await runtimeA.connectWithGrant(deviceA.grant);
    await runtimeB.connectWithGrant(deviceB.grant);
    await settle();

    // Turn 1 targets device A explicitly.
    turnSpecs.push({ task: captureTask, target: { deviceRef: deviceA.deviceRef } });
    await runtimeTransport.publish(
      { kind: 'tenant-inbox' },
      inputReceivedEvent(caseId, 'diagnose-A', 'Scan device A first.', { deviceRef: deviceA.deviceRef }),
      clientContext
    );
    const resultA = await withTimeout(parentAgent.toolResponses[0], 5000, 'device A targeted scan result');
    await settle();
    await settle();
    assert.equal(structuredObservation((resultA as { result?: string }).result ?? '').status, 'captured');

    const childA = (await storage.readSessions()).find((s) =>
      s.resolvedAgentSpec.agentSpecId === 'device-scan-probe' && s.delegationBinding?.parentSessionId === caseId);
    assert.ok(childA, 'a scan child for device A should exist');
    // The child was pinned to A's case + deviceRef and routed ONLY to A's worker.
    assert.deepEqual(childA.requiredWorkerLabels, { case: caseId, deviceRef: deviceA.deviceRef });
    assert.equal(childA.currentWorkerId, deviceA.workerId);
    assert.notEqual(childA.currentWorkerId, deviceB.workerId);
    assert.notEqual(childA.currentWorkerId, deviceC.workerId);

    // Turn 2 targets device B explicitly — a DISTINCT delegation key opens a distinct child on B's worker.
    turnSpecs.push({ task: captureTask, target: { deviceRef: deviceB.deviceRef } });
    await runtimeTransport.publish(
      { kind: 'tenant-inbox' },
      inputReceivedEvent(caseId, 'diagnose-B', 'Now scan device B.', { deviceRef: deviceB.deviceRef }),
      clientContext
    );
    const resultB = await withTimeout(parentAgent.toolResponses[1], 5000, 'device B targeted scan result');
    await settle();
    await settle();
    assert.equal(structuredObservation((resultB as { result?: string }).result ?? '').status, 'captured');

    const childB = (await storage.readSessions()).find((s) =>
      s.resolvedAgentSpec.agentSpecId === 'device-scan-probe'
      && s.delegationBinding?.parentSessionId === caseId
      && s.sessionId !== childA.sessionId);
    assert.ok(childB, 'a distinct scan child for device B should exist');
    assert.deepEqual(childB.requiredWorkerLabels, { case: caseId, deviceRef: deviceB.deviceRef });
    assert.equal(childB.currentWorkerId, deviceB.workerId);

    // The untargeted decoy C on the same case roster never received any work.
    const cAfter = await storage.readWorker(deviceC.workerId);
    assert.equal(cAfter?.currentSessionCount, 0);

    // B's worker actually ran B's scan to completion.
    const childBEvents = await storage.readEvents(childB.sessionId, 0);
    assert.ok(childBEvents.some((event) => event.type === 'turn.completed' && event.workerId === deviceB.workerId));

    await runtimeA.stop();
    await runtimeB.stop();
    await parentSidecar.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scenario: two turns queued back-to-back keep their own durably-bound target; the agent supplies no target and the constraints never leak across turns', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ars-delegation-turnisolation-'));
  try {
    const runtimeTransport = new InMemoryRuntimeTransportAdapter();
    const storage = new LocalFileStorage(root);
    const central = new CentralService({ storage, eventTransport: runtimeTransport, connectionIssuer: runtimeTransport });
    await central.start();

    const parentGrant = await central.negotiateSidecarConnectionForTenant('poc', parentContext, parentWorkerRegistration());
    const parentWorker = parentGrant.worker;
    assert.ok(parentWorker);
    await runtimeTransport.publish(
      { kind: 'tenant-inbox' },
      workerHeartbeatEvent(parentWorker.workerId),
      { principal: { principalId: parentWorker.workerId, type: 'service' as const } }
    );

    const captureTask = { task: 'capture', target: 'model and serial label', source: 'environment', detect: ['code'] };
    // Both turns run the SAME agent brain that emits NO tool target (no `target` key). The only thing that can route
    // each turn to a specific device is Central's durable per-turn `delegationTarget`, bound to that accepted turn.
    const turnSpecs: { task: unknown; target?: unknown }[] = [];
    const parentAgent = new MultiTargetCaptureAgentProcessAdapter(turnSpecs, 2);
    const parentSidecar = new SidecarDaemon({
      runtimeTransport: new SidecarInMemoryTransport(runtimeTransport),
      workspaceAdapter: new PassthroughWorkspaceAdapter(),
      agentProcessAdapter: parentAgent
    });
    await parentSidecar.subscribeWorkerCommands(parentWorker.workerId);

    await runtimeTransport.publish(
      { kind: 'tenant-inbox' },
      sessionCreateEvent('network-recovery-expert', 'Two devices reported at this address — open a recovery ticket.'),
      clientContext
    );
    const parentCreated = (await storage.readSessions()).find((s) => s.resolvedAgentSpec.agentSpecId === 'network-recovery-expert');
    assert.ok(parentCreated, 'the durable recovery parent session should be created');
    const caseId = parentCreated.sessionId;

    const deviceA = await enrollBoundDevice(central, storage, runtimeTransport, caseId, 'device-A', 'iOS device', 'edge-A');
    const deviceB = await enrollBoundDevice(central, storage, runtimeTransport, caseId, 'device-B', 'Android device', 'edge-B');
    const deviceC = await enrollBoundDevice(central, storage, runtimeTransport, caseId, 'device-C', 'Windows device', 'edge-C');

    const runtimeA = edgeRuntimeFor(runtimeTransport);
    const runtimeB = edgeRuntimeFor(runtimeTransport);
    await runtimeA.connectWithGrant(deviceA.grant);
    await runtimeB.connectWithGrant(deviceB.grant);
    await settle();

    // Enqueue both turn brains, then publish BOTH inputs back-to-back BEFORE awaiting either result. Turn 1 is durably
    // bound to A, turn 2 to B. The runtime accepts them in arrival order (turnSeq 1 then 2) and processes them
    // serially; each delegate call resolves against its OWN turn's durable target.
    turnSpecs.push({ task: captureTask });
    turnSpecs.push({ task: captureTask });
    await runtimeTransport.publish(
      { kind: 'tenant-inbox' },
      inputReceivedEvent(caseId, 'diagnose-A', 'Scan the first device.', { deviceRef: deviceA.deviceRef }),
      clientContext
    );
    await runtimeTransport.publish(
      { kind: 'tenant-inbox' },
      inputReceivedEvent(caseId, 'diagnose-B', 'Scan the second device.', { deviceRef: deviceB.deviceRef }),
      clientContext
    );

    const resultA = await withTimeout(parentAgent.toolResponses[0], 5000, 'queued turn 1 (device A) result');
    const resultB = await withTimeout(parentAgent.toolResponses[1], 5000, 'queued turn 2 (device B) result');
    await settle();
    await settle();
    assert.equal(structuredObservation((resultA as { result?: string }).result ?? '').status, 'captured');
    assert.equal(structuredObservation((resultB as { result?: string }).result ?? '').status, 'captured');

    const scanChildren = (await storage.readSessions()).filter((s) =>
      s.resolvedAgentSpec.agentSpecId === 'device-scan-probe' && s.delegationBinding?.parentSessionId === caseId);
    // Exactly two children — one per turn — with no third child leaked onto the untargeted decoy.
    assert.equal(scanChildren.length, 2);

    const childForA = scanChildren.find((s) => s.requiredWorkerLabels?.deviceRef === deviceA.deviceRef);
    const childForB = scanChildren.find((s) => s.requiredWorkerLabels?.deviceRef === deviceB.deviceRef);
    assert.ok(childForA, 'turn 1 must open a child bound to A even though the agent named no target');
    assert.ok(childForB, 'turn 2 must open a child bound to B even though the agent named no target');
    // The decisive no-leak assertion: turn 1 routed ONLY to A and turn 2 ONLY to B; neither turn bled into the other.
    assert.equal(childForA.currentWorkerId, deviceA.workerId);
    assert.equal(childForB.currentWorkerId, deviceB.workerId);
    assert.notEqual(childForA.currentWorkerId, deviceB.workerId);
    assert.notEqual(childForB.currentWorkerId, deviceA.workerId);

    // Each device's worker actually ran exactly its own turn.
    const aEvents = await storage.readEvents(childForA.sessionId, 0);
    const bEvents = await storage.readEvents(childForB.sessionId, 0);
    assert.ok(aEvents.some((event) => event.type === 'turn.completed' && event.workerId === deviceA.workerId));
    assert.ok(bEvents.some((event) => event.type === 'turn.completed' && event.workerId === deviceB.workerId));

    // The untargeted decoy C on the same roster never received either turn.
    const cAfter = await storage.readWorker(deviceC.workerId);
    assert.equal(cAfter?.currentSessionCount, 0);

    await runtimeA.stop();
    await runtimeB.stop();
    await parentSidecar.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scenario: targeting a device that is not paired to the case is rejected, not routed to the pool', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ars-delegation-untargeted-'));
  try {
    const runtimeTransport = new InMemoryRuntimeTransportAdapter();
    const storage = new LocalFileStorage(root);
    const central = new CentralService({ storage, eventTransport: runtimeTransport, connectionIssuer: runtimeTransport });
    await central.start();

    const parentGrant = await central.negotiateSidecarConnectionForTenant('poc', parentContext, parentWorkerRegistration());
    const parentWorker = parentGrant.worker;
    assert.ok(parentWorker);
    await runtimeTransport.publish(
      { kind: 'tenant-inbox' },
      workerHeartbeatEvent(parentWorker.workerId),
      { principal: { principalId: parentWorker.workerId, type: 'service' as const } }
    );

    const captureTask = { task: 'capture', target: 'model and serial label', source: 'environment', detect: ['code'] };
    const turnSpecs: { task: unknown; target?: unknown }[] = [];
    const parentAgent = new MultiTargetCaptureAgentProcessAdapter(turnSpecs, 1);
    const parentSidecar = new SidecarDaemon({
      runtimeTransport: new SidecarInMemoryTransport(runtimeTransport),
      workspaceAdapter: new PassthroughWorkspaceAdapter(),
      agentProcessAdapter: parentAgent
    });
    await parentSidecar.subscribeWorkerCommands(parentWorker.workerId);

    await runtimeTransport.publish(
      { kind: 'tenant-inbox' },
      sessionCreateEvent('network-recovery-expert', 'Open a recovery ticket.'),
      clientContext
    );
    const parentCreated = (await storage.readSessions()).find((s) => s.resolvedAgentSpec.agentSpecId === 'network-recovery-expert');
    assert.ok(parentCreated);
    const caseId = parentCreated.sessionId;

    // A ready browser worker exists in the tenant, but the targeted deviceRef is NOT bound to this case. The tool
    // call must fail (escaping the case/tenant boundary) rather than silently routing to a pool worker.
    await enrollBoundDevice(central, storage, runtimeTransport, caseId, 'device-real', 'iOS device', 'edge-real');

    turnSpecs.push({ task: captureTask, target: { deviceRef: 'dref_not_on_this_case' } });
    await runtimeTransport.publish(
      { kind: 'tenant-inbox' },
      inputReceivedEvent(caseId, 'diagnose-1', 'Scan an unknown device.', { deviceRef: 'dref_not_on_this_case' }),
      clientContext
    );
    const result = await withTimeout(parentAgent.toolResponses[0], 5000, 'rejected target scan result');
    await settle();
    assert.match((result as { result?: string }).result ?? '', /Subagent failed/);

    // No scan child was created for the invalid target.
    const child = (await storage.readSessions()).find((s) => s.resolvedAgentSpec.agentSpecId === 'device-scan-probe');
    assert.equal(child, undefined);

    await parentSidecar.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scenario: target all fans one child out to every rostered device and aggregates their observations, while an unrelated device on another case never receives work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ars-delegation-fanout-all-'));
  try {
    const runtimeTransport = new InMemoryRuntimeTransportAdapter();
    const storage = new LocalFileStorage(root);
    const central = new CentralService({ storage, eventTransport: runtimeTransport, connectionIssuer: runtimeTransport });
    await central.start();

    const parentGrant = await central.negotiateSidecarConnectionForTenant('poc', parentContext, parentWorkerRegistration());
    const parentWorker = parentGrant.worker;
    assert.ok(parentWorker);
    await runtimeTransport.publish(
      { kind: 'tenant-inbox' },
      workerHeartbeatEvent(parentWorker.workerId),
      { principal: { principalId: parentWorker.workerId, type: 'service' as const } }
    );

    const captureTask = { task: 'capture', target: 'model and serial label', source: 'environment', detect: ['code'] };
    const turnSpecs: { task: unknown; target?: unknown }[] = [];
    const parentAgent = new MultiTargetCaptureAgentProcessAdapter(turnSpecs, 1);
    const parentSidecar = new SidecarDaemon({
      runtimeTransport: new SidecarInMemoryTransport(runtimeTransport),
      workspaceAdapter: new PassthroughWorkspaceAdapter(),
      agentProcessAdapter: parentAgent
    });
    await parentSidecar.subscribeWorkerCommands(parentWorker.workerId);

    // Case 1 is the recovery ticket we fan out on.
    await runtimeTransport.publish(
      { kind: 'tenant-inbox' },
      sessionCreateEvent('network-recovery-expert', 'Two devices reported at this address — open a recovery ticket.'),
      clientContext
    );
    const caseOne = (await storage.readSessions()).find((s) => s.resolvedAgentSpec.agentSpecId === 'network-recovery-expert');
    assert.ok(caseOne);
    const caseId = caseOne.sessionId;

    // Case 2 is a DIFFERENT recovery ticket. Device C is paired to it — it shares the base browser selector but is
    // not on case 1's roster, so `target: all` on case 1 must never reach it.
    await runtimeTransport.publish(
      { kind: 'tenant-inbox' },
      sessionCreateEvent('network-recovery-expert', 'A different address — open a separate recovery ticket.'),
      clientContext
    );
    const caseTwo = (await storage.readSessions()).find((s) =>
      s.resolvedAgentSpec.agentSpecId === 'network-recovery-expert' && s.sessionId !== caseId);
    assert.ok(caseTwo);

    const deviceA = await enrollBoundDevice(central, storage, runtimeTransport, caseId, 'device-A', 'iOS device', 'edge-A');
    const deviceB = await enrollBoundDevice(central, storage, runtimeTransport, caseId, 'device-B', 'Android device', 'edge-B');
    const deviceC = await enrollBoundDevice(central, storage, runtimeTransport, caseTwo.sessionId, 'device-C', 'Windows device', 'edge-C');

    const runtimeA = edgeRuntimeFor(runtimeTransport);
    const runtimeB = edgeRuntimeFor(runtimeTransport);
    await runtimeA.connectWithGrant(deviceA.grant);
    await runtimeB.connectWithGrant(deviceB.grant);
    await settle();

    // One tool call targets the WHOLE roster.
    turnSpecs.push({ task: captureTask, target: { scope: 'all' } });
    await runtimeTransport.publish(
      { kind: 'tenant-inbox' },
      inputReceivedEvent(caseId, 'diagnose-all', 'Scan every device on this case.', { scope: 'all' }),
      clientContext
    );
    const aggregateResult = await withTimeout(parentAgent.toolResponses[0], 8000, 'fan-out aggregate result');
    await settle();
    await settle();

    const aggregate = JSON.parse((aggregateResult as { result?: string }).result ?? '{}');
    assert.equal(aggregate.scope, 'all');
    assert.deepEqual(aggregate.summary, { total: 2, completed: 2, failed: 0 });
    const reportedRefs = (aggregate.devices as { deviceRef: string; status: string }[]).map((device) => device.deviceRef).sort();
    assert.deepEqual(reportedRefs, [deviceA.deviceRef, deviceB.deviceRef].sort());
    assert.ok((aggregate.devices as { status: string }[]).every((device) => device.status === 'completed'));

    // Exactly two scan children were opened for case 1 — one per rostered device — and each routed to its own worker.
    const children = (await storage.readSessions()).filter((s) =>
      s.resolvedAgentSpec.agentSpecId === 'device-scan-probe' && s.delegationBinding?.parentSessionId === caseId);
    assert.equal(children.length, 2);
    const childWorkers = children.map((childSession) => childSession.currentWorkerId).sort();
    assert.deepEqual(childWorkers, [deviceA.workerId, deviceB.workerId].sort());

    // The unrelated device C (on case 2) never received any work.
    const cAfter = await storage.readWorker(deviceC.workerId);
    assert.equal(cAfter?.currentSessionCount, 0);

    await runtimeA.stop();
    await runtimeB.stop();
    await parentSidecar.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scenario: when one fan-out target is lost mid-scan, the sibling still completes and the aggregate reports the partial failure honestly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ars-delegation-fanout-partial-'));
  try {
    const runtimeTransport = new InMemoryRuntimeTransportAdapter();
    const storage = new LocalFileStorage(root);
    const central = new CentralService({ storage, eventTransport: runtimeTransport, connectionIssuer: runtimeTransport });
    await central.start();

    const parentGrant = await central.negotiateSidecarConnectionForTenant('poc', parentContext, parentWorkerRegistration());
    const parentWorker = parentGrant.worker;
    assert.ok(parentWorker);
    await runtimeTransport.publish(
      { kind: 'tenant-inbox' },
      workerHeartbeatEvent(parentWorker.workerId),
      { principal: { principalId: parentWorker.workerId, type: 'service' as const } }
    );

    const captureTask = { task: 'capture', target: 'model and serial label', source: 'environment', detect: ['code'] };
    const turnSpecs: { task: unknown; target?: unknown }[] = [];
    const parentAgent = new MultiTargetCaptureAgentProcessAdapter(turnSpecs, 1);
    const parentSidecar = new SidecarDaemon({
      runtimeTransport: new SidecarInMemoryTransport(runtimeTransport),
      workspaceAdapter: new PassthroughWorkspaceAdapter(),
      agentProcessAdapter: parentAgent
    });
    await parentSidecar.subscribeWorkerCommands(parentWorker.workerId);

    await runtimeTransport.publish(
      { kind: 'tenant-inbox' },
      sessionCreateEvent('network-recovery-expert', 'Two devices reported — open a recovery ticket.'),
      clientContext
    );
    const caseOne = (await storage.readSessions()).find((s) => s.resolvedAgentSpec.agentSpecId === 'network-recovery-expert');
    assert.ok(caseOne);
    const caseId = caseOne.sessionId;

    // Device A has a live runtime and will complete. Device B registers + heartbeats but has no live runtime, so it
    // receives its child assignment and then never runs it — standing in for a phone that dropped mid-scan.
    const deviceA = await enrollBoundDevice(central, storage, runtimeTransport, caseId, 'device-A', 'iOS device', 'edge-A');
    const deviceB = await enrollBoundDevice(central, storage, runtimeTransport, caseId, 'device-B', 'Android device', 'edge-B');
    const runtimeA = edgeRuntimeFor(runtimeTransport);
    await runtimeA.connectWithGrant(deviceA.grant);
    await settle();

    turnSpecs.push({ task: captureTask, target: { scope: 'all' } });
    await runtimeTransport.publish(
      { kind: 'tenant-inbox' },
      inputReceivedEvent(caseId, 'diagnose-all', 'Scan every device on this case.', { scope: 'all' }),
      clientContext
    );

    // Wait until device B's child has actually been assigned to B's worker (so its loss is a real mid-scan drop),
    // then lose B past its keepalive TTL. A single reconcile expires B, fails B's leased child, fails the fan-out
    // member deterministically, and — since A already completed — settles the group with an honest partial result.
    await waitFor(
      async () => {
        const bChild = (await storage.readSessions()).find((s) =>
          s.resolvedAgentSpec.agentSpecId === 'device-scan-probe'
          && s.delegationBinding?.parentSessionId === caseId
          && s.requiredWorkerLabels?.deviceRef === deviceB.deviceRef);
        return bChild?.currentWorkerId === deviceB.workerId;
      },
      'device B scan child assigned to device B worker',
      () => central.reconcileSessionsForTenant('poc')
    );
    await forceExpireWorker(storage, deviceB.workerId);
    await central.reconcileSessionsForTenant('poc');
    await settle();

    const aggregateResult = await withTimeout(parentAgent.toolResponses[0], 8000, 'partial fan-out aggregate result');
    await settle();
    const aggregate = JSON.parse((aggregateResult as { result?: string }).result ?? '{}');
    assert.equal(aggregate.scope, 'all');
    assert.deepEqual(aggregate.summary, { total: 2, completed: 1, failed: 1 });
    const devices = aggregate.devices as { deviceRef: string; status: string; error?: string }[];
    const reportedA = devices.find((device) => device.deviceRef === deviceA.deviceRef);
    const reportedB = devices.find((device) => device.deviceRef === deviceB.deviceRef);
    assert.equal(reportedA?.status, 'completed');
    assert.equal(reportedB?.status, 'failed');
    assert.match(reportedB?.error ?? '', /child_session_lost/);

    await runtimeA.stop();
    await parentSidecar.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scenario: a device-scoped scan with no target is rejected, never silently routed to an available pool worker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ars-delegation-absent-target-'));
  try {
    const runtimeTransport = new InMemoryRuntimeTransportAdapter();
    const storage = new LocalFileStorage(root);
    const central = new CentralService({ storage, eventTransport: runtimeTransport, connectionIssuer: runtimeTransport });
    await central.start();

    const parentGrant = await central.negotiateSidecarConnectionForTenant('poc', parentContext, parentWorkerRegistration());
    const parentWorker = parentGrant.worker;
    assert.ok(parentWorker);
    await runtimeTransport.publish(
      { kind: 'tenant-inbox' },
      workerHeartbeatEvent(parentWorker.workerId),
      { principal: { principalId: parentWorker.workerId, type: 'service' as const } }
    );

    const captureTask = { task: 'capture', target: 'model and serial label', source: 'environment', detect: ['code'] };
    const turnSpecs: { task: unknown; target?: unknown }[] = [];
    const parentAgent = new MultiTargetCaptureAgentProcessAdapter(turnSpecs, 1);
    const parentSidecar = new SidecarDaemon({
      runtimeTransport: new SidecarInMemoryTransport(runtimeTransport),
      workspaceAdapter: new PassthroughWorkspaceAdapter(),
      agentProcessAdapter: parentAgent
    });
    await parentSidecar.subscribeWorkerCommands(parentWorker.workerId);

    await runtimeTransport.publish(
      { kind: 'tenant-inbox' },
      sessionCreateEvent('network-recovery-expert', 'Open a recovery ticket.'),
      clientContext
    );
    const parentCreated = (await storage.readSessions()).find((s) => s.resolvedAgentSpec.agentSpecId === 'network-recovery-expert');
    assert.ok(parentCreated);
    const caseId = parentCreated.sessionId;

    // A real, ready, paired browser worker is available on this case — the only reason a scan could "succeed" via
    // pool routing. The device-scan-capture delegate is `targetPolicy: 'device'`, so a call that names NO target
    // (neither a durable operator turn constraint nor a tool-argument target) must be rejected outright; it must never
    // fall back to picking this (or any) worker from the pool. This is the security property that a legacy/untyped
    // caller cannot obtain a device scan without an explicit, validated target.
    const paired = await enrollBoundDevice(central, storage, runtimeTransport, caseId, 'device-ready', 'iOS device', 'edge-ready');
    const pairedRuntime = edgeRuntimeFor(runtimeTransport);
    await pairedRuntime.connectWithGrant(paired.grant);
    await settle();

    turnSpecs.push({ task: captureTask });
    await runtimeTransport.publish(
      { kind: 'tenant-inbox' },
      inputReceivedEvent(caseId, 'diagnose-1', 'Scan the device.'),
      clientContext
    );
    const result = await withTimeout(parentAgent.toolResponses[0], 5000, 'untargeted scan result');
    await settle();
    assert.match((result as { result?: string }).result ?? '', /Subagent failed \[delegation_rejected\]/);

    // No scan child was created, and the available paired worker never received work.
    const child = (await storage.readSessions()).find((s) => s.resolvedAgentSpec.agentSpecId === 'device-scan-probe');
    assert.equal(child, undefined);
    const pairedAfter = await storage.readWorker(paired.workerId);
    assert.equal(pairedAfter?.currentSessionCount, 0);

    await pairedRuntime.stop();
    await parentSidecar.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scenario: the operator target is durably bound to the turn; an agent that tries to widen or redirect it is rejected and no unintended device is scanned', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ars-delegation-agent-widen-'));
  try {
    const runtimeTransport = new InMemoryRuntimeTransportAdapter();
    const storage = new LocalFileStorage(root);
    const central = new CentralService({ storage, eventTransport: runtimeTransport, connectionIssuer: runtimeTransport });
    await central.start();

    const parentGrant = await central.negotiateSidecarConnectionForTenant('poc', parentContext, parentWorkerRegistration());
    const parentWorker = parentGrant.worker;
    assert.ok(parentWorker);
    await runtimeTransport.publish(
      { kind: 'tenant-inbox' },
      workerHeartbeatEvent(parentWorker.workerId),
      { principal: { principalId: parentWorker.workerId, type: 'service' as const } }
    );

    const captureTask = { task: 'capture', target: 'front-panel status LEDs', source: 'environment', detect: ['led-indicator'] };
    const turnSpecs: { task: unknown; target?: unknown }[] = [];
    const parentAgent = new MultiTargetCaptureAgentProcessAdapter(turnSpecs, 1);
    const parentSidecar = new SidecarDaemon({
      runtimeTransport: new SidecarInMemoryTransport(runtimeTransport),
      workspaceAdapter: new PassthroughWorkspaceAdapter(),
      agentProcessAdapter: parentAgent
    });
    await parentSidecar.subscribeWorkerCommands(parentWorker.workerId);

    await runtimeTransport.publish(
      { kind: 'tenant-inbox' },
      sessionCreateEvent('network-recovery-expert', 'Open a recovery ticket.'),
      clientContext
    );
    const parentCreated = (await storage.readSessions()).find((s) => s.resolvedAgentSpec.agentSpecId === 'network-recovery-expert');
    assert.ok(parentCreated);
    const caseId = parentCreated.sessionId;

    // Two devices are on the case roster: the operator selected A for this turn (bound durably to the turn), but the
    // agent's tool call names B. Central enforces its own durable copy of the operator selection, so the mismatch is
    // rejected — the agent cannot widen or redirect the scan — and NEITHER device is scanned.
    const deviceA = await enrollBoundDevice(central, storage, runtimeTransport, caseId, 'device-a', 'iOS device', 'edge-a');
    const deviceB = await enrollBoundDevice(central, storage, runtimeTransport, caseId, 'device-b', 'Android device', 'edge-b');
    const runtimeA = edgeRuntimeFor(runtimeTransport);
    const runtimeB = edgeRuntimeFor(runtimeTransport);
    await runtimeA.connectWithGrant(deviceA.grant);
    await runtimeB.connectWithGrant(deviceB.grant);
    await settle();

    // Durable operator selection = device A; the agent maliciously/incorrectly tries to redirect to device B.
    turnSpecs.push({ task: captureTask, target: { deviceRef: deviceB.deviceRef } });
    await runtimeTransport.publish(
      { kind: 'tenant-inbox' },
      inputReceivedEvent(caseId, 'diagnose-fixed', 'Scan the device I selected.', { deviceRef: deviceA.deviceRef }),
      clientContext
    );
    const result = await withTimeout(parentAgent.toolResponses[0], 5000, 'agent-widen rejected result');
    await settle();
    assert.match((result as { result?: string }).result ?? '', /Subagent failed \[delegation_rejected\]/);

    // No scan child was created, and neither the operator-selected device nor the agent-requested device received work.
    const child = (await storage.readSessions()).find((s) => s.resolvedAgentSpec.agentSpecId === 'device-scan-probe');
    assert.equal(child, undefined, 'a rejected mismatched target must not open any scan child');
    const aAfter = await storage.readWorker(deviceA.workerId);
    const bAfter = await storage.readWorker(deviceB.workerId);
    assert.equal(aAfter?.currentSessionCount, 0, 'the operator-selected device is not scanned when the agent is rejected');
    assert.equal(bAfter?.currentSessionCount, 0, 'the agent-requested device is never scanned');

    await runtimeA.stop();
    await runtimeB.stop();
    await parentSidecar.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scenario: after a partial fan-out failure, retrying re-targets only the failed device and never re-scans the sibling that already completed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ars-delegation-retry-failed-'));
  try {
    const runtimeTransport = new InMemoryRuntimeTransportAdapter();
    const storage = new LocalFileStorage(root);
    const central = new CentralService({ storage, eventTransport: runtimeTransport, connectionIssuer: runtimeTransport });
    await central.start();

    const parentGrant = await central.negotiateSidecarConnectionForTenant('poc', parentContext, parentWorkerRegistration());
    const parentWorker = parentGrant.worker;
    assert.ok(parentWorker);
    await runtimeTransport.publish(
      { kind: 'tenant-inbox' },
      workerHeartbeatEvent(parentWorker.workerId),
      { principal: { principalId: parentWorker.workerId, type: 'service' as const } }
    );

    const captureTask = { task: 'capture', target: 'model and serial label', source: 'environment', detect: ['code'] };
    // Two turns: turn 1 fans out to the whole roster (A completes, B is lost); turn 2 retries only the failed B.
    const turnSpecs: { task: unknown; target?: unknown }[] = [];
    const parentAgent = new MultiTargetCaptureAgentProcessAdapter(turnSpecs, 2);
    const parentSidecar = new SidecarDaemon({
      runtimeTransport: new SidecarInMemoryTransport(runtimeTransport),
      workspaceAdapter: new PassthroughWorkspaceAdapter(),
      agentProcessAdapter: parentAgent
    });
    await parentSidecar.subscribeWorkerCommands(parentWorker.workerId);

    await runtimeTransport.publish(
      { kind: 'tenant-inbox' },
      sessionCreateEvent('network-recovery-expert', 'Two devices reported — open a recovery ticket.'),
      clientContext
    );
    const caseOne = (await storage.readSessions()).find((s) => s.resolvedAgentSpec.agentSpecId === 'network-recovery-expert');
    assert.ok(caseOne);
    const caseId = caseOne.sessionId;

    const deviceA = await enrollBoundDevice(central, storage, runtimeTransport, caseId, 'device-A', 'iOS device', 'edge-A');
    const deviceB = await enrollBoundDevice(central, storage, runtimeTransport, caseId, 'device-B', 'Android device', 'edge-B');
    const runtimeA = edgeRuntimeFor(runtimeTransport);
    await runtimeA.connectWithGrant(deviceA.grant);
    await settle();

    // Turn 1: fan out to all. A completes; B receives its child then drops past keepalive → partial failure.
    turnSpecs.push({ task: captureTask, target: { scope: 'all' } });
    await runtimeTransport.publish(
      { kind: 'tenant-inbox' },
      inputReceivedEvent(caseId, 'diagnose-all', 'Scan every device on this case.', { scope: 'all' }),
      clientContext
    );
    await waitFor(
      async () => {
        const bChild = (await storage.readSessions()).find((s) =>
          s.resolvedAgentSpec.agentSpecId === 'device-scan-probe'
          && s.delegationBinding?.parentSessionId === caseId
          && s.requiredWorkerLabels?.deviceRef === deviceB.deviceRef);
        return bChild?.currentWorkerId === deviceB.workerId;
      },
      'device B scan child assigned to device B worker',
      () => central.reconcileSessionsForTenant('poc')
    );
    await forceExpireWorker(storage, deviceB.workerId);
    await central.reconcileSessionsForTenant('poc');
    await settle();

    const firstAggregate = JSON.parse((await withTimeout(parentAgent.toolResponses[0], 8000, 'partial aggregate') as { result?: string }).result ?? '{}');
    assert.deepEqual(firstAggregate.summary, { total: 2, completed: 1, failed: 1 });
    await settle();

    // Record the exact children device B already has, so we can prove the retry adds a child ONLY for B.
    const bChildrenBefore = (await storage.readSessions()).filter((s) =>
      s.resolvedAgentSpec.agentSpecId === 'device-scan-probe' && s.requiredWorkerLabels?.deviceRef === deviceB.deviceRef).length;
    assert.equal(bChildrenBefore, 1, 'device B has exactly its one failed scan child before the retry');

    // Device B rejoins with a fresh worker lifetime (same durable deviceRef via its stored binding credential).
    const bRejoinGrant = await reconnectBoundDevice(central, runtimeTransport, deviceB, 'edge-B2');
    const bRejoinedWorkerId = bRejoinGrant.worker?.workerId;
    assert.ok(bRejoinedWorkerId);
    const runtimeB = edgeRuntimeFor(runtimeTransport);
    await runtimeB.connectWithGrant(bRejoinGrant);
    await settle();

    // Turn 2: retry ONLY the failed device by naming its deviceRef explicitly. A is not in the target set.
    turnSpecs.push({ task: captureTask, target: { deviceRefs: [deviceB.deviceRef] } });
    await runtimeTransport.publish(
      { kind: 'tenant-inbox' },
      inputReceivedEvent(caseId, 'retry-b', 'Retry the device that dropped.', { deviceRefs: [deviceB.deviceRef] }),
      clientContext
    );
    const retryAggregate = JSON.parse((await withTimeout(parentAgent.toolResponses[1], 8000, 'retry aggregate') as { result?: string }).result ?? '{}');
    await settle();
    await settle();

    // The retry aggregate reports only B, and B completed on its rejoined worker.
    assert.deepEqual(retryAggregate.summary, { total: 1, completed: 1, failed: 0 });
    const retryDevices = retryAggregate.devices as { deviceRef: string; status: string }[];
    assert.deepEqual(retryDevices.map((device) => device.deviceRef), [deviceB.deviceRef]);
    assert.equal(retryDevices[0]?.status, 'completed');

    // A was NEVER re-scanned: it still has exactly its single (turn 1) child. B has one more (the fresh retry child).
    const sessions = await storage.readSessions();
    const aChildren = sessions.filter((s) =>
      s.resolvedAgentSpec.agentSpecId === 'device-scan-probe' && s.requiredWorkerLabels?.deviceRef === deviceA.deviceRef);
    const bChildren = sessions.filter((s) =>
      s.resolvedAgentSpec.agentSpecId === 'device-scan-probe' && s.requiredWorkerLabels?.deviceRef === deviceB.deviceRef);
    assert.equal(aChildren.length, 1, 'the already-completed sibling A must not be re-scanned by the retry');
    assert.equal(bChildren.length, 2, 'device B has its original failed child plus one fresh retry child');
    const freshBChild = bChildren.find((s) => s.currentWorkerId === bRejoinedWorkerId);
    assert.ok(freshBChild, 'the retry child routed to device B\'s rejoined worker');

    await runtimeA.stop();
    await runtimeB.stop();
    await parentSidecar.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
