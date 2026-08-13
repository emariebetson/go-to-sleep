# Task 4 private canary smoke report

## Outcome

Source-only, read-only smoke and rollback evidence tooling is implemented. It does not deploy, migrate, issue entitlements or invites, access secrets, call providers, activate a route, or change a kill switch. All live observations are required adapters and absence fails closed.

Skeptic fix: the callback-driven function is now named `assessPrivateCanaryObservations` and explicitly documented as a non-evidentiary schema predicate. `scripts/private-canary-live.ts` is the deployment-owned path and requires workload-identity authentication, TLS PostgreSQL, Cloud KMS asymmetric verification, the durable PostgreSQL nonce store, an exact signed rollback digest, and exclusive-create output.

## Changed files

- `scripts/private-canary-smoke.ts`
- `scripts/private-canary-live.ts`
- `tests/private-canary-smoke.test.mjs`
- `tests/private-canary-live-cli.test.mjs`
- `docs/runbooks/private-canary-smoke.md`
- `package.json`

## TDD evidence

- RED: focused test initially failed with `ERR_MODULE_NOT_FOUND` for `scripts/private-canary-smoke.ts`.
- GREEN: 4/4 focused tests pass, including missing-binding failure, exact frozen release/household scope, invited/denied/kill behavior, migration/trigger/pre-operation/outbox checks, heartbeat/provider checks, and rollback rejection.

## Verification

- Focused smoke tests: 4/4 pass.
- Hardened live-wrapper focused tests: 2/2 pass.
- Final hardened focused matrix: 10/10 passes, including executable migrated SQLite `preflight` (0/0/0), `issued` (1/1/0), and `revoked` (0/1/1) release-scoped canary-source counts plus immutable audit enforcement.
- Full repository tests: 474/474 pass.
- TypeScript: pass.
- Full ESLint: pass.
- D1 domain registry drift: pass.
- `git diff --check`: pass.
- Production build: blocked before compilation by the local Rolldown native binding's macOS Team-ID signature mismatch. This is a dependency/runtime environment defect; source gates above pass. No dependency was modified.
- `tsconfig.tsbuildinfo`: absent.

## External live inputs and commands

The deployment-owned wrapper must supply short-lived WIF/OIDC-backed adapters for the exact release and two hashed test households, then call `runPrivateCanarySmoke`. See `docs/runbooks/private-canary-smoke.md`. Required live facts are D1 migration/trigger/zero-row/outbox state, authoritative PostgreSQL invite and rollout decisions, Story activation/heartbeat/provider prerequisites, and a retained rollback artifact. No live claim is made in this report.

Local command: `node --import tsx --test tests/private-canary-smoke.test.mjs`.

## Remaining concerns

- The concrete wrapper now composes D1-owned Story activation/heartbeat with PostgreSQL-owned signed provider readiness, and the CI catalog workflow applies migration `0006`.
- This machine has no Docker, Colima, Podman, `psql`, `postgres`, `initdb`, or Postgres.app. Run the `postgres-contract` job in `.github/workflows/production-evidence.yml`, download `catalog-manifest-review-candidate`, obtain skeptic review, and only then explicitly promote it. Until then, the two reviewed-catalog tests intentionally fail closed.
- Live D1, PostgreSQL, OIDC/WIF, provider/media, and rollback observations require credentials and deployed runtimes.
- The production build must be rerun in a supported environment with a valid native Rolldown binding before release evidence is accepted.
