import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { InMemoryRuntimeTransportAdapter } from '../../src/central/adapters';
import { CentralService } from '../../src/central/central-service';
import { AgentSpecAdmissionManager } from '../../src/central/managers';
import { COPILOT_STORAGE_CLASS, COPILOT_WORKER_LABELS, POC_AGENT_SPEC } from '../support/config-fixtures';
import { LocalFileStorage } from '../../src/central/storage/local-file-storage';
import type { Clock, DelegationRecord, RuntimeEvent, SessionRecord, WorkerRecord } from '../../src/shared';

class FixedClock implements Clock {
  constructor(private currentTime: string) {}

  now(): string {
    return this.currentTime;
  }

  set(time: string): void {
    this.currentTime = time;
  }
}

test('scenario: queued session is assigned when matching worker becomes ready', async () => {
  await withRuntime(async ({ central, storage, transport, clock }) => {
    const created = await createQueuedSession(transport);
    const worker = await registerWorker(central);
    const workerCommands: RuntimeEvent[] = [];
    await transport.subscribe({ kind: 'worker-commands', workerId: worker.workerId }, async (envelope) => {
      workerCommands.push(envelope.event);
    });
    clock.set('2026-06-25T00:00:10.000Z');

    await publishReadyHeartbeat(transport, worker.workerId);
    await central.reconcileSessionsForTenant('poc');

    const session = await storage.readSession(created.sessionId!);
    assert.equal(session?.status, 'starting');
    assert.equal(session?.currentWorkerId, worker.workerId);
    assert.equal(typeof session?.sessionLeaseId, 'string');
    assert.deepEqual(workerCommands.map((event) => event.type), ['session.assign']);
    assert.equal(workerCommands[0].sessionId, created.sessionId);
  });
});

test('scenario: running status is not overwritten by a concurrent command acknowledgement', async () => {
  await withRuntime(async ({ central, storage, transport, clock }) => {
    const created = await createQueuedSession(transport);
    const worker = await registerWorker(central);
    clock.set('2026-06-25T00:00:10.000Z');
    await publishReadyHeartbeat(transport, worker.workerId);
    await central.reconcileSessionsForTenant('poc');
    const starting = await storage.readSession(created.sessionId!);
    assert.equal(starting?.status, 'starting');
    assert.ok(starting?.sessionLeaseId);

    await Promise.all([
      transport.publish({ kind: 'tenant-inbox' }, {
        eventId: 'event-session-running',
        sessionId: starting.sessionId,
        workerId: worker.workerId,
        sessionLeaseId: starting.sessionLeaseId,
        sequence: 0,
        type: 'status.changed',
        timestamp: clock.now(),
        actor: 'sidecar',
        payload: { status: 'running' }
      }),
      transport.publish({ kind: 'tenant-inbox' }, {
        eventId: 'event-command-accepted',
        sessionId: starting.sessionId,
        workerId: worker.workerId,
        sessionLeaseId: starting.sessionLeaseId,
        turnSeq: 1,
        sequence: 0,
        type: 'worker.command.accepted',
        timestamp: clock.now(),
        actor: 'sidecar',
        payload: { commandEventId: 'event-session-assign', turnSeq: 1 }
      })
    ]);

    const running = await storage.readSession(starting.sessionId);
    assert.equal(running?.status, 'running');
    assert.equal(running?.eventCursor, 3);
  });
});

test('scenario: idle queued session pauses and is not auto-assigned', async () => {
  await withRuntime(async ({ central, storage, transport, clock }) => {
    const created = await createQueuedSession(transport);
    const worker = await registerWorker(central);
    const workerCommands: RuntimeEvent[] = [];
    await transport.subscribe({ kind: 'worker-commands', workerId: worker.workerId }, async (envelope) => {
      workerCommands.push(envelope.event);
    });
    clock.set('2026-06-25T00:02:01.000Z');

    await publishReadyHeartbeat(transport, worker.workerId);
    await central.reconcileSessionsForTenant('poc');

    const session = await storage.readSession(created.sessionId!);
    assert.equal(session?.status, 'paused');
    assert.equal(session?.currentWorkerId, undefined);
    assert.equal(session?.sessionLeaseId, undefined);
    assert.deepEqual(workerCommands, []);
    const events = await storage.readEvents(created.sessionId!, 0);
    assert.deepEqual(events.map((event) => event.type), ['session.created', 'session.paused']);
    assert.deepEqual(events[1].payload, { reason: 'idle_timeout' });
  });
});

