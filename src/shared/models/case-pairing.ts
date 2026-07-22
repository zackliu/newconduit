/**
 * A one-time, short-lived pairing invite minted by Central for a specific tenant + recovery case. The invite is the
 * ONLY secret that travels in the pairing link (carried in the URL fragment, never a query param), and it grants no
 * durable authority: a device redeems it exactly once to obtain a durable {@link CaseDeviceBindingRecord}. Central
 * stores only the salted hash of the secret; the plaintext secret exists solely in the mint response and the link.
 */
export interface PairingInviteRecord {
  inviteId: string;
  tenantId: string;
  caseId: string;
  /** Hash of the high-entropy invite secret. The plaintext is never persisted, logged, or echoed back. */
  inviteSecretHash: string;
  /** Per-invite random salt mixed (with the server pepper) into {@link inviteSecretHash}. */
  inviteSecretSalt: string;
  status: PairingInviteStatus;
  /** Absolute expiry; redeem is rejected once `now > expiresAt`. */
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  /** Set exactly once when the invite is consumed; a second redeem is rejected as replay. */
  redeemedAt?: string;
  /** The device binding this invite was consumed into, for audit. */
  redeemedDeviceRef?: string;
  revision: number;
}

export type PairingInviteStatus = 'pending' | 'redeemed' | 'revoked';

export interface CreatePairingInviteResult {
  invite: PairingInviteRecord;
  created: boolean;
}
