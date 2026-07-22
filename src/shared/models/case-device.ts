/**
 * The durable, Central-authoritative binding of one browser/device to one recovery case, created by redeeming a
 * {@link PairingInviteRecord}. It is both the case roster entry AND the device's authorization record:
 *
 * - `deviceId` is the device's own crypto-random, self-asserted identity — identity metadata, NOT authorization. It
 *   never travels in a URL and is never trusted on its own.
 * - `deviceRef` is Central-authoritative and deterministic per `(tenant, case, device)`, so a browser that rejoins
 *   maps to the same roster slot. It is the ONLY device-pinned label Central mints onto the worker; it is opaque
 *   (a hash) so it leaks neither the deviceId nor the invite secret.
 * - `bindingCredentialHash` is the authorization proof. Register/reconnect present the plaintext binding credential
 *   (returned once at redeem); Central re-mints the worker's `{ case, deviceRef }` labels only when it matches. A
 *   forged `deviceId` without the credential is rejected. v1 authorization is this bearer credential; a future
 *   asymmetric challenge-response is a code-level swap of the credential provider, so we do NOT persist an unused
 *   device key that would imply a signature handshake we have not built.
 */
export interface CaseDeviceBindingRecord {
  tenantId: string;
  caseId: string;
  deviceId: string;
  deviceRef: string;
  bindingCredentialHash: string;
  /** Per-credential random salt mixed (with the server pepper) into {@link bindingCredentialHash}. */
  bindingCredentialSalt: string;
  deviceLabel: string;
  /** The most recent worker lifetime that registered against this binding, for roster liveness joins. */
  workerId?: string;
  status: CaseDeviceBindingStatus;
  createdAt: string;
  updatedAt: string;
  /** Advances every time the invite/credential is (re)issued for this device. */
  lastRedeemedAt: string;
  lastRegisteredAt?: string;
  /** Set when the binding is explicitly revoked (device removal) or its case is closed; a revoked binding never routes. */
  revokedAt?: string;
  revision: number;
}

export type CaseDeviceBindingStatus = 'active' | 'revoked';

export interface CreateCaseDeviceBindingResult {
  binding: CaseDeviceBindingRecord;
  created: boolean;
}

/**
 * Safe, tenant- and case-scoped projection of a {@link CaseDeviceBindingRecord} joined with live worker state, for
 * the console roster. It deliberately omits the credential hash and the raw `deviceId`: an operator routes by the
 * opaque `deviceRef`, and availability (`online`/`ready`/`busy`) is derived from the paired worker's heartbeat so a
 * device shows up as joined the moment it registers — before any delegation, task, or observation.
 */
export interface CaseDeviceView {
  deviceRef: string;
  deviceLabel: string;
  /** A live worker is currently registered for this binding and its heartbeat is fresh. */
  online: boolean;
  /** Online and has free capacity to accept a delegated scan. */
  ready: boolean;
  /** Online but currently holding a session/turn (no free capacity). */
  busy: boolean;
  workerId?: string;
  lastHeartbeatAt?: string;
  lastRedeemedAt: string;
}