test('scenario: idle running session pauses and releases worker lease', async () => {
  await withRuntime(async ({ central, storage, transport, clock }) => {
    const worker = await registerWorker(central);
    await writeActiveWorker(storage, worker.workerId, clock.now());
    const session = await writeRunningSession(storage, worker.workerId, 'lease-running', clock.now());
    const workerCommands: RuntimeEvent[] = [];
    await transport.subscribe({ kind: 'worker-commands', workerId: worker.workerId }, async (envelope) => {
      workerCommands.push(envelope.event);
    });
    clock.set('2026-06-25T00:02:01.000Z');
    await writeActiveWorker(storage, worker.workerId, clock.now(), { allocatable: 0, currentSessionCount: 1, conditions: ['busy'] });

    await central.reconcileSessionsForTenant('poc');

    const pausing = await storage.readSession(session.sessionId);
    assert.equal(pausing?.status, 'pausing');
    assert.deepEqual(workerCommands.map((event) => event.type), ['session.pause.requested']);
    assert.equal(workerCommands[0].sessionLeaseId, 'lease-running');

    await transport.publish({ kind: 'tenant-inbox' }, {
      eventId: 'event-session-paused',
      sessionId: session.sessionId,
      workerId: worker.workerId,
      sessionLeaseId: 'lease-running',
      sequence: 0,
      type: 'session.paused',
      timestamp: clock.now(),
      actor: 'sidecar',
      payload: { reason: 'idle_timeout' }
    });

    const paused = await storage.readSession(session.sessionId);
    assert.equal(paused?.status, 'paused');
    assert.equal(paused?.currentWorkerId, undefined);
    assert.equal(paused?.sessionLeaseId, undefined);
    const releasedWorker = await storage.readWorker(worker.workerId);
    assert.equal(releasedWorker?.allocatable, 1);
    assert.deepEqual(releasedWorker?.conditions, ['ready']);
  });
});

test('scenario: pausing session with a live Worker replays its durable pause intent', async () => {
  await withRuntime(async ({ central, storage, transport, clock }) => {
    const worker = await registerWorker(central);
    await writeActiveWorker(storage, worker.workerId, clock.now(), { allocatable: 0, currentSessionCount: 1, conditions: ['busy'] });
    const session = await writePausingSession(storage, worker.workerId, 'lease-pausing', clock.now());
    const workerCommands: RuntimeEvent[] = [];
    await transport.subscribe({ kind: 'worker-commands', workerId: worker.workerId }, async (envelope) => {
      workerCommands.push(envelope.event);
    });

    await central.reconcileSessionsForTenant('poc');

    assert.equal((await storage.readSession(session.sessionId))?.status, 'pausing');
    assert.equal(workerCommands.length, 1);
    assert.equal(workerCommands[0].type, 'session.pause.requested');
    assert.equal(workerCommands[0].sequence, 2);
    assert.deepEqual((workerCommands[0].payload as { capture?: unknown }).capture, {
      snapshotId: 'event-pause-requested',
      storageClass: COPILOT_STORAGE_CLASS,
      handle: `${session.sessionId}/event-pause-requested`
    });
    assert.deepEqual((await storage.readEvents(session.sessionId, 0)).map((event) => event.type), ['session.created', 'session.pause.requested']);
  });
});

test('scenario: pausing session whose Worker is terminal becomes failed', async () => {
  await withRuntime(async ({ central, storage, clock }) => {
    const worker = await registerWorker(central);
    await writeActiveWorker(storage, worker.workerId, clock.now(), {
      allocatable: 0,
      currentSessionCount: 1,
      conditions: ['disconnected'],
      lifecycleState: 'expired',
      terminalReason: 'worker_keepalive_expired'
    });
    const session = await writePausingSession(storage, worker.workerId, 'lease-terminal-pausing', clock.now());

    await central.reconcileSessionsForTenant('poc');

    const failed = await storage.readSession(session.sessionId);
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.currentWorkerId, undefined);
    assert.equal(failed?.sessionLeaseId, undefined);
    assert.equal(failed?.lifecycleReason, 'worker_lost');
    assert.deepEqual((await storage.readEvents(session.sessionId, 0)).map((event) => event.type), [
      'session.created',
      'session.pause.requested',
      'session.lease.lost'
    ]);
  });
});

