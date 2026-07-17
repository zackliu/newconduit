import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DelegationRecord } from '../../src/shared';
import { AgentSpecAdmissionManager } from '../../src/central/managers';
import { LocalFileStorage } from '../../src/central/storage/local-file-storage';
import { POC_AGENT_SPEC } from '../support/config-fixtures';

test('scenario: one Parent and Delegate persist one relation across storage restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ars-delegation-storage-'));
  try {
    const storage = new LocalFileStorage(root);
    const first = relation('delegation-1', 'parent-1');
    const duplicateKey = relation('delegation-2', 'parent-1');

    assert.deepEqual(await storage.createDelegation(first), { delegation: first, created: true });
    assert.deepEqual(await storage.createDelegation(duplicateKey), { delegation: first, created: false });

    const restartedStorage = new LocalFileStorage(root);
    assert.deepEqual(await restartedStorage.readDelegation('delegation-1'), first);
    assert.deepEqual(await restartedStorage.readDelegationByKey('parent-1', 'copilot-foundry'), first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scenario: concurrent Delegation updates have one revision winner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ars-delegation-cas-'));
  try {
    const storage = new LocalFileStorage(root);
    const first = relation('delegation-1', 'parent-1');
    await storage.createDelegation(first);

    const left = { ...first, status: 'open' as const, revision: 2, updatedAt: '2026-07-14T00:00:01.000Z' };
    const right = { ...first, status: 'closing' as const, revision: 2, updatedAt: '2026-07-14T00:00:02.000Z' };
    const outcomes = await Promise.all([
      storage.compareAndSetDelegation(1, left),
      storage.compareAndSetDelegation(1, right)
    ]);

    assert.equal(outcomes.filter(Boolean).length, 1);
    assert.equal((await storage.readDelegation(first.delegationId))?.revision, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function relation(delegationId: string, parentSessionId: string): DelegationRecord {
  const now = '2026-07-14T00:00:00.000Z';
  return {
    delegationId,
    tenantId: 'poc',
    parentSessionId,
    childSessionId: 'child-1',
    resolvedDelegate: {
      id: 'copilot-foundry',
      toolName: 'copilot_foundry',
      description: 'Ask copilot-foundry.',
      digest: 'delegate-digest',
      maxInputBytes: 2048,
      maxResultBytes: 8192,
      deadlineMs: 120_000,
      maxQueuedCalls: 2
    },
    resolvedCalleeAgentSpec: new AgentSpecAdmissionManager({ now: () => now }).resolve(POC_AGENT_SPEC),
    status: 'creating_child',
    nextCallSeq: 1,
    calls: [],
    revision: 1,
    createdAt: now,
    updatedAt: now
  };
}