import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WebPubSubTransportAdapter } from '../../src/central/adapters';
import { CentralService } from '../../src/central/central-service';
import { LocalFileStorage } from '../../src/central/storage/local-file-storage';
import { CENTRAL_EVENTS_GROUP, type RuntimeEvent } from '../../src/shared';

test('scenario: create session request creates durable session truth', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ars-slice1-'));
  try {
    const transport = new WebPubSubTransportAdapter();
    const storage = new LocalFileStorage(root);
    const central = new CentralService({ storage, transport });
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

    await transport.publish(CENTRAL_EVENTS_GROUP, request);

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