test('scenario: running session awaiting interaction does not idle pause', async () => {
  await withRuntime(async ({ central, storage, transport, clock }) => {
    const worker = await registerWorker(central);
    await writeActiveWorker(storage, worker.workerId, clock.now());
    const session = await writeRunningSession(storage, worker.workerId, 'lease-awaiting-interaction', clock.now());
    await storage.createInteraction({
      interactionId: 'interaction-approval',
      tenantId: 'poc',
      kind: 'approval',
      request: { action: 'run-shell' },
      ownerSessionId: session.sessionId,
      ownerTurnSeq: 1,
      adapterRequestId: 'adapter-approval',
      requestLeaseId: 'lease-awaiting-interaction',
      views: [{
        sessionId: session.sessionId,
        turnSeq: 1,
        role: 'owner',
        requestedEventId: 'interaction-requested-event',
        requestedProjected: true,
        respondedProjected: false,
        interruptedProjected: false
      }],
      state: 'open',
      delivery: { state: 'not_ready' },
      revision: 1,
      createdAt: clock.now(),
      updatedAt: clock.now()
    });
    const workerCommands: RuntimeEvent[] = [];
    await transport.subscribe({ kind: 'worker-commands', workerId: worker.workerId }, async (envelope) => {
      workerCommands.push(envelope.event);
    });
    clock.set('2026-06-25T00:02:01.000Z');
    await writeActiveWorker(storage, worker.workerId, clock.now(), { allocatable: 0, currentSessionCount: 1, conditions: ['busy'] });

    await central.reconcileSessionsForTenant('poc');

    const running = await storage.readSession(session.sessionId);
    assert.equal(running?.status, 'running');
    assert.equal(running?.currentWorkerId, worker.workerId);
    assert.equal(running?.sessionLeaseId, 'lease-awaiting-interaction');
    assert.deepEqual(workerCommands, []);
  });
});

test('scenario: Parent and queued Child with active delegation do not idle pause while waiting for capacity', async () => {
  await withRuntime(async ({ central, storage, clock }) => {
    const worker = await registerWorker(central);
    const parent = await writeRunningSession(storage, worker.workerId, 'lease-parent-delegation', clock.now());
    const child = await writeQueuedSession(storage, 'session-delegated-child', clock.now());
    child.delegationBinding = {
      delegationId: 'delegation-active',
      parentSessionId: parent.sessionId,
      delegateId: 'local-diagnostic'
    };
    await storage.writeSession(child);
    await storage.createDelegation(activeDelegation(parent, child, clock.now()));
    clock.set('2026-06-25T00:02:01.000Z');
    await writeActiveWorker(storage, worker.workerId, clock.now(), { allocatable: 0, currentSessionCount: 1, conditions: ['busy'] });

    await central.reconcileSessionsForTenant('poc');

    assert.equal((await storage.readSession(parent.sessionId))?.status, 'running');
    assert.equal((await storage.readSession(child.sessionId))?.status, 'queued');
    assert.deepEqual((await storage.readEvents(parent.sessionId, 0)).map((event) => event.type), ['session.created']);
    assert.deepEqual((await storage.readEvents(child.sessionId, 0)).map((event) => event.type), ['session.created']);
  });
});

