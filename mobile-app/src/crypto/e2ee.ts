// Byte-for-byte parity with index.html's E2EE implementation
// (index.html:~10340-10445). Every constant, algorithm, and byte-layout
// choice here was read directly out of that file, not guessed — this has
// to interop with the web client, so "close enough" isn't good enough.
//
// Scheme, confirmed against index.html:
//   - P-256 ECDH keypair per device, public key published server-side.
//   - Web's `crypto.subtle.exportKey('raw', pub)` is SEC1 UNCOMPRESSED
//     (0x04 || X || Y, 65 bytes) — so every public key here uses
//     p256.getPublicKey(secretKey, false), never the compressed default.
//   - Web's `crypto.subtle.deriveBits({name:'ECDH', public}, priv, 256)`
//     returns exactly the 32-byte shared-secret X coordinate, NO format
//     prefix. @noble/curves' getSharedSecret returns the full SEC1 point
//     instead (prefix + X + Y), so this module explicitly slices out
//     bytes [1, 33) to match — get this wrong and every derived key is
//     silently different from the web app's, with no error, just messages
//     that never decrypt.
//   - HKDF-SHA256, salt = 32 zero bytes, info = a fixed ASCII string
//     constant, 256-bit output, used directly as a raw AES-256-GCM key.
//   - AES-GCM, 12-byte random IV per encrypt call, default 128-bit tag
//     (both WebCrypto and @noble/ciphers default here, so ciphertext+tag
//     byte layout matches with no extra handling needed).
//
// This file implements the CURRENT wrap-based scheme (same for DMs and
// groups — see e2ee.ts's ensureChatKey) plus the legacy pre-multi-device
// pairwise-DM-key derivation (E2EE_DM_INFO, deriveLegacyDmKey below) used
// as a decrypt-only fallback for old DM history — see decryptWithFallback
// in state/messages.ts and the important caveat documented there: this
// fallback only ever succeeds on the ORIGINAL device an account's legacy
// key was frozen against, by construction (see index.html:10328-10332)
// — mobile, as a newly-added second device, can derive the fallback key
// but it will not match ciphertext from before mobile was linked.

import { p256 } from '@noble/curves/nist.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { gcm } from '@noble/ciphers/aes.js';
import { bufToB64, b64ToBuf } from './base64';

// Matches index.html:10343 exactly — do not change without changing the
// web app too, this is the AAD-equivalent "info" string every wrap and
// every DM key derivation is bound to.
export const E2EE_GROUP_WRAP_INFO = 'PArA-PIN-GroupWrap-v1';
// Matches index.html:10342 — legacy pre-multi-device pairwise DM key info
// string. Decrypt-only fallback, see the module comment above.
export const E2EE_DM_INFO = 'PArA-PIN-DM-v1';

const HKDF_SALT = new Uint8Array(32); // 32 zero bytes, matches index.html:10421
const IV_LENGTH = 12;

export interface KeyPair {
  secretKey: Uint8Array; // 32 bytes
  publicKeyB64: string; // 65-byte uncompressed SEC1 point, base64
}

export function generateKeyPair(): KeyPair {
  const secretKey = p256.utils.randomSecretKey();
  const publicKey = p256.getPublicKey(secretKey, false); // false = uncompressed, matches web's 'raw' export
  return { secretKey, publicKeyB64: bufToB64(publicKey) };
}

// The ECDH step: shared X-coordinate only (32 bytes), matching
// crypto.subtle.deriveBits({name:'ECDH', public}, priv, 256) exactly —
// see the module comment above for why the noble output needs slicing.
function ecdhSharedX(mySecretKey: Uint8Array, theirPublicKeyB64: string): Uint8Array {
  const theirPub = b64ToBuf(theirPublicKeyB64);
  const sharedPoint = p256.getSharedSecret(mySecretKey, theirPub, false); // 65 bytes: 0x04 || X || Y
  return sharedPoint.slice(1, 33); // X only, 32 bytes
}

