import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AgentSpec, Delegate, RuntimeEvent, SessionRecord } from '../../src/shared';
import { AgentSpecAdmissionManager, DelegateAdmissionManager, DelegationManager, EventLogManager, InteractionManager, SessionAssignmentManager, SessionLeaseManager, SessionLifecycleManager, SessionLifecycleReconciler, SessionManager, SessionPauseManager, SessionStartManager, WorkerSelector } from '../../src/central/managers';
import { InMemoryRuntimeTransportAdapter } from '../../src/central/adapters';
import { StaticDelegateBindingIndex, StaticDelegateRegistry, StaticResolvedDelegateRegistry } from '../../src/central/registries/delegate-registry';
import { StaticAgentSpecRegistry } from '../../src/central/registries/agent-spec-registry';
import { LocalFileStorage } from '../../src/central/storage/local-file-storage';
import { SnapshotManager } from '../../src/central/persistence';

const NOW = '2026-07-14T00:00:00.000Z';
const DELEGATE_ID = 'copilot-foundry';
const DELEGATE: Delegate = { id: DELEGATE_ID, toolName: 'copilot_foundry', description: 'Ask copilot-foundry.', maxInputBytes: 2048, maxResultBytes: 8192, deadlineMs: 120_000, maxQueuedCalls: 2 };

