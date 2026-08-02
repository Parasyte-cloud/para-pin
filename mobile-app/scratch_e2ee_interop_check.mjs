// One-off interop verification: does the RN (@noble) E2EE implementation
// actually produce the same derived keys and compatible ciphertext as the
// real web app's WebCrypto implementation, when only public keys cross
// the wire (exactly like production: two independent devices, each
// generating their own keypair)? NOT part of the shipped app — run once,
// then this file can be deleted.
import { webcrypto } from 'node:crypto';
import { p256 } from '@noble/curves/nist.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { gcm } from '@noble/ciphers/aes.js';

const INFO = 'PArA-PIN-GroupWrap-v1';
const HKDF_SALT = new Uint8Array(32);

function b64(bytes) { return Buffer.from(bytes).toString('base64'); }
function unb64(str) { return new Uint8Array(Buffer.from(str, 'base64')); }

// ---- exact copy of index.html's e2eeDeriveAesKey/encrypt/decrypt, using Node's real WebCrypto ----
async function webDeriveAesKey(privateKey, publicKeyB64, infoStr) {
  const pub = await webcrypto.subtle.importKey('raw', unb64(publicKeyB64), { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  const sharedBits = await webcrypto.subtle.deriveBits({ name: 'ECDH', public: pub }, privateKey, 256);
  const hkdfKey = await webcrypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveBits']);
  const keyBits = await webcrypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode(infoStr) },
    hkdfKey, 256
  );
  return { cryptoKey: await webcrypto.subtle.importKey('raw', keyBits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']), rawBits: new Uint8Array(keyBits) };
}
async function webEncrypt(key, plaintext) {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  return { iv: b64(iv), ciphertext: b64(ct) };
}
async function webDecrypt(key, ivB64, ctB64) {
  const pt = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(ivB64) }, key, unb64(ctB64));
  return new TextDecoder().decode(pt);
}

// ---- exact copy of src/crypto/e2ee.ts's logic (noble) ----
function nobleGenerateKeyPair() {
  const secretKey = p256.utils.randomSecretKey();
  const publicKey = p256.getPublicKey(secretKey, false);
  return { secretKey, publicKeyB64: b64(publicKey) };
}
function nobleDeriveAesKey(mySecretKey, theirPublicKeyB64, infoStr) {
  const theirPub = unb64(theirPublicKeyB64);
  const sharedPoint = p256.getSharedSecret(mySecretKey, theirPub, false);
  const sharedX = sharedPoint.slice(1, 33);
  const info = new TextEncoder().encode(infoStr);
  return hkdf(sha256, sharedX, HKDF_SALT, info, 32);
}
function nobleEncrypt(keyBytes, plaintext) {
  const iv = randomBytes(12);
  const ct = gcm(keyBytes, iv).encrypt(new TextEncoder().encode(plaintext));
  return { iv: b64(iv), ciphertext: b64(ct) };
}
function nobleDecrypt(keyBytes, ivB64, ctB64) {
  const pt = gcm(keyBytes, unb64(ivB64)).decrypt(unb64(ctB64));
  return new TextDecoder().decode(pt);
}

async function main() {
  let failures = 0;
  const check = (label, cond) => {
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + label);
    if (!cond) failures++;
  };

  // Independent keypair generation, exactly like two real devices.
  const webKp = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const webPubRaw = new Uint8Array(await webcrypto.subtle.exportKey('raw', webKp.publicKey));
  const webPubB64 = b64(webPubRaw);

  const nobleKp = nobleGenerateKeyPair();

  check('web public key export is 65 bytes, uncompressed (0x04 prefix)', webPubRaw.length === 65 && webPubRaw[0] === 0x04);
  check('noble public key export is 65 bytes, uncompressed (0x04 prefix)', unb64(nobleKp.publicKeyB64).length === 65 && unb64(nobleKp.publicKeyB64)[0] === 0x04);

  // Each side derives using ITS OWN private key + the OTHER side's public key.
  const webDerived = await webDeriveAesKey(webKp.privateKey, nobleKp.publicKeyB64, INFO);
  const nobleDerived = nobleDeriveAesKey(nobleKp.secretKey, webPubB64, INFO);

  check('derived AES key bytes are IDENTICAL between web(WebCrypto) and noble', Buffer.from(webDerived.rawBits).equals(Buffer.from(nobleDerived)));

  // Cross-decrypt in both directions.
  const msg1 = 'hello from web, decrypt me on mobile';
  const enc1 = await webEncrypt(webDerived.cryptoKey, msg1);
  const dec1 = nobleDecrypt(nobleDerived, enc1.iv, enc1.ciphertext);
  check('web-encrypted message decrypts correctly via noble', dec1 === msg1);

  const msg2 = 'hello from mobile, decrypt me on web';
  const enc2 = nobleEncrypt(nobleDerived, msg2);
  const dec2 = await webDecrypt(webDerived.cryptoKey, enc2.iv, enc2.ciphertext);
  check('noble-encrypted message decrypts correctly via web(WebCrypto)', dec2 === msg2);

  // Wrap/unwrap flow (group chat key distribution): noble wraps a raw
  // chat key for web's device, web unwraps it using its own private key.
  const ephemeral = nobleGenerateKeyPair();
  const rawChatKey = randomBytes(32);
  const wrapKeyNoble = nobleDeriveAesKey(ephemeral.secretKey, webPubB64, INFO);
  const wrapIv = randomBytes(12);
  const wrapped = gcm(wrapKeyNoble, wrapIv).encrypt(rawChatKey);

  const wrapKeyWeb = await webDeriveAesKey(webKp.privateKey, ephemeral.publicKeyB64, INFO);
  const unwrappedRaw = new Uint8Array(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: wrapIv }, wrapKeyWeb.cryptoKey, wrapped));

  check('group-key wrap created by noble unwraps correctly via web(WebCrypto)', Buffer.from(rawChatKey).equals(Buffer.from(unwrappedRaw)));

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('ERROR', e); process.exit(1); });
