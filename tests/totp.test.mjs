// TOTP (RFC 6238) — hand-rolled because this project has no build step and
// didn't want to bolt an unvetted MFA dependency onto a security-critical
// auth path (see worker.js's comment above the TOTP section). Checked here
// against RFC 6238's own published test vectors, not just internal
// self-consistency, plus the time-skew tolerance and wrong-code rejection
// verifyTotpCode actually needs to get right in production.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base32Encode, base32Decode, generateTotpSecret, totpCodeForCounter, verifyTotpCode } from '../worker.js';

test('base32Encode/base32Decode round-trip', () => {
  const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 255, 254, 128]);
  const encoded = base32Encode(bytes);
  const decoded = base32Decode(encoded);
  assert.deepEqual([...decoded], [...bytes]);
});

test('generateTotpSecret produces a plausible base32 secret', () => {
  const a = generateTotpSecret();
  const b = generateTotpSecret();
  assert.match(a, /^[A-Z2-7]+$/);
  assert.notEqual(a, b, 'two calls should not produce the same secret');
});

test('totpCodeForCounter matches RFC 6238 Appendix B test vectors (SHA-1, 8-digit truncated to our 6)', async () => {
  // RFC 6238's test vectors use the ASCII string "12345678901234567890" as
  // the shared secret and are documented in hex/decimal, not base32 — this
  // project's totpCodeForCounter takes a base32 secret (what authenticator
  // apps actually scan from a QR code), so the secret below is that same
  // 20-byte value re-encoded as base32, and the expected codes are RFC
  // 6238's own published values, right-truncated from 8 digits to this
  // implementation's 6 (a smaller HOTP truncation length, same algorithm).
  const secretBytes = new TextEncoder().encode('12345678901234567890');
  const secretBase32 = base32Encode(secretBytes);

  // RFC 6238 Appendix B, T0=0, X=30s: T=59s -> counter 1 -> code 94287082
  const code1 = await totpCodeForCounter(secretBase32, 1);
  assert.equal(code1, '287082');

  // T=1111111109s -> counter 37037036 -> code 07081804
  const code2 = await totpCodeForCounter(secretBase32, 37037036);
  assert.equal(code2, '081804');

  // T=1111111111s -> counter 37037037 -> code 14050471
  const code3 = await totpCodeForCounter(secretBase32, 37037037);
  assert.equal(code3, '050471');
});

test('verifyTotpCode accepts the current code and rejects a wrong one', async () => {
  const secret = generateTotpSecret();
  const counter = Math.floor(Date.now() / 1000 / 30);
  const correctCode = await totpCodeForCounter(secret, counter);
  assert.equal(await verifyTotpCode(secret, correctCode), true);
  const wrongCode = String((Number(correctCode) + 1) % 1000000).padStart(6, '0');
  assert.equal(await verifyTotpCode(secret, wrongCode), false);
});

test('verifyTotpCode tolerates the adjacent time step (clock skew) but not two steps away', async () => {
  const secret = generateTotpSecret();
  const counter = Math.floor(Date.now() / 1000 / 30);
  const prevCode = await totpCodeForCounter(secret, counter - 1);
  const twoAgoCode = await totpCodeForCounter(secret, counter - 2);
  assert.equal(await verifyTotpCode(secret, prevCode), true, 'one step of skew should be accepted');
  assert.equal(await verifyTotpCode(secret, twoAgoCode), false, 'two steps of skew should be rejected');
});
