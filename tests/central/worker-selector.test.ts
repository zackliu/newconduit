import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentSpecAdmissionManager, WorkerSelector } from '../../src/central/managers';
import { COPILOT_STORAGE_CLASS, COPILOT_WORKER_LABELS, POC_AGENT_SPEC } from '../support/config-fixtures';
import { SystemClock, type SessionRecord, type WorkerRecord } from '../../src/shared';

test('scenario: queued session is assigned to matching ready worker', () => {
  const now = new Date().toISOString();
  const resolvedAgentSpec = new AgentSpecAdmissionManager(new SystemClock()).resolve(POC_AGENT_SPEC);
  const session: SessionRecord = {
    sessionId: 'session-1',
    tenantId: 'tenant-1',
    owner: 'owner-1',
    resolvedAgentSpec,
    status: 'queued',
    sessionLeaseId: undefined,
    eventCursor: 0,
    nextTurnSeq: 1,
    workspaceRef: 'workspace-volume',
    lastEventUpdatedAt: now,
    createdAt: now,
    updatedAt: now
  };
  const worker: WorkerRecord = {
    workerId: 'worker-1',
    tenantId: 'tenant-1',
    capacityScope: 'tenant-1',
    labels: COPILOT_WORKER_LABELS,
    storageClass: COPILOT_STORAGE_CLASS,
    capacity: 1,
    allocatable: 1,
    conditions: ['ready'],
    lifecycleState: 'active',
    heartbeatAt: now,
    expiresAt: new Date(Date.parse(now) + 30_000).toISOString(),
    currentSessionCount: 0,
    updatedAt: now
  };

  const selected = new WorkerSelector().select(session, [worker]);

  assert.equal(selected?.workerId, 'worker-1');
});

test('scenario: expired ready worker is not selected for queued session', () => {
  const now = Date.parse('2026-06-25T12:00:00.000Z');
  const resolvedAgentSpec = new AgentSpecAdmissionManager(new SystemClock()).resolve(POC_AGENT_SPEC);
  const session: SessionRecord = {
    sessionId: 'session-1',
    tenantId: 'tenant-1',
    owner: 'owner-1',
    resolvedAgentSpec,
    status: 'queued',
    sessionLeaseId: undefined,
    eventCursor: 0,
    nextTurnSeq: 1,
    workspaceRef: 'workspace-volume',
    lastEventUpdatedAt: new Date(now).toISOString(),
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString()
  };
  const worker: WorkerRecord = {
    workerId: 'worker-1',
    tenantId: 'tenant-1',
    capacityScope: 'tenant-1',
    labels: COPILOT_WORKER_LABELS,
    storageClass: COPILOT_STORAGE_CLASS,
    capacity: 1,
    allocatable: 1,
    conditions: ['ready'],
    lifecycleState: 'active',
    heartbeatAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now - 30_000).toISOString(),
    currentSessionCount: 0,
    updatedAt: new Date(now - 60_000).toISOString()
  };

  const selected = new WorkerSelector(() => now).select(session, [worker]);

  assert.equal(selected, undefined);
});

test('scenario: no-reuse worker only accepts its bound session, never a different one', () => {
  const now = new Date().toISOString();
  const resolvedAgentSpec = new AgentSpecAdmissionManager(new SystemClock()).resolve(POC_AGENT_SPEC);
  const sessionFor = (sessionId: string): SessionRecord => ({
    sessionId,
    tenantId: 'tenant-1',
    owner: 'owner-1',
    resolvedAgentSpec,
    status: 'queued',
    sessionLeaseId: undefined,
    eventCursor: 0,
    nextTurnSeq: 1,
    workspaceRef: `workspace-${sessionId}`,
    lastEventUpdatedAt: now,
    createdAt: now,
    updatedAt: now
  });
  const workerWith = (overrides: Partial<WorkerRecord>): WorkerRecord => ({
    workerId: 'worker-1',
    tenantId: 'tenant-1',
    capacityScope: 'tenant-1',
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
  });

  const selector = new WorkerSelector();

  // Bound to a different session: excluded even though it has free capacity and matches labels.
  assert.equal(selector.select(sessionFor('session-A'), [workerWith({ reuse: false, boundSessionId: 'session-B' })]), undefined);
  // Bound to the same session (e.g. resume onto its still-alive worker): selected.
  assert.equal(selector.select(sessionFor('session-A'), [workerWith({ reuse: false, boundSessionId: 'session-A' })])?.workerId, 'worker-1');
  // Fresh no-reuse worker (unbound): selectable, and becomes bound once assigned.
  assert.equal(selector.select(sessionFor('session-A'), [workerWith({ reuse: false })])?.workerId, 'worker-1');
  // Reuse (shared) worker: any matching session may be placed even if another session already used it.
  assert.equal(selector.select(sessionFor('session-A'), [workerWith({ reuse: true, boundSessionId: 'session-B' })])?.workerId, 'worker-1');
});

// --- Per-device pairing: a session with requiredWorkerLabels is narrowed to one specific paired worker --------

