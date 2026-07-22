import assert from 'node:assert/strict';
import { test } from 'node:test';

/**
 * The scripted dev "brain" registers a REAL standalone Worker with central. Because it is an untyped `.mjs`,
 * TypeScript cannot guard its registration shape — that is exactly how a bare-string `description` slipped in
 * and made central reject the worker with HTTP 400. This test pins the exported builder to a central-valid
 * shape so the same regression cannot return silently: `description` must be a Record<string,string> (central's
 * isWorkerRegisterPayload rejects a bare string) and the labels must match the network-recovery-expert selector.
 */
const moduleUrl = new URL('../../dev/scripted-parent.mjs', import.meta.url);

type Registration = {
  centralUrl: string;
  tenantId: string;
  storageClass: string;
  labels: Record<string, unknown>;
  description: unknown;
  capacity: unknown;
  allocatable: unknown;
};

type ScriptedParentModule = {
  buildWorkerRegistration: (opts?: { centralUrl?: string; tenantId?: string }) => Registration;
};

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.values(value).every((entry) => typeof entry === 'string');
}

test('scripted-parent buildWorkerRegistration produces a central-valid registration shape', async () => {
  const mod = (await import(moduleUrl.href)) as ScriptedParentModule;
  const registration = mod.buildWorkerRegistration({ centralUrl: 'http://localhost:3000', tenantId: 'poc' });

  assert.ok(isStringRecord(registration.description), 'description must be a Record<string,string>, never a bare string');
  assert.ok(isStringRecord(registration.labels), 'labels must be a Record<string,string>');
  assert.equal(registration.labels.role, 'network-recovery-expert');
  assert.equal(registration.labels.storage, 'host-managed');
  assert.equal(registration.storageClass, 'host-managed');
  assert.equal(typeof registration.capacity, 'number');
  assert.equal(typeof registration.allocatable, 'number');
});

test('scripted-parent buildWorkerRegistration defaults the central url and tenant', async () => {
  const mod = (await import(moduleUrl.href)) as ScriptedParentModule;
  const registration = mod.buildWorkerRegistration();
  assert.equal(registration.centralUrl, 'http://localhost:3000');
  assert.equal(registration.tenantId, 'poc');
});
