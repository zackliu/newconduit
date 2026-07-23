import type { CaseDeviceBindingRecord, CaseDeviceView, Clock, PairingInviteRecord, RuntimeStorage, SessionStatus, WorkerRecord } from '../../../shared';
import { BearerCredentialProvider, type BindingCredentialProvider, deriveDeviceRef, randomToken } from './pairing-crypto';

/**
 * Central-minted worker label keys for the case-pairing binding model. Both are stamped by Central from a validated
 * binding at registration and are NEVER trusted from a client: a browser that self-declares `case`/`deviceRef`
 * labels has them stripped and re-minted, so possession of a durable binding credential — not a self-asserted
 * identity — is what authorizes routing to a device.
 */
export const EDGE_CASE_LABEL_KEY = 'case';
export const EDGE_DEVICE_REF_LABEL_KEY = 'deviceRef';

const DEFAULT_INVITE_TTL_MS = 10 * 60_000;

// A case (recovery session) in one of these states is closed: no new invite may be minted or redeemed into it, and
// its device bindings are revoked so a lingering credential can no longer route.
const TERMINAL_CASE_STATUSES: ReadonlySet<SessionStatus> = new Set<SessionStatus>(['completed', 'cancelled', 'failed']);

// Bounded inputs: every device-supplied field has an explicit ceiling so a redeem/register cannot carry an unbounded
// label or secret into durable state.
const MAX_DEVICE_ID_LENGTH = 128;
const MAX_DEVICE_LABEL_LENGTH = 200;
const MAX_SECRET_LENGTH = 256;

export type CasePairingErrorCode =
  | 'case_not_found'
  | 'case_closed'
  | 'invite_not_found'
  | 'invite_expired'
  | 'invite_already_redeemed'
  | 'invite_secret_invalid'
  | 'binding_not_found'
  | 'binding_credential_invalid'
  | 'invalid_input';

/** A typed, sanitized failure for the pairing flow. `code` is safe to surface to a client; `message` carries no secret. */
export class CasePairingError extends Error {
  constructor(readonly code: CasePairingErrorCode, message: string) {
    super(message);
    this.name = 'CasePairingError';
  }
}

export interface MintPairingInviteResult {
  inviteId: string;
  /** Plaintext invite secret — returned exactly once, carried only in the pair link fragment, never persisted. */
  inviteSecret: string;
  caseId: string;
  expiresAt: string;
}

export interface RedeemPairingInput {
  inviteId: string;
  inviteSecret: string;
  deviceId: string;
  deviceLabel: string;
}

export interface RedeemPairingResult {
  caseId: string;
  deviceRef: string;
  /** Plaintext binding credential — returned exactly once; presented on every register/reconnect, never the invite. */
  bindingCredential: string;
}

export interface ResolveEdgeBindingInput {
  caseId: string;
  deviceId: string;
  deviceRef: string;
  bindingCredential: string;
}

export interface ResolvedEdgeBinding {
  caseId: string;
  deviceRef: string;
  /** Central-authoritative labels to stamp onto the worker, replacing any client-supplied `case`/`deviceRef`. */
  mintedLabels: Record<string, string>;
}

export interface CasePairingManagerOptions {
  inviteTtlMs?: number;
  /**
   * Optional server-side pepper folded into every stored verifier by the default bearer provider, so a leak of the
   * durable store alone is not offline-verifiable. Inject from a secret store in production; empty in the POC.
   */
  credentialPepper?: string;
  /** Override the bearer credential provider — the single swap point for a future asymmetric proof scheme. */
  credentialProvider?: BindingCredentialProvider;
}

/**
 * Tenant-scoped owner of the case-pairing binding model: it mints one-time invites, redeems them into durable
 * device bindings, validates a device's binding credential at registration (minting the routing labels), and
 * projects the case roster. It is the single authority that turns a self-asserted device identity into an
 * authorized, case-scoped routing label — closing the earlier hole where a client could self-declare a pairing
 * label. Everything is scoped to one `tenantId`; a foreign-tenant invite/binding is treated as not found.
 */
