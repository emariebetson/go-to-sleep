# NearYou Full Production Platform Design

**Date:** August 12, 2026
**Status:** Approved direction (Option A), written specification pending final review
**Controlling objective:** Implement and independently verify the full production platform plan for NearFamily, NearStory, and NearLegacy while every product flag remains disabled until source and operational gates pass.

## Scope

This design completes the full plan in `docs/plans/2026-08-11-nearyou-production-expansion.md`. Existing source-cleared NearStory, NearLegacy, cutover, evidence, and infrastructure mechanisms remain the baseline. Completion additionally requires:

1. NearFamily as an operational higher-capacity household tier, not merely a discovery label.
2. A source-ready iOS and Android Expo client for the versioned NearYou APIs.
3. End-to-end structured telemetry, tracing, privacy-safe analytics, error monitoring, spend/margin signals, alerts, and kill-switch observability.
4. A reviewed nonzero PostgreSQL 16/pgvector catalog plus executable RLS evidence.
5. Live restore, load, accessibility, security, media, and durable 24-hour canary evidence bound into the existing asymmetric release-evidence chain.
6. An independent final audit proving every requirement and confirming all activation flags remain off.

## Global safety boundary

- All product, worker, scheduler, mobile, cutover, and rollout activation flags remain false or literal-off during implementation and evidence collection.
- Terraform must not infer readiness from operator booleans. Only authenticated, release-bound, nonce-consumed evidence may authorize later rollout operations.
- Children never receive accounts, billing access, or voice clones.
- Direct child microphone and posthumous synthetic narration stay disabled pending separate legal and safety approval.
- Stripe stays in test mode until explicit launch approval.
- Migrations are additive, replay-safe, and rollback-compatible; destructive rollback is prohibited.
- Runtime and evidence paths fail closed on missing identity, release, schema, artifact, secret version, freshness, or reconciliation data.
- No public deployment, repository publication, demo, launch, public use, pitch, or offer for sale is part of this implementation authorization.

## NearFamily operational tier

NearFamily is a server-owned household plan and policy bundle. It increases capacity and unlocks eligible household-management features without changing the adult-managed identity model.

### Entitlements

- Server-owned monthly and annual price IDs map only to the canonical NearFamily plan.
- The entitlement carries exact limits for active adults, children, private voices, storage, playlists, concurrent provider work, and weighted allowances.
- Existing NearSleep and parent-controlled NearStory access remain compatible with the existing tier rules; NearFamily is not a prerequisite for baseline NearSleep household operation.
- NearLegacy remains separately purchased or entitled according to the canonical catalog.

### Household capabilities

- Adult owners invite and manage bounded adult roles.
- Child profiles remain non-login, adult-managed records.
- Capacity changes are serialized in the database and checked in the same transaction as membership, child, voice, storage, or job mutations.
- Plan downgrade cannot silently strand or delete data. Over-capacity households enter a restricted management state that permits deletion, export, consent revocation, billing management, and member departure while blocking new capacity-consuming mutations.
- Privacy, consent, entitlement, invitation, and member-management probes are required in signed NearFamily readiness evidence.

### Product access

- PostgreSQL remains authoritative for release/version-bound household rollout authorization.
- The NearFamily discovery endpoint remains literal-off until a reviewed activation change.
- Product-only NearFamily operations use centralized rollout middleware; shared NearSleep household operations retain baseline behavior and enforce plan limits rather than a NearFamily rollout flag.

## Mobile client

The Expo workspace becomes a source-ready client for iOS and Android while `platformFeaturesEnabled` remains false.

### Identity and session

- Google and Apple OAuth use PKCE, state, server-persisted one-use sessions, claimed HTTPS callbacks, provider-signed ID-token verification, and exact redirect/provider binding.
- No provider secret ships in the application.
- Account linkage requires the server’s identity policy, including verified email where configured.

### Parent-controlled product flows

- Authenticated household selection, child selection, entitlement display, NearSleep playback/library controls, parent-started NearStory creation/status/playback, and NearLegacy contribution/playback/export status use the existing versioned APIs.
- Mobile must not expose direct child microphone or posthumous synthesis controls while their server gates are off.
- Every mutation uses a stable idempotency key and the same-origin/native provenance contract expected by the API.

### Native media and offline use

- Background playback handles interruption, Bluetooth route changes, lock-screen controls, and bounded resume state.
- Downloads use the verified native non-exportable device-key boundary, signed offline-rights receipts, encrypted files, integrity checks, account/device/media binding, and resumable purge journal.
- Logout, account removal, rights revocation, biometric/passcode invalidation, and cache tamper all converge on purge.
- Notifications contain no child, voice, transcript, story, archive, or entitlement secrets and deep-link only through authenticated routes.
- Native accessibility covers labels, focus order, reduced motion, dynamic type, captions/transcripts, recording state, and current/prior-major iOS and Android verification.

