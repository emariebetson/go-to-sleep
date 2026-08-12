# NearLegacy implementation report

Status: code-complete and independently cleared for a dark deployment on 2026-08-11. Public activation remains disabled.

## Delivered

- Household-scoped, consent-based family archive schema and `/api/v1/legacy` interfaces.
- Contributor-controlled recording and transcription consent with one-use liveness challenges, private media processing, presentation-attack checks, revocation, expiry, and deletion.
- Guided interviews, original recordings, corrected transcripts, grounded search with exact provenance, private Range playback, archive metadata, photos, and portable exports.
- Custodian bootstrap, successor appointment/acceptance/transfer, death review, contributor rights, MFA/recovery codes, immutable audit history, and verified erasure.
- Durable transcription, export, evidence-retention, deletion, storage, provider-spend, and annual-allowance state machines with idempotency, retries, leases, backoff, and dead-letter behavior.
- NearLegacy, Archive Builder, and Archive Care checkout/entitlement support plus accessible owner and contributor workflows.
- Containerized Python/FFmpeg/Pillow media processor with bounded audio/image validation and fail-closed liveness/PAD contracts.

## Verification

- Application tests: 259/259 passed.
- Media-processor tests: 5/5 passed.
- TypeScript, ESLint, production build, migration check, SQLite integrity/foreign keys, and diff checks passed.
- Independent skeptic review: CLEAR for code commit and dark deployment.

## Activation gates

- Deploy the media processor and independently reviewed presentation-attack detector.
- Configure the authenticated one-minute production scheduler.
- Observe readiness canaries and uninterrupted heartbeats for at least 24 hours.
- Validate scheduler throughput and provider/storage capacity under expected production load.
- Keep every NearLegacy feature flag off until all gates pass.