export class CasePairingManager {
  private readonly inviteTtlMs: number;
  private readonly credentials: BindingCredentialProvider;
  private readonly caseOperations = new Map<string, Promise<void>>();

  constructor(
    private readonly tenantId: string,
    private readonly storage: RuntimeStorage,
    private readonly clock: Clock,
    options: CasePairingManagerOptions = {}
  ) {
    this.inviteTtlMs = options.inviteTtlMs ?? DEFAULT_INVITE_TTL_MS;
    this.credentials = options.credentialProvider ?? new BearerCredentialProvider(options.credentialPepper ?? '');
  }

  async authorizeCaseAccess(caseId: string, principalId: string): Promise<void> {
    this.requireNonEmpty(caseId, 'caseId');
    this.requireNonEmpty(principalId, 'principalId');
    const session = await this.storage.readSession(caseId);
    if (!session || session.tenantId !== this.tenantId || session.owner !== principalId) {
      throw new CasePairingError('case_not_found', `case ${caseId} is not an owned session`);
    }
  }

  /**
   * Mint a one-time, short-lived invite for a case the operator owns. The case must be an existing, non-terminal
   * session in this tenant, so a client cannot mint invites for arbitrary, foreign, or closed case ids. Only a
   * salted (and optionally peppered) keyed hash of the secret is stored; the plaintext is returned once for the link.
   */
  async mintPairingInvite(caseId: string): Promise<MintPairingInviteResult> {
    this.requireNonEmpty(caseId, 'caseId');
    const session = await this.storage.readSession(caseId);
    if (!session || session.tenantId !== this.tenantId) {
      throw new CasePairingError('case_not_found', `case ${caseId} is not an owned session`);
    }
    if (TERMINAL_CASE_STATUSES.has(session.status)) {
      throw new CasePairingError('case_closed', `case ${caseId} is closed`);
    }
    const now = this.clock.now();
    const inviteId = randomToken(16);
    const { secret: inviteSecret, hashed } = this.credentials.issue();
    const expiresAt = new Date(Date.parse(now) + this.inviteTtlMs).toISOString();
    const record: PairingInviteRecord = {
      inviteId,
      tenantId: this.tenantId,
      caseId,
      inviteSecretHash: hashed.hash,
      inviteSecretSalt: hashed.salt,
      status: 'pending',
      expiresAt,
      createdAt: now,
      updatedAt: now,
      revision: 1
    };
    const created = await this.storage.createPairingInvite(record);
    if (!created.created) {
      // inviteId is 128 bits of entropy; a collision is a storage-invariant failure, not an expected path.
      throw new CasePairingError('invalid_input', 'invite id collision');
    }
    return { inviteId, inviteSecret, caseId, expiresAt };
  }

