# Task 2A report — default-off NearSleep verification and reservation foundation

## Status

Task 2A is implemented as a **default-off, explicitly non-deployable foundation**. It does not complete Task 2 and must not be enabled in production. Migration `0006_nearyou_shared_foundation.sql` remains undeployed, and new migration `0007_nearsleep_production_upgrade.sql` must also remain undeployed until Task 2B completes live generation/session/Stripe/UI/deletion/export integration and the resulting end-to-end security review is clear.

`NEARYOU_ENABLE_PRODUCTION_UPGRADE_FOUNDATION` defaults to `false` and gates both new routes before authentication, database access, or provider work. `NEARYOU_REQUIRE_VERIFIED_VOICE_CONSENT`, async jobs, Story, Legacy Archive, child microphone, and posthumous synthesis remain off. Current Sleep Studio and sleep-session behavior remains unchanged: script `requestId` is optional, current `personalizedScript()` still performs one non-retrying provider request, and no live generation route consumes the new reservation or consent-lease helpers.

## Files

Production foundation:

- `.env.example`
- `db/schema.ts`
- `drizzle/0007_nearsleep_production_upgrade.sql`
- `drizzle/meta/0007_snapshot.json`
- `drizzle/meta/_journal.json`
- `app/api/onboarding/route.ts`
- `app/api/voices/verification/route.ts`
- `lib/adult-voice-verification.ts`
- `lib/nearyou-foundation.ts`
- `lib/provider-guard.ts`
- `lib/usage-reservations.ts`
- `lib/sleep-script.ts`
- `lib/sleep-session.ts`

Tests:

- `tests/adult-voice-verification.test.mjs`
- `tests/generation-reservations.test.mjs`
- `tests/nearyou-foundation.test.mjs`
- `tests/provider-guard.test.mjs`
- `tests/script-safety.test.mjs`
- `tests/task2-migration.test.mjs`
- `tests/task2a-release-gates.test.mjs`
- `tests/usage-reservations.test.mjs`

## Migration and API foundation

Migration `0007_nearsleep_production_upgrade.sql` adds:

- versioned `adult_onboarding_acceptances` and expiring `voice_verification_challenges`;
- durable `voice_replacements` verification state/lock and atomic activation trigger;
- dormant `voice_consent_leases` for Task 2B generation binding;
- atomic/idempotent `usage_reservations` with reservation/release ledger triggers;
- `provider_spend_reservations`, `provider_budget_policies`, and `provider_circuits` with household/global rolling spend and concurrency enforcement;
- durable `generation_operations` result state for Task 2B idempotent response replay;
- dormant queue, favorite, repeat, job-progress, reservation, and consent fields for Task 2B;
- `ON DELETE SET NULL` actions for sleep-session/job reservation and consent references, matching the Drizzle schema.

The provider-spend lifecycle is `in_flight -> charge_committed -> settled`. A provider call may begin only after the charge-commit CAS succeeds. Unexpired `in_flight` and `charge_committed` rows count against concurrency. `charge_committed` rows remain included in rolling spend even after expiry and reconcile to `settled`, never `released`; only expired work that was never invoked can be released. Estimated/actual amounts, initial states, and transitions are validated at runtime and in SQL.

New default-off APIs:

- `GET /api/onboarding`: returns the current server-owned adult/caregiver attestation and current acceptance.
- `POST /api/onboarding`: validates and idempotently records the current version and every required attestation.
- `POST /api/voices/verification` with JSON: creates/idempotently returns a five-minute random-phrase challenge for an owned ready voice after current onboarding.
- `POST /api/voices/verification` with multipart data: exclusively claims the challenge, transcribes a bounded live passage, requires the exact normalized phrase, and creates a replacement clone from that same recording before atomic consent activation.

## Security dispositions

- Transcript equality alone never upgrades an existing clone. The sufficiently long challenge-bearing recording is also the input to the replacement clone, binding the activated provider voice to the verification ceremony.
- Activation is a single SQLite-trigger transaction bound by CAS to the processing challenge, ready voice, original provider voice ID, and original consent ID. Revocation/deletion that wins before activation prevents verified-consent creation.
- The old provider clone is retired only after the new local pointer and verified consent are durable. Failed retirement leaves a tracked `cleanup_pending` replacement rather than deleting both old and new provider voices.
- Failed/mismatched challenges transition to `failed`, clear the phrase, and release the partial unique verification lock so a new challenge can be created. One provider attempt is allowed per challenge; retries require a new challenge and new spend keys.
- Verification evidence stores the challenge/version and hashes of the phrase, audio, transcript, and replacement provider ID plus transcription model/request ID. It does not retain the uploaded audio or transcript.
- A lost/unreadable ElevenLabs clone response preserves `provider_response_unreadable` and the provider request ID. Provider name/description include a deterministic non-secret replacement correlation marker for later orphan reconciliation.
- Onboarding validation errors are bounded 400 responses. Persistence/internal errors are logged server-side and returned as generic 500 responses. Reservation failures map to stable codes; payload/idempotency conflicts map to 409.
- Customer allowance and provider spend are separate. A Free save is restricted to one five-minute, 1,000-milliunit creation; grandfathered legacy saves retain one-credit semantics at supported durations. The required preview and script allowance weights are tested zero-cost no-ops. New paid tiers debit duration minutes in milliunits. Entitlement selection checks status, validity interval, and NearSleep plan feature.
- Provider calls are not invoked until durable charge commitment. Response parsing, settlement telemetry, or circuit telemetry failure cannot release possibly charged spend. Charge-committed expiry remains spend-accounted without permanently occupying concurrency.
- Guarded retry helpers require a stable provider idempotency key, combine caller and timeout abort signals, cancel retry response bodies, and do not retry ambiguous network exceptions. The helper is dormant for live script generation until Task 2B wires reservation/result replay atomically.
- YouTube source metadata is serialized as structured `untrusted_external_metadata`; provider instructions forbid following metadata instructions. Independent narration safety validation remains in the current session validator before TTS.

