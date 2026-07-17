import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { InMemoryRuntimeTransportAdapter } from '../../src/central/adapters';
import { CentralService } from '../../src/central/central-service';
import { LocalFileStorage } from '../../src/central/storage/local-file-storage';
import type { Clock, HostPoolInstanceRecord, RuntimeEvent, WorkerPoolRecord, WorkerRecord } from '../../src/shared';
import { COPILOT_STORAGE_CLASS, COPILOT_WORKER_LABELS } from '../support/config-fixtures';
import type { HostPoolAdapter, HostPoolEnsureRunningInput, HostPoolEnsureRunningResult, HostPoolEnsureStoppedInput } from '../../src/central/managers';

class FixedClock implements Clock {
  constructor(private currentTime: string) {}

  now(): string {
    return this.currentTime;
  }

  set(time: string): void {
    this.currentTime = time;
  }
}

class DeterministicHostPoolAdapter implements HostPoolAdapter {
  readonly ensureRunningInputs: HostPoolEnsureRunningInput[] = [];
  readonly ensureStoppedInputs: HostPoolEnsureStoppedInput[] = [];

  async ensureRunning(input: HostPoolEnsureRunningInput): Promise<HostPoolEnsureRunningResult> {
    this.ensureRunningInputs.push(input);
    return { hostHandle: input.instance.hostHandle ?? `container-${input.instance.instanceId}` };
  }

  async ensureStopped(input: HostPoolEnsureStoppedInput): Promise<void> {
    this.ensureStoppedInputs.push(input);
  }

  async releaseControl(): Promise<void> {
    return;
  }
}

test('scenario: queued session causes worker pool to scale out, assign provisioned worker, then scale in after idle', async () => {
  await withRuntime(async ({ central, storage, transport, clock, adapter }) => {
    const workerCommands: RuntimeEvent[] = [];

    const created = await createQueuedSession(transport);
    await central.reconcileSessionsForTenant('poc');
    const afterReconcile = await storage.readSession(created.sessionId!);
    const poolStatus = await central.describeWorkerPoolsForTenant('poc');
    assert.equal(afterReconcile?.status, 'queued');
    assert.equal(poolStatus.workerPools.length, 1);
    assert.equal(poolStatus.hostPoolInstances.length, 1);
    await waitFor(() => adapter.ensureRunningInputs.length > 0, 'worker pool scale out');
    const [ensureRunning] = adapter.ensureRunningInputs;
    assert.equal(ensureRunning.pool.poolId, 'poc-docker-copilot');
    assert.deepEqual(ensureRunning.pool.template.labels, COPILOT_WORKER_LABELS);
    assert.equal(ensureRunning.instance.state, 'pending');
    assert.equal(ensureRunning.instance.capacity, 1);

    const pending = await storage.readHostPoolInstance(ensureRunning.instance.instanceId);
    assert.equal(pending?.hostHandle, `container-${ensureRunning.instance.instanceId}`);
    assert.equal(pending?.currentWorkerId, undefined);

    const worker = await registerWorkerFromInstance(central, ensureRunning.instance);
    await transport.subscribe({ kind: 'worker-commands', workerId: worker.workerId }, async (envelope) => {
      workerCommands.push(envelope.event);
    });

    clock.set('2026-06-25T00:00:05.000Z');
    await publishReadyHeartbeat(transport, worker.workerId, clock.now());
    await central.reconcileSessionsForTenant('poc');

    const assigned = await storage.readSession(created.sessionId!);
    assert.equal(assigned?.status, 'starting');
    assert.equal(assigned?.currentWorkerId, worker.workerId);
    assert.equal(typeof assigned?.sessionLeaseId, 'string');
    assert.deepEqual(workerCommands.map((event) => event.type), ['session.assign']);

    const readyInstance = await storage.readHostPoolInstance(ensureRunning.instance.instanceId);
    assert.equal(readyInstance?.state, 'ready');
    assert.equal(readyInstance?.currentWorkerId, worker.workerId);

    await publishStatusChanged(transport, assigned!.sessionId, worker.workerId, assigned!.sessionLeaseId!, 'running', clock.now());
    const running = await storage.readSession(assigned!.sessionId);
    assert.equal(running?.status, 'running');

    await transport.publish({ kind: 'tenant-inbox' }, {
      eventId: 'event-client-pause-request',
      sessionId: running!.sessionId,
      ackId: 'ack-pause',
      sequence: 0,
      type: 'session.pause.requested',
      timestamp: clock.now(),
      actor: 'client',
      payload: {}
    }, demoContext());
    assert.deepEqual(workerCommands.map((event) => event.type), ['session.assign', 'session.pause.requested']);

    await transport.publish({ kind: 'tenant-inbox' }, {
      eventId: 'event-session-paused',
      sessionId: running!.sessionId,
      workerId: worker.workerId,
      sessionLeaseId: running!.sessionLeaseId,
      sequence: 0,
      type: 'session.paused',
      timestamp: clock.now(),
      actor: 'sidecar',
      payload: { reason: 'client_requested' }
    });
    await central.reconcileSessionsForTenant('poc');

    const idleMarked = await storage.readHostPoolInstance(ensureRunning.instance.instanceId);
    assert.equal(idleMarked?.state, 'ready');
    assert.equal(idleMarked?.idleSince, '2026-06-25T00:00:05.000Z');
    assert.equal(adapter.ensureStoppedInputs.length, 0);

    clock.set('2026-06-25T00:00:10.001Z');
    await central.reconcileSessionsForTenant('poc');

    assert.equal(adapter.ensureStoppedInputs.length, 1);
    assert.equal(adapter.ensureStoppedInputs[0].instance.currentWorkerId, worker.workerId);
    const stopped = await storage.readHostPoolInstance(ensureRunning.instance.instanceId);
    assert.equal(stopped?.state, 'stopped');
    assert.equal(stopped?.stoppedAt, '2026-06-25T00:00:10.001Z');
    const closedWorker = await storage.readWorker(worker.workerId);
    assert.equal(closedWorker?.lifecycleState, 'closed');
    assert.equal(closedWorker?.terminalReason, 'worker_closed');
  });
});