  /**
   * Redeem a one-time invite into a durable device binding. Validates existence, tenant, pending status, expiry, and
   * the invite secret, then atomically claims the invite (compare-and-set pending→redeemed) so a replayed or
   * concurrent second redeem is rejected. Only after the claim wins is the binding created/rotated and a fresh
   * binding credential returned once. Re-redeeming for the same device (a new invite) rotates the credential but
   * keeps the same deterministic `deviceRef`.
   */
  async redeemPairingInvite(input: RedeemPairingInput): Promise<RedeemPairingResult> {
    const deviceId = this.requireBounded(input.deviceId, MAX_DEVICE_ID_LENGTH, 'deviceId');
    const deviceLabel = this.requireBounded(input.deviceLabel, MAX_DEVICE_LABEL_LENGTH, 'deviceLabel');
    const inviteSecret = this.requireBounded(input.inviteSecret, MAX_SECRET_LENGTH, 'inviteSecret');
    this.requireNonEmpty(input.inviteId, 'inviteId');

    const initialInvite = await this.storage.readPairingInvite(input.inviteId);
    if (!initialInvite || initialInvite.tenantId !== this.tenantId) {
      throw new CasePairingError('invite_not_found', 'pairing invite not found');
    }
    return this.serializeCaseOperation(initialInvite.caseId, async () => {
      const invite = await this.storage.readPairingInvite(input.inviteId);
      if (!invite || invite.tenantId !== this.tenantId || invite.caseId !== initialInvite.caseId) {
        throw new CasePairingError('invite_not_found', 'pairing invite not found');
      }
      if (invite.status !== 'pending' || invite.redeemedAt) {
        throw new CasePairingError('invite_already_redeemed', 'pairing invite already used');
      }
      if (Date.parse(invite.expiresAt) <= Date.parse(this.clock.now())) {
        throw new CasePairingError('invite_expired', 'pairing invite expired');
      }
      if (!this.credentials.verify(inviteSecret, { hash: invite.inviteSecretHash, salt: invite.inviteSecretSalt })) {
        throw new CasePairingError('invite_secret_invalid', 'pairing invite secret invalid');
      }

      const caseId = invite.caseId;
      const session = await this.storage.readSession(caseId);
      if (!session || session.tenantId !== this.tenantId) {
        throw new CasePairingError('case_not_found', 'case is not an owned session');
      }
      if (TERMINAL_CASE_STATUSES.has(session.status)) {
        throw new CasePairingError('case_closed', 'case is closed');
      }
      const deviceRef = deriveDeviceRef(this.tenantId, caseId, deviceId);
      const now = this.clock.now();

      const claimed = await this.storage.compareAndSetPairingInvite(invite.revision, {
        ...invite,
        status: 'redeemed',
        redeemedAt: now,
        redeemedDeviceRef: deviceRef,
        updatedAt: now,
        revision: invite.revision + 1
      });
      if (!claimed) {
        throw new CasePairingError('invite_already_redeemed', 'pairing invite already used');
      }

      const { secret: bindingCredential, hashed } = this.credentials.issue();
      await this.upsertBinding({ caseId, deviceId, deviceRef, deviceLabel, bindingCredentialHash: hashed.hash, bindingCredentialSalt: hashed.salt, now });
      return { caseId, deviceRef, bindingCredential };
    });
  }

  /**
   * Validate the binding credential a worker presents at register/reconnect and return the Central-minted routing
   * labels. This is the authorization gate: a forged or unbound `deviceId`, a wrong `deviceRef`, or an invalid
   * credential is rejected, so a device is routable only after it has redeemed a real invite. The self-asserted
   * `deviceId` alone never authorizes anything.
   */
  async resolveEdgeBinding(input: ResolveEdgeBindingInput): Promise<ResolvedEdgeBinding> {
    const deviceId = this.requireBounded(input.deviceId, MAX_DEVICE_ID_LENGTH, 'deviceId');
    const bindingCredential = this.requireBounded(input.bindingCredential, MAX_SECRET_LENGTH, 'bindingCredential');
    this.requireNonEmpty(input.caseId, 'caseId');
    this.requireNonEmpty(input.deviceRef, 'deviceRef');

    const binding = await this.storage.readCaseDeviceBinding(input.caseId, input.deviceRef);
    if (!binding || binding.tenantId !== this.tenantId || binding.status !== 'active') {
      throw new CasePairingError('binding_not_found', 'device binding not found');
    }
    // Defense in depth: a credential is dead the instant its owning case closes, even if the asynchronous revocation
    // driven by the terminal transition has not persisted yet. This closes the race where a worker could still
    // negotiate/reconnect into a just-closed case. Pause/resume are NOT terminal, so a paused case keeps its bindings
    // and a suspended device can reconnect.
    const caseSession = await this.storage.readSession(binding.caseId);
    if (!caseSession || caseSession.tenantId !== this.tenantId || TERMINAL_CASE_STATUSES.has(caseSession.status)) {
      throw new CasePairingError('case_closed', 'case is closed');
    }
    if (binding.deviceId !== deviceId || binding.deviceRef !== deriveDeviceRef(this.tenantId, input.caseId, deviceId)) {
      throw new CasePairingError('binding_credential_invalid', 'device binding identity mismatch');
    }
    if (!this.credentials.verify(bindingCredential, { hash: binding.bindingCredentialHash, salt: binding.bindingCredentialSalt })) {
      throw new CasePairingError('binding_credential_invalid', 'device binding credential invalid');
    }
    return {
      caseId: binding.caseId,
      deviceRef: binding.deviceRef,
      mintedLabels: { [EDGE_CASE_LABEL_KEY]: binding.caseId, [EDGE_DEVICE_REF_LABEL_KEY]: binding.deviceRef }
    };
  }

