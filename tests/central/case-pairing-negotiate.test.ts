import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { InMemoryRuntimeTransportAdapter } from '../../src/central/adapters';
import { CentralService } from '../../src/central/central-service';
import { AgentSpecAdmissionManager, CasePairingError, CasePairingManager, EDGE_CASE_LABEL_KEY, EDGE_DEVICE_REF_LABEL_KEY } from '../../src/central/managers';
import { LocalFileStorage } from '../../src/central/storage/local-file-storage';
import type { SessionRecord, WorkerRegisterPayload } from '../../src/shared';
import { POC_AGENT_SPEC } from '../support/config-fixtures';

/**
 * The negotiate enrollment seam is the point where a self-asserted device identity becomes an authorized,
 * Central-minted routing label. These tests prove — over a REAL `CentralService` — that the `case`/`deviceRef`
 * label keys are Central-owned: they are minted only from a validated binding credential and any client-supplied
 * value for them is stripped, so a browser worker can never self-declare which case/device it routes for.
 */

const NOW = '2026-07-22T00:00:00.000Z';
const context = (principalId: string) => ({ principal: { principalId, type: 'service' as const } });
const clientContext = { principal: { principalId: 'console', type: 'user' as const }, connectionId: 'console-conn' };

function baseBrowserLabels(extra: Record<string, string> = {}): Record<string, string> {
  return { agent: 'browser-edge', tier: 'edge', role: 'device-scan-probe', storage: 'host-managed', ...extra };
}

