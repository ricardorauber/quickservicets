# 0078 - Test certificates are created at test time, not committed

- Date: 2026-10-28
- Spec: 0270-server-tls
- Status: accepted

## Context
Spec 0270 AC1 (and specs 0271 to 0275 after it) use "the committed test certificates under
`packages/core/src/testing/certs/`": a CA, server certificates and client certificates with their private keys. The
study chose committed fixtures because Bun has no X.509 generation API. Committing private keys, even test ones, is
flagged by secret scanners and invites reuse outside tests; the block's instructions ask for certificates created at
test time in temporary folders.

## Options considered
- A: `createTestCertificates()` in `@quickservicets/core/testing` creates the CA, the server pairs (`localhost`, a
  second pair, one expiring in ten days) and the client certificates (`billing` with a SPIFFE SAN, `reports`,
  `orders-api`, one from another CA) once per test process with `openssl` in a temporary folder, and every TLS test
  uses it. No key is ever committed; tests need `openssl` on the machine, as the mTLS example's `scripts/certs.ts`
  already does.
- B: Commit the fixtures as the spec says, clearly marked as test-only: offline and fast, but private keys live in the
  repository.
- C: Generate certificates in TypeScript with an X.509 library: a new dependency for tests only.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`packages/core/src/testing/certs/` does not exist; the acceptance criteria that name it are verified with the same
certificates created by `createTestCertificates()`. The mTLS example of spec 0275 uses its own `scripts/certs.ts`,
and its test creates certificates the same way.