  /**
   * Case-scoped roster for the operator console: every device that has redeemed into this case, joined with live
   * worker state so a device shows as online the moment it registers — before any delegation or observation. The
   * projection omits the credential hash and raw `deviceId`; the operator routes by the opaque `deviceRef`.
   */
  async listCaseDevices(caseId: string): Promise<CaseDeviceView[]> {
    this.requireNonEmpty(caseId, 'caseId');
    const bindings = (await this.storage.readCaseDeviceBindings(caseId)).filter(
      (binding) => binding.tenantId === this.tenantId && binding.status === 'active'
    );
    if (bindings.length === 0) {
      return [];
    }
    const now = Date.parse(this.clock.now());
    const workers = (await this.storage.readWorkers()).filter((worker) => worker.tenantId === this.tenantId);
    return bindings
      .map((binding) => this.toCaseDeviceView(binding, workers, now))
      .sort((left, right) => left.deviceLabel.localeCompare(right.deviceLabel) || left.deviceRef.localeCompare(right.deviceRef));
  }

  private toCaseDeviceView(binding: CaseDeviceBindingRecord, workers: WorkerRecord[], now: number): CaseDeviceView {
    const worker = this.newestLiveWorkerForBinding(binding, workers);
    const online = worker !== undefined && worker.lifecycleState === 'active' && Date.parse(worker.expiresAt) > now;
    const ready = online && worker!.conditions.includes('ready') && worker!.allocatable > 0;
    const busy = online && !ready;
    return {
      deviceRef: binding.deviceRef,
      deviceLabel: binding.deviceLabel,
      online,
      ready,
      busy,
      workerId: worker?.workerId,
      lastHeartbeatAt: worker?.heartbeatAt,
      lastRedeemedAt: binding.lastRedeemedAt
    };
  }

  private newestLiveWorkerForBinding(binding: CaseDeviceBindingRecord, workers: WorkerRecord[]): WorkerRecord | undefined {
    return workers
      .filter((worker) =>
        worker.lifecycleState !== 'closed'
        && worker.lifecycleState !== 'expired'
        && worker.labels[EDGE_CASE_LABEL_KEY] === binding.caseId
        && worker.labels[EDGE_DEVICE_REF_LABEL_KEY] === binding.deviceRef)
      .sort((left, right) => Date.parse(right.registeredAt ?? right.heartbeatAt) - Date.parse(left.registeredAt ?? left.heartbeatAt))
      .at(0);
  }

