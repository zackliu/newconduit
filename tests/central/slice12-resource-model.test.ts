import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { InMemoryRuntimeTransportAdapter } from '../../src/central/adapters';
import { CentralService } from '../../src/central/central-service';
import { AgentSpecAdmissionManager, WorkerManager, WorkerPoolManager, WorkerSelector, type HostPoolAdapter, type HostPoolScaleInInput, type HostPoolScaleOutInput, type HostPoolScaleOutResult } from '../../src/central/managers';
import { SnapshotManager } from '../../src/central/persistence';
import { LocalFileStorage } from '../../src/central/storage/local-file-storage';
import { SystemClock, type ResolvedAgentSpec, type RuntimeEvent, type SessionRecord, type WorkerPoolRecord, type WorkerRecord } from '../../src/shared';
import { COPILOT_STORAGE_CLASS, COPILOT_WORKER_LABELS, POC_AGENT_SPEC } from '../support/config-fixtures';

function admit(): ResolvedAgentSpec {
  return new AgentSpecAdmissionManager(new SystemClock()).resolve(POC_AGENT_SPEC);
}

function nowIso(): string {
  return new Date().toISOString();
}

function worker(overrides: Partial<WorkerRecord> = {}): WorkerRecord {
  const now = nowIso();
  return {
    workerId: 'worker-1',
    tenantId: 'poc',
    capacityScope: 'poc',
    labels: COPILOT_WORKER_LABELS,
    storageClass: COPILOT_STORAGE_CLASS,
    capacity: 1,
    allocatable: 1,
    conditions: ['ready'],
    lifecycleState: 'active',
    heartbeatAt: now,
    expiresAt: new Date(Date.parse(now) + 30_000).toISOString(),
    currentSessionCount: 0,
    updatedAt: now,
    ...overrides
  };
}

