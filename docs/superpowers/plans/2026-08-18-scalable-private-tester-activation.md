# Scalable Private Tester Activation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clear NearStory and NearFamily for a small invited tester cohort through a repeatable release pipeline that remains safe as the schema, product count, and tester count grow.

**Architecture:** Replace provider-size-dependent evidence with immutable, paginated application attestations bound to the exact Sites archive, runtime build ID, deployment, D1 state, PostgreSQL catalog, and KMS-signed release. Separate evidence collection, promotion, activation, and 24-hour monitoring into fail-closed stages; no stage may infer or silently repair another stage’s facts.

**Tech Stack:** TypeScript, Node test runner, Vinext/OpenNext, OpenAI Sites, Cloudflare D1/R2, PostgreSQL 16 on Cloud SQL, Cloud KMS RSA-PSS, Google OIDC, Cloud Build/GitHub Actions, Terraform.

**Spec:** `docs/superpowers/plans/2026-08-14-nearstory-nearfamily-private-testers.md`

## Global Constraints

- NearStory, NearFamily, schedulers, canary entitlement writes, and temporary migration routes stay literal-dark until the activation task.
- Never depend on the Sites database viewer enumerating all tables; its current limit is 50 while the reviewed database has more than 100 user tables.
- Never trust caller headers, environment labels, saved-version ordering, or a runtime’s claim about its own deployment.
- Every evidence file is canonical JSON, raw-byte SHA-256 bound, freshness bounded, immutable (`O_EXCL` or generation-zero object write), and free of user content or secret values.
- D1 evidence is paginated by deterministic object identity and supports at least 10,000 schema objects and 10,000 migrations without changing the evidence schema.
- PostgreSQL evidence must use `nearyou-pt-baseline@nearnight.iam`; rollout changes must use the dedicated readiness controller.
- The first cohort is invitation-only. Percent rollout stays `0`; global product source gates remain off until the invited-path proof and 24-hour canary pass.
- Rollback never down-migrates D1 or PostgreSQL. It disables access, stops new work, preserves evidence, and redeploys the immediately prior Sites version when needed.
- Public copy, IP, analytics, and legal guardrails from the NearYou Still launch remain unchanged.

---

### Task 1: Versioned, paginated Sites evidence protocol

**Files:**
- Create: `lib/private-tester-sites-evidence.ts`
- Create: `tests/private-tester-sites-evidence.test.mjs`
- Modify: `lib/private-tester-baseline-gateway.ts`
- Modify: `app/api/internal/private-tester-baseline/[kind]/route.ts`

**Interfaces:**
- Produces: `readEvidencePage(kind, cursor)` responses with `{version, kind, buildId, page, nextCursor, rows, pageSha256}`.
- Produces: `completeEvidence(kind, orderedPageHashes)` with exact count and ordered digest.

- [ ] Write failing tests proving 51, 500, and 5,001 table/object inventories paginate without truncation, duplication, omission, or caller-selected SQL.
- [ ] Add adversarial tests for reordered cursors, repeated pages, missing pages, cursor substitution, oversized pages, malformed rows, and mixed build IDs.
- [ ] Run the focused test and confirm the missing protocol fails.
- [ ] Implement fixed-query cursor pagination over canonical D1 schema and migration projections; cap each page at 200 rows and sign no user data.
- [ ] Return the Vinext `BUILD_ID` with every page and require one build ID across the entire observation.
- [ ] Keep authentication before query/body parsing and return only fixed error classes with `no-store`.
- [ ] Run focused tests, TypeScript, ESLint, and `git diff --check`.
- [ ] Commit: `feat: add scalable Sites evidence pagination`.

### Task 2: Archive-to-runtime build identity binding

**Files:**
- Create: `scripts/read-sites-build-identity.ts`
- Create: `tests/sites-build-identity.test.mjs`
- Modify: `scripts/package-sites-dark-release.ts`
- Modify: `scripts/capture-private-tester-baseline.ts`
- Modify: `scripts/promote-private-tester-baseline.ts`

**Interfaces:**
- Consumes: saved Sites version, archive SHA, `dist/server/BUILD_ID`, deployed HTML/RSC build ID, and provider-log script version.
- Produces: `SitesBuildReceiptV1` binding project, saved version, commit, archive hash, deployment, build ID, provider script name, and provider log version.