## Observability and operations

### Event envelope

All production telemetry uses one bounded, versioned envelope containing timestamp, environment, release ID, product, operation, outcome, latency bucket, correlation ID, and redacted error code. Tenant, user, child, contributor, voice, media, transcript, raw request, token, signature, URL query, and provider response values are prohibited.

### Collection

- Request and worker boundaries produce structured logs and trace context.
- Provider calls record bounded attempt, latency, circuit, reservation, and settlement outcomes without provider payloads or credentials.
- Privacy-safe analytics record only reviewed product events and coarse capacity/flow states.
- Error monitoring receives redacted codes and trace identifiers, never raw exceptions known to contain third-party bodies or personal data.
- Spend/margin metrics reconcile provider reservations and settlements against server-owned entitlements.

### Reliability

- Telemetry failure never reverses a user transaction, but release evidence fails closed when required operational outcomes are missing.
- Alerts cover database availability/capacity, service error rate/latency, scheduler failures, queue depth/DLQ, evidence heartbeat, KMS/secret denial anomalies, migration failures, provider circuits, restore freshness, and budget thresholds.
- Kill-switch transitions and release/version fences are visible through immutable rollout audit records and are rechecked at irreversible provider/storage boundaries.

## Evidence and activation

### Catalog and RLS

- A supported PostgreSQL 16 image with pgvector applies migrations through the exact current head.
- The comprehensive catalog query attests schemas, tables, columns, constraints, indexes, triggers, policies, functions, sequences, extensions, roles, memberships, owners, ACLs, and RLS/FORCE RLS flags.
- A review-only candidate is promoted to a committed reviewed manifest only after checksum and security invariant review.
- RLS evidence seeds two tenants, proves five positive controls, proves five cross-tenant denials, proves two mutation denials, records observed results, and rolls the fixture transaction back.

### Operational gates

- Restore: Cloud SQL operation success plus connection to the restored database, migration-ledger checksum, live catalog checksum, row checksum/count, and private media/export verification.
- Load: exact HTTPS targets, bounded request count, p95 and error-rate thresholds, queue/retry behavior, and spend ceiling.
- Accessibility: executable Playwright/axe plus native device accessibility evidence with zero unresolved violations.
- Security: pinned dependency, secret, SAST, and ZAP scans plus a separate reviewed penetration-test artifact; zero unresolved critical/high findings.
- Media: workload-identity-authenticated NearStory and NearLegacy probes return exact release/product/persisted artifact and output checksums.
- Canary: at least 24 hours, at least 95% one-minute server buckets, bounded gaps, zero failures/DLQ, positive completions, and exact D1-to-PostgreSQL terminal-outcome reconciliation.

### Signed release evidence

- Every artifact is exact-bound to release and schema before composition.
- Claims use the historical observation start as `notBefore`, current issuance time, and the earliest product-readiness expiry.
- KMS HSM signs the canonical claims digest; production verification checks the exact key tuple and atomically consumes the nonce in PostgreSQL.
- The immutable envelope is written once and independently reviewed. Evidence collection alone never enables a product.

## Verification model

Each subsystem has four evidence levels:

1. **Source:** type checks, lint, static contracts, and tests.
2. **Executable local/rehearsal:** real database, route, migration, concurrency, crash/lost-response, and native simulator/device tests as applicable.
3. **Operational:** live provider/cloud restore, load, security, media, accessibility, and 24-hour canary artifacts.
4. **Independent review:** adversarial source and evidence review with an explicit source/activation verdict.

No subsystem is complete if a required level is missing. The final audit maps every requirement in this document and the 2026-08-11 production plan to authoritative evidence.

## Delivery decomposition

Implementation uses four independently reviewed plans:

1. NearFamily entitlement and capacity enforcement.
2. Mobile production client.
3. Structured observability and operational controls.
4. Catalog, cloud evidence, and final activation audit.

NearStory and NearLegacy source-cleared functionality is preserved and extended only where these plans expose a concrete missing requirement. Every plan ends with flags still off.

## IP and disclosure record

Implementation must preserve material, nonduplicative technical events, exact commit hashes, tests, dates, task IDs, files, disclosures, and known natural-person contributors. AI suggestions or implementation do not establish human conception. Potential new matter relative to provisional application 64/131,861 must not be assigned its filing date without support analysis. Warn before public disclosure and append qualifying events to the designated ongoing IP log.