// Returns a raw 32-byte AES-256-GCM key, matching e2eeDeriveAesKey's
// output (index.html:10416-10424) — that function returns an opaque
// CryptoKey, but since @noble/ciphers' gcm() takes raw key bytes directly,
// there's no non-extractable-key equivalent to preserve here; the raw
// bytes are the key either way.
export function deriveAesKey(mySecretKey: Uint8Array, theirPublicKeyB64: string, infoStr: string): Uint8Array {
  const sharedX = ecdhSharedX(mySecretKey, theirPublicKeyB64);
  const info = new TextEncoder().encode(infoStr);
  return hkdf(sha256, sharedX, HKDF_SALT, info, 32);
}

export function encryptString(keyBytes: Uint8Array, plaintext: string): { iv: string; ciphertext: string } {
  const iv = randomBytes(IV_LENGTH);
  const ct = gcm(keyBytes, iv).encrypt(new TextEncoder().encode(plaintext));
  return { iv: bufToB64(iv), ciphertext: bufToB64(ct) };
}

export function decryptString(keyBytes: Uint8Array, ivB64: string, ciphertextB64: string): string {
  const iv = b64ToBuf(ivB64);
  const ct = b64ToBuf(ciphertextB64);
  const pt = gcm(keyBytes, iv).decrypt(ct);
  return new TextDecoder().decode(pt);
}

// Raw-byte variants for attachments (index.html's e2eeEncryptBytes /
// e2eeDecryptBytes, index.html:10436-10444) — same AES-256-GCM, just no
// UTF-8 text encode/decode step, since the plaintext is arbitrary file
// bytes (image/file/voice-note data) rather than a string.
export function decryptBytes(keyBytes: Uint8Array, ivB64: string, ciphertext: Uint8Array): Uint8Array {
  const iv = b64ToBuf(ivB64);
  return gcm(keyBytes, iv).decrypt(ciphertext);
}

export function encryptBytes(keyBytes: Uint8Array, plaintext: Uint8Array): { iv: string; bytes: Uint8Array } {
  const iv = randomBytes(IV_LENGTH);
  const ct = gcm(keyBytes, iv).encrypt(plaintext);
  return { iv: bufToB64(iv), bytes: ct };
}

// Legacy pairwise DM key (index.html:10416-10425's e2eeDeriveAesKey called
// with E2EE_DM_INFO, index.html:10497-10506's ensureLegacyDmKey) — derived
// from MY device's private key and the peer's frozen legacy public key.
// Decrypt-only fallback for DM history from before multi-device shipped.
export function deriveLegacyDmKey(mySecretKey: Uint8Array, peerLegacyPublicKeyB64: string): Uint8Array {
  return deriveAesKey(mySecretKey, peerLegacyPublicKeyB64, E2EE_DM_INFO);
}

// Group-key wrap primitives — DMs and groups use the identical scheme now
// (index.html:10554-10560's comment is explicit about this), a random
// per-chat key wrapped once per member device via a fresh ephemeral ECDH
// exchange each time, rather than DMs deriving a fixed pairwise key.

export function generateRawChatKey(): Uint8Array {
  return randomBytes(32);
}

export interface Wrap {
  ephemeralPub: string;
  iv: string;
  wrapped: string;
}

export function wrapRawKeyForDevice(rawKey: Uint8Array, devicePubB64: string): Wrap {
  const ephemeral = generateKeyPair();
  const wrapKey = deriveAesKey(ephemeral.secretKey, devicePubB64, E2EE_GROUP_WRAP_INFO);
  const iv = randomBytes(IV_LENGTH);
  const wrapped = gcm(wrapKey, iv).encrypt(rawKey);
  return { ephemeralPub: ephemeral.publicKeyB64, iv: bufToB64(iv), wrapped: bufToB64(wrapped) };
}

export function unwrapRawKey(wrap: Wrap, mySecretKey: Uint8Array): Uint8Array {
  const unwrapKey = deriveAesKey(mySecretKey, wrap.ephemeralPub, E2EE_GROUP_WRAP_INFO);
  const iv = b64ToBuf(wrap.iv);
  const wrapped = b64ToBuf(wrap.wrapped);
  return gcm(unwrapKey, iv).decrypt(wrapped);
}

export { bufToB64, b64ToBuf };
