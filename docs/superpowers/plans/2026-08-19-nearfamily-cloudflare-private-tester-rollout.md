# NearFamily Cloudflare Private Tester Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safely admit one release-bound NearFamily tester household while public access remains zero.

**Architecture:** Separate Cloud Run decision and controller services connect privately to Cloud SQL using distinct IAM identities and fixed PostgreSQL functions. The Cloudflare Worker uses only the signed, read-only decision service; immutable Cloudflare-native receipts bind the private-route release before the synthetic canary and first invitation.

**Tech Stack:** TypeScript, Node 24, Cloudflare Workers/D1/R2, Cloud Run, Cloud SQL PostgreSQL 16, Google IAM, Cloud KMS, Terraform, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-19-cloudflare-private-tester-readiness-gateway-design.md`

## Global Constraints

- NearStory remains dark throughout this plan.
- Public NearFamily rollout is always zero; no public source gate or percentage rollout is permitted.
- Cloudflare never stores a Cloud SQL connection string or database password.
- Decision and controller services, IAM identities, database roles, signing keys, nonce stores, and logs are distinct.
- Controller actions originate only from the reviewed Cloud Build identity; an app-user or Worker cannot invoke them.
- Every release/evidence object is canonical JSON, KMS-signed, raw-byte SHA-256 bound, and generation-zero written.
- Rollback is kill/revoke, denial readback, queue fence, entitlement revoke, prior Worker deployment, recovery verification.

---

### Task 1: Fixed PostgreSQL decision authority

**Files:**
- Create: `postgres/migrations/0012_nearfamily_private_tester_decision.sql`
- Modify: `postgres/catalog-manifest.json`
- Modify: `infra/production/main.tf`
- Create: `tests/nearfamily-private-decision.test.mjs`

**Interfaces:**
- Produces `nearyou.authorize_nearfamily_private_tester(household_hash text, release_id text, observed_at timestamptz) returns table(allowed boolean, expires_at timestamptz)`.
- Produces distinct IAM users `nearyou-pt-decision@nearnight.iam` and existing controller identity with no overlapping sensitive PostgreSQL memberships.

- [ ] Write failing tests for exact product/release/hash matching, expiry, revocation, terminal kill, and non-mutating decision role.
- [ ] Run `node --import tsx --test tests/nearfamily-private-decision.test.mjs`; expect failure because migration/function are absent.
- [ ] Implement the fixed execute-only function and grants; add catalog entries and correct Terraform’s reviewed migration-head/RLS predicate.
- [ ] Add a disposable PostgreSQL 16 migration test that proves neither identity has the other role or table privileges.
- [ ] Run the focused tests, `npm run typecheck`, and `git diff --check`.
- [ ] Commit `feat: add isolated NearFamily decision authority`.

### Task 2: Decision and controller gateway contracts

**Files:**
- Create: `services/readiness-decision/src/envelope.ts`
- Create: `services/readiness-decision/src/server.ts`
- Create: `services/readiness-controller/src/server.ts`
- Create: `services/readiness-gateway/package.json`
- Create: `tests/readiness-gateway-contract.test.mjs`

**Interfaces:**
- Decision accepts only canonical `{version:1,releaseId,householdHash,issuedAt,nonce,bodySha256,keyVersion,signature}` and returns `{version:1,allowed:boolean,expiresAt?:number}`.
- Controller accepts the existing strict activation request only after Cloud Run IAM identity verification.

- [ ] Write failing vectors for canonical HMAC, unknown fields, 4 KiB limit, clock window, duplicate/uncertain nonce, key windows, and decision credentials reaching controller.
- [ ] Implement envelope parsing and atomic PostgreSQL nonce consumption before decision queries; retain nonces ten minutes and fail closed on any store uncertainty.
- [ ] Implement decision service with one fixed database function and controller service with distinct Google-ID-token audience/subject verification and strict action schema.
- [ ] Add tests proving controller retry requires byte-identical operation data and emergency kill is independent of ordinary controller access.
- [ ] Run focused tests, typecheck, lint, and diff check.
- [ ] Commit `feat: add split private tester readiness gateways`.

### Task 3: Disposable Cloud Run and Cloud SQL proof

**Files:**
- Create: `infra/production/readiness-gateway.tf`
- Create: `infra/disposable/readiness-gateway.tfvars.example`
- Create: `scripts/verify-readiness-gateway.ts`
- Create: `tests/readiness-gateway-infrastructure.test.mjs`

**Interfaces:**
- Produces decision/controller Cloud Run revisions, separate service accounts, private VPC egress, Cloud SQL IAM connector configuration, secret resource names/versions, and immutable verification JSON.

- [ ] Write failing infrastructure tests requiring decision max instances `1`, concurrency `10`, two-second timeout, controller `allUsers` denial, and separate service-account/database identities.
- [ ] Implement Terraform without database credentials, public Cloud Run controller ingress, or guessed Cloudflare network identifiers.
- [ ] Implement read-only verifier returning revision/image/IAM/VPC/identity digests without values or user content.
- [ ] Apply only to a disposable project; run verifier and prove wrong audience, Worker decision credential, replay, and controller privilege escalation are denied.
- [ ] Preserve immutable disposable proof; run focused tests/typecheck/lint/diff check.
- [ ] Commit `feat: provision isolated readiness gateway proof`.

### Task 4: Cloudflare private-route decision client

**Files:**
- Create: `lib/nearfamily-private-decision-client.ts`
- Modify: `lib/nearfamily-activation.ts`
- Modify: `lib/nearfamily-route.ts`
- Modify: `app/api/v1/family/route.ts`
- Modify: `app/family/availability.ts`
- Modify: `cloudflare-env.d.ts`
- Create: `tests/nearfamily-private-route.test.mjs`

**Interfaces:**
- Consumes the Task 2 decision endpoint and a Worker secret `NEARFAMILY_DECISION_SIGNING_KEY`.
- Produces a private-route state that authorizes only a valid decision response; every fetch/parse/signature error returns unavailable.

- [ ] Write failing tests for one exact invited hash, non-invited denial, release mismatch, expired reply, key mismatch, gateway timeout, and source-private/public-zero state.
- [ ] Implement signed request construction and bounded fetch; do not log household hashes, nonce, body, or headers.
- [ ] Change NearFamily from literal dark to a separately attested private-route gate that still defaults deny and has no public percentage path.
- [ ] Add a kill-first rollback helper and tests proving deny occurs before any prior-version restore operation.
- [ ] Run focused tests, typecheck, lint, build, and diff check.
- [ ] Commit `feat: gate NearFamily through private decision authority`.

### Task 5: Cloudflare-native immutable release evidence

**Files:**
- Create: `lib/cloudflare-private-tester-evidence.ts`
- Create: `scripts/capture-cloudflare-private-tester-baseline.ts`
- Create: `tests/cloudflare-private-tester-evidence.test.mjs`
- Create: `wrangler.production.jsonc`
- Modify: `docs/runbooks/private-tester-rollout.md`

**Interfaces:**
- Produces a signed receipt binding active/rollback Worker versions and traffic, build hash, custom domains, D1/R2 identities/digests, decision revision, Cloud SQL identity digests, secret version references, and private/public gate facts.

- [ ] Write failing tests for mixed version/traffic, binding substitution, deployment changes during reads, wrong domain, secret values, and immutable storage conflicts.
- [ ] Implement pre/post deployment bracketing and generation-zero receipt publication; use a distinct collector identity and pinned KMS trust tuple.
- [ ] Add `wrangler.production.jsonc` only with dashboard-verified Worker/D1/R2 identifiers, `keep_vars`, and no route, secret, or guessed service binding.
- [ ] Run a disposable capture and promotion; verify every artifact shares release/build/version/gate values.
- [ ] Run focused tests, typecheck, lint, build, and diff check.
- [ ] Commit `feat: bind private tester evidence to Cloudflare deployment`.

### Task 6: Production release, canary, and first invitation

**Files:**
- Create: `docs/runbooks/nearfamily-private-tester-invitation.md`
- Modify: `.github/workflows/canary-evidence-sampler.yml`
- Modify: `.github/workflows/production-evidence.yml`
- Modify: `docs/runbooks/private-tester-rollout.md`

**Interfaces:**
- Consumes Task 5 promoted receipt and Task 2 controller service; produces synthetic proof, 96-sample signed canary, auditable go/no-go, exact seven-day invite, entitlement issuance, and denial readback.

- [ ] Add failing workflow/CLI tests requiring controller-only activation, real emergency kill callback, receipt verification, exact release/build/deployment identity, and no Worker controller mutation.
- [ ] Configure the reviewed production services and apply separately authorized PostgreSQL/D1 migrations only after recovery identifiers and catalog review are captured.
- [ ] Deploy and evidence the dark release, then the separately evidenced private-route release; run synthetic invited/denied, capacity, deletion, revocation, and rollback proof.
- [ ] Start the durable synthetic canary; collect 96 valid samples over 24 continuous hours and finalize/verify the signed receipt.
- [ ] Perform security/public-copy/IP review and final controller readback/denial probe; issue one seven-day NearFamily invite and audited Family entitlement only when every check is green.
- [ ] Monitor the first real session; immediately execute emergency kill/revoke on any invariant failure.