test('scenario: client pause releases worker and assigns next queued session', async () => {
  await withRuntime(async ({ central, storage, transport, clock }) => {
    const worker = await registerWorker(central);
    await writeActiveWorker(storage, worker.workerId, clock.now(), { allocatable: 0, currentSessionCount: 1, conditions: ['busy'] });
    const running = await writeRunningSession(storage, worker.workerId, 'lease-running', clock.now());
    const queued = await writeQueuedSession(storage, 'session-queued-next', clock.now());
    const workerCommands: RuntimeEvent[] = [];
    await transport.subscribe({ kind: 'worker-commands', workerId: worker.workerId }, async (envelope) => {
      workerCommands.push(envelope.event);
    });

    await transport.publish({ kind: 'tenant-inbox' }, {
      eventId: 'event-client-pause-request',
      sessionId: running.sessionId,
      ackId: 'ack-pause',
      sequence: 0,
      type: 'session.pause.requested',
      timestamp: clock.now(),
      actor: 'client',
      payload: {}
    }, demoContext());

    const pausing = await storage.readSession(running.sessionId);
    assert.equal(pausing?.status, 'pausing');
    assert.deepEqual(workerCommands.map((event) => event.type), ['session.pause.requested']);
    assert.equal(workerCommands[0].sessionId, running.sessionId);

    clock.set('2026-06-25T00:00:05.000Z');
    await transport.publish({ kind: 'tenant-inbox' }, {
      eventId: 'event-client-paused',
      sessionId: running.sessionId,
      workerId: worker.workerId,
      sessionLeaseId: 'lease-running',
      sequence: 0,
      type: 'session.paused',
      timestamp: clock.now(),
      actor: 'sidecar',
      payload: { reason: 'client_requested' }
    });
    await central.reconcileSessionsForTenant('poc');

    const paused = await storage.readSession(running.sessionId);
    const assigned = await storage.readSession(queued.sessionId);
    assert.equal(paused?.status, 'paused');
    assert.equal(paused?.currentWorkerId, undefined);
    assert.equal(paused?.sessionLeaseId, undefined);
    assert.equal(assigned?.status, 'starting');
    assert.equal(assigned?.currentWorkerId, worker.workerId);
    assert.deepEqual(workerCommands.map((event) => event.type), ['session.pause.requested', 'session.assign']);
    assert.equal(workerCommands[1].sessionId, queued.sessionId);
  });
});

test('scenario: opening a session does not refresh activity or resume it', async () => {
  await withRuntime(async ({ storage, transport, clock }) => {
    const session = await writePausedSession(storage, '2026-06-25T00:00:00.000Z');
    const acknowledgements: RuntimeEvent[] = [];
    await transport.subscribe({ kind: 'client-private-inbox', clientConnectionId: 'demo-connection' }, async (envelope) => {
      acknowledgements.push(envelope.event);
    });
    clock.set('2026-06-25T00:05:00.000Z');

    await transport.publish({ kind: 'tenant-inbox' }, {
      eventId: 'event-history-request',
      sessionId: session.sessionId,
      ackId: 'ack-history',
      sequence: 0,
      type: 'session.events.requested',
      timestamp: clock.now(),
      actor: 'client',
      payload: { afterSequence: 0 }
    }, demoContext());

    const replayed = acknowledgements.find((event) => event.ackId === 'ack-history');
    assert.equal(replayed?.type, 'session.events.replayed');
    const unchanged = await storage.readSession(session.sessionId);
    assert.equal(unchanged?.status, 'paused');
    assert.equal(unchanged?.lastEventUpdatedAt, '2026-06-25T00:00:00.000Z');
    assert.equal(unchanged?.currentWorkerId, undefined);
    assert.equal(unchanged?.sessionLeaseId, undefined);
  });
});

test('scenario: resume moves paused session back to queued before assignment', async () => {
  await withRuntime(async ({ central, storage, transport, clock }) => {
    const paused = await writePausedSession(storage, clock.now());
    const worker = await registerWorker(central);
    clock.set('2026-06-25T00:05:00.000Z');
    await writeActiveWorker(storage, worker.workerId, clock.now());
    const workerCommands: RuntimeEvent[] = [];
    await transport.subscribe({ kind: 'worker-commands', workerId: worker.workerId }, async (envelope) => {
      workerCommands.push(envelope.event);
    });

    await transport.publish({ kind: 'tenant-inbox' }, {
      eventId: 'event-resume-request',
      sessionId: paused.sessionId,
      ackId: 'ack-resume',
      sequence: 0,
      type: 'session.resume.requested',
      timestamp: clock.now(),
      actor: 'client',
      payload: {}
    }, demoContext());

    const resumed = await storage.readSession(paused.sessionId);
    assert.equal(resumed?.status, 'starting');
    assert.equal(resumed?.lastEventUpdatedAt, '2026-06-25T00:05:00.000Z');
    assert.equal(resumed?.currentWorkerId, worker.workerId);
    assert.equal(typeof resumed?.sessionLeaseId, 'string');
    assert.deepEqual(workerCommands.map((event) => event.type), ['session.assign']);
    const events = await storage.readEvents(paused.sessionId, 0);
    assert.deepEqual(events.map((event) => event.type), ['session.created', 'session.paused', 'session.resume.requested']);
  });
});