test('scenario: a no-reuse pool pins each instance to its session and retains the durable workspace across an idle pause', async () => {
  await withRuntime(async ({ central, storage, transport, clock, adapter }) => {
    const created = await createQueuedSession(transport);
    await central.reconcileSessionsForTenant('poc');
    await waitFor(() => adapter.ensureRunningInputs.length > 0, 'worker pool scale out');
    const [ensureRunning] = adapter.ensureRunningInputs;

    const session = await storage.readSession(created.sessionId!);
    assert.ok(session);
    // no-reuse: the instance is pinned to the session and carries its stable workspaceRef, so a session-keyed host
    // (a Foundry sandbox) can key its durable store on the session and reach it again after a resume.
    assert.equal(ensureRunning.instance.boundSessionId, session.sessionId);
    assert.equal(ensureRunning.instance.workspaceRef, session.workspaceRef);

    const worker = await registerWorkerFromInstance(central, ensureRunning.instance);
    clock.set('2026-06-25T00:00:05.000Z');
    await publishReadyHeartbeat(transport, worker.workerId, clock.now());
    await central.reconcileSessionsForTenant('poc');

    // correlate pre-binds the worker to exactly this session so WorkerSelector can never place another session on it
    const boundWorker = await storage.readWorker(worker.workerId);
    assert.equal(boundWorker?.reuse, false);
    assert.equal(boundWorker?.boundSessionId, session.sessionId);

    const assigned = await storage.readSession(session.sessionId);
    assert.equal(assigned?.status, 'starting');
    assert.equal(assigned?.currentWorkerId, worker.workerId);

    await publishStatusChanged(transport, session.sessionId, worker.workerId, assigned!.sessionLeaseId!, 'running', clock.now());
    await transport.publish({ kind: 'tenant-inbox' }, {
      eventId: 'event-pause-request', sessionId: session.sessionId, ackId: 'ack-pause', sequence: 0,
      type: 'session.pause.requested', timestamp: clock.now(), actor: 'client', payload: {}
    }, demoContext());
    await transport.publish({ kind: 'tenant-inbox' }, {
      eventId: 'event-session-paused', sessionId: session.sessionId, workerId: worker.workerId,
      sessionLeaseId: assigned!.sessionLeaseId, sequence: 0, type: 'session.paused',
      timestamp: clock.now(), actor: 'sidecar', payload: { reason: 'client_requested' }
    });
    await central.reconcileSessionsForTenant('poc');
    const paused = await storage.readSession(session.sessionId);
    assert.equal(paused?.status, 'paused');

    clock.set('2026-06-25T00:00:10.001Z');
    await central.reconcileSessionsForTenant('poc');

    // the worker recycles, but because the bound session is still alive (paused) the host must RETAIN the durable
    // workspace so the session can resume onto a fresh instance and find its files intact.
    assert.equal(adapter.ensureStoppedInputs.length, 1);
    assert.equal(adapter.ensureStoppedInputs[0].durableAction, 'retain');
  }, { reuse: false });
});

