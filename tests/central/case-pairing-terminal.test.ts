import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { SessionRecord } from '../../src/shared';
import { AgentSpecAdmissionManager, CasePairingError, CasePairingManager, SessionLifecycleManager } from '../../src/central/managers';
import { LocalFileStorage } from '../../src/central/storage/local-file-storage';
import { POC_AGENT_SPEC } from '../support/config-fixtures';

const NOW = '2026-07-22T00:00:00.000Z';

// These tests exercise the authoritative wiring TenantRuntime uses: a session first crossing into a terminal status
// drives case-device-binding revocation directly through SessionLifecycleManager, independent of the delegation
// reconcile loop. This is what makes a case with ZERO delegations revoke its bindings when it closes.

test('scenario: the terminal session transition revokes a zero-delegation case and its credential dies', async () => {
  await withHarness(async ({ storage, manager, lifecycle }) => {
    await writeCase(storage, 'case-1');
    const invite = await manager.mintPairingInvite('case-1');
    const redeemed = await manager.redeemPairingInvite({ inviteId: invite.inviteId, inviteSecret: invite.inviteSecret, deviceId: 'device-A', deviceLabel: 'iOS device' });
    // Enrolled and routable, with no delegation ever created on this case.
    assert.equal((await manager.listCaseDevices('case-1')).length, 1);

    const session = await requireSession(storage, 'case-1');
    await lifecycle.transition(session, 'failed', 'agent_failed');

    // The terminal transition alone revoked the binding: the roster drops the device and the credential no longer
    // authorizes — no delegation loop was involved.
    assert.equal((await manager.listCaseDevices('case-1')).length, 0);
    await assert.rejects(
      () => manager.resolveEdgeBinding({ caseId: 'case-1', deviceId: 'device-A', deviceRef: redeemed.deviceRef, bindingCredential: redeemed.bindingCredential }),
      (error: unknown) => error instanceof CasePairingError
    );

    // Idempotent: revoking the same closed case again is a no-op.
    assert.equal(await manager.revokeCase('case-1'), 0);
  });
});

test('scenario: re-running the terminal transition for an already-terminal case revokes nothing further', async () => {
  await withHarness(async ({ storage, manager, lifecycle }) => {
    await writeCase(storage, 'case-1');
    const invite = await manager.mintPairingInvite('case-1');
    await manager.redeemPairingInvite({ inviteId: invite.inviteId, inviteSecret: invite.inviteSecret, deviceId: 'device-A', deviceLabel: 'iOS device' });

    const session = await requireSession(storage, 'case-1');
    const failed = await lifecycle.transition(session, 'failed', 'agent_failed');
    assert.equal((await manager.listCaseDevices('case-1')).length, 0);

    // A second transition observed from the already-terminal record must NOT re-fire the hook (edge-triggered);
    // revoking the closed case again stays a no-op. This proves repeated terminal reconciliation is idempotent.
    await lifecycle.transition(failed, 'failed', 'agent_failed');
    assert.equal(await manager.revokeCase('case-1'), 0);
  });
});

test('scenario: closing one case never revokes a sibling case\'s device bindings', async () => {
  await withHarness(async ({ storage, manager, lifecycle }) => {
    await writeCase(storage, 'case-1');
    await writeCase(storage, 'case-2');
    const i1 = await manager.mintPairingInvite('case-1');
    await manager.redeemPairingInvite({ inviteId: i1.inviteId, inviteSecret: i1.inviteSecret, deviceId: 'device-A', deviceLabel: 'iOS device' });
    const i2 = await manager.mintPairingInvite('case-2');
    const b2 = await manager.redeemPairingInvite({ inviteId: i2.inviteId, inviteSecret: i2.inviteSecret, deviceId: 'device-B', deviceLabel: 'Android device' });

    await lifecycle.transition(await requireSession(storage, 'case-1'), 'failed', 'agent_failed');

    // Only the closed case's bindings were revoked; the sibling case's device is untouched and still routable.
    assert.equal((await manager.listCaseDevices('case-1')).length, 0);
    const roster2 = await manager.listCaseDevices('case-2');
    assert.equal(roster2.length, 1);
    const resolved = await manager.resolveEdgeBinding({ caseId: 'case-2', deviceId: 'device-B', deviceRef: b2.deviceRef, bindingCredential: b2.bindingCredential });
    assert.equal(resolved.deviceRef, b2.deviceRef);
  });
});

test('scenario: a non-terminal transition (pause) retains the case bindings', async () => {
  await withHarness(async ({ storage, manager, lifecycle }) => {
    await writeCase(storage, 'case-1');
    const invite = await manager.mintPairingInvite('case-1');
    const redeemed = await manager.redeemPairingInvite({ inviteId: invite.inviteId, inviteSecret: invite.inviteSecret, deviceId: 'device-A', deviceLabel: 'iOS device' });

    await lifecycle.transition(await requireSession(storage, 'case-1'), 'paused', 'idle_timeout');

    // Pause is not terminal: the binding survives and the device can reconnect.
    assert.equal((await manager.listCaseDevices('case-1')).length, 1);
    const resolved = await manager.resolveEdgeBinding({ caseId: 'case-1', deviceId: 'device-A', deviceRef: redeemed.deviceRef, bindingCredential: redeemed.bindingCredential });
    assert.equal(resolved.deviceRef, redeemed.deviceRef);
  });
});

interface Harness {
  storage: LocalFileStorage;
  manager: CasePairingManager;
  lifecycle: SessionLifecycleManager;
}

async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'ars-case-pairing-terminal-'));
  try {
    const storage = new LocalFileStorage(root);
    const clock = { now: () => NOW };
    const manager = new CasePairingManager('poc', storage, clock);
    // The same hook wiring TenantRuntime installs: a terminal session revokes its case's device bindings.
    const lifecycle = new SessionLifecycleManager(storage, clock, (session) => manager.revokeCase(session.sessionId).then(() => undefined));
    await run({ storage, manager, lifecycle });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function requireSession(storage: LocalFileStorage, caseId: string): Promise<SessionRecord> {
  const session = await storage.readSession(caseId);
  assert.ok(session, `case ${caseId} must exist`);
  return session;
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
