import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { InMemoryRuntimeTransportAdapter } from '../../src/central/adapters';
import { CentralService } from '../../src/central/central-service';
import { LocalFileStorage } from '../../src/central/storage/local-file-storage';
import { COPILOT_PROCESS_WRAPPER_SIDECAR_CLASS, type RuntimeEvent } from '../../src/shared';

test('scenario: create session request creates durable session truth', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ars-slice1-'));
  try {
    const transport = new InMemoryRuntimeTransportAdapter();
    const storage = new LocalFileStorage(root);
    const central = new CentralService({ storage, eventTransport: transport, connectionIssuer: transport });
    await central.start();

    const request: RuntimeEvent = {
      eventId: 'evt-create-request',
      sequence: 0,
      type: 'session.create.requested',
      timestamp: new Date().toISOString(),
      actor: 'client',
      payload: {
        agent: {
          agentSpecId: 'copilot-poc'
        },
        input: {
          initialMessage: 'make the repo build',
          clientRequestId: 'client-request-1'
        },
        workspace: {
          source: 'empty'
        }
      }
    };

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
    const sessionFile = await readFile(join(root, 'sessions', sessionId, 'session.json'), 'utf8');
    const session = JSON.parse(sessionFile) as {
      tenantId: string;
      owner: string;
      status: string;
      eventCursor: number;
      resolvedAgentSpec: { agentSpecId: string; digest: string };
    };

    assert.equal(session.tenantId, 'poc');
    assert.equal(session.owner, 'demo-user');
    assert.equal(session.status, 'queued');
    assert.equal(session.eventCursor, 1);
    assert.equal(session.resolvedAgentSpec.agentSpecId, 'copilot-poc');
    assert.equal(typeof session.resolvedAgentSpec.digest, 'string');

    const eventsFile = await readFile(join(root, 'sessions', sessionId, 'events.jsonl'), 'utf8');
    const events = eventsFile.trim().split('\n').map((line) => JSON.parse(line) as RuntimeEvent);

    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'session.created');
    assert.equal(events[0].sequence, 1);
    assert.equal(events[0].sessionId, sessionId);
    assert.deepEqual(events[0].payload, {
      initialMessage: 'make the repo build',
      clientRequestId: 'client-request-1',
      workspace: { source: 'empty' },
      requestedBy: 'demo-user'
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scenario: sidecar worker register event creates active worker truth', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ars-slice3-'));
  try {
    const transport = new InMemoryRuntimeTransportAdapter();
    const storage = new LocalFileStorage(root);
    const central = new CentralService({ storage, eventTransport: transport, connectionIssuer: transport });
    await central.start();

    const request: RuntimeEvent = {
      eventId: 'evt-worker-register',
      sequence: 0,
      type: 'worker.register',
      timestamp: new Date().toISOString(),
      actor: 'sidecar',
      payload: {
        sidecarId: 'sidecar-1',
        sidecarClass: COPILOT_PROCESS_WRAPPER_SIDECAR_CLASS,
        labels: { agent: 'copilot' },
        capacity: 1,
        allocatable: 1
      }
    };

    await transport.publish({ kind: 'tenant-inbox' }, request, {
      principal: {
        principalId: 'demo-sidecar',
        type: 'service'
      },
      connectionId: 'sidecar-connection'
    });

    const workerIds = (await readdir(join(root, 'workers'))).filter((file) => file.endsWith('.json')).map((file) => file.replace(/\.json$/, ''));
    assert.equal(workerIds.length, 1);

    const workerFile = await readFile(join(root, 'workers', `${workerIds[0]}.json`), 'utf8');
    const worker = JSON.parse(workerFile) as {
      tenantId: string;
      sidecarId: string;
      sidecarClass: string;
      labels: Record<string, string>;
      capacity: number;
      allocatable: number;
      lifecycleState: string;
      conditions: string[];
    };

    assert.equal(worker.tenantId, 'poc');
    assert.equal(worker.sidecarId, 'sidecar-1');
    assert.equal(worker.sidecarClass, COPILOT_PROCESS_WRAPPER_SIDECAR_CLASS);
    assert.deepEqual(worker.labels, { agent: 'copilot' });
    assert.equal(worker.capacity, 1);
    assert.equal(worker.allocatable, 1);
    assert.equal(worker.lifecycleState, 'active');
    assert.deepEqual(worker.conditions, ['ready']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});