test('scenario: scale-in rechecks a Worker that became busy after the idle snapshot', async () => {
  await withRuntime(async ({ central, storage, clock, adapter }) => {
    const instance = {
      ...restartInstance('assignment-race-instance', 'assignment-race-worker'),
      controllerEpoch: 'test-controller',
      idleSince: '2026-06-25T00:00:00.000Z'
    };
    const worker = restartWorker(instance, {
      heartbeatAt: '2026-06-25T00:00:05.000Z',
      expiresAt: '2026-06-25T00:01:00.000Z'
    });
    await storage.writeHostPoolInstance(instance);
    await storage.writeWorker(worker);

    const readHostPoolInstances = storage.readHostPoolInstances.bind(storage);
    let readCount = 0;
    storage.readHostPoolInstances = async () => {
      const instances = await readHostPoolInstances();
      readCount += 1;
      if (readCount === 3) {
        await storage.writeWorker({
          ...worker,
          allocatable: 0,
          conditions: ['busy'],
          currentSessionCount: 1,
          updatedAt: clock.now()
        });
      }
      return instances;
    };

    clock.set('2026-06-25T00:00:10.000Z');
    await central.reconcileSessionsForTenant('poc');

    assert.equal(adapter.ensureStoppedInputs.length, 0);
    const preserved = await storage.readHostPoolInstance(instance.instanceId);
    assert.equal(preserved?.state, 'ready');
    assert.equal(preserved?.idleSince, undefined);
    assert.deepEqual((await storage.readWorker(worker.workerId))?.conditions, ['busy']);
  });
});

test('scenario: central restart re-arms a ready instance until the same Worker sends a fresh report', async () => {
  await withRuntime(async ({ central, storage, transport, clock, adapter }) => {
    const instance = restartInstance('restart-instance', 'restart-worker');
    const worker = restartWorker(instance, {
      conditions: ['busy'],
      allocatable: 0,
      currentSessionCount: 1
    });
    await storage.writeHostPoolInstance(instance);
    await storage.writeWorker(worker);

    clock.set('2026-06-25T00:00:10.000Z');
    await central.reconcileSessionsForTenant('poc');

    const awaitingReport = await storage.readHostPoolInstance(instance.instanceId);
    assert.equal(awaitingReport?.state, 'pending');
    assert.notEqual(awaitingReport?.controllerEpoch, 'old-controller');
    assert.equal(awaitingReport?.currentWorkerId, undefined);
    assert.equal(awaitingReport?.reportExpectedAfter, clock.now());
    assert.equal(adapter.ensureStoppedInputs.length, 0);
    const protectedWorker = await storage.readWorker(worker.workerId);
    assert.equal(protectedWorker?.lifecycleState, 'active');
    assert.deepEqual(protectedWorker?.conditions, ['disconnected']);
    assert.equal(protectedWorker?.expiresAt, awaitingReport?.reportDeadline);

    clock.set('2026-06-25T00:00:15.000Z');
    await publishWorkerHeartbeat(transport, worker.workerId, clock.now(), 0, ['busy']);
    await central.reconcileSessionsForTenant('poc');

    const recovered = await storage.readHostPoolInstance(instance.instanceId);
    assert.equal(recovered?.state, 'ready');
    assert.equal(recovered?.currentWorkerId, worker.workerId);
    assert.equal(recovered?.reportExpectedAfter, undefined);
    assert.equal(recovered?.reportDeadline, undefined);
    const sameWorkerLifetime = await storage.readWorker(worker.workerId);
    assert.equal(sameWorkerLifetime?.lifecycleState, 'active');
  });
});

