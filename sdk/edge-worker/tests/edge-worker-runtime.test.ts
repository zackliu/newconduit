import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  CameraDiagnosticAgent,
  CanvasHeuristicAnalyzer,
  EdgeWorkerRuntime,
  LocalStorageOutboundQueueStore,
  createAnalyzerCaptureProvider,
  type EdgeDeviceManifest,
  type EdgeFrame,
  type EdgeRuntimeChannel,
  type EdgeRuntimeEvent,
  type EdgeRuntimeEventHandler,
  type EdgeWorkerLifecycleEvent,
  type EdgeWorkerRegistration,
  type EdgeWorkerSubscription,
  type EdgeWorkerTransport,
  type RuntimeConnectionGrant,
  type WebStorageLike,
  type WorkerRecord
} from '../src/index';

/**
 * Weak-network is a first-class edge capability. These tests drive the real `EdgeWorkerRuntime` over a
 * scriptable transport to prove: (1) a result finished while the link is down is durably queued and
 * delivered exactly once on reconnect under the same lease; (2) after a tab reload the saved result is
 * replayed under a NEW lease without re-capturing the device (reusing central's restart-with-context).
 */

const MANIFEST: EdgeDeviceManifest = {
  deviceLabel: 'Test phone',
  runtime: 'browser-edge-worker',
  captureSources: ['environment', 'user'],
  analyzers: [{ id: 'canvas-heuristic-v1', displayName: 'Canvas heuristic analyzer' }],
  secureContext: true,
  privacy: { rawMediaLeavesDevice: false, returns: 'structured-analysis-only' }
};

function warmFrame(): EdgeFrame {
  const width = 24;
  const height = 24;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = 205;
    data[i * 4 + 1] = 120;
    data[i * 4 + 2] = 70;
    data[i * 4 + 3] = 255;
  }
  return { data, width, height };
}

class FakeWebStorage implements WebStorageLike {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

class ScriptableTransport implements EdgeWorkerTransport {
  readonly published: EdgeRuntimeEvent[] = [];
  online = true;
  autoAcknowledgeResults = true;
  stopped = false;
  private handler: EdgeRuntimeEventHandler | undefined;
  private readonly connectionListeners = new Set<(state: 'connected' | 'disconnected') => void>();

  async connect(): Promise<void> {}

  async publish(_channel: EdgeRuntimeChannel, event: EdgeRuntimeEvent): Promise<void> {
    if (!this.online) {
      throw new Error('transport offline');
    }
    this.published.push(event);
    if (this.autoAcknowledgeResults && (event.type === 'turn.completed' || event.type === 'turn.failed')) {
      await this.handler?.(resultAcknowledged(event));
    }
  }

