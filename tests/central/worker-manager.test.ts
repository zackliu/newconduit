import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { InMemoryRuntimeTransportAdapter } from '../../src/central/adapters';
import { AgentSpecAdmissionManager, WorkerManager, WorkerSelector } from '../../src/central/managers';
import { COPILOT_STORAGE_CLASS, COPILOT_WORKER_LABELS, POC_AGENT_SPEC } from '../support/config-fixtures';
import { LocalFileStorage } from '../../src/central/storage/local-file-storage';
import type { Clock, RuntimeEvent, SessionRecord, WorkerRecord } from '../../src/shared';

class FixedClock implements Clock {
  constructor(private currentTime: string) {}

  now(): string {
    return this.currentTime;
  }

  set(time: string): void {
    this.currentTime = time;
  }
}

test('scenario: standalone sidecar registers worker and becomes ready after first heartbeat', async () => {
  await withStorage(async ({ storage, root, clock }) => {
    const manager = new WorkerManager(storage, clock, 30_000);

    const worker = await registerWorker(manager);

    assert.equal(worker.tenantId, 'poc');
    assert.equal(worker.storageClass, COPILOT_STORAGE_CLASS);
    assert.deepEqual(worker.labels, COPILOT_WORKER_LABELS);
    assert.equal(worker.capacity, 1);
    assert.equal(worker.allocatable, 0);
    assert.deepEqual(worker.conditions, ['disconnected']);
    assert.equal(worker.lifecycleState, 'registered');
    assert.equal(selectWorker(worker), undefined);

    const ready = await manager.heartbeat({
      workerId: worker.workerId,
      capacity: 1,
      allocatable: 1,
      conditions: ['ready']
    });
    assert.ok(ready);
    assert.equal(ready.lifecycleState, 'active');
    assert.deepEqual(ready.conditions, ['ready']);
    assert.equal(selectWorker(ready)?.workerId, ready.workerId);

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
      capacity: 2,
      allocatable: 2,
      conditions: ['ready']
    });
    assert.ok(updated);

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

    await manager.heartbeat({ workerId: worker.workerId, capacity: 1, allocatable: 1, conditions: ['ready'] });
    const closed = await manager.close({ workerId: worker.workerId });

    assert.equal(closed.lifecycleState, 'closed');
    assert.equal(closed.terminalReason, 'worker_closed');
    assert.equal(closed.allocatable, 0);
    assert.deepEqual(closed.conditions, ['disconnected']);
    assert.equal(selectWorker(closed), undefined);

    const events = await readWorkerEvents(root, worker.workerId);
    assert.deepEqual(events.map((event) => event.type), ['worker.registered', 'worker.heartbeat', 'worker.closed']);
  });
});

test('scenario: draining worker stops new assignment while existing lease finishes', async () => {
  await withStorage(async ({ storage, root, clock }) => {
    const manager = new WorkerManager(storage, clock, 30_000);
    const worker = await registerWorker(manager);

    await manager.heartbeat({ workerId: worker.workerId, capacity: 1, allocatable: 1, conditions: ['ready'] });
    const draining = await manager.drain({ workerId: worker.workerId });

    assert.equal(draining.lifecycleState, 'active');
    assert.equal(draining.allocatable, 0);
    assert.deepEqual(draining.conditions, ['draining']);
    assert.equal(selectWorker(draining), undefined);

    const events = await readWorkerEvents(root, worker.workerId);
    assert.deepEqual(events.map((event) => event.type), ['worker.registered', 'worker.heartbeat', 'worker.draining']);
  });
});

test('scenario: expired worker keepalive removes worker from active selection', async () => {
  await withStorage(async ({ storage, root, clock }) => {
    const manager = new WorkerManager(storage, clock, 1_000);
    const worker = await registerWorker(manager);
    await manager.heartbeat({ workerId: worker.workerId, capacity: 1, allocatable: 1, conditions: ['ready'] });
    clock.set('2026-06-24T00:00:01.001Z');

    const expiredWorkers = await manager.expireWorkers();

    assert.equal(expiredWorkers.length, 1);
    assert.equal(expiredWorkers[0].workerId, worker.workerId);
    assert.equal(expiredWorkers[0].lifecycleState, 'expired');
    assert.equal(expiredWorkers[0].terminalReason, 'worker_keepalive_expired');
    assert.equal(selectWorker(expiredWorkers[0]), undefined);

    const events = await readWorkerEvents(root, worker.workerId);
    assert.deepEqual(events.map((event) => event.type), ['worker.registered', 'worker.heartbeat', 'worker.expired']);
  });
});

