# NearStory and NearFamily Invite-Only Web Canary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make NearFamily and NearStory usable on the web by explicitly invited Elizabeth-controlled adult households while public product APIs remain dark and no live payment is accepted.

**Architecture:** Preserve PostgreSQL as the signed rollout/kill-switch authority and D1 as the current product-domain store. Add a small authenticated NearFamily dashboard, an audited expiring manual entitlement operation, and private runtime connectivity for the existing Story worker. Activation is household-invite-only, release/version-bound, and reversible through the existing PostgreSQL kill switch.

**Tech Stack:** Vinext/React 19, TypeScript 5.9, Cloudflare D1/R2, PostgreSQL 16/Cloud SQL, Cloud Run, Google OIDC/WIF/KMS, OpenAI moderation/writing, ElevenLabs speech/effects.

## Global Constraints

- Stripe remains in test mode and is outside the canary critical path.
- Public/uninvited requests continue to receive 404; no percentage or public rollout occurs today.
- Children remain non-login records; child microphone and posthumous synthesis remain disabled.
- Only authenticated, expiring, audited manual entitlements and exact PostgreSQL household invites may grant access.
- Every provider/storage/finalization boundary remains release/version fenced; the kill switch must stop new product work.
- No product is enabled until exact migrations, secrets, runtime probes, tests, and rollback rehearsal pass.

---

### Task 1: NearFamily web dashboard and shared activation gate

- [ ] Write failing route/page/navigation tests for dark, unauthorized, invited, restricted, and kill-switch behavior.
- [ ] Add one default-off source activation helper shared by the page and API; no plain environment variable may unlock it alone.
- [ ] Add authenticated `/family` UI showing exact capacity use/limits, restricted-state remediation links, and explicit adult-managed safety boundaries.
- [ ] Add conditional AppShell navigation without duplicating existing household, child, voice, invitation, billing, or export mutations.
- [ ] Run focused tests, TypeScript, scoped ESLint, build, and diff-check; obtain skeptic approval.

### Task 2: Audited manual canary entitlement

- [ ] Write failing executable tests for an authenticated admin operation that issues one exact plan entitlement to one household with release ID, actor, reason, issued/expiry times, idempotency key, and immutable audit.
- [ ] Reject public callers, arbitrary plan IDs, expired grants, cross-household replay, conflicting idempotency, and extension without a new operation.
- [ ] Preserve existing billing state; the canary grant is separately identifiable, bounded, revocable, and cannot enable Stripe live mode.
- [ ] Add a read-only verification command that emits the exact household entitlement and rollout-invite bindings without PII.
- [ ] Run concurrency/replay tests and obtain skeptic approval.

### Task 3: Private runtime and migrations

- [ ] Produce immutable web/Story-worker/migration images with SBOM/provenance and exact digests.
- [ ] Create exact-version Secret Manager entries for provider, media-worker, database, and worker credentials; mount only into the identities that use them.
- [ ] Run D1 migrations through `0025` and PostgreSQL migrations through `0005`; capture ledger, catalog, RLS, controller mapping, and restore evidence.
- [ ] Deploy the web/API and Story worker with supported private Cloud SQL connectivity; keep public product activation and schedulers disabled.
- [ ] Verify OIDC audience/subject, database role mapping, D1/R2 bindings, provider spend caps, and private media access.

### Task 4: Runtime canary and rollback rehearsal

- [ ] Create one or two Elizabeth-controlled adult test households and issue expiring manual canary entitlements.
- [ ] Insert exact release-bound PostgreSQL canary invites; verify all other households remain denied.
- [ ] Exercise NearFamily exact-limit and downgrade remediation flows.
- [ ] Exercise NearStory create, moderation, queue, worker stages, private audio/captions/transcript, deletion, provider outage, and lost-response recovery.
- [ ] Confirm fresh worker heartbeat, zero DLQ/pending outcome mismatch, bounded spend, and D1-to-PostgreSQL reconciliation.
- [ ] Trigger the kill switch between checks/provider boundaries and prove new work pauses while deletion/remediation remains available.

### Task 5: Invite-only web availability

- [ ] Run the full test, type, lint, build, migration, security, accessibility, and route-inventory gates on the exact release commit.
- [ ] Obtain final skeptic source/runtime verdict.
- [ ] Enable only the exact invited household hashes; do not enable a percentage rollout.
- [ ] Verify both web journeys from a clean browser session and retain the prior Sites/runtime version for rollback.
- [ ] Start the durable 24-hour operational canary; broader/public access remains blocked until its signed evidence passes.