  private async upsertBinding(input: {
    caseId: string;
    deviceId: string;
    deviceRef: string;
    deviceLabel: string;
    bindingCredentialHash: string;
    bindingCredentialSalt: string;
    now: string;
  }): Promise<void> {
    const existing = await this.storage.readCaseDeviceBinding(input.caseId, input.deviceRef);
    if (!existing) {
      const record: CaseDeviceBindingRecord = {
        tenantId: this.tenantId,
        caseId: input.caseId,
        deviceId: input.deviceId,
        deviceRef: input.deviceRef,
        bindingCredentialHash: input.bindingCredentialHash,
        bindingCredentialSalt: input.bindingCredentialSalt,
        deviceLabel: input.deviceLabel,
        status: 'active',
        createdAt: input.now,
        updatedAt: input.now,
        lastRedeemedAt: input.now,
        revision: 1
      };
      const created = await this.storage.createCaseDeviceBinding(record);
      if (created.created) {
        return;
      }
      throw new CasePairingError('invalid_input', 'device binding was created concurrently');
    }
    // Redeeming a fresh invite rotates the credential and re-activates a previously revoked device: revocation
    // invalidates the current credential, it is not a permanent ban, so a new operator-authorized invite re-admits.
    const { revokedAt: _revoked, ...retained } = existing;
    const next: CaseDeviceBindingRecord = {
      ...retained,
      deviceLabel: input.deviceLabel,
      bindingCredentialHash: input.bindingCredentialHash,
      bindingCredentialSalt: input.bindingCredentialSalt,
      status: 'active',
      updatedAt: input.now,
      lastRedeemedAt: input.now,
      revision: existing.revision + 1
    };
    const rotated = await this.storage.compareAndSetCaseDeviceBinding(existing.revision, next);
    if (!rotated) {
      throw new CasePairingError('invalid_input', 'device binding was updated concurrently');
    }
  }

  /**
   * Explicitly revoke one device's binding (operator removes a device from the case). The binding is kept for audit
   * but marked `revoked`, so {@link resolveEdgeBinding} rejects its credential at the next register/reconnect and the
   * roster drops it. Returns false only if the binding is absent or already revoked.
   */
  async revokeDevice(caseId: string, deviceRef: string): Promise<boolean> {
    this.requireNonEmpty(caseId, 'caseId');
    this.requireNonEmpty(deviceRef, 'deviceRef');
    return this.serializeCaseOperation(caseId, async () => {
      const binding = await this.storage.readCaseDeviceBinding(caseId, deviceRef);
      if (!binding || binding.tenantId !== this.tenantId || binding.status !== 'active') {
        return false;
      }
      return this.markBindingRevoked(binding);
    });
  }

  /**
   * Revoke every active binding on a case (case close). Idempotent: already-revoked bindings are skipped. Combined
   * with the terminal-case guard on redeem, a closed case can neither keep routing to enrolled devices nor admit a
   * new one from a still-pending invite.
   */
  async revokeCase(caseId: string): Promise<number> {
    this.requireNonEmpty(caseId, 'caseId');
    return this.serializeCaseOperation(caseId, async () => {
      const bindings = (await this.storage.readCaseDeviceBindings(caseId)).filter(
        (binding) => binding.tenantId === this.tenantId && binding.status === 'active'
      );
      let revoked = 0;
      for (const binding of bindings) {
        if (await this.markBindingRevoked(binding)) {
          revoked += 1;
        }
      }
      return revoked;
    });
  }

  async reconcileTerminalCases(): Promise<void> {
    const terminalCases = (await this.storage.readSessions()).filter(
      (session) => session.tenantId === this.tenantId && TERMINAL_CASE_STATUSES.has(session.status)
    );
    for (const session of terminalCases) {
      await this.revokeCase(session.sessionId);
    }
  }

  private async markBindingRevoked(binding: CaseDeviceBindingRecord): Promise<boolean> {
    const now = this.clock.now();
    return this.storage.compareAndSetCaseDeviceBinding(binding.revision, {
      ...binding,
      status: 'revoked',
      revokedAt: now,
      updatedAt: now,
      revision: binding.revision + 1
    });
  }

  private requireNonEmpty(value: string, field: string): void {
    if (typeof value !== 'string' || value.length === 0) {
      throw new CasePairingError('invalid_input', `${field} is required`);
    }
  }

  private requireBounded(value: string, max: number, field: string): string {
    if (typeof value !== 'string' || value.length === 0 || value.length > max) {
      throw new CasePairingError('invalid_input', `${field} is required and must be at most ${max} characters`);
    }
    return value;
  }

  private serializeCaseOperation<T>(caseId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.caseOperations.get(caseId) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.caseOperations.set(caseId, tail);
    void tail.finally(() => {
      if (this.caseOperations.get(caseId) === tail) {
        this.caseOperations.delete(caseId);
      }
    });
    return result;
  }
}
