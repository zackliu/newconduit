import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FanoutManager } from '../../src/central/managers';
import { LocalFileStorage } from '../../src/central/storage/local-file-storage';

function fixedClock(): { now: () => string } {
  let tick = 0;
  return { now: () => new Date(Date.UTC(2026, 6, 22, 0, 0, tick++)).toISOString() };
}

async function withManager(run: (manager: FanoutManager, storage: LocalFileStorage) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'ars-fanout-'));
  try {
    const storage = new LocalFileStorage(root);
    await run(new FanoutManager('poc', storage, fixedClock()), storage);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('scenario: a fan-out group settles only once every member call terminalizes', async () => {
  await withManager(async (manager) => {
    await manager.openGroup({
      parentSessionId: 'parent-1',
      parentTurnSeq: 4,
      parentRequestId: 'req-1',
      caseId: 'parent-1',
      members: [
        { deviceRef: 'ref-a', delegationCallId: 'call-a' },
        { deviceRef: 'ref-b', delegationCallId: 'call-b' }
      ]
    });

    const first = await manager.recordOutcome('call-a', { status: 'completed', result: '{"led":"green"}' });
    assert.equal(first?.settledAggregate, undefined, 'group is not settled while a sibling is still pending');
    assert.equal(first?.group.status, 'open');

    const second = await manager.recordOutcome('call-b', { status: 'completed', result: '{"led":"amber"}' });
    assert.ok(second?.settledAggregate, 'the last member settles the group');
    const aggregate = JSON.parse(second!.settledAggregate!);
    assert.equal(aggregate.scope, 'all');
    assert.deepEqual(aggregate.summary, { total: 2, completed: 2, failed: 0 });
    assert.deepEqual(
      aggregate.devices.map((device: { deviceRef: string; status: string }) => ({ deviceRef: device.deviceRef, status: device.status })),
      [{ deviceRef: 'ref-a', status: 'completed' }, { deviceRef: 'ref-b', status: 'completed' }]
    );
    assert.deepEqual(aggregate.devices[0].observation, { led: 'green' });
  });
});

test('scenario: a partial failure is reported honestly and settlement is idempotent', async () => {
  await withManager(async (manager) => {
    await manager.openGroup({
      parentSessionId: 'parent-1',
      parentTurnSeq: 4,
      parentRequestId: 'req-1',
      caseId: 'parent-1',
      members: [
        { deviceRef: 'ref-a', delegationCallId: 'call-a' },
        { deviceRef: 'ref-b', delegationCallId: 'call-b' }
      ]
    });

    await manager.recordOutcome('call-a', { status: 'completed', result: '{"led":"green"}' });
    const settled = await manager.recordOutcome('call-b', { status: 'failed', code: 'child_session_lost', message: 'device dropped mid-scan' });
    const aggregate = JSON.parse(settled!.settledAggregate!);
    assert.deepEqual(aggregate.summary, { total: 2, completed: 1, failed: 1 });
    const failed = aggregate.devices.find((device: { deviceRef: string }) => device.deviceRef === 'ref-b');
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /child_session_lost: device dropped mid-scan/);

    // A redelivered terminal outcome (e.g. a post-restart reconcile) must not answer the parent a second time.
    const replay = await manager.recordOutcome('call-b', { status: 'failed', code: 'child_session_lost', message: 'device dropped mid-scan' });
    assert.equal(replay?.settledAggregate, undefined, 'a settled group is not re-aggregated');
    assert.equal(replay?.group.status, 'settled');
  });
});

test('scenario: recording an outcome for an unknown member call is a no-op', async () => {
  await withManager(async (manager) => {
    const result = await manager.recordOutcome('call-missing', { status: 'completed', result: '{}' });
    assert.equal(result, undefined);
  });
});
