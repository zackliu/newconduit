import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LocalFileStorage } from '../../src/central/storage/local-file-storage';
import type { WorkerRecord } from '../../src/shared';

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