- [ ] Write a failing end-to-end archive test that extracts `dist/server/BUILD_ID`, observes the deployed build ID, and rejects any mismatch.
- [ ] Add tests for a deployment swap between pre-read and post-read, stale receipts, archive substitution, same project/wrong version, and mixed provider log versions.
- [ ] Run the focused test and confirm current worker-ID assumptions fail.
- [ ] Implement a build receipt using only authenticated Sites save/deploy responses, exact archive bytes, the runtime BUILD_ID, and correlated provider log rays.
- [ ] Bracket all runtime evidence with pre/post build reads; require the same build ID and deployment throughout capture.
- [ ] Remove the unavailable `workerDeploymentId` assumption; retain the independently observed provider script version as a separate fact.
- [ ] Run focused tests, TypeScript, ESLint, packaging validation, and diff check.
- [ ] Commit: `fix: bind Sites evidence to archive build identity`.

### Task 3: Scalable D1 and R2 logical-resource attestation

**Files:**
- Modify: `lib/sites-managed-resource-receipt.ts`
- Modify: `lib/private-tester-deployment-manifest.ts`
- Modify: `scripts/private-tester-d1-live-state.ts`
- Modify: `scripts/compose-private-tester-deployment-manifest.ts`
- Test: `tests/sites-managed-resource-receipt.test.mjs`
- Test: `tests/private-tester-deployment-manifest.test.mjs`

**Interfaces:**
- Produces: schema-v3 logical resources: `AUDIO` bound to archive/deployment and `DB` bound to the paginated D1 completion digest.
- Preserves: schema-v1/v2 parsing for historical evidence only; new capture accepts schema-v3 only.

- [ ] Write failing tests proving the exact Sites “more than 50 tables” response cannot block or weaken D1 attestation.
- [ ] Add tests rejecting a claimed table list, a fabricated physical bucket/database ID, incomplete pagination, and a digest from another build.
- [ ] Run tests and observe RED.
- [ ] Implement schema-v3 resources using logical bindings plus the Task 1 completion digest; do not claim inaccessible physical IDs.
- [ ] Bind R2 to logical `AUDIO`, the exact archive, deployment, and live build; verify upload/read/delete behavior separately in smoke tests.
- [ ] Run all manifest, receipt, baseline, and promotion tests plus static checks.
- [ ] Commit: `feat: attest Sites-managed resources without size limits`.

### Task 4: One-shot evidence runner with immutable receipts

**Files:**
- Create: `scripts/run-private-tester-evidence.ts`
- Create: `tests/private-tester-evidence-runner.test.mjs`
- Modify: `.github/workflows/production-evidence.yml`
- Modify: `infra/production/cloud-sql-auth-proxy.args`
- Modify: `docs/runbooks/private-tester-rollout.md`

**Interfaces:**
- Consumes: exact release ID, saved Sites version, deployment, rollback version, KMS trust, Cloud SQL IAM proxy, and Task 1–3 receipts.
- Produces: signed manifest, review-required baseline, provider-log receipt, promoted baseline, and immutable evidence index.

- [ ] Write failing state-machine tests for first run, lost response, retry, concurrent runner, stale observation, and partial artifact sets.
- [ ] Require operation ID and start time as immutable inputs so retries reproduce byte-identical objects.
- [ ] Implement Cloud Build execution with the pinned Auth Proxy image, metadata identity, no static DB password, and exact verifier username.
- [ ] Upload every artifact generation-zero; on conflict download the exact generation and compare raw SHA before converging.
- [ ] Refuse to promote unless every artifact points to the same release, deployment, build ID, D1 digest, PostgreSQL catalog, and dark-gate snapshot.
- [ ] Run focused tests and a disposable end-to-end evidence build.
- [ ] Commit: `feat: automate immutable private tester evidence`.

### Task 5: Release-independent activation controller

**Files:**
- Create: `lib/private-tester-activation.ts`
- Create: `scripts/private-tester-activation-cli.ts`
- Create: `tests/private-tester-activation.test.mjs`
- Modify: `lib/product-release-readiness-service.ts`
- Modify: `lib/canary-entitlement.ts`

**Interfaces:**
- Consumes: promoted baseline SHA, signed release evidence, invited household hashes, expiry, expected rollout-state version.
- Produces: invitation-only authorization; global percent remains zero.

