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

1. Create a D1 backup/recovery point and record its identifier outside source control.
2. Preview the exact pending migration with Wrangler against the intended database. Confirm the final pending file is `0026_canary_entitlements.sql` and that no unexpected migration is listed.
3. Apply using the supported deployment migration identity: `wrangler d1 migrations apply site-creator-d1 --remote --config <reviewed-production-config>`.
4. Read back `d1_migrations` and verify `0026_canary_entitlements` is recorded exactly once.
5. Query only counts and schema metadata: confirm `canary_entitlement_audit` exists, both immutability triggers exist, and zero canary rows exist before the authorized operation.

Do not use `wrangler.local.jsonc` against production. Do not manually execute partial statements. A failure leaves both product gates dark and requires restoring the recorded recovery point or applying a reviewed forward fix.

## Verification

Run `node --import tsx scripts/verify-private-canary-runtime.ts`. Then run the repository tests, typecheck, lint, build, and `git diff --check`. A source pass proves only that the binding contract and migration are present; it does not prove that Cloudflare can reach Cloud SQL, that OIDC works, or that migration `0026` ran remotely.

Before any later activation, capture runtime evidence for exact OIDC issuer/audience/subject, private `READINESS_PG` connectivity, D1 migration ledger, immutable audit triggers, and an authorized dry-run verification. No product route or internal mutation route may be enabled during Task 3.
