import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AgentSpecAdmissionManager, WorkerManager, WorkerSelector } from '../../src/central/managers';
import { POC_AGENT_SPEC } from '../../src/central/registries/poc-class-registry';
import { LocalFileStorage } from '../../src/central/storage/local-file-storage';
import { COPILOT_PROCESS_WRAPPER_SIDECAR_CLASS, type Clock, type RuntimeEvent, type SessionRecord, type WorkerRecord } from '../../src/shared';

class FixedClock implements Clock {
  constructor(private currentTime: string) {}

  now(): string {
    return this.currentTime;
  }

  set(time: string): void {
    this.currentTime = time;
  }
}

test('scenario: standalone sidecar registers ready worker capacity', async () => {
  await withStorage(async ({ storage, root, clock }) => {
    const manager = new WorkerManager(storage, clock, 30_000);

    const worker = await registerWorker(manager);

    assert.equal(worker.tenantId, 'poc');
    assert.equal(worker.sidecarId, 'sidecar-1');
    assert.equal(worker.sidecarClass, COPILOT_PROCESS_WRAPPER_SIDECAR_CLASS);
    assert.deepEqual(worker.labels, { agent: 'copilot' });
    assert.equal(worker.capacity, 1);
    assert.equal(worker.allocatable, 1);
    assert.deepEqual(worker.conditions, ['ready']);
    assert.equal(worker.lifecycleState, 'active');
    assert.equal(worker.generation, 1);

    const stored = await storage.readWorker(worker.workerId);
    assert.equal(stored?.workerId, worker.workerId);

    const events = await readWorkerEvents(root, worker.workerId);
    assert.equal(events[0].type, 'worker.registered');
  });
});

test('scenario: worker heartbeat refreshes active capacity', async () => {
  await withStorage(async ({ storage, clock }) => {
    const manager = new WorkerManager(storage, clock, 30_000);
    const worker = await registerWorker(manager);
    clock.set('2026-06-24T00:00:10.000Z');

    const updated = await manager.heartbeat({
      workerId: worker.workerId,
      generation: worker.generation,
      capacity: 2,
      allocatable: 2,
      conditions: ['ready']
    });

    assert.equal(updated.heartbeatAt, '2026-06-24T00:00:10.000Z');
    assert.equal(updated.expiresAt, '2026-06-24T00:00:40.000Z');
    assert.equal(updated.capacity, 2);
    assert.equal(updated.allocatable, 2);
    assert.deepEqual(updated.conditions, ['ready']);
    assert.equal(updated.lifecycleState, 'active');
  });
});

test('scenario: graceful worker close removes worker from active selection', async () => {
  await withStorage(async ({ storage, root, clock }) => {
    const manager = new WorkerManager(storage, clock, 30_000);
    const worker = await registerWorker(manager);

    const closed = await manager.close({ workerId: worker.workerId, generation: worker.generation });

    assert.equal(closed.lifecycleState, 'closed');
    assert.equal(closed.terminalReason, 'worker_closed');
    assert.equal(closed.allocatable, 0);
    assert.deepEqual(closed.conditions, ['disconnected']);
    assert.equal(selectWorker(closed), undefined);

    const events = await readWorkerEvents(root, worker.workerId);
    assert.deepEqual(events.map((event) => event.type), ['worker.registered', 'worker.closed']);
  });
});

test('scenario: draining worker stops new assignment while existing lease finishes', async () => {
  await withStorage(async ({ storage, root, clock }) => {
    const manager = new WorkerManager(storage, clock, 30_000);
    const worker = await registerWorker(manager);

    const draining = await manager.drain({ workerId: worker.workerId, generation: worker.generation });

    assert.equal(draining.lifecycleState, 'active');
    assert.equal(draining.allocatable, 0);
    assert.deepEqual(draining.conditions, ['draining']);
    assert.equal(selectWorker(draining), undefined);

    const events = await readWorkerEvents(root, worker.workerId);
    assert.deepEqual(events.map((event) => event.type), ['worker.registered', 'worker.draining']);
  });
});

test('scenario: expired worker keepalive removes worker from active selection', async () => {
  await withStorage(async ({ storage, root, clock }) => {
    const manager = new WorkerManager(storage, clock, 1_000);
    const worker = await registerWorker(manager);
    clock.set('2026-06-24T00:00:01.001Z');

    const expiredWorkers = await manager.expireWorkers();

    assert.equal(expiredWorkers.length, 1);
    assert.equal(expiredWorkers[0].workerId, worker.workerId);
    assert.equal(expiredWorkers[0].lifecycleState, 'expired');
    assert.equal(expiredWorkers[0].terminalReason, 'worker_keepalive_expired');
    assert.equal(selectWorker(expiredWorkers[0]), undefined);

    const events = await readWorkerEvents(root, worker.workerId);
    assert.deepEqual(events.map((event) => event.type), ['worker.registered', 'worker.expired']);
  });
});