- [ ] Write failing tests proving no activation without promoted evidence, exact controller mapping, exact release, unexpired invite, and expected state version.
- [ ] Add race, replay, revocation, kill-switch, wrong-household, wrong-product, and stale-evidence tests.
- [ ] Implement one transactional controller operation per product with compare-and-swap versioning and immutable audit evidence.
- [ ] Enable only invitation evaluation; do not change public/source feature constants or scheduler defaults.
- [ ] Verify NearStory and NearFamily denial for non-invited accounts and exact access for one synthetic invited account.
- [ ] Commit: `feat: add invitation-only private tester activation`.

### Task 6: Automated product smoke and rollback proof

**Files:**
- Modify: `scripts/private-canary-live.ts`
- Modify: `tests/private-canary-smoke.test.mjs`
- Create: `scripts/private-tester-rollback-drill.ts`
- Create: `tests/private-tester-rollback-drill.test.mjs`

**Interfaces:**
- NearStory smoke: create, process, persist, play, delete, and prove outcome delivery.
- NearFamily smoke: identity, member access, invited entitlement, privacy boundary, revocation, and capacity remediation.

- [ ] Write failing tests for every success path and every denial/rollback invariant.
- [ ] Implement synthetic, non-personal test fixtures with deterministic cleanup and immutable result hashes.
- [ ] Prove kill switch immediately denies new work, queued work is fenced, deletion/remediation remain available, and the prior Sites version is deployable.
- [ ] Require D1 audit triggers, zero dead letters, correct R2 object scope, and no cross-household reads.
- [ ] Commit: `test: prove private tester smoke and rollback`.

### Task 7: Durable 24-hour canary and alerting

**Files:**
- Modify: `.github/workflows/canary-evidence-sampler.yml`
- Modify: `.github/workflows/production-evidence.yml`
- Modify: `scripts/canary-evidence-cli.ts`
- Create: `tests/private-tester-canary-window.test.mjs`

**Interfaces:**
- Produces: immutable samples at least every 15 minutes for 24 hours and one final signed canary receipt.

- [ ] Write failing tests for missing intervals, late samples, duplicate samples, deployment changes, release changes, error spikes, dead letters, stale heartbeat, and rollback failure.
- [ ] Implement resumable sampling keyed by release/build/deployment with generation-zero storage.
- [ ] Fail and invoke the kill switch on any authorization leak, data-integrity failure, persistent worker failure, or evidence discontinuity.
- [ ] Require 24 continuous hours, at least 96 valid samples, zero denied-household grants, and successful end-of-window rollback recheck.
- [ ] Commit: `feat: enforce durable private tester canary`.

### Task 8: Tester invitation clearance and controlled launch

**Files:**
- Modify: `docs/runbooks/private-tester-rollout.md`
- Create: `docs/runbooks/private-tester-invitation.md`
- Modify: the release evidence index generated by Task 4 (through its CLI only)

**Interfaces:**
- Consumes: promoted baseline, signed product readiness, successful smoke, rollback receipt, and completed 24-hour canary.
- Produces: one auditable go/no-go record and the first tester invitation authorization.

- [ ] Run the complete focused suite, full repository suite, TypeScript, ESLint, production build, migration/artifact checks, and diff check.
- [ ] Run a security diff review and public-copy/IP review; record only material nonduplicative disclosure events.
- [ ] Confirm apex SSL/OAuth, D1/R2, Cloud SQL, secret versions, DNS, and rollback version immediately before launch.
- [ ] Activate only the exact invited household hashes for NearStory and NearFamily; keep percent rollout at zero.
- [ ] Send invitations only after the controller readback and denial probes pass.
- [ ] Monitor the first real tester session; revoke immediately on any invariant failure.
- [ ] Commit the final runbook/evidence references without committing private evidence.

## Completion Definition

The goal is complete only when the exact deployed build has a promoted baseline, NearStory and NearFamily both pass synthetic invited/denied tests, rollback is proven, the uninterrupted 24-hour canary is signed and accepted, and at least one explicitly invited tester can enter while a non-invited account remains denied. No global percentage or unrelated product gate is enabled.

## Self-Review

- Spec coverage: provider scale, runtime identity, D1/R2, PostgreSQL, OAuth/DNS/secrets, activation, rollback, 24-hour monitoring, and invitation are each assigned to a task.
- Placeholder scan: no deferred implementation steps or unowned requirements remain.
- Type consistency: Tasks 1–4 produce immutable build/resource/baseline evidence; Tasks 5–8 consume those exact artifacts without inference.
