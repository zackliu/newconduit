import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { SessionRecord, WorkerRecord } from '../../src/shared';
import { AgentSpecAdmissionManager, CasePairingError, CasePairingManager, EDGE_CASE_LABEL_KEY, EDGE_DEVICE_REF_LABEL_KEY } from '../../src/central/managers';
import { LocalFileStorage } from '../../src/central/storage/local-file-storage';
import { POC_AGENT_SPEC } from '../support/config-fixtures';

const NOW = '2026-07-22T00:00:00.000Z';

test('scenario: an operator mints an invite and a device redeems it into a routable binding', async () => {
  await withManager(async ({ storage, manager }) => {
    await writeCase(storage, 'case-1');
    const invite = await manager.mintPairingInvite('case-1');
    assert.equal(invite.caseId, 'case-1');
    assert.notEqual(invite.inviteSecret, '');

    const redeemed = await manager.redeemPairingInvite({
      inviteId: invite.inviteId,
      inviteSecret: invite.inviteSecret,
      deviceId: 'device-A',
      deviceLabel: 'iOS device'
    });
    assert.equal(redeemed.caseId, 'case-1');
    assert.match(redeemed.deviceRef, /^dref_/);
    assert.notEqual(redeemed.bindingCredential, '');

    // The device is authorized only with its credential; Central mints the case + deviceRef routing labels.
    const resolved = await manager.resolveEdgeBinding({
      caseId: 'case-1',
      deviceId: 'device-A',
      deviceRef: redeemed.deviceRef,
      bindingCredential: redeemed.bindingCredential
    });
    assert.deepEqual(resolved.mintedLabels, { [EDGE_CASE_LABEL_KEY]: 'case-1', [EDGE_DEVICE_REF_LABEL_KEY]: redeemed.deviceRef });

    // Roster shows the device as joined (offline until a worker registers), then online once a live worker exists.
    const before = await manager.listCaseDevices('case-1');
    assert.equal(before.length, 1);
    assert.equal(before[0]!.deviceRef, redeemed.deviceRef);
    assert.equal(before[0]!.online, false);

    await writeLiveWorker(storage, 'case-1', redeemed.deviceRef);
    const after = await manager.listCaseDevices('case-1');
    assert.equal(after[0]!.online, true);
    assert.equal(after[0]!.ready, true);
  });
});

test('scenario: a one-time invite cannot be replayed', async () => {
  await withManager(async ({ storage, manager }) => {
    await writeCase(storage, 'case-1');
    const invite = await manager.mintPairingInvite('case-1');
    await manager.redeemPairingInvite({ inviteId: invite.inviteId, inviteSecret: invite.inviteSecret, deviceId: 'device-A', deviceLabel: 'iOS device' });
    await assertCode('invite_already_redeemed', () =>
      manager.redeemPairingInvite({ inviteId: invite.inviteId, inviteSecret: invite.inviteSecret, deviceId: 'device-A', deviceLabel: 'iOS device' }));
  });
});

test('scenario: an expired invite is rejected', async () => {
  await withManager(async ({ storage, manager, setNow }) => {
    await writeCase(storage, 'case-1');
    const invite = await manager.mintPairingInvite('case-1');
    setNow('2026-07-22T01:00:00.000Z');
    await assertCode('invite_expired', () =>
      manager.redeemPairingInvite({ inviteId: invite.inviteId, inviteSecret: invite.inviteSecret, deviceId: 'device-A', deviceLabel: 'iOS device' }));
  });
});

test('scenario: a wrong invite secret is rejected', async () => {
  await withManager(async ({ storage, manager }) => {
    await writeCase(storage, 'case-1');
    const invite = await manager.mintPairingInvite('case-1');
    await assertCode('invite_secret_invalid', () =>
      manager.redeemPairingInvite({ inviteId: invite.inviteId, inviteSecret: 'not-the-secret', deviceId: 'device-A', deviceLabel: 'iOS device' }));
  });
});

test('scenario: a cross-tenant redeem cannot see another tenant\'s invite', async () => {
  await withManager(async ({ storage, manager, clock }) => {
    await writeCase(storage, 'case-1', 'poc');
    const invite = await manager.mintPairingInvite('case-1');
    const foreign = new CasePairingManager('other-tenant', storage, clock);
    await assertCode('invite_not_found', () =>
      foreign.redeemPairingInvite({ inviteId: invite.inviteId, inviteSecret: invite.inviteSecret, deviceId: 'device-A', deviceLabel: 'iOS device' }));
  });
});

