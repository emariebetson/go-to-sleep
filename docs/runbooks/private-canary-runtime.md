# Private canary runtime preparation

This is a source-verification runbook only. **Do not deploy** from this document. It performs no product activation and reads no secret values.

## Required dark state

- `app/api/internal/canary-entitlement/route.ts`: `ROUTE_ENABLED = false`.
- `lib/nearfamily-activation.ts`: `NEARFAMILY_SOURCE_ACTIVATED = false`.
- Stripe remains test-only; no live-mode binding is part of this runtime.

## Runtime bindings

The Sites/Worker release must bind the existing D1 database as `DB` and a private PostgreSQL adapter as `READINESS_PG`. The adapter must use the dedicated IAM-authenticated readiness-controller identity and must not contain a static database password.

Provision these non-secret, reviewed values through the hosting environment: `CANARY_OIDC_ISSUER`, `CANARY_OIDC_AUDIENCE`, `CANARY_OIDC_SUBJECT`, and `CANARY_OIDC_JWKS_URL`. The issuer and JWKS URL must be HTTPS; the tuple must exactly match the readiness-controller service identity. Never put tokens, client secrets, database URLs, or private keys in `.openai/hosting.json` or `.openai/worker-bindings.json`.

## Migration execution

Migration `0026_canary_entitlements.sql` is intentionally excluded from the deployable `drizzle/` directory after the Sites executor rejected it. Its reviewed draft is preserved at `docs/pending/0026_canary_entitlements.sql.disabled`. The source verifier must remain red and both routes must remain dark until a disposable Sites database proves an authenticated, atomic trigger-bootstrap design.

1. Create a D1 backup/recovery point and record its identifier outside source control.
2. Do not rename or copy the pending draft into `drizzle/` until that separate review is complete.
3. Apply using the supported deployment migration identity: `wrangler d1 migrations apply site-creator-d1 --remote --config <reviewed-production-config>`.
4. Read back `d1_migrations` and verify `0026_canary_entitlements` is recorded exactly once.
5. Query only counts and schema metadata: confirm `canary_entitlement_audit` exists, both immutability triggers exist, and zero canary rows exist before the authorized operation.

Do not use `wrangler.local.jsonc` against production. Do not manually execute partial statements. A failure leaves both product gates dark and requires restoring the recorded recovery point or applying a reviewed forward fix.

## Verification

Run `node --import tsx scripts/verify-private-canary-runtime.ts`. Then run the repository tests, typecheck, lint, build, and `git diff --check`. A source pass proves only that the binding contract and migration are present; it does not prove that Cloudflare can reach Cloud SQL, that OIDC works, or that migration `0026` ran remotely.

Before any later activation, capture runtime evidence for exact OIDC issuer/audience/subject, private `READINESS_PG` connectivity, D1 migration ledger, immutable audit triggers, and an authorized dry-run verification. No product route or internal mutation route may be enabled during Task 3.

## Authenticated private-tester baseline

The private-tester baseline is no longer allowed to infer a live Sites version, rollback, D1 database, or R2 bucket from environment variables, runtime binding labels, saved-version ordering, or a gateway response. Its control-plane input is the canonical deployment-operation file signed by `scripts/compose-private-tester-deployment-manifest.ts` with the pinned Cloud KMS RSA-PSS-3072 key.

Baseline collection accepts the exact release file, the signed deployment-manifest file, and a new output path. It verifies the manifest signature and configured trust tuple, atomically consumes the manifest nonce through `nearyou.consume_private_tester_deployment_manifest`, and then exact-compares the signed release and resource facts with:

- the release descriptor and fresh Sites runtime commit;
- authenticated Cloudflare `GET` inventory for the signed account-qualified D1 database and R2 bucket;
- the complete live D1 ledger and `sqlite_schema`, including the exact five reviewed provider-internal objects;
- the live PostgreSQL session/current identity `nearyou-private-tester-baseline@nearnight.iam` and reviewed catalog reads;
- fresh DNS, OAuth redirect-proof, secret-version, and literal-false gate observations.

`CLOUDFLARE_API_TOKEN` is a read credential only; it is never accepted as a resource fact and must have only the D1 Read and R2 bucket-read permissions required for the two signed resources. KMS resource coordinates, signer mapping, and `EVIDENCE_TRUST_JSON` configure verification but cannot substitute live/rollback/resource claims. The output is still created exclusively and collection remains read-only apart from the single-purpose nonce consumption.

PostgreSQL migration `0007_private_tester_deployment_manifest.sql` is source-only and unapplied as of this remediation. The reviewed live PostgreSQL 16 catalog remains at `0006_private_canary_observation`. Do not rename the `0006` catalog evidence, relabel its checksum as `0007`, or attempt baseline collection until an independently authorized migration applies `0007` and a fresh catalog candidate is reviewed. Applying that migration is outside this runbook and was not performed by Task 3.