test('scenario: same Parent and Delegate reuse one durable Child while another Parent is isolated', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ars-delegation-manager-'));
  try {
    const storage = new LocalFileStorage(root);
    const manager = createManager(storage);
    const parentA = parent('parent-a');
    const call1 = await manager.startCall({ parentSession: parentA, callerTurnSeq: 1, callerToolRequestId: 'tool-1', delegateId: DELEGATE_ID, input: 'When?' });
    const retry = await manager.startCall({ parentSession: parentA, callerTurnSeq: 1, callerToolRequestId: 'tool-1', delegateId: DELEGATE_ID, input: 'When?' });
    const call2 = await manager.startCall({ parentSession: parentA, callerTurnSeq: 2, callerToolRequestId: 'tool-2', delegateId: DELEGATE_ID, input: 'Why?' });
    const otherParent = await manager.startCall({ parentSession: parent('parent-b'), callerTurnSeq: 1, callerToolRequestId: 'tool-1', delegateId: DELEGATE_ID, input: 'When?' });

    assert.equal(call1.delegation.status, 'open');
    assert.equal(retry.call.delegationCallId, call1.call.delegationCallId);
    assert.equal(call2.delegation.delegationId, call1.delegation.delegationId);
    assert.equal(call2.delegation.childSessionId, call1.delegation.childSessionId);
    assert.equal(call2.call.callSeq, 2);
    assert.notEqual(otherParent.delegation.delegationId, call1.delegation.delegationId);
    assert.notEqual(otherParent.delegation.childSessionId, call1.delegation.childSessionId);

    const child = await storage.readSession(call1.delegation.childSessionId);
    assert.deepEqual(child?.delegationBinding, {
      delegationId: call1.delegation.delegationId,
      parentSessionId: parentA.sessionId,
      delegateId: DELEGATE_ID
    });

    await storage.writeSession(parentA);
    const sessionManager = createSessionManager(storage);
    const listed = await sessionManager.listSessions(ownerContext(), 'ack-list');
    const listedSessions = (listed.responseEvent.payload as { sessions: Array<SessionRecord & { parentSessionId?: string }> }).sessions;
    assert.deepEqual(listedSessions.map((session) => session.sessionId).sort(), [
      call1.delegation.childSessionId,
      otherParent.delegation.childSessionId,
      parentA.sessionId
    ].sort());
    assert.equal(listedSessions.find((session) => session.sessionId === call1.delegation.childSessionId)?.parentSessionId, parentA.sessionId);
    await sessionManager.readSessionEvents(ownerContext(), call1.delegation.childSessionId, 'ack-history', 0);
    const childForInput = await storage.readSession(call1.delegation.childSessionId);
    assert.ok(childForInput);
    await storage.writeSession({
      ...childForInput,
      status: 'running',
      currentWorkerId: 'worker-child-direct',
      sessionLeaseId: 'lease-child-direct'
    });
    const accepted = await sessionManager.acceptInput(ownerContext(), childForInput.sessionId, 'ack-input', { input: { message: 'direct child message' } });
    assert.ok(accepted.workerCommand);
    assert.equal(accepted.workerCommand.workerId, 'worker-child-direct');
    assert.equal(accepted.workerCommand.event.sessionId, childForInput.sessionId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scenario: delegation rejects invalid input, unauthorized caller, and delegated recursion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ars-delegation-validation-'));
  try {
    const manager = createManager(new LocalFileStorage(root));
    await assert.rejects(
      manager.startCall({ parentSession: parent('parent-a'), callerTurnSeq: 1, callerToolRequestId: 'tool-1', delegateId: DELEGATE_ID, input: '' }),
      /must not be empty/
    );
    await assert.rejects(
      manager.startCall({ parentSession: parent('parent-b', []), callerTurnSeq: 1, callerToolRequestId: 'tool-1', delegateId: DELEGATE_ID, input: 'When?' }),
      /cannot call Delegate/
    );
    const delegated = parent('child-a');
    delegated.delegationBinding = { delegationId: 'd', parentSessionId: 'p', delegateId: DELEGATE_ID };
    await assert.rejects(
      manager.startCall({ parentSession: delegated, callerTurnSeq: 1, callerToolRequestId: 'tool-1', delegateId: DELEGATE_ID, input: 'When?' }),
      /cannot start delegation/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scenario: concurrent first calls share one relation and one Child Session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ars-delegation-concurrent-'));
  try {
    const storage = new LocalFileStorage(root);
    const manager = createManager(storage);
    const parentA = parent('parent-a');
    const [left, right] = await Promise.all([
      manager.startCall({ parentSession: parentA, callerTurnSeq: 1, callerToolRequestId: 'tool-left', delegateId: DELEGATE_ID, input: 'When?' }),
      manager.startCall({ parentSession: parentA, callerTurnSeq: 1, callerToolRequestId: 'tool-right', delegateId: DELEGATE_ID, input: 'Why?' })
    ]);

    assert.equal(left.delegation.delegationId, right.delegation.delegationId);
    assert.equal(left.delegation.childSessionId, right.delegation.childSessionId);
    const persisted = await storage.readDelegation(left.delegation.delegationId);
    assert.equal(persisted?.status, 'open');
    assert.equal(persisted?.calls.length, 2);
    assert.deepEqual(persisted?.calls.map((call) => call.callSeq).sort(), [1, 2]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scenario: Child approval resolves both views and a stale Parent response is idempotent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ars-delegated-interaction-'));
  try {
    const storage = new LocalFileStorage(root);
    const clock = { now: () => NOW };
    const transport = new InMemoryRuntimeTransportAdapter();
    const parentSession = parent('parent-a');
    const childSession: SessionRecord = {
      ...parent('child-a', []),
      currentWorkerId: 'worker-child',
      sessionLeaseId: 'lease-child',
      delegationBinding: { delegationId: 'delegation-a', parentSessionId: parentSession.sessionId, delegateId: DELEGATE_ID }
    };
    await storage.writeSession(parentSession);
    await storage.writeSession(childSession);
    await storage.createDelegation({
      delegationId: 'delegation-a',
      tenantId: 'poc',
      parentSessionId: parentSession.sessionId,
      childSessionId: childSession.sessionId,
      resolvedDelegate: new DelegateAdmissionManager().resolve(DELEGATE),
      resolvedCalleeAgentSpec: childSession.resolvedAgentSpec,
      status: 'open',
      activeCallId: 'call-a',
      nextCallSeq: 2,
      calls: [{
        delegationCallId: 'call-a',
        delegationId: 'delegation-a',
        callSeq: 1,
        callerTurnSeq: 2,
        callerToolRequestId: 'tool-a',
        input: 'diagnose',
        inputHash: 'hash-a',
        status: 'active',
        dispatch: { childTurnSeq: 1, inputEventId: 'input-a', commandEventId: 'command-a', commandState: 'accepted' },
        deadlineAt: NOW,
        createdAt: NOW,
        updatedAt: NOW
      }],
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW
    });
    const lifecycle = new SessionLifecycleManager(storage, clock);
    const eventLog = new EventLogManager(storage, clock);
    const interactionManager = new InteractionManager(
      'poc',
      storage,
      clock,
      eventLog,
      lifecycle,
      new SessionLeaseManager(storage),
      transport
    );
    const parentEvents: RuntimeEvent[] = [];
    const childEvents: RuntimeEvent[] = [];
    const workerCommands: RuntimeEvent[] = [];
    await transport.subscribe({ kind: 'session-events', sessionId: parentSession.sessionId }, async ({ event }) => { parentEvents.push(event); });
    await transport.subscribe({ kind: 'session-events', sessionId: childSession.sessionId }, async ({ event }) => { childEvents.push(event); });
    await transport.subscribe({ kind: 'worker-commands', workerId: 'worker-child' }, async ({ event }) => { workerCommands.push(event); });

    const interaction = await interactionManager.admitAgentRequest({
      eventId: 'agent-request-a',
      sessionId: childSession.sessionId,
      workerId: 'worker-child',
      sessionLeaseId: 'lease-child',
      turnSeq: 1,
      sequence: 0,
      type: 'agent.interaction.requested',
      timestamp: NOW,
      actor: 'sidecar',
      payload: {}
    }, {
      adapterRequestId: 'approval-child',
      kind: 'approval',
      request: { action: 'run-shell' }
    });
    assert.equal(interaction.views.length, 2);
    assert.equal((parentEvents[0].payload as { interactionId: string }).interactionId, interaction.interactionId);
    assert.equal((childEvents[0].payload as { interactionId: string }).interactionId, interaction.interactionId);

    const resolved = await interactionManager.resolve(
      { principal: { principalId: parentSession.owner, type: 'user' }, connectionId: 'client-a' },
      childSession.sessionId,
      { interactionId: interaction.interactionId, decision: 'approved', scope: 'once' }
    );
    const stale = await interactionManager.resolve(
      { principal: { principalId: parentSession.owner, type: 'user' }, connectionId: 'client-b' },
      parentSession.sessionId,
      { interactionId: interaction.interactionId, decision: 'denied', scope: 'once' }
    );

    assert.equal(resolved.status, 'resolved');
    assert.equal(stale.status, 'already_resolved');
    assert.equal(parentEvents.filter((event) => event.type === 'interaction.responded').length, 1);
    assert.equal(childEvents.filter((event) => event.type === 'interaction.responded').length, 1);
    assert.equal(workerCommands.length, 1);
    assert.equal(workerCommands[0].sessionId, childSession.sessionId);
    assert.equal((workerCommands[0].payload as { adapterRequestId: string }).adapterRequestId, 'approval-child');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scenario: terminal Parent fails its active Call without losing the Child identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ars-parent-terminal-'));
  try {
    const storage = new LocalFileStorage(root);
    const manager = createManager(storage);
    const started = await manager.startCall({
      parentSession: parent('parent-terminal'),
      callerTurnSeq: 2,
      callerToolRequestId: 'tool-terminal',
      delegateId: DELEGATE_ID,
      input: 'work'
    });

    const failed = await manager.failForParentTerminal(started.delegation.delegationId);
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.closeReason, 'parent_terminal');
    assert.equal(failed?.calls[0].status, 'failed');
    assert.equal(failed?.calls[0].failure?.code, 'parent_terminal');
    assert.equal(failed?.childSessionId, started.delegation.childSessionId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scenario: Session create scheduling does not wait for capacity reconciliation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ars-session-start-nonblocking-'));
  try {
    let reconcileCalls = 0;
    const neverCompletes = new Promise<void>(() => undefined);
    const reconciler = {
      reconcile(): Promise<void> {
        reconcileCalls += 1;
        return neverCompletes;
      }
    } as SessionLifecycleReconciler;
    const manager = createSessionManager(new LocalFileStorage(root), reconciler);

    const result = manager.reconcileStartedSession(true);

    assert.equal(result, undefined);
    assert.equal(reconcileCalls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function createManager(storage: LocalFileStorage): DelegationManager {
  const clock = { now: () => NOW };
  const rawRegistry = new StaticDelegateRegistry([DELEGATE]);
  const caller = agentSpec('caller', [DELEGATE_ID], []);
  const callee = agentSpec('callee', [], [DELEGATE_ID]);
  const admission = new DelegateAdmissionManager();
  const resolvedRegistry = new StaticResolvedDelegateRegistry({
    delegates: [DELEGATE],
    admissionManager: admission
  });
  return new DelegationManager(
    'poc',
    storage,
    clock,
    resolvedRegistry,
    new StaticDelegateBindingIndex(rawRegistry, [caller, callee]),
    admission,
    new AgentSpecAdmissionManager(clock),
    new SessionLifecycleManager(storage, clock)
  );
}

function parent(sessionId: string, asCaller: string[] = [DELEGATE_ID]): SessionRecord {
  return {
    sessionId,
    tenantId: 'poc',
    owner: 'owner-1',
    resolvedAgentSpec: new AgentSpecAdmissionManager({ now: () => NOW }).resolve(agentSpec('caller', asCaller, [])),
    status: 'running',
    currentWorkerId: `worker-${sessionId}`,
    sessionLeaseId: `lease-${sessionId}`,
    eventCursor: 1,
    nextTurnSeq: 2,
    workspaceRef: `workspace-${sessionId}`,
    lastEventUpdatedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW
  };
}

function agentSpec(agentSpecId: string, asCaller: string[], asCallee: string[]): AgentSpec {
  return {
    agentSpecId,
    labels: {},
    launch: { command: 'agent', args: [] },
    instructions: 'Test agent instructions.',
    toolProfile: 'test-tools',
    delegateRefs: { asCaller, asCallee },
    workerSelector: { matchLabels: { agent: agentSpecId } },
    pausePolicy: 'stop-on-pause',
    recoveryPolicy: 'restart-with-context',
    idlePauseTimeoutMs: 120_000,
    version: 'test-v1'
  };
}

function createSessionManager(storage: LocalFileStorage, reconciler?: SessionLifecycleReconciler): SessionManager {
  const clock = { now: () => NOW };
  const lifecycle = new SessionLifecycleManager(storage, clock);
  const eventLog = new EventLogManager(storage, clock);
  const snapshot = new SnapshotManager(storage, clock);
  const assignment = new SessionAssignmentManager(storage, clock, new WorkerSelector(() => Date.parse(NOW)), new SessionLeaseManager(storage), snapshot);
  return new SessionManager(
    { tenantId: 'poc', storageRoot: '', webPubSubHub: 'test' },
    storage,
    new StaticAgentSpecRegistry([]),
    new AgentSpecAdmissionManager(clock),
    lifecycle,
    eventLog,
    new SessionStartManager(lifecycle, eventLog, assignment),
    new SessionPauseManager(storage, lifecycle, eventLog, snapshot),
    reconciler
  );
}

function ownerContext() {
  return { principal: { principalId: 'owner-1', type: 'user' as const }, connectionId: 'client-1' };
}