test('scenario: a forged deviceId or wrong credential cannot resolve a binding', async () => {
  await withManager(async ({ storage, manager }) => {
    await writeCase(storage, 'case-1');
    const invite = await manager.mintPairingInvite('case-1');
    const redeemed = await manager.redeemPairingInvite({ inviteId: invite.inviteId, inviteSecret: invite.inviteSecret, deviceId: 'device-A', deviceLabel: 'iOS device' });

    // A forged deviceId that reuses the real deviceRef + credential is rejected: deviceId is metadata, not authority.
    await assertCode('binding_credential_invalid', () =>
      manager.resolveEdgeBinding({ caseId: 'case-1', deviceId: 'device-IMPOSTER', deviceRef: redeemed.deviceRef, bindingCredential: redeemed.bindingCredential }));
    // The real deviceId with a wrong credential is rejected too.
    await assertCode('binding_credential_invalid', () =>
      manager.resolveEdgeBinding({ caseId: 'case-1', deviceId: 'device-A', deviceRef: redeemed.deviceRef, bindingCredential: 'wrong-credential' }));
  });
});

test('scenario: minting an invite for an unowned case is rejected', async () => {
  await withManager(async ({ manager }) => {
    await assertCode('case_not_found', () => manager.mintPairingInvite('no-such-case'));
  });
});

test('scenario: case pairing access is restricted to the session owner', async () => {
  await withManager(async ({ storage, manager }) => {
    await writeCase(storage, 'case-1');
    await manager.authorizeCaseAccess('case-1', 'owner-1');
    await assertCode('case_not_found', () => manager.authorizeCaseAccess('case-1', 'other-owner'));
    await assertCode('case_not_found', () => manager.authorizeCaseAccess('no-such-case', 'owner-1'));
  });
});

test('scenario: two devices redeem into one case roster', async () => {
  await withManager(async ({ storage, manager }) => {
    await writeCase(storage, 'case-1');
    const inviteA = await manager.mintPairingInvite('case-1');
    const a = await manager.redeemPairingInvite({ inviteId: inviteA.inviteId, inviteSecret: inviteA.inviteSecret, deviceId: 'device-A', deviceLabel: 'iOS device' });
    const inviteB = await manager.mintPairingInvite('case-1');
    const b = await manager.redeemPairingInvite({ inviteId: inviteB.inviteId, inviteSecret: inviteB.inviteSecret, deviceId: 'device-B', deviceLabel: 'Android device' });

    assert.notEqual(a.deviceRef, b.deviceRef);
    const roster = await manager.listCaseDevices('case-1');
    assert.deepEqual(roster.map((d) => d.deviceRef).sort(), [a.deviceRef, b.deviceRef].sort());
  });
});

test('scenario: revoking a device invalidates its credential and drops it from the roster', async () => {
  await withManager(async ({ storage, manager }) => {
    await writeCase(storage, 'case-1');
    const invite = await manager.mintPairingInvite('case-1');
    const redeemed = await manager.redeemPairingInvite({ inviteId: invite.inviteId, inviteSecret: invite.inviteSecret, deviceId: 'device-A', deviceLabel: 'iOS device' });

    // Before revoke: the credential resolves and the device is on the roster.
    await manager.resolveEdgeBinding({ caseId: 'case-1', deviceId: 'device-A', deviceRef: redeemed.deviceRef, bindingCredential: redeemed.bindingCredential });
    assert.equal((await manager.listCaseDevices('case-1')).length, 1);

    assert.equal(await manager.revokeDevice('case-1', redeemed.deviceRef), true);
    // A second revoke is a no-op (already revoked).
    assert.equal(await manager.revokeDevice('case-1', redeemed.deviceRef), false);

    // After revoke: the same credential no longer authorizes, and the roster drops the device.
    await assertCode('binding_not_found', () =>
      manager.resolveEdgeBinding({ caseId: 'case-1', deviceId: 'device-A', deviceRef: redeemed.deviceRef, bindingCredential: redeemed.bindingCredential }));
    assert.equal((await manager.listCaseDevices('case-1')).length, 0);
  });
});

