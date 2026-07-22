import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { InMemoryRuntimeTransportAdapter } from '../../src/central/adapters';
import { CentralService } from '../../src/central/central-service';
import { LocalFileStorage } from '../../src/central/storage/local-file-storage';
import type { RuntimeChannel, RuntimeEvent, RuntimeEventTransport, WorkerRegisterPayload } from '../../src/shared';
import {
  CameraDiagnosticAgent,
  CanvasHeuristicAnalyzer,
  EdgeWorkerRuntime,
  createAnalyzerCaptureProvider,
  type CaptureFailureStatus,
  type EdgeDeviceManifest,
  type EdgeFrame,
  type EdgeRuntimeChannel,
  type EdgeRuntimeEvent,
  type EdgeRuntimeEventHandler,
  type EdgeWorkerSubscription,
  type EdgeWorkerTransport,
  type FrameProviderResult
} from '../../sdk/edge-worker/src/index';

/**
 * Faithfulness proof: the browser edge worker runtime is driven against a REAL `CentralService`. The same
 * negotiate -> heartbeat -> assign -> input -> turn.completed protocol the Node sidecar speaks routes a
 * device-capture task to the in-browser agent, and the raw frame never appears in any persisted event.
 */

class InMemoryEdgeWorkerTransport implements EdgeWorkerTransport {
  constructor(private readonly transport: RuntimeEventTransport) {}

  async connect(): Promise<void> {
    return;
  }

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

  async stop(): Promise<void> {
    return;
  }
}

const BROWSER_MANIFEST: EdgeDeviceManifest = {
  deviceLabel: 'Test Phone (Chromium)',
  runtime: 'browser-edge-worker',
  captureSources: ['environment', 'user'],
  analyzers: [{ id: 'canvas-heuristic-v1', displayName: 'Canvas heuristic analyzer' }],
  secureContext: true,
  privacy: { rawMediaLeavesDevice: false, returns: 'structured-analysis-only' }
};

function warmFrame(): EdgeFrame {
  const width = 32;
  const height = 32;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = 205;
    data[i * 4 + 1] = 125;
    data[i * 4 + 2] = 70;
    data[i * 4 + 3] = 255;
  }
  return { data, width, height };
}

function browserWorkerRegistration(): WorkerRegisterPayload {
  return {
    labels: { agent: 'browser-edge', tier: 'edge', role: 'device-scan-probe', storage: 'host-managed' },
    storageClass: 'host-managed',
    capacity: 1,
    allocatable: 1
  };
}

function sessionCreateEvent(message: string): RuntimeEvent {
  return {
    eventId: 'evt-create-edge-session',
    ackId: 'ack-create-edge',
    sequence: 0,
    type: 'session.create.requested',
    timestamp: new Date().toISOString(),
    actor: 'client',
    payload: {
      agent: { agentSpecId: 'device-scan-probe' },
      input: { message },
      workspace: { source: 'empty' }
    }
  };
}

function inputReceivedEvent(sessionId: string, ackId: string, message: string): RuntimeEvent {
  return {
    eventId: `evt-${ackId}`,
    sessionId,
    ackId,
    sequence: 0,
    type: 'input.received',
    timestamp: new Date().toISOString(),
    actor: 'client',
    payload: { input: { message } }
  };
}

const clientContext = { principal: { principalId: 'diagnostics-console', type: 'user' as const }, connectionId: 'console-conn' };
const edgeContext = { principal: { principalId: 'edge-worker', type: 'service' as const } };

function lastResultForTurn(events: RuntimeEvent[], turnSeq: number): Record<string, unknown> | undefined {
  const completed = [...events].reverse().find((event) => event.type === 'turn.completed' && event.turnSeq === turnSeq);
  const result = (completed?.payload as { result?: { output?: unknown } } | undefined)?.result;
  return result && typeof result.output === 'object' ? result.output as Record<string, unknown> : undefined;
}

