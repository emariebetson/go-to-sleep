# Production release and recovery runbook

All new platform paths are dark by default. A release cannot activate from environment claims alone: evidence tied to the exact release ID, schema checksum, reconciled backfill checksum, actual non-owner RLS negative test, shadow-read window, and media-worker canary must be stored in `nearyou.release_evidence`. The repository evidence linter only validates shape and always exits blocked; a managed verifier must authenticate CI identity/signatures, artifact hashes, and freshness before writing verified database rows.

## Cutover gate

1. Restore a recent D1/R2 manifest into an isolated rehearsal environment.
2. Apply PostgreSQL migration as the migration role; run `postgres-rls-gate.sql` through the checked-out app-role connection.
3. Backfill deterministic pages, record per-table counts/checksums, replay delta, then run shadow reads. No mismatch is accepted.
4. Freeze writes briefly, replay the final delta, verify checksum and queues, mark durable evidence, and enable one cohort.
5. Retain D1 read-only for 30 days. Rollback disables the cutover flag, drains new jobs, switches reads/writes to D1, and reconciles the PostgreSQL-only delta before retry.

The current cutover CLI is a fail-closed deployment scaffold; infrastructure-specific backfill/delta/shadow/rollback execution remains blocked until a checked-out managed PostgreSQL driver and CI secret bindings are supplied. The included RLS SQL is likewise an unexecuted rehearsal artifact: `rls_negative_test` must remain pending until CI runs it against an ephemeral PostgreSQL clone as the real app role. Source inspection and documentation never count as runtime evidence.

## Release gates

- Serial unit/integration/E2E suite; provider fixtures/canaries with spend caps; Stripe and RevenueCat sandbox replay/order tests.
- Load/soak: Range streaming, webhook burst, job leases/retries, concurrent Story branches; abort at error/latency/cost ceilings.
- Restore drill: PostgreSQL PITR plus R2 manifest/checksum restoration, private playback, export and deletion reconciliation.
- Provider outage exercise: circuit opens, unused allowance releases, jobs retry safely, user status remains accurate.
- Accessibility: keyboard/screen reader, reduced motion, captions, contrast, microphone state, iOS/Android current and prior major versions.
- Security: independent penetration test and zero unresolved critical/high findings.

### NearFamily activation gate

NearFamily remains compile-time dark until one exact release has authenticated, unexpired product-readiness evidence for the identity, household-member, entitlement, invitation, privacy/PAD, capacity, restore, load, and security probes. The same evidence must bind both reviewed iOS and Android artifacts, the exact service secret versions, the current schema/RLS checksum, and a successful controller-identity mapping. Before canary admission, rehearse a Family-to-Plus downgrade at real limits and prove that existing members, children, voices, and media remain intact; every new capacity-consuming mutation is rejected; delete/export/revoke/billing/member-departure remediation remains available; and all capacity conflicts return to zero after remediation.

Source completion does not enable NearFamily. `NEARFAMILY_ROUTE_ENABLED` must remain literal false, Terraform service and scheduler readiness must remain false, and no rollout transition may occur until the supported-PostgreSQL catalog manifest is generated and reviewed and all live restore/load/security/accessibility/mobile/provider/24-hour canary evidence is verified. Activation begins with an invited household cohort and must preserve the audited kill switch and prior-version rollback path.

## Rollback and retention

Retain the prior Sites version. Rollback is flag-first, then code. Never roll back a destructive migration. Raw clone samples delete after verification unless separately consented; working files expire in 7–30 days; account/consent deletion remains auditable without PII. Quarterly restore drills and annual archive export verification are required.