test('scenario: closing a case revokes every binding and blocks new redeems', async () => {
  await withManager(async ({ storage, manager }) => {
    await writeCase(storage, 'case-1');
    const inviteA = await manager.mintPairingInvite('case-1');
    const a = await manager.redeemPairingInvite({ inviteId: inviteA.inviteId, inviteSecret: inviteA.inviteSecret, deviceId: 'device-A', deviceLabel: 'iOS device' });
    const inviteB = await manager.mintPairingInvite('case-1');
    const b = await manager.redeemPairingInvite({ inviteId: inviteB.inviteId, inviteSecret: inviteB.inviteSecret, deviceId: 'device-B', deviceLabel: 'Android device' });
    // Mint one more invite that is still pending when the case closes.
    const latePending = await manager.mintPairingInvite('case-1');

    assert.equal(await manager.revokeCase('case-1'), 2);
    // Idempotent: a second case-close revokes nothing further.
    assert.equal(await manager.revokeCase('case-1'), 0);

    await closeCase(storage, 'case-1');

    // Both devices' credentials are dead and the roster is empty.
    await assertCode('binding_not_found', () =>
      manager.resolveEdgeBinding({ caseId: 'case-1', deviceId: 'device-A', deviceRef: a.deviceRef, bindingCredential: a.bindingCredential }));
    await assertCode('binding_not_found', () =>
      manager.resolveEdgeBinding({ caseId: 'case-1', deviceId: 'device-B', deviceRef: b.deviceRef, bindingCredential: b.bindingCredential }));
    assert.equal((await manager.listCaseDevices('case-1')).length, 0);

    // A still-pending invite cannot resurrect a closed case.
    await assertCode('case_closed', () =>
      manager.redeemPairingInvite({ inviteId: latePending.inviteId, inviteSecret: latePending.inviteSecret, deviceId: 'device-C', deviceLabel: 'Windows device' }));
  });
});

test('scenario: a closed case rejects both minting and redeeming', async () => {
  await withManager(async ({ storage, manager }) => {
    await writeCase(storage, 'case-1');
    const invite = await manager.mintPairingInvite('case-1');
    await closeCase(storage, 'case-1');

    await assertCode('case_closed', () => manager.mintPairingInvite('case-1'));
    await assertCode('case_closed', () =>
      manager.redeemPairingInvite({ inviteId: invite.inviteId, inviteSecret: invite.inviteSecret, deviceId: 'device-A', deviceLabel: 'iOS device' }));
  });
});

test('scenario: a fresh operator-authorized invite re-admits a previously revoked device', async () => {
  await withManager(async ({ storage, manager }) => {
    await writeCase(storage, 'case-1');
    const first = await manager.mintPairingInvite('case-1');
    const before = await manager.redeemPairingInvite({ inviteId: first.inviteId, inviteSecret: first.inviteSecret, deviceId: 'device-A', deviceLabel: 'iOS device' });
    await manager.revokeDevice('case-1', before.deviceRef);

    // Re-redeeming a new invite rotates the credential, keeps the same deterministic deviceRef, and re-activates.
    const second = await manager.mintPairingInvite('case-1');
    const after = await manager.redeemPairingInvite({ inviteId: second.inviteId, inviteSecret: second.inviteSecret, deviceId: 'device-A', deviceLabel: 'iOS device' });
    assert.equal(after.deviceRef, before.deviceRef);
    assert.notEqual(after.bindingCredential, before.bindingCredential);

    // The old credential stays dead; only the rotated one authorizes.
    await assertCode('binding_credential_invalid', () =>
      manager.resolveEdgeBinding({ caseId: 'case-1', deviceId: 'device-A', deviceRef: before.deviceRef, bindingCredential: before.bindingCredential }));
    const resolved = await manager.resolveEdgeBinding({ caseId: 'case-1', deviceId: 'device-A', deviceRef: after.deviceRef, bindingCredential: after.bindingCredential });
    assert.equal(resolved.deviceRef, after.deviceRef);
  });
});

test('scenario: pairing errors never echo the secret or credential', async () => {
  await withManager(async ({ storage, manager }) => {
    await writeCase(storage, 'case-1');
    const invite = await manager.mintPairingInvite('case-1');
    const redeemed = await manager.redeemPairingInvite({ inviteId: invite.inviteId, inviteSecret: invite.inviteSecret, deviceId: 'device-A', deviceLabel: 'iOS device' });

    const secretError = await captureError(() =>
      manager.redeemPairingInvite({ inviteId: invite.inviteId, inviteSecret: 'super-secret-guess-value', deviceId: 'device-A', deviceLabel: 'iOS device' }));
    assert.ok(!secretError.message.includes('super-secret-guess-value'), 'invite secret must not appear in the error');

    const credError = await captureError(() =>
      manager.resolveEdgeBinding({ caseId: 'case-1', deviceId: 'device-A', deviceRef: redeemed.deviceRef, bindingCredential: redeemed.bindingCredential + 'tampered' }));
    assert.ok(!credError.message.includes(redeemed.bindingCredential), 'binding credential must not appear in the error');
  });
});