test('scenario: a browser tab registers as a real worker and a routed capture task returns structured evidence only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ars-edge-worker-'));
  try {
    const runtimeTransport = new InMemoryRuntimeTransportAdapter();
    const storage = new LocalFileStorage(root);
    const central = new CentralService({ storage, eventTransport: runtimeTransport, connectionIssuer: runtimeTransport });
    await central.start();

    const grant = await central.negotiateSidecarConnectionForTenant('poc', edgeContext, browserWorkerRegistration());
    const worker = grant.worker;
    assert.ok(worker, 'central should issue a worker record for the browser edge worker');

    const captureProvider = createAnalyzerCaptureProvider(new CanvasHeuristicAnalyzer(), async (request) => ({
      status: 'captured',
      captured: { frame: warmFrame(), source: request.source, sampleSource: 'simulated', facingMode: request.source }
    }));
    const agent = new CameraDiagnosticAgent({ captureProvider, manifestProvider: () => BROWSER_MANIFEST });
    const runtime = new EdgeWorkerRuntime({ transport: new InMemoryEdgeWorkerTransport(runtimeTransport), agent });
    await runtime.connectWithGrant(grant);

    // Console creates/starts the diagnostic session; central assigns it to the ready browser worker.
    await runtimeTransport.publish({ kind: 'tenant-inbox' }, sessionCreateEvent('Remote network recovery online'), clientContext);
    const [session] = await storage.readSessions();
    assert.ok(session);
    assert.equal(session.status, 'running');
    assert.equal(session.currentWorkerId, worker.workerId);
    assert.equal(session.resolvedAgentSpec.agentSpecId, 'device-scan-probe');

    // Turn 2: the console asks the device for its capability manifest (no sensor access).
    await runtimeTransport.publish({ kind: 'tenant-inbox' }, inputReceivedEvent(session.sessionId, 'manifest', JSON.stringify({ task: 'manifest' })), clientContext);
    // Turn 3: the console routes an actual capture task to the phone.
    await runtimeTransport.publish({ kind: 'tenant-inbox' }, inputReceivedEvent(session.sessionId, 'capture', JSON.stringify({ task: 'capture', target: 'router status LEDs', source: 'environment' })), clientContext);

    const events = await storage.readEvents(session.sessionId, 0);

    const manifestOutput = lastResultForTurn(events, 2);
    assert.equal(manifestOutput?.kind, 'device-manifest');
    assert.deepEqual((manifestOutput?.manifest as EdgeDeviceManifest).captureSources, ['environment', 'user']);

    const evidence = lastResultForTurn(events, 3);
    assert.equal(evidence?.kind, 'device-evidence');
    assert.equal(evidence?.status, 'captured');
    assert.equal(evidence?.source, 'environment');
    assert.ok(evidence?.analysis, 'structured optical analysis must be present');
    const analysis = evidence?.analysis as { signals: { colorBalance: { dominantCast: string } } };
    assert.equal(analysis.signals.colorBalance.dominantCast, 'red');

    // Privacy invariant: no raw RGBA buffer is ever persisted in the runtime event log.
    const serializedEvents = JSON.stringify(events);
    assert.ok(!serializedEvents.includes('"data"'), 'raw frame pixels must never appear in the runtime event log');

    // Protocol invariant: the worker acknowledged each command and reported running.
    assert.ok(events.some((event) => event.type === 'status.changed' && (event.payload as { status?: string }).status === 'running'));
    assert.equal(events.filter((event) => event.type === 'worker.command.accepted').length, 2);

    await runtime.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scenario: a declined on-device capture completes the turn with a structured status instead of failing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ars-edge-worker-declined-'));
  try {
    const runtimeTransport = new InMemoryRuntimeTransportAdapter();
    const storage = new LocalFileStorage(root);
    const central = new CentralService({ storage, eventTransport: runtimeTransport, connectionIssuer: runtimeTransport });
    await central.start();

    const grant = await central.negotiateSidecarConnectionForTenant('poc', edgeContext, browserWorkerRegistration());
    assert.ok(grant.worker);

    const declineReason = 'device holder dismissed the camera permission prompt';
    const captureProvider = createAnalyzerCaptureProvider(new CanvasHeuristicAnalyzer(), async (): Promise<FrameProviderResult> => ({
      status: 'declined' as CaptureFailureStatus,
      reason: declineReason
    }));
    const agent = new CameraDiagnosticAgent({ captureProvider, manifestProvider: () => BROWSER_MANIFEST });
    const runtime = new EdgeWorkerRuntime({ transport: new InMemoryEdgeWorkerTransport(runtimeTransport), agent });
    await runtime.connectWithGrant(grant);

    await runtimeTransport.publish({ kind: 'tenant-inbox' }, sessionCreateEvent('diagnostic online'), clientContext);
    const [session] = await storage.readSessions();
    assert.ok(session);

    await runtimeTransport.publish({ kind: 'tenant-inbox' }, inputReceivedEvent(session.sessionId, 'capture', JSON.stringify({ task: 'capture', target: 'display' })), clientContext);

    const events = await storage.readEvents(session.sessionId, 0);
    const evidence = lastResultForTurn(events, 2);
    assert.equal(evidence?.kind, 'device-evidence');
    assert.equal(evidence?.status, 'declined');
    assert.equal(evidence?.reason, declineReason);
    assert.ok(!('analysis' in (evidence ?? {})));
    // A declined capture is a normal completed turn, not a turn failure.
    assert.ok(events.some((event) => event.type === 'turn.completed' && event.turnSeq === 2));
    assert.ok(!events.some((event) => event.type === 'turn.failed'));

    await runtime.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
