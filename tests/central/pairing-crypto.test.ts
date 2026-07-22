import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BearerCredentialProvider } from '../../src/central/managers';

test('scenario: a bearer credential round-trips only against its own salted verifier', () => {
  const provider = new BearerCredentialProvider();
  const { secret, hashed } = provider.issue();

  assert.equal(typeof secret, 'string');
  assert.ok(secret.length >= 32, 'secret is high-entropy');
  assert.ok(hashed.salt.length > 0, 'a per-secret salt is stored');
  // The stored verifier is non-reversible: it must not contain the plaintext secret.
  assert.notEqual(hashed.hash, secret);
  assert.ok(!hashed.hash.includes(secret));

  assert.equal(provider.verify(secret, hashed), true);
  assert.equal(provider.verify('not-the-secret', hashed), false);
  // Tampering with the stored salt breaks verification (the salt keys the HMAC).
  assert.equal(provider.verify(secret, { salt: 'tampered', hash: hashed.hash }), false);
});

test('scenario: two issues of the same provider get distinct salts and non-colliding verifiers', () => {
  const provider = new BearerCredentialProvider();
  const a = provider.issue();
  const b = provider.issue();
  assert.notEqual(a.hashed.salt, b.hashed.salt);
  assert.notEqual(a.hashed.hash, b.hashed.hash);
  // A secret only verifies against its own record — salts are not interchangeable.
  assert.equal(provider.verify(a.secret, b.hashed), false);
  assert.equal(provider.verify(b.secret, a.hashed), false);
});

test('scenario: a stolen verifier store alone is not offline-verifiable without the server pepper', () => {
  const withPepper = new BearerCredentialProvider('server-side-pepper');
  const { secret, hashed } = withPepper.issue();

  // The same salted secret, verified by a provider that lacks the pepper, does not match — so a leak of the
  // durable store (salt + hash) alone cannot be replayed without the separately held pepper.
  const noPepper = new BearerCredentialProvider('');
  assert.equal(noPepper.verify(secret, hashed), false);
  const wrongPepper = new BearerCredentialProvider('different-pepper');
  assert.equal(wrongPepper.verify(secret, hashed), false);
  // The correct pepper still verifies.
  assert.equal(withPepper.verify(secret, hashed), true);
});

test('scenario: malformed verifier inputs are rejected rather than throwing', () => {
  const provider = new BearerCredentialProvider();
  assert.equal(provider.verify('', { salt: 's', hash: 'h' }), false);
  assert.equal(provider.verify('secret', { salt: '', hash: '' }), false);
  assert.equal(provider.verify('secret', undefined as never), false);
});
