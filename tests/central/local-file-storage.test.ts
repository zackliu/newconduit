import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LocalFileStorage } from '../../src/central/storage/local-file-storage';
import type { InteractionRecord, WorkerRecord } from '../../src/shared';

function worker(overrides: Partial<WorkerRecord> = {}): WorkerRecord {
  const now = '2026-07-15T00:00:00.000Z';
  return {
    workerId: 'worker-1',
    tenantId: 'poc',
    capacityScope: 'poc',
    labels: { agent: 'copilot', storage: 'volume-snapshot' },
    storageClass: 'volume-snapshot',
    capacity: 1,
    allocatable: 1,
    conditions: ['ready'],
    lifecycleState: 'active',
    heartbeatAt: now,
    expiresAt: '2026-07-15T00:00:30.000Z',
    currentSessionCount: 0,
    updatedAt: now,
    ...overrides
  };
}

function interaction(interactionId: string): InteractionRecord {
  const now = '2026-07-15T00:00:00.000Z';
  return {
    interactionId,
    tenantId: 'poc',
    kind: 'approval',
    request: { action: 'delete-file' },
    ownerSessionId: 'session-1',
    ownerTurnSeq: 2,
    adapterRequestId: 'adapter-request-1',
    requestLeaseId: 'lease-1',
    views: [{
      sessionId: 'session-1',
      turnSeq: 2,
      role: 'owner',
      requestedEventId: 'requested-1',
      requestedProjected: false,
      respondedProjected: false,
      interruptedProjected: false
    }],
    state: 'open',
    delivery: { state: 'not_ready' },
    revision: 1,
    createdAt: now,
    updatedAt: now
  };
}

test('scenario: an existing record is never observed missing or torn under concurrent writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ars-storage-atomic-'));
  try {
    const storage = new LocalFileStorage(root);
    await storage.writeWorker(worker());

    const writes = Array.from({ length: 200 }, (_, index) =>
      storage.writeWorker(worker({ conditions: index % 2 === 0 ? ['ready'] : ['busy'], updatedAt: `update-${index}` }))
    );
    const reads = Array.from({ length: 200 }, async () => {
      const read = await storage.readWorker('worker-1');
      assert.equal(read?.workerId, 'worker-1');
    });

    await Promise.all([...writes, ...reads]);

    assert.equal((await storage.readWorker('worker-1'))?.workerId, 'worker-1');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scenario: a missing record reads as not-found while a corrupt record fails loudly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ars-storage-corrupt-'));
  try {
    const storage = new LocalFileStorage(root);
    assert.equal(await storage.readWorker('nope'), undefined);

    await storage.writeWorker(worker({ workerId: 'worker-corrupt' }));
    await writeFile(join(root, 'workers', 'worker-corrupt.json'), '{ not valid json', 'utf8');
    await assert.rejects(() => storage.readWorker('worker-corrupt'), /corrupt/);

    await writeFile(join(root, 'workers', 'worker-empty.json'), '', 'utf8');
    await assert.rejects(() => storage.readWorker('worker-empty'), /empty/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scenario: an atomic record write leaves no temporary files behind', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ars-storage-temp-'));
  try {
    const storage = new LocalFileStorage(root);
    await storage.writeWorker(worker());
    assert.deepEqual(await readdir(join(root, 'workers')), ['worker-1.json']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scenario: duplicate adapter admission creates one canonical Interaction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ars-storage-interaction-create-'));
  try {
    const storage = new LocalFileStorage(root);
    const [left, right] = await Promise.all([
      storage.createInteraction(interaction('interaction-left')),
      storage.createInteraction(interaction('interaction-right'))
    ]);

    assert.equal(left.interaction.interactionId, right.interaction.interactionId);
    assert.equal([left.created, right.created].filter(Boolean).length, 1);
    assert.equal((await storage.readInteractions()).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scenario: concurrent Interaction resolutions have one revision winner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ars-storage-interaction-cas-'));
  try {
    const storage = new LocalFileStorage(root);
    const created = (await storage.createInteraction(interaction('interaction-1'))).interaction;
    const resolved: InteractionRecord = {
      ...created,
      state: 'resolved',
      resolution: {
        response: { decision: 'approved', scope: 'once' },
        principalId: 'owner-1',
        viaSessionId: created.ownerSessionId,
        resolvedAt: '2026-07-15T00:00:01.000Z'
      },
      delivery: { state: 'pending', commandEventId: 'command-1' },
      revision: 2,
      updatedAt: '2026-07-15T00:00:01.000Z'
    };
    const interrupted: InteractionRecord = {
      ...created,
      state: 'interrupted',
      interruption: { reason: 'owner_lease_lost', interruptedAt: '2026-07-15T00:00:01.000Z' },
      delivery: { state: 'abandoned' },
      revision: 2,
      updatedAt: '2026-07-15T00:00:01.000Z'
    };

    const outcomes = await Promise.all([
      storage.compareAndSetInteraction(1, resolved),
      storage.compareAndSetInteraction(1, interrupted)
    ]);

    assert.deepEqual(outcomes.sort(), [false, true]);
    assert.equal((await storage.readInteraction(created.interactionId))?.revision, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