test('scenario: a terminal case rejects a credential before its bindings are revoked (race is closed)', async () => {
  await withManager(async ({ storage, manager }) => {
    await writeCase(storage, 'case-1');
    const invite = await manager.mintPairingInvite('case-1');
    const redeemed = await manager.redeemPairingInvite({ inviteId: invite.inviteId, inviteSecret: invite.inviteSecret, deviceId: 'device-A', deviceLabel: 'iOS device' });

    // Simulate the window where the case has terminalized but the asynchronous binding revocation has NOT persisted
    // yet: the binding is still 'active' in storage.
    const session = await storage.readSession('case-1');
    assert.ok(session);
    await storage.writeSession({ ...session, status: 'failed', updatedAt: NOW });
    const stillActive = await storage.readCaseDeviceBinding('case-1', redeemed.deviceRef);
    assert.equal(stillActive!.status, 'active');

    // Defense in depth: negotiate/reconnect is rejected on the terminal case, not on the (lagging) binding status.
    await assertCode('case_closed', () =>
      manager.resolveEdgeBinding({ caseId: 'case-1', deviceId: 'device-A', deviceRef: redeemed.deviceRef, bindingCredential: redeemed.bindingCredential }));

    await manager.reconcileTerminalCases();
    assert.equal((await manager.listCaseDevices('case-1')).length, 0);
  });
});

test('scenario: a paused case retains its bindings so a suspended device can reconnect', async () => {
  await withManager(async ({ storage, manager }) => {
    await writeCase(storage, 'case-1');
    const invite = await manager.mintPairingInvite('case-1');
    const redeemed = await manager.redeemPairingInvite({ inviteId: invite.inviteId, inviteSecret: invite.inviteSecret, deviceId: 'device-A', deviceLabel: 'iOS device' });

    // Pause/resume are NOT terminal: only case closure revokes. A suspended device reconnecting is legitimate.
    const session = await storage.readSession('case-1');
    assert.ok(session);
    await storage.writeSession({ ...session, status: 'paused', updatedAt: NOW });

    const resolved = await manager.resolveEdgeBinding({ caseId: 'case-1', deviceId: 'device-A', deviceRef: redeemed.deviceRef, bindingCredential: redeemed.bindingCredential });
    assert.equal(resolved.deviceRef, redeemed.deviceRef);
    assert.equal((await manager.listCaseDevices('case-1')).length, 1);
  });
});

interface Harness {
  storage: LocalFileStorage;
  manager: CasePairingManager;
  clock: { now: () => string };
  setNow: (value: string) => void;
}

async function withManager(run: (harness: Harness) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'ars-case-pairing-mgr-'));
  try {
    const storage = new LocalFileStorage(root);
    let current = NOW;
    const clock = { now: () => current };
    const manager = new CasePairingManager('poc', storage, clock);
    await run({ storage, manager, clock, setNow: (value) => { current = value; } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function assertCode(code: string, run: () => Promise<unknown>): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof CasePairingError, `expected CasePairingError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

async function captureError(run: () => Promise<unknown>): Promise<CasePairingError> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof CasePairingError, `expected CasePairingError, got ${String(error)}`);
    return error;
  }
  throw new assert.AssertionError({ message: 'expected the call to reject' });
}

async function closeCase(storage: LocalFileStorage, caseId: string): Promise<void> {
  const session = await storage.readSession(caseId);
  assert.ok(session, `case ${caseId} must exist`);
  await storage.writeSession({ ...session, status: 'completed', updatedAt: NOW });
}

async function writeCase(storage: LocalFileStorage, caseId: string, tenantId = 'poc'): Promise<void> {
  const session: SessionRecord = {
    sessionId: caseId,
    tenantId,
    owner: 'owner-1',
    resolvedAgentSpec: new AgentSpecAdmissionManager({ now: () => NOW }).resolve(POC_AGENT_SPEC),
    status: 'running',
    eventCursor: 0,
    nextTurnSeq: 1,
    workspaceRef: 'ws',
    lastEventUpdatedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW
  };
  await storage.createSession(session);
}

async function writeLiveWorker(storage: LocalFileStorage, caseId: string, deviceRef: string): Promise<void> {
  const worker: WorkerRecord = {
    workerId: `worker-${deviceRef}`,
    tenantId: 'poc',
    capacityScope: 'poc',
    labels: { agent: 'browser-edge', storage: 'host-managed', role: 'device-scan-probe', [EDGE_CASE_LABEL_KEY]: caseId, [EDGE_DEVICE_REF_LABEL_KEY]: deviceRef },
    storageClass: 'host-managed',
    capacity: 1,
    allocatable: 1,
    conditions: ['ready'],
    lifecycleState: 'active',
    heartbeatAt: NOW,
    expiresAt: '2026-07-22T00:00:30.000Z',
    registeredAt: NOW,
    currentSessionCount: 0,
    updatedAt: NOW
  };
  await storage.writeWorker(worker);
}