test('scenario: restart expectation timeout stops and fails the host attempt when no Worker reports', async () => {
  await withRuntime(async ({ central, storage, clock, adapter }) => {
    const instance: HostPoolInstanceRecord = {
      ...restartInstance('instance-with-expired-worker', 'expired-worker'),
      hostHandle: 'container-with-expired-worker'
    };
    const worker = restartWorker(instance, {
      allocatable: 0,
      conditions: ['disconnected'],
      lifecycleState: 'expired',
      expiresAt: '2026-06-24T23:59:30.000Z',
      terminalReason: 'worker_keepalive_expired'
    });
    await storage.writeHostPoolInstance(instance);
    await storage.writeWorker(worker);

    clock.set('2026-06-25T00:00:10.000Z');
    await central.reconcileSessionsForTenant('poc');

    const awaitingReport = await storage.readHostPoolInstance(instance.instanceId);
    assert.equal(awaitingReport?.state, 'pending');
    assert.equal(adapter.ensureStoppedInputs.length, 0);

    clock.set('2026-06-25T00:01:10.000Z');
    await central.reconcileSessionsForTenant('poc');

    assert.equal(adapter.ensureStoppedInputs.length, 1);
    assert.equal(adapter.ensureStoppedInputs[0].instance.instanceId, instance.instanceId);
    assert.equal(adapter.ensureStoppedInputs[0].durableAction, 'release');
    const stopped = await storage.readHostPoolInstance(instance.instanceId);
    assert.equal(stopped?.state, 'failed');
    assert.equal(stopped?.failureReason, 'worker_report_timeout');
  });
});

test('scenario: two fresh Worker lifetimes for one host attempt are fenced as split brain', async () => {
  await withRuntime(async ({ central, storage, clock, adapter }) => {
    const instance: HostPoolInstanceRecord = {
      ...restartInstance('split-brain-instance', 'unused-worker'),
      state: 'pending',
      currentWorkerId: undefined,
      controllerEpoch: 'test-controller',
      reportExpectedAfter: '2026-06-25T00:00:00.000Z',
      reportDeadline: '2026-06-25T00:01:00.000Z'
    };
    const first = restartWorker({ ...instance, currentWorkerId: 'worker-a' }, {
      workerId: 'worker-a',
      heartbeatAt: '2026-06-25T00:00:05.000Z',
      expiresAt: '2026-06-25T00:00:35.000Z'
    });
    const second = restartWorker({ ...instance, currentWorkerId: 'worker-b' }, {
      workerId: 'worker-b',
      heartbeatAt: '2026-06-25T00:00:06.000Z',
      expiresAt: '2026-06-25T00:00:36.000Z'
    });
    await storage.writeHostPoolInstance(instance);
    await storage.writeWorker(first);
    await storage.writeWorker(second);
    clock.set('2026-06-25T00:00:10.000Z');

    await central.reconcileSessionsForTenant('poc');

    const failed = await storage.readHostPoolInstance(instance.instanceId);
    assert.equal(failed?.state, 'failed');
    assert.equal(failed?.failureReason, 'multiple_worker_reports');
    assert.equal((await storage.readWorker(first.workerId))?.lifecycleState, 'expired');
    assert.equal((await storage.readWorker(second.workerId))?.lifecycleState, 'expired');
    assert.equal(adapter.ensureStoppedInputs.length, 1);
  });
});

