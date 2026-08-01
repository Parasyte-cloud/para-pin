// Smaller pure-logic functions that are cheap to cover and easy to
// regress silently (a CSV-injection-shaped bug or an avatar URL sanitizer
// that stops rejecting something it should reject tends to fail quietly).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvEscape, toCsv, sanitizeAvatarUrl, sha256Hex, arrayBufferToBase64 } from '../worker.js';

test('csvEscape quotes values containing commas, quotes, or newlines; leaves plain values alone', () => {
  assert.equal(csvEscape('plain'), 'plain');
  assert.equal(csvEscape('has,comma'), '"has,comma"');
  assert.equal(csvEscape('has "quote"'), '"has ""quote"""');
  assert.equal(csvEscape('multi\nline'), '"multi\nline"');
  assert.equal(csvEscape(null), '');
  assert.equal(csvEscape(undefined), '');
  assert.equal(csvEscape(42), '42');
});

test('toCsv joins rows with CRLF and escapes each cell', () => {
  const csv = toCsv([['name', 'note'], ['Ada', 'likes, commas'], ['Grace', 'says "hi"']]);
  assert.equal(csv, 'name,note\r\nAda,"likes, commas"\r\nGrace,"says ""hi"""');
});

test('sanitizeAvatarUrl only accepts this app\'s own /api/media/<id> shape', () => {
  assert.equal(sanitizeAvatarUrl('/api/media/abc123_-XYZ'), '/api/media/abc123_-XYZ');
  assert.equal(sanitizeAvatarUrl(null), null);
  assert.equal(sanitizeAvatarUrl(''), null);
  assert.equal(sanitizeAvatarUrl('/api/media/with"quote'), null, 'must reject anything that could break out of a CSS url(\"...\")');
  assert.equal(sanitizeAvatarUrl('https://evil.example.com/x'), null, 'must reject external URLs entirely');
  assert.equal(sanitizeAvatarUrl('/api/media/../../etc/passwd'), null);
});

test('sha256Hex matches a known SHA-256 test vector', async () => {
  assert.equal(await sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('arrayBufferToBase64 round-trips through atob and handles buffers larger than one chunk', () => {
  // getRandomValues caps out at 65536 bytes per call (Web Crypto spec,
  // matches actual Workers behavior too), so build a >0x8000-byte buffer
  // (the function's own internal chunk size) out of two calls instead of one.
  const bytes = new Uint8Array(65536);
  bytes.set(crypto.getRandomValues(new Uint8Array(32768)), 0);
  bytes.set(crypto.getRandomValues(new Uint8Array(32768)), 32768);
  const b64 = arrayBufferToBase64(bytes.buffer);
  const decoded = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  assert.deepEqual([...decoded], [...bytes]);
});