async function withRuntime(testBody: (input: { root: string; storage: LocalFileStorage; transport: InMemoryRuntimeTransportAdapter; central: CentralService; clock: FixedClock }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'ars-session-reconciler-'));
  try {
    const clock = new FixedClock('2026-06-25T00:00:00.000Z');
    const transport = new InMemoryRuntimeTransportAdapter();
    const storage = new LocalFileStorage(root);
    const central = new CentralService({ storage, eventTransport: transport, connectionIssuer: transport, clock });
    await central.start();
    try {
      await testBody({ root, storage, transport, central, clock });
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
      input: { message: 'start' },
      workspace: { source: 'empty' }
    }
  }, demoContext());
  const created = acknowledgements.find((event) => event.ackId === 'ack-create-session');
  assert.equal(created?.type, 'session.created.ack');
  return created!;
}

async function registerWorker(central: CentralService): Promise<WorkerRecord> {
  const grant = await central.negotiateSidecarConnectionForTenant('poc', {
    principal: { principalId: 'sidecar', type: 'service' },
    connectionId: 'sidecar-connection'
  }, {
    labels: COPILOT_WORKER_LABELS,
    storageClass: COPILOT_STORAGE_CLASS,
    capacity: 1,
    allocatable: 1
  });
  assert.ok(grant.worker);
  return grant.worker;
}

async function publishReadyHeartbeat(transport: InMemoryRuntimeTransportAdapter, workerId: string): Promise<void> {
  await transport.publish({ kind: 'tenant-inbox' }, {
    eventId: `event-heartbeat-${workerId}`,
    workerId,
    sequence: 0,
    type: 'worker.heartbeat',
    timestamp: '2026-06-25T00:00:10.000Z',
    actor: 'sidecar',
    payload: {
      workerId,
      capacity: 1,
      allocatable: 1,
      conditions: ['ready']
    }
  });
}

async function writeActiveWorker(storage: LocalFileStorage, workerId: string, now: string, overrides?: Partial<WorkerRecord>): Promise<void> {
  await storage.writeWorker({
    workerId,
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
  });
}

async function writeRunningSession(storage: LocalFileStorage, workerId: string, sessionLeaseId: string, now: string): Promise<SessionRecord> {
  const session: SessionRecord = {
    sessionId: 'session-running',
    tenantId: 'poc',
    owner: 'demo-user',
    resolvedAgentSpec: new AgentSpecAdmissionManager({ now: () => now }).resolve(POC_AGENT_SPEC),
    status: 'running',
    currentWorkerId: workerId,
    sessionLeaseId,
    storageClass: COPILOT_STORAGE_CLASS,
    eventCursor: 1,
    nextTurnSeq: 2,
    workspaceRef: 'workspace-volume',
    lastEventUpdatedAt: now,
    createdAt: now,
    updatedAt: now
  };
  await storage.writeSession(session);
  await storage.appendEvent({
    eventId: 'event-running-created',
    sessionId: session.sessionId,
    sequence: 1,
    type: 'session.created',
    timestamp: now,
    actor: 'central',
    payload: { status: 'queued' }
  });
  return session;
}

