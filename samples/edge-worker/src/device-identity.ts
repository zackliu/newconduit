import { persist } from './config';

/**
 * The device's own stable, opaque identity — and the durable case binding it earns by redeeming an invite.
 *
 * Identity is self-minted in the browser and is NOT authorization: `deviceId` is a random opaque id (no browser
 * fingerprint, hardware serial, or UA-derived value). The device presents `deviceId` + the stored `bindingCredential`
 * on every register/reconnect; Central mints the routing labels from the credential, treating `deviceId` as metadata
 * only. v1 authorization is that bearer credential — we deliberately do NOT mint or register a device key, because an
 * unused key would imply a signed challenge-response we have not built. Adding asymmetric proof later is a coordinated
 * SDK + Central change, not a dormant browser key.
 */

const DEVICE_ID_KEY = 'deviceId';
const BINDING_KEY = 'binding';

export interface DeviceBinding {
  caseId: string;
  deviceRef: string;
  bindingCredential: string;
}

function readStored(key: string): string | undefined {
  try {
    return localStorage.getItem(`rnr.edge.${key}`) ?? undefined;
  } catch {
    return undefined;
  }
}

function randomId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `dev-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  }
}

/** Get this browser's stable opaque device id, minting and persisting one on first visit. */
export function getOrCreateDeviceId(): string {
  const existing = readStored(DEVICE_ID_KEY);
  if (existing) return existing;
  const id = randomId();
  persist(DEVICE_ID_KEY, id);
  return id;
}

export function readBinding(): DeviceBinding | undefined {
  const raw = readStored(BINDING_KEY);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<DeviceBinding>;
    if (typeof parsed.caseId === 'string' && typeof parsed.deviceRef === 'string' && typeof parsed.bindingCredential === 'string') {
      return { caseId: parsed.caseId, deviceRef: parsed.deviceRef, bindingCredential: parsed.bindingCredential };
    }
  } catch {
    /* corrupt — treat as unbound */
  }
  return undefined;
}

export function storeBinding(binding: DeviceBinding): void {
  persist(BINDING_KEY, JSON.stringify(binding));
}