async function writeCase(storage: LocalFileStorage, caseId: string): Promise<void> {
  const session: SessionRecord = {
    sessionId: caseId,
    tenantId: 'poc',
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

async function withCentral(run: (ctx: { storage: LocalFileStorage; central: CentralService }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'ars-negotiate-'));
  const runtimeTransport = new InMemoryRuntimeTransportAdapter();
  const storage = new LocalFileStorage(root);
  const central = new CentralService({ storage, eventTransport: runtimeTransport, connectionIssuer: runtimeTransport });
  await central.start();
  try {
    await run({ storage, central });
  } finally {
    await central.stop();
    await rm(root, { recursive: true, force: true });
  }
}

/** Redeem a real binding for a device on `caseId`, returning the credential the worker presents at register. */
async function redeemDevice(storage: LocalFileStorage, central: CentralService, caseId: string, deviceId: string) {
  const pairing = new CasePairingManager('poc', storage, { now: () => new Date().toISOString() });
  const invite = await pairing.mintPairingInvite(caseId);
  return central.redeemPairingInviteForTenant('poc', clientContext, {
    inviteId: invite.inviteId,
    inviteSecret: invite.inviteSecret,
    deviceId,
    deviceLabel: 'Field phone'
  });
}

test('scenario: a valid binding mints authoritative case + deviceRef labels onto the worker', async () => {
  await withCentral(async ({ storage, central }) => {
    await writeCase(storage, 'case-1');
    const redeemed = await redeemDevice(storage, central, 'case-1', 'device-A');

    const registration: WorkerRegisterPayload = {
      labels: baseBrowserLabels(),
      storageClass: 'host-managed',
      capacity: 1,
      allocatable: 1,
      edgeBinding: { caseId: redeemed.caseId, deviceId: 'device-A', deviceRef: redeemed.deviceRef, bindingCredential: redeemed.bindingCredential }
    };
    const grant = await central.negotiateSidecarConnectionForTenant('poc', context('device-A'), registration);
    assert.ok(grant.worker);
    const stored = await storage.readWorker(grant.worker.workerId);
    assert.ok(stored);
    // Base capability labels are preserved and the Central-authoritative routing labels are minted from the binding.
    assert.equal(stored.labels.agent, 'browser-edge');
    assert.equal(stored.labels.role, 'device-scan-probe');
    assert.equal(stored.labels[EDGE_CASE_LABEL_KEY], 'case-1');
    assert.equal(stored.labels[EDGE_DEVICE_REF_LABEL_KEY], redeemed.deviceRef);
  });
});

test('scenario: client-supplied case/deviceRef labels are overridden by the authoritative binding values', async () => {
  await withCentral(async ({ storage, central }) => {
    await writeCase(storage, 'case-1');
    const redeemed = await redeemDevice(storage, central, 'case-1', 'device-A');

    // Adversarial: the worker tries to self-declare a DIFFERENT case and a forged deviceRef in its labels while
    // presenting a valid binding for (case-1, its real deviceRef). Central must ignore the self-declared values.
    const registration: WorkerRegisterPayload = {
      labels: baseBrowserLabels({ [EDGE_CASE_LABEL_KEY]: 'case-victim', [EDGE_DEVICE_REF_LABEL_KEY]: 'dref_forged' }),
      storageClass: 'host-managed',
      capacity: 1,
      allocatable: 1,
      edgeBinding: { caseId: redeemed.caseId, deviceId: 'device-A', deviceRef: redeemed.deviceRef, bindingCredential: redeemed.bindingCredential }
    };
    const grant = await central.negotiateSidecarConnectionForTenant('poc', context('device-A'), registration);
    assert.ok(grant.worker);
    const stored = await storage.readWorker(grant.worker.workerId);
    assert.ok(stored);
    assert.equal(stored.labels[EDGE_CASE_LABEL_KEY], 'case-1');
    assert.equal(stored.labels[EDGE_DEVICE_REF_LABEL_KEY], redeemed.deviceRef);
    assert.notEqual(stored.labels[EDGE_DEVICE_REF_LABEL_KEY], 'dref_forged');
  });
});

test('scenario: a worker with no binding cannot self-declare case/deviceRef routing labels', async () => {
  await withCentral(async ({ storage, central }) => {
    // No edgeBinding at all, but the client tries to self-assert routing labels. The keys must be stripped while
    // the ordinary capability labels still register the worker.
    const registration: WorkerRegisterPayload = {
      labels: baseBrowserLabels({ [EDGE_CASE_LABEL_KEY]: 'case-victim', [EDGE_DEVICE_REF_LABEL_KEY]: 'dref_forged' }),
      storageClass: 'host-managed',
      capacity: 1,
      allocatable: 1
    };
    const grant = await central.negotiateSidecarConnectionForTenant('poc', context('rogue'), registration);
    assert.ok(grant.worker);
    const stored = await storage.readWorker(grant.worker.workerId);
    assert.ok(stored);
    assert.equal(stored.labels[EDGE_CASE_LABEL_KEY], undefined);
    assert.equal(stored.labels[EDGE_DEVICE_REF_LABEL_KEY], undefined);
    assert.equal(stored.labels.agent, 'browser-edge');
  });
});

test('scenario: an invalid binding credential is rejected at negotiate', async () => {
  await withCentral(async ({ storage, central }) => {
    await writeCase(storage, 'case-1');
    const redeemed = await redeemDevice(storage, central, 'case-1', 'device-A');

    const registration: WorkerRegisterPayload = {
      labels: baseBrowserLabels(),
      storageClass: 'host-managed',
      capacity: 1,
      allocatable: 1,
      edgeBinding: { caseId: redeemed.caseId, deviceId: 'device-A', deviceRef: redeemed.deviceRef, bindingCredential: 'wrong-credential' }
    };
    await assert.rejects(
      () => central.negotiateSidecarConnectionForTenant('poc', context('device-A'), registration),
      (error: unknown) => error instanceof CasePairingError && error.code === 'binding_credential_invalid'
    );
    // No worker record leaked from the rejected registration.
    assert.equal((await storage.readWorkers()).length, 0);
  });
});

test('scenario: a forged deviceId with a real deviceRef but no matching binding is rejected', async () => {
  await withCentral(async ({ storage, central }) => {
    await writeCase(storage, 'case-1');
    const redeemed = await redeemDevice(storage, central, 'case-1', 'device-A');

    // The real deviceRef + credential belong to device-A; presenting device-B's self-asserted id must not resolve.
    const registration: WorkerRegisterPayload = {
      labels: baseBrowserLabels(),
      storageClass: 'host-managed',
      capacity: 1,
      allocatable: 1,
      edgeBinding: { caseId: redeemed.caseId, deviceId: 'device-B', deviceRef: redeemed.deviceRef, bindingCredential: redeemed.bindingCredential }
    };
    await assert.rejects(
      () => central.negotiateSidecarConnectionForTenant('poc', context('device-B'), registration),
      (error: unknown) => error instanceof CasePairingError && error.code === 'binding_credential_invalid'
    );
  });
});