  async subscribe(_channel: EdgeRuntimeChannel, handler: EdgeRuntimeEventHandler): Promise<EdgeWorkerSubscription> {
    this.handler = handler;
    return { close: async () => {} };
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  onConnectionStateChanged(listener: (state: 'connected' | 'disconnected') => void): void {
    this.connectionListeners.add(listener);
  }

  async deliver(event: EdgeRuntimeEvent): Promise<void> {
    await this.handler?.(event);
  }

  setOnline(next: boolean): void {
    const was = this.online;
    this.online = next;
    if (was === next) {
      return;
    }
    for (const listener of this.connectionListeners) {
      listener(next ? 'connected' : 'disconnected');
    }
  }

  completed(): EdgeRuntimeEvent[] {
    return this.published.filter((event) => event.type === 'turn.completed');
  }
}

function grant(workerId: string): RuntimeConnectionGrant {
  return {
    url: 'mem://central',
    worker: {
      workerId,
      tenantId: 'poc',
      labels: { agent: 'browser-edge', storage: 'host-managed' },
      storageClass: 'host-managed',
      capacity: 1,
      allocatable: 1,
      conditions: ['ready']
    }
  };
}

function assignCmd(sessionId: string, lease: string, workerId: string): EdgeRuntimeEvent {
  return {
    eventId: randomUUID(),
    type: 'session.assign',
    timestamp: new Date().toISOString(),
    actor: 'central',
    sequence: 0,
    sessionId,
    workerId,
    sessionLeaseId: lease,
    payload: {
      sessionId,
      workerId,
      sessionLeaseId: lease,
      workspaceRef: '',
      copilotSessionStateRef: '',
      resolvedAgentSpec: { agentSpecId: 'device-scan-probe' }
    }
  } as EdgeRuntimeEvent;
}

function inputCmd(sessionId: string, lease: string, turnSeq: number, message: string, workerId: string): EdgeRuntimeEvent {
  return {
    eventId: randomUUID(),
    type: 'session.input',
    timestamp: new Date().toISOString(),
    actor: 'central',
    sequence: 0,
    sessionId,
    workerId,
    sessionLeaseId: lease,
    turnSeq,
    payload: { sessionId, workerId, sessionLeaseId: lease, turnSeq, input: { message } }
  } as EdgeRuntimeEvent;
}

function pauseCmd(sessionId: string, lease: string, workerId: string): EdgeRuntimeEvent {
  return {
    eventId: randomUUID(),
    type: 'session.pause.requested',
    timestamp: new Date().toISOString(),
    actor: 'central',
    sequence: 0,
    sessionId,
    workerId,
    sessionLeaseId: lease,
    payload: { sessionId, workerId, sessionLeaseId: lease, reason: 'client_requested' }
  } as EdgeRuntimeEvent;
}

function resultAcknowledged(result: EdgeRuntimeEvent): EdgeRuntimeEvent {
  return {
    eventId: randomUUID(),
    type: 'worker.result.acknowledged',
    timestamp: new Date().toISOString(),
    actor: 'central',
    sequence: 0,
    sessionId: result.sessionId,
    workerId: result.workerId,
    sessionLeaseId: result.sessionLeaseId,
    turnSeq: result.turnSeq,
    payload: { resultEventId: result.eventId }
  };
}

const captureTask = JSON.stringify({ task: 'capture', target: 'router status LEDs', source: 'environment' });

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

test('weak-network: a result finished during a disconnect is durably queued and flushed once on reconnect', async () => {
  const transport = new ScriptableTransport();
  let captureCount = 0;
  const captureProvider = createAnalyzerCaptureProvider(new CanvasHeuristicAnalyzer(), async (request) => {
    captureCount++;
    transport.setOnline(false); // the network drops while the frame is being captured/analyzed on-device
    return {
      status: 'captured',
      captured: { frame: warmFrame(), source: request.source, sampleSource: 'simulated', facingMode: request.source }
    };
  });
  const agent = new CameraDiagnosticAgent({ captureProvider, manifestProvider: () => MANIFEST });
  const runtime = new EdgeWorkerRuntime({ transport, agent });
  await runtime.connectWithGrant(grant('w-1'));

  await transport.deliver(assignCmd('sess-1', 'lease-1', 'w-1'));
  await transport.deliver(inputCmd('sess-1', 'lease-1', 2, captureTask, 'w-1'));

  // Offline when the turn finished: no result reached central, but it is durably queued on-device.
  assert.equal(transport.completed().length, 0);
  assert.equal(await runtime.pendingResultCount(), 1);

  // The link returns: the queued result is delivered under the same lease, exactly once, with no re-capture.
  transport.setOnline(true);
  await settle();
  assert.equal(await runtime.pendingResultCount(), 0);
  assert.equal(captureCount, 1);
  const completed = transport.completed();
  assert.equal(completed.length, 1);
  assert.equal(completed[0].sessionLeaseId, 'lease-1');

  // The delivered result carries the structured observation (the only field forwarded to the parent).
  const result = (completed[0].payload as { result: { message: string; output: { kind: string } } }).result;
  assert.equal(result.output.kind, 'device-evidence');
  assert.match(result.message, /structured-observation:/);
  const structured = JSON.parse(result.message.slice(result.message.indexOf('{'))) as { status: string };
  assert.equal(structured.status, 'captured');

  await runtime.stop();
});

test('weak-network: after a reload the saved result is replayed under a new lease without re-capturing', async () => {
  const storage = new FakeWebStorage();

  // Tab A: capture completes but the network is down at delivery time; the result persists to localStorage.
  const transportA = new ScriptableTransport();
  let captureA = 0;
  const providerA = createAnalyzerCaptureProvider(new CanvasHeuristicAnalyzer(), async (request) => {
    captureA++;
    transportA.setOnline(false);
    return {
      status: 'captured',
      captured: { frame: warmFrame(), source: request.source, sampleSource: 'simulated', facingMode: request.source }
    };
  });
  const runtimeA = new EdgeWorkerRuntime({
    transport: transportA,
    agent: new CameraDiagnosticAgent({ captureProvider: providerA, manifestProvider: () => MANIFEST }),
    outboundQueue: new LocalStorageOutboundQueueStore(storage, 'rdd.edge')
  });
  await runtimeA.connectWithGrant(grant('w-A'));
  await transportA.deliver(assignCmd('sess-1', 'lease-1', 'w-A'));
  await transportA.deliver(inputCmd('sess-1', 'lease-1', 2, captureTask, 'w-A'));
  assert.equal(await runtimeA.pendingResultCount(), 1);
  assert.equal(captureA, 1);
  transportA.online = true; // allow an orderly worker.close without triggering a result flush
  await runtimeA.stop(); // the tab is closed before it could reconnect

  // Tab B: reloaded tab -> new worker + new lease, same durable session + same on-device localStorage queue.
  const transportB = new ScriptableTransport();
  let captureB = 0;
  const providerB = createAnalyzerCaptureProvider(new CanvasHeuristicAnalyzer(), async (request) => {
    captureB++;
    return {
      status: 'captured',
      captured: { frame: warmFrame(), source: request.source, sampleSource: 'simulated', facingMode: request.source }
    };
  });
  const events: EdgeWorkerLifecycleEvent[] = [];
  const runtimeB = new EdgeWorkerRuntime({
    transport: transportB,
    agent: new CameraDiagnosticAgent({ captureProvider: providerB, manifestProvider: () => MANIFEST }),
    outboundQueue: new LocalStorageOutboundQueueStore(storage, 'rdd.edge'),
    observer: (event) => events.push(event)
  });
  await runtimeB.connectWithGrant(grant('w-B'));
  // Central re-assigns the durable session (new lease) and restarts the still-pending turn.
  await transportB.deliver(assignCmd('sess-1', 'lease-2', 'w-B'));
  await transportB.deliver(inputCmd('sess-1', 'lease-2', 2, captureTask, 'w-B'));

  // The saved result is replayed, not recomputed: the device was never captured again.
  assert.equal(captureB, 0);
  assert.ok(events.some((event) => event.type === 'turn.replayed'), 'the runtime should replay the saved result');
  assert.equal(await runtimeB.pendingResultCount(), 0);
  const completed = transportB.completed();
  assert.equal(completed.length, 1);
  assert.equal(completed[0].sessionLeaseId, 'lease-2'); // delivered under the NEW lease

  await runtimeB.stop();
});

/**
 * A transport that records which worker-command channels were subscribed and how many subscriptions were
 * closed, so a re-registration can be observed precisely: the transport must NOT reconnect, the old worker's
 * command subscription must be closed, and the new worker's channel must be subscribed.
 */
class ReconnectRecordingTransport implements EdgeWorkerTransport {
  connectCount = 0;
  readonly accessUrls: string[] = [];
  closedSubscriptions = 0;
  readonly subscribedWorkerIds: string[] = [];
  readonly heartbeats: EdgeRuntimeEvent[] = [];
  online = true;
  private handler: EdgeRuntimeEventHandler | undefined;

