# NearStory parent beta implementation report

Date: 2026-08-11

## Release state

- Parent-entered NearStory is implemented behind `NEARYOU_ENABLE_STORY` and coordinated foundation, NearSleep, library, async-job, allowance, verified-consent, migration, and worker-heartbeat gates.
- The flag remains off. Story navigation, child microphone input, and dynamic branching remain dark.
- The first paid tier includes NearSleep and parent-controlled NearStory at $14.99/month or $149.99/year. Grandfathered $12 subscriptions do not receive NearStory.

## Implemented

- Typed, bounded story plans for ages 0–8 with child profile, verified adult narrator, modes, sensitivities, pronunciation, linked-inspiration rights receipts, and fail-closed input/output moderation.
- Tenant-namespaced idempotent `/api/v1/stories` contracts with same-origin checks, entitlement enforcement, atomic narration allowance reservations, provider-spend ceilings, and private authenticated media.
- Durable one-stage-per-invocation worker with attempt leases, deterministic provider idempotency, five aligned narration segments, cached rights-safe ambience, real segment timing/captions, attempt-unique private R2 staging, and bounded provider/media bodies.
- Scheduler hook, health heartbeat, stale-attempt recovery, exhausted-attempt refund/revocation, intermediate checkpoint lifecycle cleanup, and retrying deletion reconciliation.
- Library playback, visible transcript, status polling, deletion, export inventory, and account-erasure inventory. Branch and child-microphone interfaces stay disabled until their separate end-to-end implementation is complete.

## Failure and privacy evidence

- Actual SQLite/R2 tests cover cross-household selectors and playback, idempotent lost HTTP responses, lost R2 responses after narration and SFX writes, stale attempt adoption, deterministic TTS replay, SFX HEAD/checksum recovery without a second provider call, three-attempt terminal cleanup, export of six checksummed Story media parts, retrying Story deletion, and account erasure of intermediate Story audio without touching another household.
- Persist races are exercised in both directions: a stale attempt paused after PUT cannot erase a takeover attempt's completed media, and a stale attempt paused before PUT cannot recreate audio after deletion. Cleanup is scoped to the attempt-owned staging keys.
- Database triggers fence live exports, account deletion, pending Story deletion, attempt ownership, consent leases, media bindings, storage quota, and Story completion invariants.

## Verification

- TypeScript: passed.
- Scoped lint: passed.
- Production build: passed.
- Full repository tests: 239/239 passed.

## Activation prerequisites

- Configure and verify a production scheduled trigger that invokes the Worker at least once per minute; Sites hosting metadata currently does not declare that external schedule.
- Apply migration `0013_nearstory_parent_beta.sql`, run a production worker canary, and set `nearstory_activation_state` ready only after migration, queue, provider, storage, and media-worker checks pass.
- Keep child microphone and branch UI disabled. Complete independent security/privacy review and production provider contract canaries before enabling the parent beta cohort.
