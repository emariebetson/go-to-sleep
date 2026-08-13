# Task 2 canary entitlement report

## Status

Implemented a narrow D1 canary-entitlement controller, migration, and literal-default-off internal route. No public route, push, deployment, live flag, Stripe mode, or external system was changed.

## Changed files

- `drizzle/0026_canary_entitlements.sql` — immutable issue/revoke audit with exact plan, release, principal, reason, bounded time window, idempotency, and digest constraints; database triggers bind audit insertion to the exact canary entitlement state.
- `db/schema.ts` — adds `canary` as a distinct entitlement source and models the audit table.
- `lib/canary-entitlement.ts` — validates and atomically issues/revokes grants, recovers exact replay/lost responses, rejects conflicts, and emits a PII-free verification projection.
- `scripts/generate-d1-domain-registry.ts` — classifies the immutable operational audit as non-domain inventory metadata; registry output remains unchanged and `--check` passes.
- `tests/canary-entitlement.test.mjs` — executable SQLite behavior tests.

## RED evidence

`/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --import tsx --test tests/canary-entitlement.test.mjs`

Failed with `ERR_MODULE_NOT_FOUND` for `lib/canary-entitlement.ts`, proving the tests required missing production behavior.

## GREEN evidence

- New focused tests: 6/6 passed.
- Combined focused suite: 44/44 passed.
- TypeScript: passed.
- Scoped ESLint: passed.
- D1 registry drift: `tsx scripts/generate-d1-domain-registry.ts --check` passed.
- `git diff --check`: passed.
- Production Vinext build: passed using the previously established local `/tmp/nearyou-build-node` dependency-signing workaround; repository source was not altered by that workaround.

Covered behaviors: exact `nearyou_plus`/`nearyou_family` allowlist; one household and release; service-principal format; bounded reason; issued/not-before/expiry with maximum 24 hours; request digest and idempotency; atomic grant plus immutable audit; exact replay, conflict, concurrent replay and committed-lost-response recovery; separate `source='canary'`; Stripe row preservation; new-operation revocation; and PII-free entitlement/rollout binding verification.

## Remaining concerns

- The internal route is literal-default-off and cannot yet be used. Its environment bindings, workload identity, live PostgreSQL invite lookup, and D1 migration remain runtime-unproven.
- Migration `0026` is source-only and has not been applied to any live D1 database.

## Skeptic fix round

- The controller is now dormant unless supplied an opaque capability created by `verifyCanaryAdminRequest` after the pinned service authenticator succeeds; a plain principal string is insufficient.
- Verification now accepts only an opaque `NearFamilyInviteCapability` produced by a PostgreSQL query that derives the household hash internally and requires exact `product='nearfamily'`, release, household hash, and server-unexpired invite. It also requires the D1 grant to be active and within its validity window at trusted time.
- D1 batch errors now reload the immutable audit. Exact digest replay returns the committed operation; mismatched digest fails as a conflict. This covers committed-lost response and unique/PK race recovery.
- Replay status is derived from the immutable operation: issue always returns its original `active` result even after a subsequent revoke; revoke returns `revoked`.
- Fix-round gates: 33/33 combined tests, TypeScript, scoped ESLint, D1 registry drift, diff-check, and production build passed.

## Final production-entrypoint refactor

- Removed every exported generic capability/controller/verifier API. The module now exports only `createPrivateCanaryEntitlementService`.
- The concrete factory accepts the runtime D1, `READINESS_PG`, and exact pinned OIDC issuer/audience/subject/JWKS configuration. It internally invokes `createServiceOidcAuthenticator`; callers cannot supply an authenticator, clock, principal, invite, or capability mint.
- Mutation time and verification time come from the server clock. Invite verification queries the runtime PostgreSQL binding and derives the household hash internally.
- Behavioral tests use a real RSA-signed JWT and JWKS response through the production factory. They assert an unsigned request is rejected and the module has no generic capability exports.
- Final gates: 32/32 combined tests, TypeScript, scoped ESLint, registry drift, diff-check, and production build passed.

## Minimal closure

- The generic constructor is now module-private. The sole export is a runtime-bound service instantiated from `cloudflare:workers` `env`; no production export accepts an authenticator, clock, principal, PG client, D1 client, or capability mint.
- Added `/api/internal/canary-entitlement` with a literal `ROUTE_ENABLED=false` as its first executable guard. The runtime service is dynamically imported only after that guard, then pinned OIDC authentication completes before `request.json()` and before either mutation or verification.
- Mutation and verification share the same unforgeable, service-owned authorization object. Verification cannot bypass OIDC.
- Added an executable dark-before-parse test using invalid JSON, plus source export-inventory and boundary tests.
- Closure gates: 32/32 combined tests, TypeScript, scoped ESLint, registry drift, diff-check, and production build passed; the build includes the dark internal route.
