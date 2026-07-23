import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { InMemoryRuntimeTransportAdapter } from '../../src/central/adapters';
import { CentralService } from '../../src/central/central-service';
import { AgentSpecAdmissionManager, CasePairingManager } from '../../src/central/managers';
import { LocalFileStorage } from '../../src/central/storage/local-file-storage';
import type { RuntimeEvent, SessionRecord } from '../../src/shared';
import { COPILOT_STORAGE_CLASS, COPILOT_WORKER_LABELS, POC_AGENT_SPEC } from '../support/config-fixtures';

test('scenario: create session request creates durable session truth', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ars-slice1-'));
  try {
    const transport = new InMemoryRuntimeTransportAdapter();
    const storage = new LocalFileStorage(root);
    const central = new CentralService({ storage, eventTransport: transport, connectionIssuer: transport });
    await central.start();

    const request: RuntimeEvent = {
      eventId: 'evt-create-request',
      ackId: 'ack-create-1',
      sequence: 0,
      type: 'session.create.requested',
      timestamp: new Date().toISOString(),
      actor: 'client',
      payload: {
        agent: {
          agentSpecId: 'copilot-poc'
        },
        input: {
          message: 'make the repo build'
        },
        workspace: {
          source: 'empty'
        }
      }
    };

    let acknowledgementResolve: (event: RuntimeEvent) => void;
    const acknowledgement = new Promise<RuntimeEvent>((resolve) => {
      acknowledgementResolve = resolve;
    });
    const sessionEvents: RuntimeEvent[] = [];
    const clientProjections: RuntimeEvent[] = [];
    await transport.subscribe({ kind: 'client-private-inbox', clientConnectionId: 'demo-connection' }, async (envelope) => {
      if (envelope.event.ackId === 'ack-create-1') {
        acknowledgementResolve(envelope.event);
      }
    });
    await transport.subscribe({ kind: 'client-inbox' }, async (envelope) => {
      clientProjections.push(envelope.event);
    });

    await transport.publish({ kind: 'tenant-inbox' }, request, {
      principal: {
        principalId: 'demo-user',
        type: 'user'
      },
      connectionId: 'demo-connection'
    });

    const sessionIds = await readdir(join(root, 'sessions'));
    assert.equal(sessionIds.length, 1);

    const sessionId = sessionIds[0];
    await transport.subscribe({ kind: 'session-events', sessionId }, async (envelope) => {
      sessionEvents.push(envelope.event);
    });
    assert.notEqual(sessionId, 'ack-create-1');
    const sessionFile = await readFile(join(root, 'sessions', sessionId, 'session.json'), 'utf8');
    const session = JSON.parse(sessionFile) as {
      tenantId: string;
      owner: string;
      status: string;
      eventCursor: number;
      nextTurnSeq: number;
      resolvedAgentSpec: { agentSpecId: string; digest: string };
    };

    assert.equal(session.tenantId, 'poc');
    assert.equal(session.owner, 'demo-user');
    assert.equal(session.status, 'queued');
    assert.equal(session.eventCursor, 1);
    assert.equal(session.nextTurnSeq, 2);
    assert.equal(session.resolvedAgentSpec.agentSpecId, 'copilot-poc');
    assert.equal(typeof session.resolvedAgentSpec.digest, 'string');

    const eventsFile = await readFile(join(root, 'sessions', sessionId, 'events.jsonl'), 'utf8');
    const events = eventsFile.trim().split('\n').map((line) => JSON.parse(line) as RuntimeEvent);

    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'session.created');
    assert.equal(events[0].sequence, 1);
    assert.equal(events[0].sessionId, sessionId);
    assert.equal(events[0].ackId, 'ack-create-1');
    assert.equal(events[0].turnSeq, 1);
    assert.deepEqual(events[0].payload, {
      input: { message: 'make the repo build' },
      workspace: { source: 'empty' },
      status: 'queued',
      requestedBy: 'demo-user'
    });

    const ack = await acknowledgement;
    assert.equal(ack.type, 'session.created.ack');
    assert.equal(ack.sessionId, sessionId);
    assert.equal(ack.turnSeq, 1);
    assert.deepEqual(ack.payload, { status: 'queued' });
    assert.deepEqual(clientProjections.map((event) => event.type), ['session.catalog.updated']);
    assert.equal(clientProjections[0].ackId, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scenario: session list and history queries use runtime request acknowledgements', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ars-query-wps-'));
  try {
    const transport = new InMemoryRuntimeTransportAdapter();
    const storage = new LocalFileStorage(root);
    const central = new CentralService({ storage, eventTransport: transport, connectionIssuer: transport });
    await central.start();

    const createRequest: RuntimeEvent = {
      eventId: 'evt-create-query-session',
      ackId: 'ack-create-query-session',
      sequence: 0,
      type: 'session.create.requested',
      timestamp: new Date().toISOString(),
      actor: 'client',
      payload: {
        agent: {
          agentSpecId: 'copilot-poc'
        },
        input: {
          message: 'prepare query session'
        },
        workspace: {
          source: 'empty'
        }
      }
    };

    const acknowledgements: RuntimeEvent[] = [];
    const clientProjections: RuntimeEvent[] = [];
    await transport.subscribe({ kind: 'client-private-inbox', clientConnectionId: 'demo-connection' }, async (envelope) => {
      acknowledgements.push(envelope.event);
    });
    await transport.subscribe({ kind: 'client-inbox' }, async (envelope) => {
      clientProjections.push(envelope.event);
    });

    const context = {
      principal: {
        principalId: 'demo-user',
        type: 'user' as const
      },
      connectionId: 'demo-connection'
    };
    await transport.publish({ kind: 'tenant-inbox' }, createRequest, context);
    const created = acknowledgements.find((event) => event.ackId === 'ack-create-query-session');
    assert.equal(created?.type, 'session.created.ack');
    assert.equal(typeof created?.eventId, 'string');
    assert.equal(typeof created?.sessionId, 'string');
    assert.deepEqual(clientProjections.map((event) => event.type), ['session.catalog.updated']);

    await transport.publish({ kind: 'tenant-inbox' }, {
      eventId: 'evt-list-query-session',
      ackId: 'ack-list-query-session',
      sequence: 0,
      type: 'session.list.requested',
      timestamp: new Date().toISOString(),
      actor: 'client',
      payload: {}
    }, context);

    const listed = acknowledgements.find((event) => event.ackId === 'ack-list-query-session');
    assert.equal(listed?.type, 'session.listed');
    const listedPayload = listed?.payload as { sessions: Array<{ sessionId: string; owner: string }> };
    assert.equal(listedPayload.sessions.length, 1);
    assert.equal(listedPayload.sessions[0].sessionId, created!.sessionId);
    assert.equal(listedPayload.sessions[0].owner, 'demo-user');

    const sessionEvents: RuntimeEvent[] = [];
    await transport.subscribe({ kind: 'session-events', sessionId: created!.sessionId! }, async (envelope) => {
      sessionEvents.push(envelope.event);
    });

    await transport.publish({ kind: 'tenant-inbox' }, {
      eventId: 'evt-input-query-session',
      sessionId: created!.sessionId,
      ackId: 'ack-input-query-session',
      sequence: 0,
      type: 'input.received',
      timestamp: new Date().toISOString(),
      actor: 'client',
      payload: {
        input: {
          message: 'tenant inbox ack must not leak this input'
        }
      }
    }, context);

    const inputAck = acknowledgements.find((event) => event.ackId === 'ack-input-query-session');
    assert.equal(inputAck?.type, 'input.accepted.ack');
    assert.deepEqual(inputAck?.payload, { status: 'accepted' });
    const inputSessionEvent = sessionEvents.find((event) => event.ackId === 'ack-input-query-session');
    assert.equal(inputSessionEvent?.type, 'input.accepted');
    assert.deepEqual((inputSessionEvent?.payload as { input?: { message?: string } }).input, { message: 'tenant inbox ack must not leak this input' });

    await transport.publish({ kind: 'tenant-inbox' }, {
      eventId: 'evt-history-query-session',
      sessionId: created!.sessionId,
      ackId: 'ack-history-query-session',
      sequence: 0,
      type: 'session.events.requested',
      timestamp: new Date().toISOString(),
      actor: 'client',
      payload: {
        afterSequence: 0
      }
    }, context);

    const replayed = acknowledgements.find((event) => event.ackId === 'ack-history-query-session');
    assert.equal(replayed?.type, 'session.events.replayed');
    assert.equal(replayed?.sessionId, created!.sessionId);
    const replayedPayload = replayed?.payload as { events: RuntimeEvent[] };
    assert.deepEqual(replayedPayload.events.map((event) => event.type), ['session.created', 'input.accepted', 'turn.failed']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scenario: sidecar negotiate creates registered worker truth', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ars-slice3-'));
  try {
    const transport = new InMemoryRuntimeTransportAdapter();
    const storage = new LocalFileStorage(root);
    const central = new CentralService({ storage, eventTransport: transport, connectionIssuer: transport });
    await central.start();

    const grant = await central.negotiateSidecarConnectionForTenant('poc', {
      principal: {
        principalId: 'demo-sidecar',
        type: 'service'
      },
      connectionId: 'sidecar-connection'
    }, {
      labels: COPILOT_WORKER_LABELS,
      storageClass: COPILOT_STORAGE_CLASS,
      capacity: 1,
      allocatable: 1
    });
    assert.equal(typeof grant.worker?.workerId, 'string');

    const workerIds = (await readdir(join(root, 'workers'))).filter((file) => file.endsWith('.json')).map((file) => file.replace(/\.json$/, ''));
    assert.equal(workerIds.length, 1);

    const workerFile = await readFile(join(root, 'workers', `${workerIds[0]}.json`), 'utf8');
    const worker = JSON.parse(workerFile) as {
      tenantId: string;
      storageClass: string;
      labels: Record<string, string>;
      capacity: number;
      allocatable: number;
      lifecycleState: string;
      conditions: string[];
    };

    assert.equal(worker.tenantId, 'poc');
    assert.equal(worker.storageClass, COPILOT_STORAGE_CLASS);
    assert.deepEqual(worker.labels, COPILOT_WORKER_LABELS);
    assert.equal(worker.capacity, 1);
    assert.equal(worker.allocatable, 0);
    assert.equal(worker.lifecycleState, 'registered');
    assert.deepEqual(worker.conditions, ['disconnected']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scenario: concurrent client inputs allocate distinct turn sequences', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ars-concurrent-inputs-'));
  try {
    const transport = new InMemoryRuntimeTransportAdapter();
    const storage = new LocalFileStorage(root);
    const central = new CentralService({ storage, eventTransport: transport, connectionIssuer: transport });
    const now = new Date().toISOString();
    await storage.createSession({
      sessionId: 'concurrent-case',
      tenantId: 'poc',
      owner: 'operator',
      resolvedAgentSpec: new AgentSpecAdmissionManager({ now: () => now }).resolve(POC_AGENT_SPEC),
      status: 'running',
      eventCursor: 0,
      nextTurnSeq: 1,
      workspaceRef: 'ws-concurrent-case',
      lastEventUpdatedAt: now,
      createdAt: now,
      updatedAt: now
    });
    await central.start();
    const context = {
      principal: { principalId: 'operator', type: 'user' as const },
      connectionId: 'operator-connection'
    };
    const input = (id: string, message: string): RuntimeEvent => ({
      eventId: id,
      ackId: `ack-${id}`,
      sessionId: 'concurrent-case',
      sequence: 0,
      type: 'input.received',
      timestamp: now,
      actor: 'client',
      payload: { input: { message, delegationTarget: { deviceRef: `device-${id}` } } }
    });

    await Promise.all([
      transport.publish({ kind: 'tenant-inbox' }, input('one', 'first'), context),
      transport.publish({ kind: 'tenant-inbox' }, input('two', 'second'), context)
    ]);

    const accepted = (await storage.readEvents('concurrent-case', 0))
      .filter((event) => event.type === 'input.accepted')
      .sort((left, right) => left.turnSeq! - right.turnSeq!);
    assert.deepEqual(accepted.map((event) => event.turnSeq), [1, 2]);
    assert.deepEqual(
      accepted.map((event) => (event.payload as { input: { delegationTarget: { deviceRef: string } } }).input.delegationTarget.deviceRef).sort(),
      ['device-one', 'device-two']
    );
    assert.equal((await storage.readSession('concurrent-case'))?.nextTurnSeq, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scenario: the case device roster surfaces a paired device before any task and hides other cases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ars-case-roster-'));
  try {
    const transport = new InMemoryRuntimeTransportAdapter();
    const storage = new LocalFileStorage(root);
    const central = new CentralService({ storage, eventTransport: transport, connectionIssuer: transport });
    await central.start();

    // Two recovery cases each enroll their own phone via a Central-minted binding; both workers heartbeat ready.
    const paired = await enrollReadyDevice(central, storage, transport, 'case-A', 'device-A');
    const other = await enrollReadyDevice(central, storage, transport, 'case-B', 'device-B');

    const acknowledgements: RuntimeEvent[] = [];
    await transport.subscribe({ kind: 'client-private-inbox', clientConnectionId: 'console-conn' }, async (envelope) => {
      acknowledgements.push(envelope.event);
    });
    const consoleContext = {
      principal: { principalId: 'recovery-console', type: 'user' as const },
      connectionId: 'console-conn'
    };

    // The console lists the devices Central authorized for its own case.
    await transport.publish({ kind: 'tenant-inbox' }, {
      eventId: 'evt-devices-case-a',
      ackId: 'ack-devices-case-a',
      sequence: 0,
      type: 'case.devices.requested',
      timestamp: new Date().toISOString(),
      actor: 'client',
      payload: { caseId: 'case-A' }
    }, consoleContext);

    const provided = acknowledgements.find((event) => event.ackId === 'ack-devices-case-a');
    assert.equal(provided?.type, 'case.devices.provided');
    const devices = (provided?.payload as { devices: Array<Record<string, unknown>> }).devices;
    // The case-A device is reported online/ready BEFORE any delegation is assigned to it, keyed by its deviceRef.
    assert.equal(devices.length, 1);
    assert.equal(devices[0].deviceRef, paired.deviceRef);
    assert.equal(devices[0].online, true);
    assert.equal(devices[0].ready, true);
    assert.equal(devices[0].busy, false);
    assert.equal(devices[0].workerId, paired.workerId);
    // The other case's device is never exposed on this case's roster.
    assert.ok(!devices.some((candidate) => candidate.deviceRef === other.deviceRef));

    const foreignAcknowledgements: RuntimeEvent[] = [];
    await transport.subscribe({ kind: 'client-private-inbox', clientConnectionId: 'foreign-conn' }, async (envelope) => {
      foreignAcknowledgements.push(envelope.event);
    });
    const foreignContext = {
      principal: { principalId: 'other-console', type: 'user' as const },
      connectionId: 'foreign-conn'
    };
    await transport.publish({ kind: 'tenant-inbox' }, {
      eventId: 'evt-foreign-devices-case-a',
      ackId: 'ack-foreign-devices-case-a',
      sequence: 0,
      type: 'case.devices.requested',
      timestamp: new Date().toISOString(),
      actor: 'client',
      payload: { caseId: 'case-A' }
    }, foreignContext);
    await transport.publish({ kind: 'tenant-inbox' }, {
      eventId: 'evt-foreign-mint-case-a',
      ackId: 'ack-foreign-mint-case-a',
      sequence: 0,
      type: 'case.pairing.mint.requested',
      timestamp: new Date().toISOString(),
      actor: 'client',
      payload: { caseId: 'case-A' }
    }, foreignContext);
    for (const response of foreignAcknowledgements) {
      assert.equal((response.payload as { error: { code: string } }).error.code, 'case_not_found');
    }
    assert.equal(foreignAcknowledgements.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** Enroll a device into `caseId` via a real Central-minted binding, register its browser worker, and heartbeat ready. */
async function enrollReadyDevice(
  central: CentralService,
  storage: LocalFileStorage,
  transport: InMemoryRuntimeTransportAdapter,
  caseId: string,
  deviceId: string
): Promise<{ deviceRef: string; workerId: string }> {
  const now = new Date().toISOString();
  const session: SessionRecord = {
    sessionId: caseId,
    tenantId: 'poc',
    owner: 'recovery-console',
    resolvedAgentSpec: new AgentSpecAdmissionManager({ now: () => now }).resolve(POC_AGENT_SPEC),
    status: 'running',
    eventCursor: 0,
    nextTurnSeq: 1,
    workspaceRef: `ws-${caseId}`,
    lastEventUpdatedAt: now,
    createdAt: now,
    updatedAt: now
  };
  await storage.createSession(session);
  const pairing = new CasePairingManager('poc', storage, { now: () => new Date().toISOString() });
  const invite = await pairing.mintPairingInvite(caseId);
  const redeemed = await central.redeemPairingInviteForTenant(
    'poc',
    { principal: { principalId: 'recovery-console', type: 'user' }, connectionId: 'console-conn' },
    { inviteId: invite.inviteId, inviteSecret: invite.inviteSecret, deviceId, deviceLabel: `device-${caseId}` }
  );
  const grant = await central.negotiateSidecarConnectionForTenant(
    'poc',
    { principal: { principalId: deviceId, type: 'service' } },
    {
      labels: { agent: 'browser-edge', role: 'device-scan-probe', storage: 'host-managed' },
      storageClass: 'host-managed',
      capacity: 1,
      allocatable: 1,
      edgeBinding: { caseId: redeemed.caseId, deviceId, deviceRef: redeemed.deviceRef, bindingCredential: redeemed.bindingCredential }
    }
  );
  const workerId = grant.worker?.workerId;
  assert.ok(workerId);
  await transport.publish({ kind: 'tenant-inbox' }, {
    eventId: `evt-heartbeat-${caseId}`,
    workerId,
    sequence: 0,
    type: 'worker.heartbeat',
    timestamp: new Date().toISOString(),
    actor: 'sidecar',
    payload: { workerId, capacity: 1, allocatable: 1, conditions: ['ready'] }
  }, { principal: { principalId: workerId, type: 'service' } });
  return { deviceRef: redeemed.deviceRef, workerId };
}