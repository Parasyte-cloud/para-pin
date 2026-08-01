# Tests

Run with:

```
npm test
```

(equivalent to `node --test tests/*.test.mjs` — no test framework dependency, Node's built-in runner.)

## What's covered, and why this scope

This isn't an attempt at full coverage of a 7,000+ line single-file Worker. It's scoped to the highest-risk hand-rolled logic — mainly cryptographic verification code that has no library available in the Cloudflare Workers runtime and was written by hand instead, where a subtle bug is a security hole rather than a visible bug:

- `saml.test.mjs` — SAML 2.0 signature verification (exclusive XML canonicalization, X.509 cert parsing, signature-wrapping/replay/audience/recipient checks). The riskiest code in this app: Workers has no DOMParser, so the usual XML-DSig libraries don't work here, meaning canonicalization is hand-rolled.
- `webauthn.test.mjs` — CBOR/COSE key parsing, DER↔raw ECDSA signature conversion, full assertion verification against a real generated keypair.
- `vapid.test.mjs` — Web Push VAPID JWT signing (the auth mechanism proving a push came from this server) and the aes128gcm payload envelope shape.
- `totp.test.mjs` — RFC 6238 TOTP, checked against the RFC's own published test vectors, not just internal self-consistency.
- `misc.test.mjs` — smaller pure functions (CSV escaping, avatar URL sanitization, base64 helpers) that are cheap to cover and easy to regress silently.

Explicitly **not** covered here: the Durable Object HTTP route handlers themselves (would need a mocked storage/env harness, a bigger lift than this pass), the OIDC network round-trip (discovery/JWKS fetch — network-dependent, harder to fixture cheaply), and all client-side (index.html) code.

## How worker.js exposes anything to test

worker.js has one `export default { fetch }` (what Wrangler actually deploys) plus a block of named exports right before it, added specifically so these pure functions are importable from test files. This changes nothing about the deployed bundle — unused named exports don't ship — it just makes the functions reachable from `../worker.js` in a test file the same way any other ES module would be.

## Fixtures

`tests/fixtures/saml/` contains **real, statically generated** signed SAML fixtures (a genuine self-signed X.509 cert + genuinely signed assertions), produced once using the actual `xml-crypto` npm package (a spec-compliant, DOM-based reference implementation) and `openssl`, in an isolated scratch directory that was never added as a project dependency. They're committed here as ground truth specifically so `saml.test.mjs` is checking this project's hand-rolled verification code against bytes it never touched, rather than against its own assumptions about what "correct" looks like.

## Extending this

The exported-functions pattern in worker.js means adding coverage for another pure function is just: add it to the `export { ... }` list, import it in a test file, write the test. For anything that needs Durable Object storage or `env` bindings, you'd need a minimal fake storage/env object passed in — none of the current tests need this, so there's no harness for it yet.
