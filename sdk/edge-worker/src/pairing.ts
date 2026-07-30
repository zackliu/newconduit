import { EDGE_WORKER_HTTP_PATHS, EDGE_WORKER_HTTP_QUERY, type PairingRedeemRequest, type PairingRedeemResult } from './protocol.js';
import { describeNegotiateFailure } from './negotiate-error.js';

/**
 * Input for the device enrollment step. `central`/`tenantId` are non-secret transport config; the `invite`
 * (`inviteId` + `inviteSecret`) is the one-time, short-lived pairing token the operator console minted and the
 * device read from the pair link's URL fragment. `deviceId` is the browser's own stable, self-minted opaque id.
 */
export interface RedeemPairingInviteInput {
  centralUrl: string;
  tenantId: string;
  inviteId: string;
  inviteSecret: string;
  deviceId: string;
  deviceLabel: string;
}

/**
 * Redeem a one-time pairing invite into a durable case-device binding. This is the honest authorization step of
 * the edge flow: it MUST be driven by an explicit user action (never automatically), it carries the invite secret
 * only in the POST body (never a query param or log), and it returns the Central-issued binding credential exactly
 * once. The caller stores `{ caseId, deviceRef, bindingCredential }` alongside its `deviceId` and presents them —
 * not the invite — on every subsequent register/reconnect.
 */
export async function redeemPairingInvite(input: RedeemPairingInviteInput): Promise<PairingRedeemResult> {
  const url = new URL(EDGE_WORKER_HTTP_PATHS.casePairingRedeem, input.centralUrl);
  url.searchParams.set(EDGE_WORKER_HTTP_QUERY.tenantId, input.tenantId);
  const body: PairingRedeemRequest = {
    inviteId: input.inviteId,
    inviteSecret: input.inviteSecret,
    deviceId: input.deviceId,
    deviceLabel: input.deviceLabel
  };
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`pairing redeem failed with ${await describeNegotiateFailure(response)}`);
  }
  return await response.json() as PairingRedeemResult;
}
