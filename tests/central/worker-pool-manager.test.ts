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
import type { HostPoolAdapter, HostPoolScaleInInput, HostPoolScaleOutInput, HostPoolScaleOutResult } from '../../src/central/managers';

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
  readonly scaleOutInputs: HostPoolScaleOutInput[] = [];
  readonly scaleInInputs: HostPoolScaleInInput[] = [];

  async scaleOut(input: HostPoolScaleOutInput): Promise<HostPoolScaleOutResult> {
    this.scaleOutInputs.push(input);
    return { containerId: `container-${input.instance.instanceId}` };
  }

  async scaleIn(input: HostPoolScaleInInput): Promise<void> {
    this.scaleInInputs.push(input);
  }
}

test('scenario: queued session causes worker pool to scale out, assign provisioned worker, then scale in after idle', async () => {
  await withRuntime(async ({ central, storage, transport, clock, adapter }) => {
    const workerCommands: RuntimeEvent[] = [];

    const created = await createQueuedSession(transport);
    await waitFor(() => adapter.scaleOutInputs.length === 1, 'worker pool scale out');
    assert.equal(adapter.scaleOutInputs.length, 1);
    const [scaleOut] = adapter.scaleOutInputs;
    assert.equal(scaleOut.pool.poolId, 'poc-docker-copilot');
    assert.deepEqual(scaleOut.pool.template.labels, COPILOT_WORKER_LABELS);
    assert.equal(scaleOut.instance.state, 'pending');
    assert.equal(scaleOut.instance.capacity, 1);

    const pending = await storage.readHostPoolInstance(scaleOut.instance.instanceId);
    assert.equal(pending?.containerId, `container-${scaleOut.instance.instanceId}`);
    assert.equal(pending?.workerId, undefined);

    const worker = await registerWorkerFromInstance(central, scaleOut.instance);
    await transport.subscribe({ kind: 'worker-commands', workerId: worker.workerId }, async (envelope) => {
      workerCommands.push(envelope.event);
    });

    clock.set('2026-06-25T00:00:05.000Z');
    await publishReadyHeartbeat(transport, worker.workerId, clock.now());

    const assigned = await storage.readSession(created.sessionId!);
    assert.equal(assigned?.status, 'starting');
    assert.equal(assigned?.currentWorkerId, worker.workerId);
    assert.equal(typeof assigned?.sessionLeaseId, 'string');
    assert.deepEqual(workerCommands.map((event) => event.type), ['session.assign']);

    const readyInstance = await storage.readHostPoolInstance(scaleOut.instance.instanceId);
    assert.equal(readyInstance?.state, 'ready');
    assert.equal(readyInstance?.workerId, worker.workerId);

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

    const idleMarked = await storage.readHostPoolInstance(scaleOut.instance.instanceId);
    assert.equal(idleMarked?.state, 'ready');
    assert.equal(idleMarked?.idleSince, '2026-06-25T00:00:05.000Z');
    assert.equal(adapter.scaleInInputs.length, 0);

    clock.set('2026-06-25T00:00:10.001Z');
    await central.reconcileSessionsForTenant('poc');

    assert.equal(adapter.scaleInInputs.length, 1);
    assert.equal(adapter.scaleInInputs[0].instance.workerId, worker.workerId);
    const stopped = await storage.readHostPoolInstance(scaleOut.instance.instanceId);
    assert.equal(stopped?.state, 'stopped');
    assert.equal(stopped?.stoppedAt, '2026-06-25T00:00:10.001Z');
    const closedWorker = await storage.readWorker(worker.workerId);
    assert.equal(closedWorker?.lifecycleState, 'closed');
    assert.equal(closedWorker?.terminalReason, 'worker_closed');
  });
});

async function withRuntime(testBody: (input: { root: string; storage: LocalFileStorage; transport: InMemoryRuntimeTransportAdapter; central: CentralService; clock: FixedClock; adapter: DeterministicHostPoolAdapter }) => Promise<void>): Promise<void> {
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
        scaleInIdleMs: 5000
      },
      centralUrlForWorkers: 'http://host.docker.internal:3000'
    };
    const central = new CentralService({
      storage,
      eventTransport: transport,
      connectionIssuer: transport,
      clock,
      workerPools: [workerPool],
      hostPoolAdapters: { docker: adapter }
    });
    await central.start();
    await testBody({ root, storage, transport, central, clock, adapter });
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
    labels: instance.labels,
    storageClass: COPILOT_STORAGE_CLASS,
    description: {
      workerPoolId: instance.poolId,
      workerPoolInstanceId: instance.instanceId
    },
    capacity: instance.capacity,
    allocatable: instance.capacity
  });
  assert.ok(grant.worker);
  return grant.worker;
}

async function publishReadyHeartbeat(transport: InMemoryRuntimeTransportAdapter, workerId: string, timestamp: string): Promise<void> {
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
      allocatable: 1,
      conditions: ['ready']
    }
  });
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