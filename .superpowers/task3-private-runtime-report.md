# Task 3 private runtime and migration report

## Status

Implemented source-only private runtime binding contracts, D1 migration registration/verification, and a fail-closed runbook. No deployment, remote migration, secret read/write, product activation, scheduler activation, push, or commit occurred.

## Changed files

- `.openai/worker-bindings.json` — declares the exact four non-secret OIDC values and the private `READINESS_PG` service binding.
- `drizzle/0026_canary_entitlements.sql`, `db/schema.ts` — Task 2 migration/schema now included in Task 3 verification.
- `app/api/internal/canary-entitlement/route.ts`, `lib/canary-entitlement.ts` — runtime-bound dark internal service from Task 2; literal route false remains intact.
- `scripts/verify-private-canary-runtime.ts`, `package.json` — executable source verifier and package command.
- `docs/runbooks/private-canary-runtime.md` — exact dark-state, binding, migration, verification, recovery, and evidence procedure.
- `tests/private-canary-runtime.test.mjs` plus updated binding/registry expectations — behavior and drift coverage.

## RED / GREEN evidence

RED: `tests/private-canary-runtime.test.mjs` failed with `ERR_MODULE_NOT_FOUND` for the absent verifier.

GREEN:

- Focused infrastructure/migration suite: 13/13.
- Registry/operational/runtime suite: 34/34.
- Full repository suite: 470/470.
- `scripts/verify-private-canary-runtime.ts`: `readyForProvisioning:true`, no missing bindings, product activation false, internal route activation false, migration `0026_canary_entitlements.sql`.
- TypeScript, scoped ESLint, D1 registry drift, diff-check, and production build passed. Build contains the dark internal canary route.

## Exact external blockers

- `.openai/hosting.json` supports D1/R2 metadata only; it does not itself provision a private Cloud SQL adapter. An approved Sites/Cloudflare deployment mechanism must install `READINESS_PG` backed by the dedicated IAM-authenticated readiness controller.
- Exact production OIDC issuer/audience/subject/JWKS values are not in source and were not read. They must be supplied by reviewed hosting configuration and verified at runtime.
- D1 migration `0026` has not been applied remotely. No backup/recovery identifier or remote migration ledger evidence exists in this task.
- Cloudflare-to-Cloud SQL private connectivity, IAM database role mapping, certificate/TLS behavior, OIDC token verification, and PostgreSQL canary invite queries have not been exercised against live infrastructure.
- No immutable image digest/SBOM/provenance was produced here. Existing GCP resources remain subject to their separate Terraform approval and reviewed-catalog gates.
- Both `ROUTE_ENABLED = false` and `NEARFAMILY_SOURCE_ACTIVATED = false` remain required and unchanged; therefore this work cannot make a product usable by itself.
