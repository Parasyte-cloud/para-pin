// Web Push VAPID (RFC 8292) — this is the auth mechanism that proves to a
// push service (FCM/Mozilla/Apple) that a push is coming from the party who
// registered the subscription, so a forged or malformed signature here is
// an actual authentication bypass, not just a delivery bug. Verified
// independently with Web Crypto against a real generated keypair, not just
// checked for "doesn't throw."
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signVapidJWT, encryptWebPushPayload, b64urlToBuf } from '../worker.js';

async function generateVapidKeyPair() {
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privateJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
  return { keyPair, privateJwk };
}

test('signVapidJWT produces a JWT whose signature independently verifies against the matching public key', async () => {
  const { keyPair, privateJwk } = await generateVapidKeyPair();
  const jwt = await signVapidJWT(privateJwk, 'https://fcm.googleapis.com', 'mailto:infra@parasyte.cloud');

  const [headerB64, payloadB64, sigB64] = jwt.split('.');
  const header = JSON.parse(new TextDecoder().decode(b64urlToBuf(headerB64)));
  const payload = JSON.parse(new TextDecoder().decode(b64urlToBuf(payloadB64)));
  assert.equal(header.alg, 'ES256');
  assert.equal(payload.aud, 'https://fcm.googleapis.com');
  assert.equal(payload.sub, 'mailto:infra@parasyte.cloud');
  assert.ok(payload.exp > Date.now() / 1000, 'exp should be in the future');
  assert.ok(payload.exp <= Date.now() / 1000 + 12 * 3600 + 5, 'exp should not exceed the documented 12h lifetime');

  const signedInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sigBytes = b64urlToBuf(sigB64);
  const verifyOk = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' }, keyPair.publicKey, sigBytes, signedInput
  );
  assert.equal(verifyOk, true, 'the JWT signature must verify against the actual signing key');
});

test('signVapidJWT signatures do not verify against an unrelated key', async () => {
  const { privateJwk } = await generateVapidKeyPair();
  const { keyPair: otherKeyPair } = await generateVapidKeyPair();
  const jwt = await signVapidJWT(privateJwk, 'https://fcm.googleapis.com', 'mailto:infra@parasyte.cloud');
  const [headerB64, payloadB64, sigB64] = jwt.split('.');
  const signedInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const verifyOk = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' }, otherKeyPair.publicKey, b64urlToBuf(sigB64), signedInput
  );
  assert.equal(verifyOk, false);
});

test('encryptWebPushPayload produces a well-formed aes128gcm record (RFC 8188 header) and fresh randomness per call', async () => {
  // Subscriber "keys" here are just random 65-byte (uncompressed P-256 point)
  // / 16-byte values in the right shape — encryptWebPushPayload only needs
  // a valid EC point to run ECDH against, it doesn't need a real browser
  // subscription on the other end for this structural test.
  const subscriberKeyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const p256dh = new Uint8Array(await crypto.subtle.exportKey('raw', subscriberKeyPair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const b64url = (bytes) => Buffer.from(bytes).toString('base64url');

  const payload = new TextEncoder().encode(JSON.stringify({ title: 'test' }));
  const record1 = await encryptWebPushPayload(payload, b64url(p256dh), b64url(auth));
  const record2 = await encryptWebPushPayload(payload, b64url(p256dh), b64url(auth));

  // header: salt(16) | recordSize(4) | idLen(1) | as_public(idLen bytes) | ciphertext
  assert.ok(record1.length > 16 + 4 + 1 + 65, 'record should contain salt + header + at least one ephemeral pubkey + ciphertext');
  const idLen = record1[20];
  assert.equal(idLen, 65, 'uncompressed P-256 public key should be 65 bytes');
  assert.notDeepEqual([...record1.slice(0, 16)], [...record2.slice(0, 16)], 'salt must be fresh per call');
  assert.notDeepEqual(
    [...record1.slice(21, 21 + idLen)], [...record2.slice(21, 21 + idLen)],
    'ephemeral public key must be fresh per call (this is what makes each push independently confidential)'
  );
});