  async connect(accessUrl: string): Promise<void> {
    this.connectCount++;
    this.accessUrls.push(accessUrl);
  }

  async publish(_channel: EdgeRuntimeChannel, event: EdgeRuntimeEvent): Promise<void> {
    if (!this.online) {
      throw new Error('transport offline');
    }
    if (event.type === 'worker.heartbeat') {
      this.heartbeats.push(event);
    }
  }

  async subscribe(channel: EdgeRuntimeChannel, handler: EdgeRuntimeEventHandler): Promise<EdgeWorkerSubscription> {
    if (channel.kind === 'worker-commands') {
      this.subscribedWorkerIds.push(channel.workerId);
    }
    this.handler = handler;
    return {
      close: async () => {
        this.closedSubscriptions++;
      }
    };
  }

  async stop(): Promise<void> {}

  async deliver(event: EdgeRuntimeEvent): Promise<void> {
    await this.handler?.(event);
  }
}

function grantFor(workerId: string, labels: Record<string, string>, url = 'mem://central'): RuntimeConnectionGrant {
  return {
    url,
    worker: {
      workerId,
      tenantId: 'poc',
      labels,
      storageClass: 'host-managed',
      capacity: 1,
      allocatable: 1,
      conditions: ['ready']
    }
  };
}

function heartbeatRejected(workerId: string, reason: string): EdgeRuntimeEvent {
  return {
    eventId: randomUUID(),
    type: 'worker.heartbeat.rejected',
    timestamp: new Date().toISOString(),
    actor: 'central',
    sequence: 0,
    workerId,
    payload: { reason }
  } as EdgeRuntimeEvent;
}

test('reconnect: a rejected heartbeat re-registers a fresh worker under the same pairing label without dropping the transport', async () => {
  const transport = new ReconnectRecordingTransport();
  const negotiated: EdgeWorkerRegistration[] = [];
  let issued = 0;
  const negotiator = async (input: EdgeWorkerRegistration): Promise<RuntimeConnectionGrant> => {
    negotiated.push(input);
    issued++;
    return grantFor(`w-${issued}`, input.labels, `mem://central/grant-${issued}`);
  };
  const events: EdgeWorkerLifecycleEvent[] = [];
  const stoppedSessions: string[] = [];
  const runtime = new EdgeWorkerRuntime({
    transport,
    agent: {
      start: async () => undefined,
      stop: async ({ sessionId }) => {
        stoppedSessions.push(sessionId);
        throw new Error('simulated teardown failure');
      },
      runTurn: async () => ({ message: 'structured result', output: { kind: 'device-evidence' } })
    },
    observer: (event) => events.push(event),
    negotiator
  });

  const registration: EdgeWorkerRegistration = {
    centralUrl: 'mem://central',
    tenantId: 'poc',
    labels: { agent: 'browser-edge', storage: 'host-managed', role: 'device-scan-probe' },
    storageClass: 'host-managed',
    capacity: 1,
    description: { deviceLabel: 'iOS device' }
  };
  const first = await runtime.register(registration);
  assert.equal(first.workerId, 'w-1');
  assert.equal(negotiated.length, 1);
  assert.equal(transport.connectCount, 1);
  assert.deepEqual(transport.subscribedWorkerIds, ['w-1']);

  await transport.deliver(assignCmd('sess-replaced', 'lease-1', 'w-1'));
  await transport.deliver(inputCmd('sess-replaced', 'lease-1', 1, captureTask, 'w-1'));
  await settle();
  assert.equal(await runtime.pendingResultCount(), 1);

  // The tab was suspended past its keepalive TTL; central rejects the resume heartbeat because w-1 is dead.
  await transport.deliver(heartbeatRejected('w-1', 'worker-expired'));
  await settle();

  // A fresh worker was re-negotiated with the SAME registration input — the same base labels — so the device
  // re-presents its stored binding and Central re-mints the same authoritative deviceRef onto the new worker.
  assert.equal(negotiated.length, 2);
  assert.deepEqual(negotiated[1].labels, registration.labels);

  // The fresh grant carries a fresh short-lived access URL, so the transport reconnects before subscribing
  // the new worker command channel. Reusing the old grant would leave the new worker unauthorized.
  assert.equal(transport.connectCount, 2);
  assert.deepEqual(transport.accessUrls, ['mem://central/grant-1', 'mem://central/grant-2']);
  assert.deepEqual(transport.subscribedWorkerIds, ['w-1', 'w-2']);
  assert.equal(transport.closedSubscriptions, 1);

  // Honest lifecycle: a re-registering signal, then a fresh registered event for the new worker id.
  assert.ok(events.some((event) => event.type === 're-registering'));
  const registered = events.filter((event) => event.type === 'registered');
  assert.equal(registered.length, 2);
  assert.equal((registered[1] as { type: 'registered'; worker: WorkerRecord }).worker.workerId, 'w-2');
  assert.deepEqual(stoppedSessions, ['sess-replaced']);
  assert.equal(await runtime.pendingResultCount(), 0);
  assert.ok(events.some((event) => event.type === 'error' && event.message.includes('worker identity was replaced')));
  assert.ok(events.some((event) => event.type === 'error' && event.message.includes('simulated teardown failure')));

  await runtime.stop();
});

test('shutdown: an agent teardown failure is surfaced without blocking subscription and transport cleanup', async () => {
  const transport = new ScriptableTransport();
  const events: EdgeWorkerLifecycleEvent[] = [];
  const runtime = new EdgeWorkerRuntime({
    transport,
    agent: {
      runTurn: async () => ({ message: 'unused' }),
      stop: async () => { throw new Error('simulated shutdown teardown failure'); }
    },
    observer: (event) => events.push(event)
  });
  await runtime.connectWithGrant(grant('w-shutdown-failure'));
  await transport.deliver(assignCmd('sess-shutdown-failure', 'lease-shutdown-failure', 'w-shutdown-failure'));

  await runtime.stop();

  assert.equal(transport.stopped, true);
  assert.ok(events.some((event) => event.type === 'error' && event.message.includes('simulated shutdown teardown failure')));
  assert.ok(events.some((event) => event.type === 'stopped'));
});

test('pause: an unacknowledged terminal result is discarded after agent teardown instead of orphaning the durable queue', async () => {
  const transport = new ScriptableTransport();
  transport.autoAcknowledgeResults = false;
  const events: EdgeWorkerLifecycleEvent[] = [];
  const stoppedSessions: string[] = [];
  const runtime = new EdgeWorkerRuntime({
    transport,
    agent: {
      stop: async ({ sessionId }) => { stoppedSessions.push(sessionId); },
      runTurn: async () => ({ message: 'structured result', output: { kind: 'device-evidence' } })
    },
    observer: (event) => events.push(event)
  });
  await runtime.connectWithGrant(grant('w-pause'));
  await transport.deliver(assignCmd('sess-pause', 'lease-pause', 'w-pause'));
  await transport.deliver(inputCmd('sess-pause', 'lease-pause', 1, captureTask, 'w-pause'));
  await settle();
  assert.equal(await runtime.pendingResultCount(), 1);

  await transport.deliver(pauseCmd('sess-pause', 'lease-pause', 'w-pause'));

  assert.deepEqual(stoppedSessions, ['sess-pause']);
  assert.equal(await runtime.pendingResultCount(), 0);
  assert.ok(events.some((event) => event.type === 'error' && event.message.includes('session was paused')));
  await runtime.stop();
});

test('weak-network: a published result stays queued until Central acknowledges its stable event id', async () => {
  const transport = new ScriptableTransport();
  transport.autoAcknowledgeResults = false;
  const runtime = new EdgeWorkerRuntime({
    transport,
    agent: new CameraDiagnosticAgent({
      captureProvider: createAnalyzerCaptureProvider(new CanvasHeuristicAnalyzer(), async (request) => ({
        status: 'captured',
        captured: { frame: warmFrame(), source: request.source, sampleSource: 'simulated', facingMode: request.source }
      })),
      manifestProvider: () => MANIFEST
    })
  });
  await runtime.connectWithGrant(grant('w-ack'));
  await transport.deliver(assignCmd('sess-ack', 'lease-ack', 'w-ack'));
  await transport.deliver(inputCmd('sess-ack', 'lease-ack', 1, captureTask, 'w-ack'));

  const first = transport.completed()[0];
  assert.ok(first);
  assert.equal(await runtime.pendingResultCount(), 1, 'transport publish is not an application-level acknowledgement');

  await runtime.flushPendingResults();
  const retried = transport.completed()[1];
  assert.ok(retried);
  assert.equal(retried.eventId, first.eventId, 'every retry must preserve the same durable result event id');
  assert.equal(await runtime.pendingResultCount(), 1);

  await transport.deliver(resultAcknowledged(retried));
  assert.equal(await runtime.pendingResultCount(), 0);
  await runtime.stop();
});

test('shutdown: an orderly stop asks Central to close the active worker before disconnecting', async () => {
  const transport = new ScriptableTransport();
  const runtime = new EdgeWorkerRuntime({
    transport,
    agent: new CameraDiagnosticAgent({
      captureProvider: createAnalyzerCaptureProvider(new CanvasHeuristicAnalyzer(), async (request) => ({
        status: 'captured',
        captured: { frame: warmFrame(), source: request.source, sampleSource: 'simulated', facingMode: request.source }
      })),
      manifestProvider: () => MANIFEST
    })
  });
  await runtime.connectWithGrant(grant('w-close'));
  await runtime.stop();

  const close = transport.published.find((event) => event.type === 'worker.close.requested');
  assert.equal(close?.workerId, 'w-close');
  assert.deepEqual(close?.payload, { workerId: 'w-close' });
});

test('reconnect: a grant-only connect with no stored registration surfaces an honest disconnect on rejection instead of looking healthy', async () => {
  const transport = new ReconnectRecordingTransport();
  const events: EdgeWorkerLifecycleEvent[] = [];
  const runtime = new EdgeWorkerRuntime({
    transport,
    agent: new CameraDiagnosticAgent({
      captureProvider: createAnalyzerCaptureProvider(new CanvasHeuristicAnalyzer(), async (request) => ({
        status: 'captured',
        captured: { frame: warmFrame(), source: request.source, sampleSource: 'simulated', facingMode: request.source }
      })),
      manifestProvider: () => MANIFEST
    }),
    observer: (event) => events.push(event)
  });

  // A grant-only connect has no stored registration to re-negotiate from.
  await runtime.connectWithGrant(grantFor('w-only', { agent: 'browser-edge', storage: 'host-managed' }));
  await transport.deliver(heartbeatRejected('w-only', 'worker-expired'));
  await settle();

  // It must not silently re-register (there is nothing to re-negotiate) and must not keep looking connected.
  assert.ok(!events.some((event) => event.type === 're-registering'));
  const last = events.filter((event) => event.type === 'transport');
  assert.ok(last.some((event) => event.type === 'transport' && event.state === 'disconnected'));
  assert.deepEqual(transport.subscribedWorkerIds, ['w-only']);

  await runtime.stop();
});
