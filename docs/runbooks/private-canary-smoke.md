# Private canary smoke and rollback evidence

This verifier is read-only. It does not deploy, migrate, issue entitlements, change invites, activate routes, call providers, or flip the kill switch.

## Inputs

Supply an exact `releaseId`, SHA-256 hashes for one invited and one denied adult test household, and a heartbeat ceiling between 60 and 900 seconds. Live adapter credentials must come from short-lived workload identity; never put them on the command line or in source.

## Required adapter observations

- Source: `NEARFAMILY_SOURCE_ACTIVATED = false`, internal canary `ROUTE_ENABLED = false`, and Story public activation remains off.
- D1: migration ledger contains `0026_canary_entitlements` once; both immutable audit triggers exist; zero canary rows exist before the authorized operation; operational outcome outbox pending and dead-letter counts are zero for the release.
- PostgreSQL: exact release is in canary mode with kill switch false only during the observation; invited household is allowed, denied household is denied, and the exact invite is unexpired. The adapter must call the authoritative PostgreSQL functions rather than echo configuration.
- Story: activation row is ready at migration `0013`, worker heartbeat is fresh, and provider/media prerequisite probe results are true. No provider secrets are printed.
- Rollback rehearsal: a separately captured artifact proves kill-switch denial, new Story work pauses, deletion and Family remediation remain available, and the prior Sites/runtime version is retained.

## Command contract

`assessPrivateCanaryObservations` is only a pure schema/consistency predicate and is not evidence. Production use must go through `scripts/private-canary-live.ts`, which requires metadata-service workload identity, an authenticated D1 observation endpoint, TLS-verified PostgreSQL, Cloud KMS public-key verification, the durable PostgreSQL nonce store, a separately signed exact rollback artifact, and exclusive-create output. Missing bindings fail closed.

The live wrapper inputs are positional: exact release ID, invited household SHA-256, denied household SHA-256, signed rollback-envelope file, and a new output path. Its environment contract is `READINESS_CONTROL_DATABASE_URL`, `D1_CANARY_SMOKE_URL`, `D1_CANARY_SMOKE_AUDIENCE`, `KMS_PROJECT`, `KMS_LOCATION`, `KMS_KEY_RING`, `KMS_KEY`, `EVIDENCE_PRINCIPAL`, `EVIDENCE_KEY_ID`, and `EVIDENCE_TRUST_JSON`. The output path must not already exist.

Before running live, execute:

`node --import tsx --test tests/private-canary-smoke.test.mjs`

Then execute the deployment-owned wrapper using its documented WIF/OIDC identity. Do not run any D1 migration or activation command as part of this smoke verifier. Keep all product gates off after the rehearsal.