`voice_replacements` is only a verification lock/state machine. It is **not** the generation/revocation `voice_consent_lease`, and this Task 2A does not claim the generation-versus-revocation TOCTOU is solved.

## Red-green evidence

- RED: onboarding/verification tests failed because the versioned attestation, challenge parser, phrase/sample validation, evidence builder, and migration did not exist. GREEN: helper and migration suites passed after adding server-owned versions, hashes, bounded samples, and replacement-clone evidence.
- RED: migration tests exposed missing `ON DELETE SET NULL`, nonpositive reservation acceptance, invalid initial states, non-atomic allowance behavior, missing entitlement validity checks, and permanent in-flight concurrency. GREEN: SQL integration tests passed with matching FKs, validation/debit/refund triggers, validity/feature checks, and expiry reconciliation.
- RED: voice route-state review exposed non-exclusive attempts, stuck processing challenges, deletion of the old provider clone before local durability, and activation races. GREEN: challenge claim/failure tests and migration CAS/revocation-race tests passed after the durable replacement state machine and atomic activation trigger.
- RED: retry regressions exposed active-lock and deterministic-key conflicts after phrase mismatch/reservation failure. GREEN: one-attempt-per-challenge failure semantics free the verification lock and require a new challenge/key.
- RED: provider partial-local-failure tests showed that a successful/ambiguous provider request could be released after parsing/telemetry failure. An initial pre-call settlement design then failed concurrency review. GREEN: `charge_committed` tests now prove pre-invoke CAS, retained concurrency, conservative post-expiry spend accounting, no provider invocation on CAS failure, and non-authoritative settlement/circuit telemetry.
- RED: zero-weight script/preview allowance calls were rejected before their intended no-op path. GREEN: zero weight returns a tested no-op before database access; negative weight remains rejected.
- RED: release-gate tests showed an optional request ID had become mandatory and guarded retry behavior could affect the live Studio path. GREEN: request ID is optional and `personalizedScript()` explicitly retains the single-attempt legacy provider path.

## Verification

- Focused reservation/migration/release-gate suites: 20/20 passed after the final spend-state hardening.
- Schema drift: `drizzle-kit generate --name verification_only` reported `No schema changes, nothing to migrate`.
- Final post-clearance full gate: ESLint passed, TypeScript passed, Vinext production build passed, 104/104 tests passed, schema drift reported no changes, and `git diff --check` passed.
- Skeptic disposition: CLEAR; no remaining Task 2A commit blockers.

## Rollout prohibition and Task 2B concerns

Do not deploy migrations `0006` or `0007`, and do not set `NEARYOU_ENABLE_PRODUCTION_UPGRADE_FOUNDATION=true`, until all Task 2B work and end-to-end review are complete. In particular:

- Existing voice DELETE/revoke handling is not bound to generation leases and can still race verification if the foundation flag is manually enabled. Task 2B must wire atomic lease acquisition/validation/revocation and close the existing DELETE race.
- Live script/audio/session routes do not yet reserve/refund customer allowance, reserve/finalize provider spend, persist/replay generation results, bind output to consent version/lease, or discard output after revocation.
- Stripe webhooks do not yet synchronize canonical plan entitlements or preserve grandfathered $12 users through the new model.
- No production reconciler yet settles stale charge-committed spend, retires `cleanup_pending` old voices, or lists/deletes a provider clone whose successful creation response was lost. The correlation evidence is present, but enabling before reconciliation exists risks a paid orphan clone.
- Studio does not yet provide onboarding/re-verification migration UX, explicit child/voice selection, or stable save idempotency across ambiguous responses.
- Favorites/private playlists/queues/repeat/download UI and API behavior, job progress polling with server fallback, and real worker reservation paths remain Task 2B. Async jobs must remain hard-disabled until that path exists.
- R2 deletion fail-closed behavior, session deletion, and export claims remain Task 2B.
- Story microphone and all Legacy features remain out of scope and off.
