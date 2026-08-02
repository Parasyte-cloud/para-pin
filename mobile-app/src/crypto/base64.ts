// Standard RFC 4648 base64 (with padding) — NOT base64url. Matches the web
// app's e2eeBufToB64/e2eeB64ToBuf (index.html:~10350), which go through
// btoa/atob, i.e. plain base64. Hand-rolled instead of relying on RN/Hermes
// possibly-present `atob`/`btoa` globals, since that varies by RN/engine
// version and this needs to be exact, not "probably fine."

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bufToB64(bytes: Uint8Array): string {
  let result = '';
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    result += CHARS[(n >> 18) & 63] + CHARS[(n >> 12) & 63] + CHARS[(n >> 6) & 63] + CHARS[n & 63];
  }
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const n = bytes[i] << 16;
    result += CHARS[(n >> 18) & 63] + CHARS[(n >> 12) & 63] + '==';
  } else if (remaining === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    result += CHARS[(n >> 18) & 63] + CHARS[(n >> 12) & 63] + CHARS[(n >> 6) & 63] + '=';
  }
  return result;
}

export function b64ToBuf(b64: string): Uint8Array {
  const clean = b64.replace(/=+$/, '');
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const val = CHARS.indexOf(clean[i]);
    if (val === -1) continue;
    buffer = (buffer << 6) | val;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}
