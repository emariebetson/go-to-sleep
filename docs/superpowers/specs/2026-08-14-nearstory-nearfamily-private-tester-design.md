# NearStory and NearFamily Private Tester Design

**Status:** Approved by Elizabeth Betson on 2026-08-14  
**Initial cohort:** Elizabeth plus 1–3 personally known adult households  
**Initial duration:** Seven days  
**Rollout order:** NearFamily first, then NearStory  

## Purpose

Bring NearFamily and NearStory to a small, manually invited private cohort without making either application publicly available, weakening the reviewed authorization model, or treating source readiness as production evidence.

This design does not authorize a public launch, percentage rollout, automatic enrollment, scheduler activation, or bypass of the existing release-readiness controls.

## Access Architecture

- Public NearStory and NearFamily application gates remain dark.
- Tester access uses the reviewed private-canary control plane, not a general environment feature flag.
- Each request must satisfy all of the following:
  - a production-authenticated user;
  - membership in the target household;
  - an active, unexpired, product-specific invitation;
  - binding to the exact deployed release;
  - PostgreSQL household rollout authorization;
  - fresh product readiness and a non-engaged kill switch.
- NearFamily opens to Elizabeth's household first, then to one household at a time.
- NearStory remains unavailable until its worker, provider, storage, moderation, consent, spending, and deletion probes pass for the exact release.
- Uninvited, expired, revoked, wrong-release, or kill-switched requests retain the existing indistinguishable 404 behavior.
- Invitations expire after seven days and require explicit renewal.
- Revocation and kill-switch decisions take priority at request and background-provider boundaries.
- No percentage rollout, public enrollment, marketing automation, or automatic scheduler activation is included.

## Implementation and Activation Sequence

### 1. Freeze and protect production

- Capture the deployed commit, Sites version, D1 ledger and schema, PostgreSQL state, bindings, exact secret versions, DNS, OAuth configuration, and rollback version.
- Confirm NearStory, NearFamily, schedulers, and internal control routes remain dark.
- Create an encrypted backup and verify its recovery identifier.

### 2. Prepare private infrastructure

- Apply reviewed D1 migrations through `0025` only through a deployment mechanism proven compatible with Sites. Do not reintroduce the rejected trigger migration path.
- Apply and attest PostgreSQL migration `0006` against the reviewed PostgreSQL 16 catalog.
- Establish the deployment-owned `READINESS_PG` adapter with pinned identity and fail-closed IAM/TLS connectivity.
- Verify the exact OIDC issuer, audience, subject, JWKS endpoint, service account, secret versions, and immutable release and image identifiers.
- Keep all activation controls off while infrastructure is verified.

### 3. NearFamily private canary

- Verify identity, membership, invitation, entitlement, privacy, capacity remediation, downgrade-at-limit, time expiry, revocation, export, and deletion.
- Issue one release-bound invitation to Elizabeth's household.
- Exercise the dashboard and existing remediation flows.
- Revoke access and prove immediate 404 behavior.
- Reissue access only after rollback evidence passes.
- Add tester households individually and manually.

### 4. NearStory private canary

- Verify OpenAI and ElevenLabs credentials, moderation, verified voice consent, provider budgets, R2 media, worker heartbeat, queues, retry and dead-letter handling, outcome reconciliation, and deletion.
- Start the worker privately while public scheduling remains disabled.
- Create one short story for Elizabeth's household.
- Verify transcript, narration, captions, playback, retry behavior, cost, and complete deletion.
- Engage the kill switch between authorization and a provider or storage boundary to confirm fencing.
- Add one tester household only after the complete Elizabeth flow passes.

### 5. Seven-day observation

- Review errors, authentication, invitations, completion rate, provider cost, queues, dead letters, deletion, revocation, and privacy events daily.
- Stop immediately for cross-household exposure, consent failure, unbounded spend, unrecoverable work, missing evidence, or rollback failure.
- Do not convert this private canary into a percentage or public rollout.

## Tester Experience

- Each tester receives a private invitation identifying the product, seven-day window, confidentiality expectations, support contact, and consent and privacy boundaries.
- Testers sign in normally at `nearyoustill.com`. Shared accounts, bypass links, and reusable bearer tokens are prohibited.
- NearFamily appears only after household authorization. NearStory appears only after its independent readiness gate passes.
- The tester checklist and feedback mechanism must exclude child names, story text, recordings, authentication data, and other sensitive content.
- Access expires automatically and can be revoked immediately.

## Go/No-Go Contract

A product may enter private testing only when every applicable result is green:

- exact release and clean deployment provenance;
- reviewed D1 and PostgreSQL migrations and catalog evidence;
- production identity and household isolation;
- product-specific, release-bound invitation;
- active kill switch and rehearsed rollback;
- fresh readiness evidence with no unresolved failure;
- NearFamily capacity-remediation and privacy checks;
- NearStory worker, provider, storage, moderation, consent, and spending checks;
- no unresolved high-severity security or data-isolation finding;
- completed pre-disclosure IP review.

Unknown, stale, mismatched, or unavailable results are no-go results.

## Evidence Package

Record every activation, test, revocation, and rollback with:

- UTC and local timestamp;
- task or thread identifier;
- release commit and image or artifact digests;
- Sites version and tested URLs;
- migration and catalog checksums;
- tester household hash, never unnecessary personal details;
- product, invitation identifier, release, expiry, and revocation;
- test outputs, queue and dead-letter state, provider request receipts, cost, and deletion result;
- natural-person contributors and their specific technical contributions;
- disclosure recipients, confidentiality status, and disclosed copy and features;
- comparison with provisional application 64/131,861 without assigning its 2026-08-12 filing date to later work.

## Rollback

1. Revoke tester invitations.
2. Engage the product kill switch.
3. Pause NearStory worker intake while preserving reviewed cleanup and deletion paths.
4. Confirm testers receive 404 and no new provider calls occur.
5. Drain or safely quarantine queued work.
6. Restore the previous web release if needed.
7. Preserve forward-only database migrations unless a separately reviewed recovery requires restoration.
8. Record the incident, affected release, evidence, and recovery result.

## IP and Disclosure Boundary

Private testing is a disclosure and potential public-use event even when testers acknowledge confidentiality. Before invitations are sent, review the disclosed product copy, mechanisms, schemas, protocols, algorithms, failure handling, and measurable improvements for potentially unfiled new matter. Record confirmed facts separately from inference and UNKNOWN/TBD items. Elizabeth's approval and supervision alone must not be treated as proof of her human conception; record her specific technical choices and any other natural-person conception contributions.

This IP component is recordkeeping and issue-spotting, not legal advice. The agent is not licensed counsel or a registered patent practitioner.