async function writePausingSession(storage: LocalFileStorage, workerId: string, sessionLeaseId: string, now: string): Promise<SessionRecord> {
  const running = await writeRunningSession(storage, workerId, sessionLeaseId, now);
  const session: SessionRecord = {
    ...running,
    status: 'pausing',
    eventCursor: 2,
    lifecycleReason: 'client_requested'
  };
  await storage.writeSession(session);
  await storage.appendEvent({
    eventId: 'event-pause-requested',
    sessionId: session.sessionId,
    workerId,
    sessionLeaseId,
    sequence: 2,
    type: 'session.pause.requested',
    timestamp: now,
    actor: 'client',
    payload: { reason: 'client_requested' }
  });
  return session;
}

async function writePausedSession(storage: LocalFileStorage, lastEventUpdatedAt: string): Promise<SessionRecord> {
  const session: SessionRecord = {
    sessionId: 'session-paused',
    tenantId: 'poc',
    owner: 'demo-user',
    resolvedAgentSpec: new AgentSpecAdmissionManager({ now: () => lastEventUpdatedAt }).resolve(POC_AGENT_SPEC),
    status: 'paused',
    eventCursor: 2,
    nextTurnSeq: 2,
    workspaceRef: 'workspace-volume',
    lastEventUpdatedAt,
    createdAt: lastEventUpdatedAt,
    updatedAt: lastEventUpdatedAt
  };
  await storage.writeSession(session);
  await storage.appendEvent({
    eventId: 'event-paused-created',
    sessionId: session.sessionId,
    sequence: 1,
    type: 'session.created',
    timestamp: lastEventUpdatedAt,
    actor: 'central',
    payload: { status: 'queued' }
  });
  await storage.appendEvent({
    eventId: 'event-paused-paused',
    sessionId: session.sessionId,
    sequence: 2,
    type: 'session.paused',
    timestamp: lastEventUpdatedAt,
    actor: 'central',
    payload: { reason: 'idle_timeout' }
  });
  return session;
}

async function writeQueuedSession(storage: LocalFileStorage, sessionId: string, now: string): Promise<SessionRecord> {
  const session: SessionRecord = {
    sessionId,
    tenantId: 'poc',
    owner: 'demo-user',
    resolvedAgentSpec: new AgentSpecAdmissionManager({ now: () => now }).resolve(POC_AGENT_SPEC),
    status: 'queued',
    eventCursor: 1,
    nextTurnSeq: 2,
    workspaceRef: 'workspace-volume',
    lastEventUpdatedAt: now,
    createdAt: now,
    updatedAt: now
  };
  await storage.writeSession(session);
  await storage.appendEvent({
    eventId: `event-${sessionId}-created`,
    sessionId,
    sequence: 1,
    type: 'session.created',
    timestamp: now,
    actor: 'central',
    payload: { status: 'queued' }
  });
  return session;
}

function activeDelegation(parent: SessionRecord, child: SessionRecord, now: string): DelegationRecord {
  return {
    delegationId: 'delegation-active',
    tenantId: 'poc',
    parentSessionId: parent.sessionId,
    childSessionId: child.sessionId,
    resolvedDelegate: {
      id: 'local-diagnostic',
      toolName: 'inspect_local_system',
      description: 'Collect local diagnostic evidence.',
      digest: 'delegate-digest',
      maxInputBytes: 8192,
      maxResultBytes: 32768,
      deadlineMs: 600000,
      maxQueuedCalls: 1,
      targetPolicy: 'pool'
    },
    resolvedCalleeAgentSpec: child.resolvedAgentSpec,
    status: 'open',
    activeCallId: 'delegation-call-active',
    nextCallSeq: 2,
    calls: [{
      delegationCallId: 'delegation-call-active',
      delegationId: 'delegation-active',
      callSeq: 1,
      callerTurnSeq: 1,
      callerToolRequestId: 'tool-request-active',
      input: 'Collect evidence.',
      inputHash: 'input-digest',
      status: 'active',
      dispatch: {
        childTurnSeq: 1,
        inputEventId: `event-${child.sessionId}-created`,
        commandEventId: 'child-command-active',
        commandState: 'pending'
      },
      deadlineAt: '2026-06-25T00:10:00.000Z',
      createdAt: now,
      updatedAt: now
    }],
    revision: 1,
    createdAt: now,
    updatedAt: now
  };
}

function demoContext() {
  return {
    principal: { principalId: 'demo-user', type: 'user' as const },
    connectionId: 'demo-connection'
  };
}