function queuedSession(resolved: ResolvedAgentSpec, overrides: Partial<SessionRecord> = {}): SessionRecord {
  const now = nowIso();
  return {
    sessionId: 'session-1',
    tenantId: 'poc',
    owner: 'owner-1',
    resolvedAgentSpec: resolved,
    status: 'queued',
    eventCursor: 0,
    nextTurnSeq: 1,
    workspaceRef: 'ws-1',
    lastEventUpdatedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function runningSession(storageClass: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  const now = nowIso();
  return {
    sessionId: 'session-run',
    tenantId: 'poc',
    owner: 'owner-1',
    resolvedAgentSpec: admit(),
    status: 'running',
    storageClass,
    currentWorkerId: 'worker-1',
    sessionLeaseId: 'lease-1',
    eventCursor: 3,
    nextTurnSeq: 2,
    workspaceRef: 'ws-run',
    lastEventUpdatedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

test('scenario: worker selection is purely label based', () => {
  const session = queuedSession(admit());
  const match = worker();
  const wrongLabels = worker({ workerId: 'worker-2', labels: { agent: 'other', storage: 'volume-snapshot' } });
  const selector = new WorkerSelector();

  assert.equal(selector.select(session, [wrongLabels, match])?.workerId, 'worker-1');
  assert.equal(selector.select(session, [wrongLabels]), undefined);
});

test('scenario: storage requirement is matched by label', () => {
  // POC AgentSpec workerSelector requires storage=volume-snapshot.
  const session = queuedSession(admit());
  const wrongStorage = worker({ workerId: 'worker-managed', labels: { agent: 'copilot', storage: 'host-managed' }, storageClass: 'host-managed' });
  const rightStorage = worker({ workerId: 'worker-snap' });
  const selector = new WorkerSelector();

  assert.equal(selector.select(session, [wrongStorage]), undefined);
  assert.equal(selector.select(session, [wrongStorage, rightStorage])?.workerId, 'worker-snap');
});

test('scenario: worker labels and capacity are declared once on the pool template', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ars-slice12-template-'));
  try {
    const clock = new SystemClock();
    const storage = new LocalFileStorage(root);
    await storage.writeSession(queuedSession(admit()));
    const pool: WorkerPoolRecord = {
      poolId: 'p1',
      tenantId: 'poc',
      template: { labels: COPILOT_WORKER_LABELS, capacity: 1 },
      hostPoolControllerClass: 'docker',
      scalePolicy: { scaleOutMaxPendingPerTick: 1, scaleInIdleMs: 5000 },
      centralUrlForWorkers: 'http://central'
    };
    const adapter = new CapturingHostPoolAdapter();
    const manager = new WorkerPoolManager(storage, clock, new WorkerManager(storage, clock), [pool], { docker: adapter });

    await manager.reconcile();

    const instances = await storage.readHostPoolInstances();
    assert.equal(instances.length, 1);
    // Single source: the scaled worker's identity is exactly the pool template, not a duplicated worker-type value.
    assert.deepEqual(instances[0].labels, COPILOT_WORKER_LABELS);
    assert.equal(instances[0].capacity, 1);
    assert.equal(adapter.scaleOutCalls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scenario: persistence records an opaque handle from a supply-declared driver', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ars-slice12-handle-'));
  try {
    const storage = new LocalFileStorage(root);
    const manager = new SnapshotManager(storage, new SystemClock());
    const session = runningSession(COPILOT_STORAGE_CLASS);

    const capture = manager.planCapture(session);
    assert.ok(capture);
    assert.equal(capture.storageClass, COPILOT_STORAGE_CLASS);
    assert.equal(typeof capture.handle, 'string');

    const snapshot = await manager.recordCapture(session, { snapshotId: capture.snapshotId, parts: ['workspace', 'agent-state'] });
    assert.ok(snapshot);
    // The envelope carries the concrete driver classId + an opaque handle + semantic parts, and NO filesystem path.
    assert.equal(snapshot.storageClass, COPILOT_STORAGE_CLASS);
    assert.equal(typeof snapshot.handle, 'string');
    assert.deepEqual(snapshot.parts, ['workspace', 'agent-state']);
    assert.equal(snapshot.baseEventCursor, session.eventCursor);
    assert.equal('location' in snapshot, false);
    assert.equal(JSON.stringify(snapshot).includes('"path"'), false);

    // Central does not parse the handle: resume hands { storageClass, handle } straight back to the worker data-half.
    const restore = await manager.planRestore({ ...session, latestSnapshotRef: snapshot.snapshotId });
    assert.ok(restore);
    assert.equal(restore.storageClass, COPILOT_STORAGE_CLASS);
    assert.equal(restore.handle, snapshot.handle);
    assert.deepEqual(restore.parts, ['workspace', 'agent-state']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scenario: attachment kind dispatches bytes and recovery reuses the recorded driver', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ars-slice12-kind-'));
  try {
    const storage = new LocalFileStorage(root);
    const manager = new SnapshotManager(storage, new SystemClock());

    // worker-pull driver: central hands the worker a capture/restore spec (the opaque handle).
    const pullSession = runningSession('volume-snapshot');
    assert.equal(manager.attachmentKind(pullSession), 'worker-pull');
    assert.ok(manager.planCapture(pullSession));

    // host-managed driver: central moves nothing and produces no dispatch spec.
    const managedSession = runningSession('host-managed', { sessionId: 'session-managed' });
    assert.equal(manager.attachmentKind(managedSession), 'host-managed');
    assert.equal(manager.planCapture(managedSession), undefined);
    assert.equal(await manager.recordCapture(managedSession, { snapshotId: 'x', parts: [] }), undefined);

    // Recovery reuses the storageClass driver recorded on the session, not one derived from a new worker.
    const snapshot = await manager.recordCapture(pullSession, { snapshotId: 'snap-1', parts: ['workspace'] });
    assert.ok(snapshot);
    const restore = await manager.planRestore({ ...pullSession, latestSnapshotRef: 'snap-1' });
    assert.equal(restore?.storageClass, 'volume-snapshot');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scenario: central mints no backend-specific workspace reference', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ars-slice12-workspaceref-'));
  try {
    const transport = new InMemoryRuntimeTransportAdapter();
    const storage = new LocalFileStorage(root);
    const central = new CentralService({ storage, eventTransport: transport, connectionIssuer: transport });
    await central.start();

    await transport.publish({ kind: 'tenant-inbox' }, createSessionEvent('ack-1'), { principal: { principalId: 'demo-user', type: 'user' }, connectionId: 'demo-conn' });

    const sessions = await storage.readSessions();
    assert.equal(sessions.length, 1);
    const workspaceRef = sessions[0].workspaceRef;
    assert.equal(typeof workspaceRef, 'string');
    assert.ok(workspaceRef.length > 0);
    assert.equal(workspaceRef.startsWith('docker-volume:'), false);
    assert.equal(workspaceRef.includes(':'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function createSessionEvent(ackId: string): RuntimeEvent {
  return {
    eventId: `evt-${ackId}`,
    ackId,
    sequence: 0,
    type: 'session.create.requested',
    timestamp: nowIso(),
    actor: 'client',
    payload: { agent: { agentSpecId: 'copilot-poc' }, workspace: { source: 'empty' } }
  };
}

class CapturingHostPoolAdapter implements HostPoolAdapter {
  scaleOutCalls = 0;
  async scaleOut(_input: HostPoolScaleOutInput): Promise<HostPoolScaleOutResult> {
    this.scaleOutCalls += 1;
    return { containerId: 'container-1' };
  }
  async scaleIn(_input: HostPoolScaleInInput): Promise<void> {
    return;
  }
}
