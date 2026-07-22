import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { CaseDeviceBindingRecord, PairingInviteRecord } from '../../src/shared';
import { LocalFileStorage } from '../../src/central/storage/local-file-storage';

const NOW = '2026-07-22T00:00:00.000Z';

test('scenario: a pairing invite is created once and survives a storage restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ars-case-pairing-'));
  try {
    const storage = new LocalFileStorage(root);
    const invite = pendingInvite('invite-1', 'case-1');
    const duplicate = { ...invite, inviteSecretHash: 'other-hash' };

    assert.deepEqual(await storage.createPairingInvite(invite), { invite, created: true });
    // A second create for the same inviteId is idempotent and returns the original, never the duplicate secret hash.
    assert.deepEqual(await storage.createPairingInvite(duplicate), { invite, created: false });

    const restarted = new LocalFileStorage(root);
    assert.deepEqual(await restarted.readPairingInvite('invite-1'), invite);
    assert.equal(await restarted.readPairingInvite('missing'), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scenario: only one redeem wins the compare-and-set race on a one-time invite', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ars-case-pairing-cas-'));
  try {
    const storage = new LocalFileStorage(root);
    const invite = pendingInvite('invite-1', 'case-1');
    await storage.createPairingInvite(invite);

    const left: PairingInviteRecord = { ...invite, status: 'redeemed', redeemedDeviceRef: 'dref-A', revision: 2, updatedAt: '2026-07-22T00:00:01.000Z' };
    const right: PairingInviteRecord = { ...invite, status: 'redeemed', redeemedDeviceRef: 'dref-B', revision: 2, updatedAt: '2026-07-22T00:00:02.000Z' };
    const outcomes = await Promise.all([
      storage.compareAndSetPairingInvite(1, left),
      storage.compareAndSetPairingInvite(1, right)
    ]);

    assert.equal(outcomes.filter(Boolean).length, 1);
    const settled = await storage.readPairingInvite('invite-1');
    assert.equal(settled?.status, 'redeemed');
    assert.equal(settled?.revision, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scenario: two devices bind into one case roster and are read back by case', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ars-case-device-'));
  try {
    const storage = new LocalFileStorage(root);
    const a = binding('case-1', 'dref-A', 'device-A');
    const b = binding('case-1', 'dref-B', 'device-B');
    const other = binding('case-2', 'dref-C', 'device-C');

    await storage.createCaseDeviceBinding(a);
    await storage.createCaseDeviceBinding(b);
    await storage.createCaseDeviceBinding(other);

    const restarted = new LocalFileStorage(root);
    assert.deepEqual(await restarted.readCaseDeviceBinding('case-1', 'dref-A'), a);
    const roster = await restarted.readCaseDeviceBindings('case-1');
    assert.deepEqual(roster.map((r) => r.deviceRef).sort(), ['dref-A', 'dref-B']);
    // The roster is case-scoped: case-2's device never leaks into case-1's roster.
    assert.equal(roster.some((r) => r.caseId !== 'case-1'), false);
    assert.deepEqual((await restarted.readCaseDeviceBindings('case-3')), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scenario: only one credential rotation wins a concurrent re-redeem of the same device', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ars-case-device-cas-'));
  try {
    const storage = new LocalFileStorage(root);
    const base = binding('case-1', 'dref-A', 'device-A');
    await storage.createCaseDeviceBinding(base);

    const left: CaseDeviceBindingRecord = { ...base, bindingCredentialHash: 'hash-left', revision: 2, updatedAt: '2026-07-22T00:00:01.000Z' };
    const right: CaseDeviceBindingRecord = { ...base, bindingCredentialHash: 'hash-right', revision: 2, updatedAt: '2026-07-22T00:00:02.000Z' };
    const outcomes = await Promise.all([
      storage.compareAndSetCaseDeviceBinding(1, left),
      storage.compareAndSetCaseDeviceBinding(1, right)
    ]);

    assert.equal(outcomes.filter(Boolean).length, 1);
    assert.equal((await storage.readCaseDeviceBinding('case-1', 'dref-A'))?.revision, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scenario: a device binding rejects a changed immutable identity on compare-and-set', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ars-case-device-immutable-'));
  try {
    const storage = new LocalFileStorage(root);
    const base = binding('case-1', 'dref-A', 'device-A');
    await storage.createCaseDeviceBinding(base);

    const forged: CaseDeviceBindingRecord = { ...base, deviceId: 'device-IMPOSTER', revision: 2 };
    await assert.rejects(() => storage.compareAndSetCaseDeviceBinding(1, forged), /immutable identity changed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function pendingInvite(inviteId: string, caseId: string): PairingInviteRecord {
  return {
    inviteId,
    tenantId: 'poc',
    caseId,
    inviteSecretHash: `hash-of-${inviteId}`,
    inviteSecretSalt: `salt-of-${inviteId}`,
    status: 'pending',
    expiresAt: '2026-07-22T00:10:00.000Z',
    createdAt: NOW,
    updatedAt: NOW,
    revision: 1
  };
}

function binding(caseId: string, deviceRef: string, deviceId: string): CaseDeviceBindingRecord {
  return {
    tenantId: 'poc',
    caseId,
    deviceId,
    deviceRef,
    bindingCredentialHash: `cred-hash-${deviceRef}`,
    bindingCredentialSalt: `cred-salt-${deviceRef}`,
    deviceLabel: 'iOS device',
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    lastRedeemedAt: NOW,
    revision: 1
  };
}
