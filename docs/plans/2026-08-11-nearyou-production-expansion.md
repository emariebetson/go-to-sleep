# NearYou Production Expansion Implementation

## Global constraints

- Preserve the live NearSleep/Nearnight flows while migrations and new modules are feature-flagged.
- Adult-managed households only; children never receive accounts, billing access, or voice clones.
- Never expose provider secrets. All mutations are authenticated, tenant-scoped, idempotent, and auditable.
- Keep Stripe in test mode until explicit launch approval. Existing $12 subscribers remain grandfathered.
- The first paid tier is $14.99/month or $149.99/year and includes NearSleep plus parent-controlled NearStory; direct child-microphone Story remains separately gated. NearFamily is the higher-capacity household tier, not the Story access gate.
- Direct child microphone and posthumous synthetic narration remain disabled until legal and safety launch gates pass.
- Use test-first development, independent skeptic review at every release gate, and rollback-compatible migrations.

## Task 1: NearYou shared foundation

- Add umbrella branding and compatibility metadata without breaking existing URLs.
- Add centralized plan catalog, feature flags, entitlements, weighted usage rules, and tests.
- Add household, member, child-profile, contributor, voice-consent, entitlement, usage-ledger, media, playlist, and job schema through an additive D1 bridge migration.
- Add authenticated `/api/v1` household, child, voice, entitlement, usage, playlist, and job interfaces.
- Auto-create a household for existing users and preserve current sessions, children, voices, credits, and Stripe state.

## Task 2: NearSleep production upgrade

- Add explicit child and adult-voice selectors, favorites, private playlists, bedtime queues, repeat timers, and authenticated downloads.
- Replace generation credits with server-owned weighted allowance reservations while keeping grandfathered credits compatible.
- Add durable job state and progress polling; keep synchronous execution as a flagged fallback until the worker is deployed.
- Add failure refunds, retries, spend ceilings, provider circuit breakers, and integration tests.

## Task 3: PostgreSQL and worker cutover

- Add managed PostgreSQL schema with household tenant keys, row-level security, pgvector, PITR-ready migrations, and a database adapter.
- Add D1 export/backfill, checksum reconciliation, shadow reads, delta cutover, and rollback tooling.
- Add queue orchestration and a containerized Python/FFmpeg media worker for normalization, mixing, waveforms, transcript chunking, and exports.
- Deploy only after credentials and infrastructure bindings are provided; retain D1 read-only for 30 days.

## Task 4: NearStory

- Add structured story plans, age bands, safe modes, narrator and child selection, sensitivities, soundscapes, branch points, and cached effects.
- Add parent-started co-use microphone sessions with visible state, short-lived tokens, transient child audio, safety pause, and no child cloning.
- Add streaming event contracts, moderation, provider budget controls, and age/safety evaluations.
- Ship parent-entered branching first; gate direct child microphone by country and legal approval.

## Task 5: NearLegacy

- Add contributors, guided interviews, recordings, transcripts, corrections, memories, people, places, photos, tags, timelines, and collections.
- Add versioned consent, liveness evidence, revocation, primary/successor custodians, deceased-state review, deletion, and portable exports.
- Add retrieval-grounded archive search that cites recordings and refuses unsupported memories.
- Keep synthetic contributor narration separately consented and disabled after a death-state change pending review.

## Task 6: Billing and mobile entitlement foundation

- Expand Stripe Checkout/webhooks/portal to the approved monthly, annual, archive, care, and add-on catalog with server-owned price allowlists.
- Preserve existing Plus subscribers and process webhook ordering, replay, upgrades, cancellations, grace periods, and allowance renewals safely.
- Add payment-channel-neutral entitlements and RevenueCat webhook/receipt interfaces for later StoreKit and Google Play clients.
- Do not enable automatic tax until registrations are confirmed.

## Task 7: Mobile and media integrations

- Add an Expo/React Native workspace using the same versioned APIs, with Google/Apple sign-in, recording, background audio, encrypted downloads, notifications, and parental controls.
- Add authoritative NearYou playlists plus OAuth-scoped Spotify catalog playlist and YouTube metadata/authorized-caption adapters.
- Never upload private NearYou audio to Spotify or rip YouTube content; require rights attestation for adaptations and explicit consent for publishing.

## Task 8: Security, operations, QA, and release

- Add threat model, security policy, retention/deletion workflows, audit logs, admin MFA gates, reason-coded access, rate limits, and upload validation.
- Add structured logs, tracing, privacy-safe analytics, error monitoring, provider spend/margin dashboards, alerts, and feature kill switches.
- Run unit, route integration, provider contract, AI safety/provenance, E2E, accessibility, load, restore, and deletion tests.
- Publish each successful gated release to the existing Sites project, retain the prior version for rollback, and keep gated features off until their external approvals are complete.