test('scenario: registered worker that never heartbeats is reaped after keepalive expiry', async () => {
  await withStorage(async ({ storage, root, clock }) => {
    const manager = new WorkerManager(storage, clock, 1_000);
    const worker = await registerWorker(manager);
    clock.set('2026-06-24T00:00:01.001Z');

    const expiredWorkers = await manager.expireWorkers();

    assert.equal(expiredWorkers.length, 1);
    assert.equal(expiredWorkers[0].workerId, worker.workerId);
    assert.equal(expiredWorkers[0].lifecycleState, 'expired');
    assert.equal(expiredWorkers[0].terminalReason, 'worker_keepalive_expired');

    const events = await readWorkerEvents(root, worker.workerId);
    assert.deepEqual(events.map((event) => event.type), ['worker.registered', 'worker.expired']);
  });
});

test('scenario: leased worker close marks lease lost without crash recovery', async () => {
  await withStorage(async ({ storage, clock }) => {
    const manager = new WorkerManager(storage, clock, 30_000);
    const worker = await registerWorker(manager);
    await manager.heartbeat({ workerId: worker.workerId, capacity: 1, allocatable: 1, conditions: ['ready'] });
    const session = await writeLeasedSession(storage, worker);

    await manager.close({ workerId: worker.workerId });

    const failed = await storage.readSession(session.sessionId);
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.lifecycleReason, 'worker_lost');
    assert.equal(failed?.eventCursor, 1);

    const events = await storage.readEvents(session.sessionId, 0);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'session.lease.lost');
    assert.equal(events[0].workerId, worker.workerId);
    assert.equal(events[0].sessionLeaseId, session.sessionLeaseId);
  });
});

test('scenario: leased worker expiry marks lease lost without crash recovery', async () => {
  await withStorage(async ({ storage, clock }) => {
    const manager = new WorkerManager(storage, clock, 1_000);
    const worker = await registerWorker(manager);
    await manager.heartbeat({ workerId: worker.workerId, capacity: 1, allocatable: 1, conditions: ['ready'] });
    const session = await writeLeasedSession(storage, worker);
    clock.set('2026-06-24T00:00:01.001Z');

    await manager.expireWorkers();

    const failed = await storage.readSession(session.sessionId);
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.lifecycleReason, 'worker_lost');

    const events = await storage.readEvents(session.sessionId, 0);
    assert.equal(events[0].type, 'session.lease.lost');
    assert.deepEqual(events[0].payload, { reason: 'worker_lost', workerState: 'expired' });
  });
});

test('scenario: worker expiry fails in-flight turn and fans out lease loss', async () => {
  await withStorage(async ({ storage, clock }) => {
    const transport = new InMemoryRuntimeTransportAdapter();
    const manager = new WorkerManager(storage, clock, 1_000, transport);
    const worker = await registerWorker(manager);
    await manager.heartbeat({ workerId: worker.workerId, capacity: 1, allocatable: 1, conditions: ['ready'] });
    const session = await writeStartingSessionWithInitialTurn(storage, worker);
    const sessionEvents: RuntimeEvent[] = [];
    await transport.subscribe({ kind: 'session-events', sessionId: session.sessionId }, async (envelope) => {
      sessionEvents.push(envelope.event);
    });
    clock.set('2026-06-24T00:00:01.001Z');

    await manager.expireWorkers();

    const failed = await storage.readSession(session.sessionId);
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.currentWorkerId, undefined);
    assert.equal(failed?.sessionLeaseId, undefined);
    assert.equal(failed?.eventCursor, 3);

    const events = await storage.readEvents(session.sessionId, 0);
    assert.deepEqual(events.map((event) => event.type), ['session.created', 'turn.failed', 'session.lease.lost']);
    assert.equal(events[1].turnSeq, 1);
    assert.deepEqual(events[1].payload, {
      error: {
        message: 'worker was lost before the turn completed',
        code: 'worker_lost',
        details: {
          workerState: 'expired'
        }
      }
    });
    assert.deepEqual(sessionEvents.map((event) => event.type), ['turn.failed', 'session.lease.lost']);
  });
});

