import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AgentSpec, Delegate, SessionRecord, WorkerRecord } from '../../src/shared';
import { AgentSpecAdmissionManager, DelegateAdmissionManager, DelegatedSessionManager, DelegationDispatcher, DelegationManager, EventLogManager, SessionAssignmentManager, SessionLeaseManager, SessionLifecycleManager, SessionStartManager, WorkerSelector } from '../../src/central/managers';
import { StaticDelegateBindingIndex, StaticDelegateRegistry, StaticResolvedDelegateRegistry } from '../../src/central/registries/delegate-registry';
import { SnapshotManager } from '../../src/central/persistence';
import { LocalFileStorage } from '../../src/central/storage/local-file-storage';

const NOW = '2026-07-14T00:00:00.000Z';
const DELEGATE_ID = 'copilot-foundry';
const DELEGATE: Delegate = { id: DELEGATE_ID, toolName: 'copilot_foundry', description: 'Ask copilot-foundry.', maxInputBytes: 2048, maxResultBytes: 8192, deadlineMs: 120_000, maxQueuedCalls: 2 };

test('scenario: queued DelegationCall becomes one ordinary leased Child turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ars-delegation-dispatch-'));
  try {
    const storage = new LocalFileStorage(root);
    const clock = { now: () => NOW };
    const lifecycle = new SessionLifecycleManager(storage, clock);
    const start = createDelegationManager(storage, lifecycle);
    const call = await start.startCall({ parentSession: parent(), callerTurnSeq: 1, callerToolRequestId: 'tool-1', delegateId: DELEGATE_ID, input: 'When?' });
    await storage.writeWorker(worker());
    const assignment = new SessionAssignmentManager(storage, clock, new WorkerSelector(() => Date.parse(NOW)), new SessionLeaseManager(storage), new SnapshotManager(storage, clock));
    const eventLog = new EventLogManager(storage, clock);
    const dispatcher = new DelegationDispatcher(storage, clock, new DelegatedSessionManager(storage, eventLog, lifecycle, new SessionStartManager(lifecycle, eventLog, assignment)));

    const dispatched = await dispatcher.dispatchNext(call.delegation.delegationId);
    assert.ok(dispatched);
    assert.equal(dispatched.call.status, 'active');
    assert.equal(dispatched.call.dispatch?.childTurnSeq, 1);
    assert.equal(dispatched.sessionCreatedEvent?.type, 'session.created');
    assert.equal(dispatched.sessionCreatedEvent?.eventId, dispatched.call.dispatch?.inputEventId);
    assert.deepEqual(dispatched.sessionCatalogUpdatedEvent?.payload, {
      sessionId: call.delegation.childSessionId,
      status: 'starting',
      parentSessionId: 'parent-1'
    });
    assert.equal(dispatched.needsReconcile, false);
    assert.deepEqual(dispatched.workerCommands.map((command) => command.event.type), ['session.assign', 'session.input']);
    const input = dispatched.workerCommands[1].event.payload as { input: { message: string } };
    assert.equal(input.input.message, 'When?');

    const child = await storage.readSession(call.delegation.childSessionId);
    assert.equal(child?.status, 'starting');
    assert.equal(child?.nextTurnSeq, 2);
    assert.equal(child?.currentWorkerId, 'worker-callee');
    assert.equal((await storage.readEvents(child!.sessionId, 0)).filter((event) => event.type === 'session.created').length, 1);

    const replay = await dispatcher.dispatchNext(call.delegation.delegationId);
    assert.ok(replay);
    assert.equal(replay.call.dispatch?.commandEventId, dispatched.call.dispatch?.commandEventId);
    assert.equal((await storage.readEvents(child!.sessionId, 0)).filter((event) => event.type === 'session.created').length, 1);

    await start.acknowledgeCommand(call.delegation.childSessionId, replay.call.dispatch!.commandEventId, 1);
    assert.equal(await dispatcher.dispatchNext(call.delegation.delegationId), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scenario: Child Session becomes durable queued demand when no Worker is ready', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ars-delegation-queued-'));
  try {
    const storage = new LocalFileStorage(root);
    const clock = { now: () => NOW };
    const lifecycle = new SessionLifecycleManager(storage, clock);
    const manager = createDelegationManager(storage, lifecycle);
    const started = await manager.startCall({ parentSession: parent(), callerTurnSeq: 1, callerToolRequestId: 'tool-queued', delegateId: DELEGATE_ID, input: 'Wait for capacity' });
    const assignment = new SessionAssignmentManager(storage, clock, new WorkerSelector(() => Date.parse(NOW)), new SessionLeaseManager(storage), new SnapshotManager(storage, clock));
    const eventLog = new EventLogManager(storage, clock);
    const dispatcher = new DelegationDispatcher(storage, clock, new DelegatedSessionManager(storage, eventLog, lifecycle, new SessionStartManager(lifecycle, eventLog, assignment)));

    const dispatched = await dispatcher.dispatchNext(started.delegation.delegationId);

    assert.ok(dispatched);
    assert.equal((await storage.readSession(started.delegation.childSessionId))?.status, 'queued');
    assert.equal(dispatched.sessionCreatedEvent?.type, 'session.created');
    assert.deepEqual(dispatched.workerCommands, []);
    assert.equal(dispatched.needsReconcile, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scenario: completed Call releases the same Child Session for Call 2', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ars-delegation-reuse-'));
  try {
    const storage = new LocalFileStorage(root);
    const clock = { now: () => NOW };
    const lifecycle = new SessionLifecycleManager(storage, clock);
    const manager = createDelegationManager(storage, lifecycle);
    const first = await manager.startCall({ parentSession: parent(), callerTurnSeq: 1, callerToolRequestId: 'tool-1', delegateId: DELEGATE_ID, input: 'When?' });
    const second = await manager.startCall({ parentSession: parent(), callerTurnSeq: 2, callerToolRequestId: 'tool-2', delegateId: DELEGATE_ID, input: 'Why?' });
    await storage.writeWorker(worker());
    const assignment = new SessionAssignmentManager(storage, clock, new WorkerSelector(() => Date.parse(NOW)), new SessionLeaseManager(storage), new SnapshotManager(storage, clock));
    const eventLog = new EventLogManager(storage, clock);
    const dispatcher = new DelegationDispatcher(storage, clock, new DelegatedSessionManager(storage, eventLog, lifecycle, new SessionStartManager(lifecycle, eventLog, assignment)));

    const call1 = await dispatcher.dispatchNext(first.delegation.delegationId);
    assert.ok(call1);
    const assignedChild = await storage.readSession(first.delegation.childSessionId);
    assert.ok(assignedChild);
    await lifecycle.transition(assignedChild, 'running');
    await manager.acknowledgeCommand(first.delegation.childSessionId, call1.call.dispatch!.commandEventId, 1);
    const completed = await manager.completeTurn(first.delegation.childSessionId, 1, '4');
    assert.equal(completed.status, 'completed');

    const call2 = await dispatcher.dispatchNext(first.delegation.delegationId);
    assert.ok(call2);
    assert.equal(call2.call.delegationCallId, second.call.delegationCallId);
    assert.equal(call2.call.dispatch?.childTurnSeq, 2);
    assert.deepEqual(call2.workerCommands.map((command) => command.event.type), ['session.input']);
    assert.equal(call2.delegation.childSessionId, first.delegation.childSessionId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function createDelegationManager(storage: LocalFileStorage, lifecycle: SessionLifecycleManager): DelegationManager {
  const clock = { now: () => NOW };
  const raw = new StaticDelegateRegistry([DELEGATE]);
  const caller = agentSpec('caller', [DELEGATE_ID], []);
  const callee = agentSpec('callee', [], [DELEGATE_ID]);
  const admission = new DelegateAdmissionManager();
  return new DelegationManager('poc', storage, clock, new StaticResolvedDelegateRegistry({
    delegates: [DELEGATE],
    admissionManager: admission
  }), new StaticDelegateBindingIndex(raw, [caller, callee]), admission, new AgentSpecAdmissionManager(clock), lifecycle);
}

function parent(): SessionRecord {
  const clock = { now: () => NOW };
  return {
    sessionId: 'parent-1', tenantId: 'poc', owner: 'owner-1', resolvedAgentSpec: new AgentSpecAdmissionManager(clock).resolve(agentSpec('caller', [DELEGATE_ID], [])),
    status: 'running', currentWorkerId: 'worker-parent', sessionLeaseId: 'lease-parent', eventCursor: 1, nextTurnSeq: 2,
    workspaceRef: 'workspace-parent', lastEventUpdatedAt: NOW, createdAt: NOW, updatedAt: NOW
  };
}

function worker(): WorkerRecord {
  return {
    workerId: 'worker-callee', tenantId: 'poc', capacityScope: 'poc', labels: { agent: 'callee', storage: 'host-managed' }, storageClass: 'host-managed',
    capacity: 1, allocatable: 1, conditions: ['ready'], lifecycleState: 'active', heartbeatAt: NOW,
    expiresAt: '2026-07-14T00:10:00.000Z', currentSessionCount: 0, updatedAt: NOW
  };
}

function agentSpec(agentSpecId: string, asCaller: string[], asCallee: string[]): AgentSpec {
  return {
    agentSpecId, labels: {}, launch: { command: 'agent', args: [] }, instructions: 'Test agent instructions.', toolProfile: 'test-tools', delegateRefs: { asCaller, asCallee },
    workerSelector: { matchLabels: { agent: agentSpecId, storage: 'host-managed' } }, pausePolicy: 'stop-on-pause',
    recoveryPolicy: 'restart-with-context', idlePauseTimeoutMs: 120_000, version: 'test-v1'
  };
}