function pairingHarness(now: string): {
  sessionFor: (requiredWorkerLabels?: Record<string, string>) => SessionRecord;
  workerWith: (overrides: Partial<WorkerRecord>) => WorkerRecord;
} {
  const resolvedAgentSpec = new AgentSpecAdmissionManager(new SystemClock()).resolve(POC_AGENT_SPEC);
  const sessionFor = (requiredWorkerLabels?: Record<string, string>): SessionRecord => ({
    sessionId: 'child-scan',
    tenantId: 'tenant-1',
    owner: 'owner-1',
    resolvedAgentSpec,
    status: 'queued',
    sessionLeaseId: undefined,
    requiredWorkerLabels,
    eventCursor: 0,
    nextTurnSeq: 1,
    workspaceRef: 'workspace-child-scan',
    lastEventUpdatedAt: now,
    createdAt: now,
    updatedAt: now
  });
  const workerWith = (overrides: Partial<WorkerRecord>): WorkerRecord => ({
    workerId: 'worker-1',
    tenantId: 'tenant-1',
    capacityScope: 'tenant-1',
    labels: COPILOT_WORKER_LABELS,
    storageClass: COPILOT_STORAGE_CLASS,
    capacity: 1,
    allocatable: 1,
    conditions: ['ready'],
    lifecycleState: 'active',
    heartbeatAt: now,
    expiresAt: new Date(Date.parse(now) + 30_000).toISOString(),
    registeredAt: now,
    currentSessionCount: 0,
    updatedAt: now,
    ...overrides
  });
  return { sessionFor, workerWith };
}

test('scenario: a pinned session routes only to the worker carrying its required device label', () => {
  const now = new Date().toISOString();
  const { sessionFor, workerWith } = pairingHarness(now);
  const paired = workerWith({ workerId: 'paired', labels: { ...COPILOT_WORKER_LABELS, deviceRef: 'dref-A' } });
  const otherTab = workerWith({ workerId: 'other-tab', labels: { ...COPILOT_WORKER_LABELS, deviceRef: 'dref-B' } });
  const unpaired = workerWith({ workerId: 'unpaired', labels: { ...COPILOT_WORKER_LABELS } });

  const selector = new WorkerSelector();
  const selected = selector.select(sessionFor({ deviceRef: 'dref-A' }), [otherTab, unpaired, paired]);

  // The base selector matches all three, but only the worker with the required device label is eligible — the
  // other browser tab and the unpaired tab are never chosen, regardless of storage order.
  assert.equal(selected?.workerId, 'paired');
});

test('scenario: a pinned session with no matching worker is not silently placed on a base-only match', () => {
  const now = new Date().toISOString();
  const { sessionFor, workerWith } = pairingHarness(now);
  const unpaired = workerWith({ workerId: 'unpaired', labels: { ...COPILOT_WORKER_LABELS } });
  const wrongDevice = workerWith({ workerId: 'wrong-device', labels: { ...COPILOT_WORKER_LABELS, deviceRef: 'dref-B' } });

  const selector = new WorkerSelector();

  // The paired device is offline: the scan stays unplaced (explicit routing failure) instead of falling back
  // to an unrelated browser worker that only matches the base selector.
  assert.equal(selector.select(sessionFor({ deviceRef: 'dref-A' }), [unpaired, wrongDevice]), undefined);
});

test('scenario: duplicate/reloaded tabs sharing a device binding resolve deterministically to the newest registration', () => {
  const base = Date.parse('2026-06-25T12:00:00.000Z');
  const stale = new Date(base).toISOString();
  const fresh = new Date(base + 5_000).toISOString();
  const { sessionFor, workerWith } = pairingHarness(stale);
  const staleTab = workerWith({
    workerId: 'stale-tab',
    labels: { ...COPILOT_WORKER_LABELS, deviceRef: 'dref-A' },
    registeredAt: stale,
    // Still inside its keepalive window, so both tabs are live at selection time.
    expiresAt: new Date(base + 30_000).toISOString()
  });
  const freshTab = workerWith({
    workerId: 'fresh-tab',
    labels: { ...COPILOT_WORKER_LABELS, deviceRef: 'dref-A' },
    registeredAt: fresh,
    expiresAt: new Date(base + 35_000).toISOString()
  });

  const selector = new WorkerSelector(() => base + 10_000);

  // The reloaded (newest) tab wins deterministically regardless of order, so a stale prior registration never
  // receives new work.
  assert.equal(selector.select(sessionFor({ deviceRef: 'dref-A' }), [staleTab, freshTab])?.workerId, 'fresh-tab');
  assert.equal(selector.select(sessionFor({ deviceRef: 'dref-A' }), [freshTab, staleTab])?.workerId, 'fresh-tab');
});

test('scenario: a required label cannot widen or escape the AgentSpec base worker selector', () => {
  const now = new Date().toISOString();
  const { sessionFor, workerWith } = pairingHarness(now);
  // A worker that does NOT satisfy the base selector (different agent class) but does carry the device label.
  const foreign = workerWith({
    workerId: 'foreign',
    labels: { agent: 'not-the-base', storage: COPILOT_STORAGE_CLASS, deviceRef: 'dref-A' }
  });

  const selector = new WorkerSelector();

  // Even though the required label matches, the base selector still fails, so narrowing can only ever shrink the
  // eligible set within the AgentSpec floor — never reach a worker the AgentSpec would not have allowed.
  assert.equal(selector.select(sessionFor({ deviceRef: 'dref-A' }), [foreign]), undefined);
});