test('scenario: stale heartbeat cannot resurrect terminal worker', async () => {
  await withStorage(async ({ storage, root, clock }) => {
    const manager = new WorkerManager(storage, clock, 30_000);
    const worker = await registerWorker(manager);
    await manager.heartbeat({ workerId: worker.workerId, capacity: 1, allocatable: 1, conditions: ['ready'] });
    await manager.close({ workerId: worker.workerId });

    const result = await manager.heartbeat({
      workerId: worker.workerId,
      capacity: 1,
      allocatable: 1,
      conditions: ['ready']
    });
    assert.ok(result);

    assert.equal(result.lifecycleState, 'closed');
    assert.equal(selectWorker(result), undefined);

    const stored = await storage.readWorker(worker.workerId);
    assert.equal(stored?.lifecycleState, 'closed');

    const events = await readWorkerEvents(root, worker.workerId);
    assert.deepEqual(events.map((event) => event.type), ['worker.registered', 'worker.heartbeat', 'worker.closed', 'worker.heartbeat.rejected']);
  });
});

test('scenario: unknown worker heartbeat is rejected without creating worker record', async () => {
  await withStorage(async ({ storage, root, clock }) => {
    const manager = new WorkerManager(storage, clock, 30_000);

    const result = await manager.heartbeat({
      workerId: 'missing-worker',
      capacity: 1,
      allocatable: 1,
      conditions: ['ready']
    });

    assert.equal(result, undefined);
    assert.equal(await storage.readWorker('missing-worker'), undefined);

    const events = await readWorkerEvents(root, 'missing-worker');
    assert.deepEqual(events.map((event) => event.type), ['worker.heartbeat.rejected']);
    assert.deepEqual(events[0].payload, { reason: 'unknown-worker' });
  });
});

test('scenario: new worker registration creates a separate active worker lifetime', async () => {
  await withStorage(async ({ storage, clock }) => {
    const manager = new WorkerManager(storage, clock, 30_000);
    const first = await registerWorker(manager);
    await manager.heartbeat({ workerId: first.workerId, capacity: 1, allocatable: 1, conditions: ['ready'] });
    const leasedSession = await writeLeasedSession(storage, first);
    clock.set('2026-06-24T00:00:10.000Z');

    const second = await registerWorker(manager);
    const secondReady = await manager.heartbeat({ workerId: second.workerId, capacity: 1, allocatable: 1, conditions: ['ready'] });
    assert.ok(secondReady);

    const retired = await storage.readWorker(first.workerId);
    assert.equal(retired?.lifecycleState, 'active');
    assert.equal(secondReady.lifecycleState, 'active');
    assert.equal(selectWorker(secondReady)?.workerId, second.workerId);

    const unchanged = await storage.readSession(leasedSession.sessionId);
    assert.equal(unchanged?.status, 'running');
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
    labels: COPILOT_WORKER_LABELS,
    storageClass: COPILOT_STORAGE_CLASS,
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
    sessionLeaseId: `lease-${worker.workerId}`,
    eventCursor: 0,
    nextTurnSeq: 1,
    workspaceRef: 'workspace-volume',
    lastEventUpdatedAt: now,
    createdAt: now,
    updatedAt: now
  };
  await storage.writeSession(session);
  return session;
}

async function writeStartingSessionWithInitialTurn(storage: LocalFileStorage, worker: WorkerRecord): Promise<SessionRecord> {
  const now = new Date().toISOString();
  const session: SessionRecord = {
    sessionId: `session-${worker.workerId}`,
    tenantId: worker.tenantId,
    owner: 'owner-1',
    resolvedAgentSpec: new AgentSpecAdmissionManager({ now: () => now }).resolve(POC_AGENT_SPEC),
    status: 'starting',
    currentWorkerId: worker.workerId,
    sessionLeaseId: `lease-${worker.workerId}`,
    eventCursor: 1,
    nextTurnSeq: 2,
    workspaceRef: 'workspace-volume',
    lastEventUpdatedAt: now,
    createdAt: now,
    updatedAt: now
  };
  await storage.writeSession(session);
  await storage.appendEvent({
    eventId: `event-${worker.workerId}`,
    sessionId: session.sessionId,
    sequence: 1,
    type: 'session.created',
    timestamp: now,
    actor: 'central',
    turnSeq: 1,
    payload: {
      status: 'queued'
    }
  });
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
    eventCursor: 0,
    nextTurnSeq: 1,
    workspaceRef: 'workspace-volume',
    lastEventUpdatedAt: now,
    createdAt: now,
    updatedAt: now
  };
  return new WorkerSelector(() => Date.parse(worker.updatedAt)).select(session, [worker]);
}