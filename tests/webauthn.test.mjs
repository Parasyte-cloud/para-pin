// WebAuthn (passkeys/hardware keys) — the pieces worth testing directly are
// the hand-rolled binary/CBOR parsing (no library available in Workers) and
// the DER<->raw ECDSA signature conversion, since a subtly wrong byte offset
// or ASN.1 length calculation here would silently accept or reject the
// wrong signatures. Builds real fixtures with Node's own WebCrypto (a real
// P-256 keypair, a real ECDSA signature over real bytes) rather than just
// asserting against pre-computed constants, so this exercises the actual
// verify path end to end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cborDecode, parseAuthenticatorData, coseKeyToEcPoint, derSignatureToRaw, verifyWebauthnAssertion,
} from '../worker.js';

function concat(...arrs) {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}
function u16be(n) { return new Uint8Array([(n >> 8) & 0xff, n & 0xff]); }
function u32be(n) { return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]); }

// Minimal CBOR encoder, just enough to build a COSE_Key map matching the
// exact shape cborDecode/coseKeyToEcPoint expect: {1:2, 3:-7, -1:1, -2:x, -3:y}.
function cborEncodeCoseKey(x, y) {
  function negInt(n) { return new Uint8Array([0x20 | (-1 - n)]); } // major type 1
  function byteString32(bytes) { return concat(new Uint8Array([0x58, 0x20]), bytes); } // major type 2, 1-byte length prefix (32)
  return concat(
    new Uint8Array([0xa5]), // map, 5 pairs
    new Uint8Array([0x01]), new Uint8Array([0x02]),       // 1: 2 (kty: EC2)
    new Uint8Array([0x03]), negInt(-7),                    // 3: -7 (alg: ES256)
    negInt(-1), new Uint8Array([0x01]),                    // -1: 1 (crv: P-256)
    negInt(-2), byteString32(x),                           // -2: x
    negInt(-3), byteString32(y),                           // -3: y
  );
}

// Real ASN.1 DER encoder for an (r,s) pair — the inverse of derSignatureToRaw,
// used here only to turn Web Crypto's raw P1363 signature output into the
// DER shape a real browser's WebAuthn API actually returns, so the test
// exercises derSignatureToRaw for real rather than assuming it.
function rawSigToDer(raw) {
  function encInt(bytes) {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    let b = bytes.slice(i);
    if (b[0] & 0x80) b = concat(new Uint8Array([0]), b);
    return concat(new Uint8Array([0x02, b.length]), b);
  }
  const rEnc = encInt(raw.slice(0, 32));
  const sEnc = encInt(raw.slice(32, 64));
  const seq = concat(rEnc, sEnc);
  return concat(new Uint8Array([0x30, seq.length]), seq);
}

test('cborDecode + coseKeyToEcPoint recover the x/y coordinates encoded in a COSE_Key map', () => {
  const x = crypto.getRandomValues(new Uint8Array(32));
  const y = crypto.getRandomValues(new Uint8Array(32));
  const cose = cborEncodeCoseKey(x, y);
  const { value: coseKey } = cborDecode(cose, 0);
  assert.ok(coseKey instanceof Map);
  const point = coseKeyToEcPoint(coseKey);
  assert.ok(point, 'should recognize a valid EC2/ES256/P-256 COSE key');
  assert.deepEqual([...point.x], [...x]);
  assert.deepEqual([...point.y], [...y]);
});

test('coseKeyToEcPoint rejects a key claiming the wrong algorithm', () => {
  const badMap = new Map([[1, 2], [3, -257 /* RS256, not ES256 */], [-1, 1], [-2, new Uint8Array(32)], [-3, new Uint8Array(32)]]);
  assert.equal(coseKeyToEcPoint(badMap), null);
});

test('parseAuthenticatorData extracts flags, signCount, and an attested COSE key', () => {
  const rpIdHash = crypto.getRandomValues(new Uint8Array(32));
  const x = crypto.getRandomValues(new Uint8Array(32));
  const y = crypto.getRandomValues(new Uint8Array(32));
  const credId = crypto.getRandomValues(new Uint8Array(16));
  const flags = new Uint8Array([0x01 | 0x40]); // user present + attested credential data included
  const signCount = u32be(7);
  const aaguid = new Uint8Array(16);
  const authData = concat(rpIdHash, flags, signCount, aaguid, u16be(credId.length), credId, cborEncodeCoseKey(x, y));

  const parsed = parseAuthenticatorData(authData);
  assert.equal(parsed.userPresent, true);
  assert.equal(parsed.attestedCredentialDataIncluded, true);
  assert.equal(parsed.signCount, 7);
  assert.deepEqual([...parsed.credentialId], [...credId]);
  const point = coseKeyToEcPoint(parsed.coseKey);
  assert.deepEqual([...point.x], [...x]);
  assert.deepEqual([...point.y], [...y]);
});

test('verifyWebauthnAssertion accepts a genuinely signed assertion and rejects tampering/wrong key', async () => {
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const rawPublic = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey)); // 0x04 || x(32) || y(32)
  const x = rawPublic.slice(1, 33);
  const y = rawPublic.slice(33, 65);

  const rpIdHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('chat.parasyte.cloud')));
  const authenticatorData = concat(rpIdHash, new Uint8Array([0x01]), u32be(8)); // no attested cred data on an assertion
  const clientDataJSON = new TextEncoder().encode(JSON.stringify({
    type: 'webauthn.get', challenge: 'dGVzdC1jaGFsbGVuZ2U', origin: 'https://chat.parasyte.cloud',
  }));
  const clientDataHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataJSON));
  const signedData = concat(authenticatorData, clientDataHash);

  const rawSig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keyPair.privateKey, signedData));
  const derSig = rawSigToDer(rawSig);

  // Round-trip check on the DER<->raw conversion itself before trusting the full verify below.
  assert.deepEqual([...derSignatureToRaw(derSig)], [...rawSig]);

  const ok = await verifyWebauthnAssertion(x, y, authenticatorData, clientDataJSON, derSig);
  assert.equal(ok, true, 'a genuinely signed assertion should verify');

  const tamperedClientData = new TextEncoder().encode(JSON.stringify({
    type: 'webauthn.get', challenge: 'DIFFERENT-CHALLENGE', origin: 'https://chat.parasyte.cloud',
  }));
  const tamperedOk = await verifyWebauthnAssertion(x, y, authenticatorData, tamperedClientData, derSig);
  assert.equal(tamperedOk, false, 'a signature over different client data must not verify');

  const otherKeyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const otherRaw = new Uint8Array(await crypto.subtle.exportKey('raw', otherKeyPair.publicKey));
  const wrongKeyOk = await verifyWebauthnAssertion(otherRaw.slice(1, 33), otherRaw.slice(33, 65), authenticatorData, clientDataJSON, derSig);
  assert.equal(wrongKeyOk, false, 'a signature must not verify against an unrelated public key');
});