test('scenario: a ready host instance is never stopped when its worker record is absent', async () => {
  await withRuntime(async ({ central, storage, clock, adapter }) => {
    await storage.writeHostPoolInstance(readyInstance('ghost-instance', 'ghost-worker'));
    // No worker record exists for the instance's currentWorkerId. Absence is a storage-invariant violation, not
    // evidence the worker died, so the (possibly still-live) host must not be destroyed.
    clock.set('2026-06-25T00:00:10.000Z');

    await central.reconcileSessionsForTenant('poc');

    assert.equal(adapter.ensureStoppedInputs.length, 0);
    const preserved = await storage.readHostPoolInstance('ghost-instance');
    assert.equal(preserved?.state, 'ready');
    assert.equal(preserved?.currentWorkerId, 'ghost-worker');
  });
});

test('scenario: a ready host instance is stopped only when its worker durably reached a terminal state', async () => {
  await withRuntime(async ({ central, storage, clock, adapter }) => {
    const instance = readyInstance('terminal-instance', 'terminal-worker');
    await storage.writeHostPoolInstance(instance);
    await storage.writeWorker(restartWorker(instance, {
      lifecycleState: 'expired',
      conditions: ['disconnected'],
      terminalReason: 'worker_keepalive_expired'
    }));
    clock.set('2026-06-25T00:00:10.000Z');

    await central.reconcileSessionsForTenant('poc');

    assert.equal(adapter.ensureStoppedInputs.length, 1);
    const stopped = await storage.readHostPoolInstance('terminal-instance');
    assert.equal(stopped?.state, 'failed');
    assert.equal(stopped?.failureReason, 'current_worker_lost');
  });
});

