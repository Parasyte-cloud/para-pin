// SAML 2.0 signature verification — the highest-risk hand-rolled crypto in
// this codebase (Cloudflare Workers has no DOMParser, ruling out the usual
// xml-crypto/xmldsigjs libraries, so exc-c14n canonicalization and X.509
// SPKI extraction are both hand-rolled here, see worker.js's comment above
// this section for the specific attack classes this guards against).
//
// Fixtures in tests/fixtures/saml/ are NOT invented — they were generated
// once with the real `xml-crypto` package (a spec-compliant, DOM-based
// reference implementation) plus `openssl`, in an isolated scratch
// directory never added as a project dependency, then committed here as
// static ground truth. That's what makes these tests meaningful: a bug in
// this file's own canonicalization would show up as a real digest/
// signature mismatch against bytes this code never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { verifySamlResponse, extractSamlResponseInResponseTo, buildSamlAuthnRequest, buildSamlSpMetadata, samlSpEntityId, samlAcsUrl, deflateRawBase64 } from '../worker.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(dir, 'fixtures', 'saml');
const read = (name) => readFileSync(path.join(fixturesDir, name), 'utf8');

const trustedCert = read('cert.pem');
const meta = JSON.parse(read('meta.json'));
const baseOpts = {
  expectedAudience: meta.audience,
  expectedAcsUrl: meta.acsUrl,
  expectedInResponseTo: meta.inResponseTo,
  now: new Date(meta.issueInstant),
};

test('accepts a genuinely signed, in-window response and reads the correct identity', async () => {
  const result = await verifySamlResponse(read('response.xml'), trustedCert, baseOpts);
  assert.equal(result.ok, true);
  assert.equal(result.nameId, meta.nameId);
});

test('rejects a response whose content was altered after signing (digest mismatch)', async () => {
  const result = await verifySamlResponse(read('response_tampered.xml'), trustedCert, baseOpts);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'digest_mismatch');
});

test('rejects a response signed with a different keypair, even though it is internally self-consistent', async () => {
  // response_forged.xml is a fully valid signature — just signed by an
  // attacker's own key/cert, not the admin-configured trusted one. This is
  // the test that proves verifySamlResponse never trusts the response's own
  // embedded <KeyInfo> certificate, only the one passed in as trustedCert.
  const result = await verifySamlResponse(read('response_forged.xml'), trustedCert, baseOpts);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'signature_invalid');
});

test('resolves identity from the actually-signed element, not an attacker-injected sibling Assertion (signature wrapping)', async () => {
  // response_wrapped.xml has TWO <saml:Assertion> elements: an attacker-
  // injected, unsigned one claiming nameId=attacker@evil.com, positioned
  // BEFORE the legitimately signed one. A verifier that located "the"
  // Assertion by tag name (e.g. document order) rather than by the
  // Signature's own Reference URI would authenticate as the wrong person.
  const result = await verifySamlResponse(read('response_wrapped.xml'), trustedCert, baseOpts);
  assert.equal(result.ok, true);
  assert.equal(result.nameId, meta.nameId, 'must resolve to the legitimately signed identity, not the injected one');
});

test('rejects replay: a stale expectedInResponseTo that does not match the response', async () => {
  const result = await verifySamlResponse(read('response.xml'), trustedCert, { ...baseOpts, expectedInResponseTo: '_some_other_request_id' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'in_response_to_mismatch');
});

test('rejects an expired assertion (now past NotOnOrAfter)', async () => {
  const result = await verifySamlResponse(read('response.xml'), trustedCert, { ...baseOpts, now: new Date(Date.now() + 365 * 24 * 3600 * 1000) });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'expired');
});

test('rejects a wrong audience (this SP is not who the assertion was issued for)', async () => {
  const result = await verifySamlResponse(read('response.xml'), trustedCert, { ...baseOpts, expectedAudience: 'https://someone-else.example.com' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'audience_mismatch');
});

test('rejects a wrong ACS URL (recipient/destination mismatch)', async () => {
  const result = await verifySamlResponse(read('response.xml'), trustedCert, { ...baseOpts, expectedAcsUrl: 'https://attacker.example.com/acs' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'recipient_mismatch');
});

test('extractSamlResponseInResponseTo pulls the same value used to look up the pending AuthnRequest', () => {
  assert.equal(extractSamlResponseInResponseTo(read('response.xml')), meta.inResponseTo);
});

test('buildSamlAuthnRequest + deflateRawBase64 produce valid raw-DEFLATE bytes a real IdP can inflate', async () => {
  const xml = buildSamlAuthnRequest({
    id: '_test123', issueInstant: '2026-01-01T00:00:00Z', destination: 'https://idp.example.com/sso',
    issuer: samlSpEntityId('https://chat.parasyte.cloud', 'org_test'), acsUrl: samlAcsUrl('https://chat.parasyte.cloud', 'org_test'),
  });
  const encoded = await deflateRawBase64(xml);
  const { inflateRawSync } = await import('node:zlib');
  const inflated = inflateRawSync(Buffer.from(encoded, 'base64')).toString('utf8');
  assert.equal(inflated, xml);
  assert.match(xml, /^<samlp:AuthnRequest/);
});

test('buildSamlSpMetadata produces well-formed SP metadata pointing at the right ACS URL', () => {
  const xml = buildSamlSpMetadata({ entityId: samlSpEntityId('https://chat.parasyte.cloud', 'org_test'), acsUrl: samlAcsUrl('https://chat.parasyte.cloud', 'org_test') });
  assert.match(xml, /entityID="https:\/\/chat\.parasyte\.cloud\/api\/sso\/saml\/metadata\?orgId=org_test"/);
  assert.match(xml, /Location="https:\/\/chat\.parasyte\.cloud\/api\/sso\/saml\/acs\?orgId=org_test"/);
});
