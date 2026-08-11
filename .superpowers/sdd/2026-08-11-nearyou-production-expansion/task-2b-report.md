# Task 2B report — NearSleep production core

## Status

Task 2B-core is implemented and verified on `codex/nearyou-foundation`. The work remains default-off: existing production behavior is unchanged unless `NEARYOU_ENABLE_NEARSLEEP_PRODUCTION=true`, and production modules are dynamically loaded only after that dark gate. Activation is permitted only as a coordinated rollout after migrations `0006` through `0011` are applied, the `0011` duplicate-live-voice preflight succeeds, selected-household onboarding and current verified-consent enforcement are live, R2/provider configuration is present, and the Stripe webhook is configured in test mode.

The parent-authorized split moves favorites, playlists, bedtime queue, repeat timer, authenticated download, individual session deletion, archive/export, and richer library UX to Task 2C. Production-mode account deletion returns a clear `503` until 2C supplies durable fail-closed R2 deletion/export. Story, child microphone, Legacy Archive, posthumous synthesis, and asynchronous media jobs remain off.

## Delivered core

- Versioned caregiver onboarding now uses the selected household and requires the exact server-presented attestation and explicit adult, caregiver, and private-use acceptance before sensitive creation APIs run.
- Voice onboarding claims a tenant-scoped local slot before provider work, enforces the effective household plan limit, creates the first clone only from the random liveness challenge recording, stores only local IDs in public APIs, and supports repeated current-version verification. Replacement activation is atomic; failed provider cleanup remains durable and retryable without deleting an activated clone.
- Free households use the intentional standard, non-cloned narrator. Paid households may create private verified clones. The current entitlement is rechecked before challenge issue and again before provider invocation, so plan transitions cannot create an unauthorized clone.
- Script generation uses canonical child records, 0–96-month ages, stable request IDs, canonical user-input fingerprints, post-claim YouTube metadata resolution, explicit source-rights attestation, structured untrusted metadata, and fail-closed child-safety moderation. Before external metadata or OpenAI work, it also verifies that the selected duration is allowed and that the current household allowance can eventually save it; Free is server-bounded to its one five-minute creation.
- Preview and saved audio use authoritative child/voice selectors, exact current consent version, generation leases, duration-bound narration, edited-narration moderation before ElevenLabs, atomic customer allowance/provider-spend accounting, tenant R2 keys, canonical media rows, and deterministic result recovery. Consent revocation after provider success makes stale output inaccessible, releases customer allowance, preserves provider spend accounting, and reaches a durable terminal result without calling the provider again.
- Studio exposes canonical child and verified local-voice selectors, renders onboarding and challenge state, supports the Free standard narrator, understands production JSON audio results, and preserves request IDs only for truly ambiguous/in-progress/reconciliation outcomes.
- Checkout, Portal, and webhook state are household-scoped. One distinct Stripe Customer is bound per household. Checkout sessions and idempotency keys persist through lost redirects and are replaced only after authoritative expiry. Current and historical subscription bindings permit cancel/resubscribe while fencing late old events.
- Stripe event claims use attempt-token fencing. Household billing, subscription history, entitlements, billing-period grants, rollover, bounded grace, and event completion converge transactionally. Active access is bounded by period end; unpaid/canceled states are not entitled; first-period allowance is granted once in either delivery order; delayed invoice events cannot revive newer terminal state. Portal access remains available to the owner independently of caregiver/voice onboarding.
- Pricing posts approved monthly plan selections and does not sell the grandfathered `$12` offer. Account billing reads the selected household's canonical entitlement/account state. Stripe remains test-key/test-mode only, annual checkout stays unavailable until internal monthly cadence exists, and Legacy prices are recognition-only while Legacy is disabled.

## Migrations and durable invariants

- `0008_nearsleep_live_integration.sql` adds durable recoverable generation results, consent-lease transition checks, revocation-linked allowance release, and ordered/fenced Stripe event state. Historical processed Stripe events are explicitly backfilled as completed with their original processing timestamps.
- `0009_nearsleep_audio_atomic.sql` adds the additive saved-audio pointers and trigger-enforced finalization. A production session can enter ready only from generating with a tenant audio key, exact consumed/current consent lease, matching reserved allowance, media/session/voice bindings, and atomic allowance commit. Pointered ready sessions are immutable.
- `0010_child_profile_pronunciation.sql` adds canonical pronunciation and a tenant-scoped legacy backfill.
- `0011_household_billing_accounts.sql` adds household checkout/customer/subscription state, subscription history, Stripe claim fencing, child/voice capacity enforcement, current consent-version constraints, voice-trial/provider-cleanup state, and re-verification history support. Its first statement is an explicit duplicate-live-voice preflight, before any schema mutation, so a failed preflight leaves the migration unapplied.
- Migrations are additive and preserve historical Stripe fields and legacy business data. Generated snapshots and the Drizzle journal match the runtime schema.

## TDD and executable failure evidence

Strict red-green cycles covered tenant collisions, provider-success persistence failures, deterministic recovery, recovery-storage outages, consent revocation races, lease expiry/current-version checks, allowance release versus provider charge, concurrent voice/child capacity, staged-media repair, unsafe edited narration, and request-ID retry classification.

Two executable integration fixtures exercise the highest-risk lost-worker paths:

- `task2b-route-recovery` runs the production saved-audio flow with fake provider, fake R2, and migrated SQLite state. A lost response followed by consent revocation invokes the provider once, removes/reconciles the object and media state, releases allowance, and terminal-fails the operation for bounded replay.
- `task2b-stripe-route-state` runs the actual production webhook handler against migrations through `0011` using a D1-compatible SQLite adapter. It proves subscription→invoice grants exactly one 60,000-milliunit allowance, invoice-before-subscription retries then converges, a completion-write loss after the financial grant returns `500` but replay does not double-grant, and cancel→resubscribe fences late historical checkout/invoice events.

## Verification

- `npm run lint` — passed.
- `npm run typecheck` — passed.
- `npm run build` — passed.
- `npm test` — passed serially under stock Node 22.23.2: TypeScript, Vinext production build, and 179/179 tests.
- `npm run db:generate` — passed: `No schema changes, nothing to migrate`.
- `git diff --check` — passed.
- All migration snapshot and journal JSON files parse successfully.

The stock Node 22 runtime is used because the Codex desktop-bundled Node process rejects the repository's native Rolldown binding signature. Verification did not change dependencies or lockfiles.

## Rollout and remaining concerns

1. Apply `0006`–`0011` in order in a rehearsal copy first. The first `0011` statement intentionally aborts if legacy data contains duplicate live household/user voice slots; repair that data before retrying.
2. Keep all production flags false during migration. Configure server-only OpenAI, ElevenLabs, R2, and Stripe test secrets; register the pinned Stripe test webhook; run selected-household onboarding/re-verification; then enable verified-consent enforcement and the NearSleep production flag together.
3. Do not enable annual checkout until monthly allowance cadence is implemented. Do not enable Story, Legacy, child microphone, posthumous synthesis, or async jobs.
4. Task 2C owns favorites/playlists/queue/repeat/download/session deletion/export/library polish and durable account deletion. Until it lands, the explicit production `503` deletion gate is required.
5. Durable `cleanup_pending` records preserve failed old-clone/R2 cleanup work, but operational reconciliation and alerting must be run as part of rollout; these records must not be treated as silently completed cleanup.