async function withRuntime(testBody: (input: { root: string; storage: LocalFileStorage; transport: InMemoryRuntimeTransportAdapter; central: CentralService; clock: FixedClock; adapter: DeterministicHostPoolAdapter }) => Promise<void>, poolOverride: Partial<WorkerPoolRecord> = {}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'ars-worker-pool-'));
  try {
    const clock = new FixedClock('2026-06-25T00:00:00.000Z');
    const transport = new InMemoryRuntimeTransportAdapter();
    const storage = new LocalFileStorage(root);
    const adapter = new DeterministicHostPoolAdapter();
    const workerPool: WorkerPoolRecord = {
      poolId: 'poc-docker-copilot',
      tenantId: 'poc',
      template: { labels: COPILOT_WORKER_LABELS, capacity: 1 },
      hostPoolControllerClass: 'docker',
      scalePolicy: {
        scaleOutMaxPendingPerTick: 1,
        scaleInIdleMs: 5000,
        workerReportTimeoutMs: 60_000
      },
      centralUrlForWorkers: 'http://host.docker.internal:3000',
      ...poolOverride
    };
    const central = new CentralService({
      storage,
      eventTransport: transport,
      connectionIssuer: transport,
      clock,
      workerPools: [workerPool],
      hostPoolAdapters: { docker: adapter },
      controllerEpoch: 'test-controller'
    });
    await central.start();
    try {
      await testBody({ root, storage, transport, central, clock, adapter });
    } finally {
      await central.stop();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function createQueuedSession(transport: InMemoryRuntimeTransportAdapter): Promise<RuntimeEvent> {
  const acknowledgements: RuntimeEvent[] = [];
  await transport.subscribe({ kind: 'client-private-inbox', clientConnectionId: 'demo-connection' }, async (envelope) => {
    acknowledgements.push(envelope.event);
  });
  await transport.publish({ kind: 'tenant-inbox' }, {
    eventId: 'event-create-session',
    ackId: 'ack-create-session',
    sequence: 0,
    type: 'session.create.requested',
    timestamp: '2026-06-25T00:00:00.000Z',
    actor: 'client',
    payload: {
      agent: { agentSpecId: 'copilot-poc' },
      input: { message: 'start through worker pool' },
      workspace: { source: 'empty' }
    }
  }, demoContext());
  const created = acknowledgements.find((event) => event.ackId === 'ack-create-session');
  assert.equal(created?.type, 'session.created.ack');
  assert.equal(toRecord(created?.payload).status, 'queued');
  return created!;
}

async function registerWorkerFromInstance(central: CentralService, instance: HostPoolInstanceRecord): Promise<WorkerRecord> {
  const grant = await central.negotiateSidecarConnectionForTenant('poc', {
    principal: { principalId: 'docker-sidecar', type: 'service' },
    connectionId: `connection-${instance.instanceId}`
  }, {
    hostPoolInstanceId: instance.instanceId,
    labels: instance.labels,
    storageClass: COPILOT_STORAGE_CLASS,
    description: {
      workerPoolId: instance.poolId
    },
    capacity: instance.capacity,
    allocatable: instance.capacity
  });
  assert.ok(grant.worker);
  return grant.worker;
}

async function publishReadyHeartbeat(transport: InMemoryRuntimeTransportAdapter, workerId: string, timestamp: string): Promise<void> {
  await publishWorkerHeartbeat(transport, workerId, timestamp, 1, ['ready']);
}

async function publishWorkerHeartbeat(transport: InMemoryRuntimeTransportAdapter, workerId: string, timestamp: string, allocatable: number, conditions: Array<'ready' | 'busy'>): Promise<void> {
  await transport.publish({ kind: 'tenant-inbox' }, {
    eventId: `event-heartbeat-${workerId}`,
    workerId,
    sequence: 0,
    type: 'worker.heartbeat',
    timestamp,
    actor: 'sidecar',
    payload: {
      workerId,
      capacity: 1,
      allocatable,
      conditions
    }
  });
}

function restartInstance(instanceId: string, currentWorkerId: string): HostPoolInstanceRecord {
  return {
    instanceId,
    tenantId: 'poc',
    poolId: 'poc-docker-copilot',
    hostPoolControllerClass: 'docker',
    labels: COPILOT_WORKER_LABELS,
    capacity: 1,
    state: 'ready',
    hostHandle: `container-${instanceId}`,
    currentWorkerId,
    controllerEpoch: 'old-controller',
    createdAt: '2026-06-24T23:59:00.000Z',
    updatedAt: '2026-06-24T23:59:05.000Z'
  };
}

function readyInstance(instanceId: string, currentWorkerId: string): HostPoolInstanceRecord {
  return { ...restartInstance(instanceId, currentWorkerId), controllerEpoch: 'test-controller' };
}

function restartWorker(instance: HostPoolInstanceRecord, overrides: Partial<WorkerRecord> = {}): WorkerRecord {
  return {
    workerId: instance.currentWorkerId!,
    tenantId: 'poc',
    capacityScope: 'poc',
    hostPoolInstanceId: instance.instanceId,
    labels: COPILOT_WORKER_LABELS,
    storageClass: COPILOT_STORAGE_CLASS,
    description: { workerPoolId: instance.poolId },
    capacity: 1,
    allocatable: 1,
    conditions: ['ready'],
    lifecycleState: 'active',
    heartbeatAt: '2026-06-24T23:59:00.000Z',
    expiresAt: '2026-06-25T00:00:01.000Z',
    currentSessionCount: 0,
    updatedAt: '2026-06-24T23:59:00.000Z',
    ...overrides
  };
}

async function publishStatusChanged(transport: InMemoryRuntimeTransportAdapter, sessionId: string, workerId: string, sessionLeaseId: string, status: 'running', timestamp: string): Promise<void> {
  await transport.publish({ kind: 'tenant-inbox' }, {
    eventId: `event-status-${sessionId}`,
    sessionId,
    workerId,
    sessionLeaseId,
    sequence: 0,
    type: 'status.changed',
    timestamp,
    actor: 'sidecar',
    payload: { status }
  });
}

function demoContext() {
  return {
    principal: { principalId: 'demo-user', type: 'user' as const },
    connectionId: 'demo-connection'
  };
}

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}