test('scenario: leased worker close marks lease lost without crash recovery', async () => {
  await withStorage(async ({ storage, clock }) => {
    const manager = new WorkerManager(storage, clock, 30_000);
    const worker = await registerWorker(manager);
    const session = await writeLeasedSession(storage, worker);

    await manager.close({ workerId: worker.workerId, generation: worker.generation });

    const failed = await storage.readSession(session.sessionId);
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.lifecycleReason, 'worker_lost');
    assert.equal(failed?.eventCursor, 1);

    const events = await storage.readEvents(session.sessionId, 0);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'worker.lease.lost');
    assert.equal(events[0].workerId, worker.workerId);
    assert.equal(events[0].workerLeaseGeneration, 1);
  });
});

test('scenario: leased worker expiry marks lease lost without crash recovery', async () => {
  await withStorage(async ({ storage, clock }) => {
    const manager = new WorkerManager(storage, clock, 1_000);
    const worker = await registerWorker(manager);
    const session = await writeLeasedSession(storage, worker);
    clock.set('2026-06-24T00:00:01.001Z');

    await manager.expireWorkers();

    const failed = await storage.readSession(session.sessionId);
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.lifecycleReason, 'worker_lost');

    const events = await storage.readEvents(session.sessionId, 0);
    assert.equal(events[0].type, 'worker.lease.lost');
    assert.deepEqual(events[0].payload, { reason: 'worker_lost', workerState: 'expired' });
  });
});

test('scenario: stale heartbeat cannot resurrect terminal worker', async () => {
  await withStorage(async ({ storage, root, clock }) => {
    const manager = new WorkerManager(storage, clock, 30_000);
    const worker = await registerWorker(manager);
    await manager.close({ workerId: worker.workerId, generation: worker.generation });

    const result = await manager.heartbeat({
      workerId: worker.workerId,
      generation: worker.generation,
      capacity: 1,
      allocatable: 1,
      conditions: ['ready']
    });

    assert.equal(result.lifecycleState, 'closed');
    assert.equal(selectWorker(result), undefined);

    const stored = await storage.readWorker(worker.workerId);
    assert.equal(stored?.lifecycleState, 'closed');

    const events = await readWorkerEvents(root, worker.workerId);
    assert.deepEqual(events.map((event) => event.type), ['worker.registered', 'worker.closed', 'worker.heartbeat.rejected']);
  });
});

async function withStorage(testBody: (input: { root: string; storage: LocalFileStorage; clock: FixedClock }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'ars-worker-lifecycle-'));
  try {
    await testBody({
      root,
      storage: new LocalFileStorage(root),
      clock: new FixedClock('2026-06-24T00:00:00.000Z')
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function registerWorker(manager: WorkerManager): Promise<WorkerRecord> {
  return manager.register({
    tenantId: 'poc',
    sidecarId: 'sidecar-1',
    sidecarClass: COPILOT_PROCESS_WRAPPER_SIDECAR_CLASS,
    labels: { agent: 'copilot' },
    capacity: 1,
    allocatable: 1
  });
}

async function readWorkerEvents(root: string, workerId: string): Promise<RuntimeEvent[]> {
  const text = await readFile(join(root, 'workers', `${workerId}.events.jsonl`), 'utf8');
  return text.trim().split('\n').map((line) => JSON.parse(line) as RuntimeEvent);
}

async function writeLeasedSession(storage: LocalFileStorage, worker: WorkerRecord): Promise<SessionRecord> {
  const now = new Date().toISOString();
  const session: SessionRecord = {
    sessionId: `session-${worker.workerId}`,
    tenantId: worker.tenantId,
    owner: 'owner-1',
    resolvedAgentSpec: new AgentSpecAdmissionManager({ now: () => now }).resolve(POC_AGENT_SPEC),
    status: 'running',
    currentWorkerId: worker.workerId,
    workerLeaseGeneration: 1,
    eventCursor: 0,
    nextTurnSeq: 1,
    workspaceRef: 'workspace-volume',
    createdAt: now,
    updatedAt: now
  };
  await storage.writeSession(session);
  return session;
}

function selectWorker(worker: WorkerRecord): WorkerRecord | undefined {
  const now = new Date().toISOString();
  const session: SessionRecord = {
    sessionId: 'queued-session',
    tenantId: worker.tenantId,
    owner: 'owner-1',
    resolvedAgentSpec: new AgentSpecAdmissionManager({ now: () => now }).resolve(POC_AGENT_SPEC),
    status: 'queued',
    workerLeaseGeneration: 0,
    eventCursor: 0,
    nextTurnSeq: 1,
    workspaceRef: 'workspace-volume',
    createdAt: now,
    updatedAt: now
  };
  return new WorkerSelector().select(session, [worker]);
}