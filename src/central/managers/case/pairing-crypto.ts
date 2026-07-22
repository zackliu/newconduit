import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Small, self-contained cryptographic helpers for the case-pairing binding model. They live in central (Node) only:
 * the browser mints its own `deviceId` and never trusts a client-derived `deviceRef` or route label. Bearer secrets
 * (invite secret, binding credential) are generated here, returned to the caller exactly once, and persisted only as
 * a salted (and optionally peppered) keyed hash — the plaintext is never stored, logged, or echoed.
 */

/** A high-entropy opaque token (hex). Used for invite secrets, durable binding credentials, and per-secret salts. */
export function randomToken(byteLength = 32): string {
  return randomBytes(byteLength).toString('hex');
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Central-authoritative, deterministic device reference for a `(tenant, case, device)` triple. Deterministic so a
 * browser that rejoins the same case maps to the same roster slot without a scan; opaque (a truncated hash) so it
 * leaks neither the raw `deviceId` nor any secret, and safe to use as a non-secret worker routing label.
 */
export function deriveDeviceRef(tenantId: string, caseId: string, deviceId: string): string {
  return `dref_${sha256Hex([tenantId, caseId, deviceId].join('\u0000')).slice(0, 40)}`;
}

/** Constant-time comparison of two equal-length hex digests. */
export function hashesMatch(left: string, right: string): boolean {
  if (left.length !== right.length || left.length === 0) {
    return false;
  }
  const leftBuf = Buffer.from(left, 'hex');
  const rightBuf = Buffer.from(right, 'hex');
  if (leftBuf.length !== rightBuf.length || leftBuf.length === 0) {
    return false;
  }
  return timingSafeEqual(leftBuf, rightBuf);
}

/** The persisted, non-reversible verifier for one bearer secret: a per-secret random salt plus its keyed hash. */
export interface HashedSecret {
  salt: string;
  hash: string;
}

/**
 * The narrow authorization primitive behind both the one-time invite secret and the durable binding credential.
 * v1 is a bearer scheme: {@link issue} mints a high-entropy secret and returns it once alongside the verifier to
 * persist; {@link verify} recomputes the verifier from a presented secret in constant time. It is deliberately a
 * small interface so a future asymmetric proof provider (signed challenge-response) can replace bearer verification
 * WITHOUT changing the pairing manager — we do not register or store an unused key that would imply we already
 * verify signatures.
 */
export interface BindingCredentialProvider {
  issue(): { secret: string; hashed: HashedSecret };
  verify(secret: string, hashed: HashedSecret): boolean;
}

/**
 * Default bearer provider. Each secret gets its own random salt; the stored verifier is `HMAC-SHA256(key = salt +
 * pepper, message = secret)`. The salt prevents cross-record hash correlation and the optional server-side `pepper`
 * (injected from a secret store in production; empty in the POC) means a leak of the durable store alone does not
 * yield offline-verifiable material. The plaintext secret is never persisted.
 */
export class BearerCredentialProvider implements BindingCredentialProvider {
  constructor(private readonly pepper = '') {}

  issue(): { secret: string; hashed: HashedSecret } {
    const secret = randomToken(32);
    const salt = randomToken(16);
    return { secret, hashed: { salt, hash: this.computeHash(secret, salt) } };
  }

  verify(secret: string, hashed: HashedSecret): boolean {
    if (typeof secret !== 'string' || secret.length === 0 || !hashed || typeof hashed.salt !== 'string' || typeof hashed.hash !== 'string') {
      return false;
    }
    return hashesMatch(this.computeHash(secret, hashed.salt), hashed.hash);
  }

  private computeHash(secret: string, salt: string): string {
    return createHmac('sha256', `${salt}${this.pepper}`).update(secret, 'utf8').digest('hex');
  }
}
