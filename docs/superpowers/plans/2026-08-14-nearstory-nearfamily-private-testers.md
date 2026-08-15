# NearStory and NearFamily Private Testers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admit Elizabeth and 1–3 manually invited adult households to a seven-day, release-bound NearFamily canary followed by NearStory, while public access remains dark and every activation is reversible and evidenced.

**Architecture:** Treat shared runtime readiness, NearFamily, and NearStory as three independent release units. A deployment-owned OIDC/PG control plane authorizes exact household and release invitations; D1 remains product-domain authority; source-off and kill-switch decisions fail closed. NearFamily is activated first, then NearStory only after provider, worker, storage, consent, moderation, spending, deletion, and reconciliation evidence passes.

**Tech Stack:** TypeScript, React/Vinext, Cloudflare Workers/Sites, D1/SQLite, PostgreSQL 16, Cloud SQL IAM Auth Proxy, Google OIDC/WIF, Cloud KMS, R2, Terraform, Node test runner.

**Local test runtime:** `NODE=/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node`

## Global Constraints

- Initial cohort is Elizabeth plus 1–3 personally known adult households.
- Initial access lasts seven days and requires explicit renewal.
- Public NearStory and NearFamily gates remain dark throughout preparation.
- Uninvited, expired, revoked, wrong-release, and kill-switched requests return the reviewed indistinguishable 404 response.
- NearFamily activates before NearStory.
- No percentage rollout, public enrollment, automatic scheduler activation, shared account, bypass URL, or reusable bearer token.
- D1 migrations must not be delivered through the Sites migration path that previously failed on trigger bodies.
- Unknown, stale, mismatched, or unavailable evidence is a no-go result.
- Tester feedback must not collect child names, story text, recordings, credentials, household identifiers, or authentication values.
- Invitations must not be sent before the pre-disclosure IP review.
- Product gates may be changed only in a separate reviewed activation commit after runtime evidence passes.

---

## File Map

- `lib/private-tester-release.ts`: exact release descriptor and seven-day tester-window validation.
- `scripts/capture-private-tester-baseline.ts`: read-only production baseline and rollback evidence collector.
- `scripts/apply-private-tester-d1.ts`: explicit supported D1 0017–0025 migration runner outside Sites packaging.
- `scripts/verify-private-tester-runtime.ts`: combines source, D1, PG, OIDC, identity, and dark-gate checks.
- `app/api/internal/canary-entitlement/route.ts`: existing default-dark invitation issue/revoke/verify boundary.
- `app/api/internal/private-canary-observation/route.ts`: existing authenticated D1 observation boundary.
- `lib/nearfamily-activation.ts`: reviewed NearFamily source activation constant; changed only in the final activation task.
- `app/api/v1/family/route.ts`: NearFamily request authorization and summary boundary.
- `app/family/availability.ts`: page/navigation authorization boundary.
- `app/api/v1/stories/production.ts`: NearStory readiness and enqueue boundary.
- `app/api/internal/nearstory-worker/route.ts`: NearStory worker authentication boundary.
- `lib/nearstory-production-worker.ts`: provider/storage/finalization fencing.
- `scripts/private-tester-go-no-go.ts`: exact product gate evaluation and immutable JSON evidence output.
- `docs/runbooks/private-tester-rollout.md`: operator sequence, smoke tests, daily review, and rollback.
- `tests/private-tester-*.test.mjs`: executable regression and workflow-alignment tests.

---

### Task 1: Exact Release and Tester-Window Contract

**Files:**
- Create: `lib/private-tester-release.ts`
- Create: `tests/private-tester-release.test.mjs`

**Interfaces:**
- Produces: `parsePrivateTesterRelease(input: unknown, nowMs: number): PrivateTesterRelease`
- Produces: `PrivateTesterRelease = { releaseId; commitSha; sitesVersion; startsAt; expiresAt; products }`

- [ ] **Step 1: Write the failing contract test**

```js
test("accepts one exact seven-day NearFamily-then-NearStory release", () => {
  const value = parsePrivateTesterRelease({
    releaseId: "rel_20260814_private_01",
    commitSha: "a".repeat(40),
    sitesVersion: "appgprj_example~appgver_example",
    startsAt: "2026-08-14T18:00:00.000Z",
    expiresAt: "2026-08-21T18:00:00.000Z",
    products: ["nearfamily", "nearstory"],
  }, Date.parse("2026-08-14T18:00:00.000Z"));
  assert.deepEqual(value.products, ["nearfamily", "nearstory"]);
});
```

Add rejection cases for reordered products, windows other than exactly seven days, non-40-hex commits, unknown keys, stale starts, and expiry beyond seven days.

- [ ] **Step 2: Run the test and observe RED**

Run: `$NODE --import tsx --test tests/private-tester-release.test.mjs`  
Expected: FAIL because `lib/private-tester-release.ts` does not exist.

- [ ] **Step 3: Implement the exact parser**

Use an exact-key object check, anchored identifier patterns, `Date.parse`, an exact `7 * 24 * 60 * 60 * 1000` interval, and the literal ordered tuple `['nearfamily', 'nearstory']`. Reject starts more than five minutes before `nowMs`.

- [ ] **Step 4: Run the focused test and TypeScript**

Run: `$NODE --import tsx --test tests/private-tester-release.test.mjs && $NODE node_modules/typescript/bin/tsc --noEmit --incremental false`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/private-tester-release.ts tests/private-tester-release.test.mjs
git commit -m "feat: define exact private tester release"
```

### Task 2: Read-Only Production Baseline and Rollback Record

**Files:**
- Create: `scripts/capture-private-tester-baseline.ts`
- Create: `tests/private-tester-baseline.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `parsePrivateTesterRelease`
- Produces: O_EXCL JSON containing release, Sites version, D1 ledger/schema hashes, PG migration/catalog hashes, DNS/OAuth identifiers, bindings, exact secret-version resource names, current gate values, and rollback Sites version.

- [ ] **Step 1: Write a failing evidence-schema test**

Assert the collector rejects missing rollback version, secret aliases lacking numeric versions, enabled product/scheduler gates, D1 ledger beyond or below the observed baseline, and an output path that already exists.

- [ ] **Step 2: Run the test and observe RED**

Run: `$NODE --import tsx --test tests/private-tester-baseline.test.mjs`  
Expected: FAIL because the collector is absent.

- [ ] **Step 3: Implement read-only collection**

Require dependency-injected read adapters in the library function but expose only a CLI that constructs deployment-owned Sites, D1, PG, Secret Manager, DNS, and OAuth readers. Hash canonical JSON with SHA-256 and write using `flag: 'wx'`. Never print secret values.

- [ ] **Step 4: Verify no mutating command is present**

Run: `rg -n "deploy|apply|insert|update|delete|secret versions access" scripts/capture-private-tester-baseline.ts`  
Expected: no mutation implementation; allow only read/list/describe/query operations.

- [ ] **Step 5: Run tests and commit**

```bash
$NODE --import tsx --test tests/private-tester-baseline.test.mjs
git add scripts/capture-private-tester-baseline.ts tests/private-tester-baseline.test.mjs package.json
git commit -m "feat: capture private tester rollback baseline"
```

### Task 3: Supported D1 0017–0025 Migration Path

**Files:**
- Create: `scripts/apply-private-tester-d1.ts`
- Create: `tests/private-tester-d1-migrations.test.mjs`
- Modify: `docs/runbooks/private-canary-runtime.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: recovery identifier, exact database ID, migration SHA-256 manifest, reviewed release.
- Produces: immutable application receipt with pre/post ledger, schema hashes, row-count invariants, and recovery identifier.

- [ ] **Step 1: Write failing migration-runner tests**

Tests must assert: only exact files `0017` through `0025` are accepted; input hashes match a committed manifest; production execution requires a recovery identifier; already-applied exact migrations replay safely; partial/mismatched ledgers fail; and no `0026` file is accepted.

- [ ] **Step 2: Run the test and observe RED**

Run: `$NODE --import tsx --test tests/private-tester-d1-migrations.test.mjs`  
Expected: FAIL because the runner is absent.

- [ ] **Step 3: Implement explicit statement-aware execution**

Use the supported D1 API/CLI path that parses SQLite trigger bodies correctly; do not use Sites packaging, naive semicolon splitting, or caller-provided SQL. Acquire an operation lock, verify the exact pre-ledger, apply one reviewed file at a time, read back schema/ledger after each file, and stop at `0025`.

- [ ] **Step 4: Run blank and upgrade fixtures**

Run: `$NODE --import tsx --test tests/migration-drift.test.mjs tests/nearfamily-capacity.test.mjs tests/private-tester-d1-migrations.test.mjs`  
Expected: PASS for blank SQLite and the production-like 0016→0025 upgrade fixture.

- [ ] **Step 5: Commit**

```bash
git add scripts/apply-private-tester-d1.ts tests/private-tester-d1-migrations.test.mjs docs/runbooks/private-canary-runtime.md package.json
git commit -m "feat: add reviewed private tester D1 upgrade"
```

### Task 4: PostgreSQL, IAM, OIDC, and READINESS_PG Runtime Proof

**Files:**
- Create: `scripts/verify-private-tester-runtime.ts`
- Create: `tests/private-tester-runtime-proof.test.mjs`
- Modify: `.openai/worker-bindings.json`
- Modify: `infra/production/product-rollout.tf`

**Interfaces:**
- Consumes: exact PG16 catalog at `0006_private_canary_observation`, Cloud SQL IAM proxy artifact, pinned OIDC tuple, `READINESS_PG` query adapter.
- Produces: `RuntimeProof` with exact identity, catalog, RLS/FORCE-RLS, controller mapping, connectivity, observed server time, and dark-gate results.

- [ ] **Step 1: Write failing proof tests**

Reject password-bearing database URLs, non-loopback proxy targets, missing `--auto-iam-authn`, OIDC tuple drift, unreviewed catalog checksum, missing FORCE RLS, public function execute, wrong controller identity, non-server timestamps, and any enabled product/scheduler route.

- [ ] **Step 2: Run the test and observe RED**

Run: `$NODE --import tsx --test tests/private-tester-runtime-proof.test.mjs`  
Expected: FAIL because the verifier is absent.

- [ ] **Step 3: Implement deployment-owned verification**

Reuse the committed catalog checker, service OIDC verifier, controller identity mapping, and `READINESS_PG` binding contract. Query PG clock and the two `0006` loaders in one statement. The CLI must accept resource identifiers, never raw credentials.

- [ ] **Step 4: Verify Terraform and bindings**

Run: `terraform -chdir=infra/production fmt -check && terraform -chdir=infra/production validate`  
Run: `$NODE --import tsx --test tests/private-canary-runtime.test.mjs tests/private-tester-runtime-proof.test.mjs`  
Expected: PASS, with services and schedulers still count-zero/dark.

- [ ] **Step 5: Commit**

```bash
git add scripts/verify-private-tester-runtime.ts tests/private-tester-runtime-proof.test.mjs .openai/worker-bindings.json infra/production/product-rollout.tf
git commit -m "feat: verify private tester runtime identity"
```

### Task 5: NearFamily Exact Private Canary

**Files:**
- Create: `tests/nearfamily-private-canary.test.mjs`
- Modify: `lib/nearfamily-activation.ts`
- Modify: `app/family/availability.ts`
- Modify: `app/api/v1/family/route.ts`
- Modify: `app/family/FamilyDashboard.tsx`

**Interfaces:**
- Consumes: exact private release, PG NearFamily invitation, D1 migrations through 0025.
- Produces: one release-bound, household-authorized NearFamily tester surface with unchanged public 404 denial.

- [ ] **Step 1: Write failing route/page tests**

Cover dark source, uninvited household, expired invitation, wrong release, kill switch, Elizabeth invited, restricted capacity, downgrade-at-limit, revocation, and immediate navigation disappearance. Assert PG authorization precedes D1 summary reads and the same decision is reused by page/navigation.

- [ ] **Step 2: Run the tests and observe RED for the activation contract**

Run: `$NODE --import tsx --test tests/nearfamily-web.test.mjs tests/nearfamily-private-canary.test.mjs`  
Expected: new activation tests fail while the literal source gate is false.

- [ ] **Step 3: Add a reviewed private-canary source mode**

Replace the boolean with an exact literal mode type:

```ts
export type NearFamilySourceMode = "dark" | "private_canary";
const NEARFAMILY_SOURCE_MODE: NearFamilySourceMode = "private_canary";
```

The mode must never read an environment variable. Keep PG household/release/invite authorization mandatory and preserve no-store 404 responses.

- [ ] **Step 4: Run NearFamily and migration gates**

Run: `$NODE --import tsx --test tests/nearfamily-capacity.test.mjs tests/nearfamily-web.test.mjs tests/nearfamily-private-canary.test.mjs tests/product-release-readiness.test.mjs`  
Expected: PASS.

- [ ] **Step 5: Commit the activation separately**

```bash
git add lib/nearfamily-activation.ts app/family/availability.ts app/api/v1/family/route.ts app/family/FamilyDashboard.tsx tests/nearfamily-private-canary.test.mjs
git commit -m "feat: admit exact NearFamily private canary"
```

### Task 6: NearFamily Rehearsal, Invitation, and Revocation

**Files:**
- Create: `scripts/private-tester-nearfamily.ts`
- Create: `tests/private-tester-nearfamily.test.mjs`
- Modify: `docs/runbooks/private-tester-rollout.md`

**Interfaces:**
- Consumes: authenticated canary-entitlement route, exact release, household hash, runtime proof.
- Produces: issue→exercise→revoke→404→reissue evidence with no personal tester data.

- [ ] **Step 1: Write failing state-machine tests**

Model `dark → issued → exercised → revoked → verified_denied → reissued`. Reject skipping revocation proof, reusing a request key with changed input, household mismatch, disclosure approval missing, or access beyond seven days.

- [ ] **Step 2: Run RED, implement, then run GREEN**

Run: `$NODE --import tsx --test tests/private-tester-nearfamily.test.mjs`  
Expected before implementation: FAIL; after implementation: PASS.

- [ ] **Step 3: Add exact smoke assertions**

The runner must verify identity/member/invite/entitlement/privacy/capacity-remediation probes, Family→Plus downgrade at exact limits, restricted-state remediation availability, export/deletion/revoke availability, and zero cross-household reads.

- [ ] **Step 4: Commit**

```bash
git add scripts/private-tester-nearfamily.ts tests/private-tester-nearfamily.test.mjs docs/runbooks/private-tester-rollout.md
git commit -m "feat: rehearse NearFamily private tester access"
```

### Task 7: NearStory Worker and Provider Readiness

**Files:**
- Create: `tests/nearstory-private-canary.test.mjs`
- Modify: `app/api/v1/stories/production.ts`
- Modify: `app/api/internal/nearstory-worker/route.ts`
- Modify: `lib/nearstory-production-worker.ts`
- Modify: `.openai/worker-bindings.json`

**Interfaces:**
- Consumes: exact release/invite authorization, OpenAI/ElevenLabs exact secret versions, R2, worker identity, D1/PG outcome reconciliation.
- Produces: private worker execution fenced at authorization, provider, storage, persist, and finalize boundaries.

- [ ] **Step 1: Write failing kill-boundary tests**

Cover kill between initial authorization and OpenAI, ElevenLabs, R2 put/copy, D1 persist, and final completion. Cover stale heartbeat, wrong release/version, consent revocation, provider timeout, moderation unavailable/unsafe, spend ceiling, retry, dead letter, deletion, and outbox reconciliation.

- [ ] **Step 2: Run the focused worker suite and record RED**

Run: `$NODE --import tsx --test tests/nearstory-worker.test.mjs tests/nearstory-private-canary.test.mjs`  
Expected: new private-canary cases fail until exact runtime bindings/fences are supplied.

- [ ] **Step 3: Implement only missing boundaries**

Reuse existing release/version fence and outcome outbox. Do not add a second authorization model. Public scheduling remains disabled; the worker is invoked only through the pinned private identity.

- [ ] **Step 4: Run NearStory gates**

Run: `$NODE --import tsx --test tests/nearstory.test.mjs tests/nearstory-route.test.mjs tests/nearstory-actual-route.test.mjs tests/nearstory-worker.test.mjs tests/nearstory-private-canary.test.mjs`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/api/v1/stories/production.ts app/api/internal/nearstory-worker/route.ts lib/nearstory-production-worker.ts .openai/worker-bindings.json tests/nearstory-private-canary.test.mjs
git commit -m "feat: fence NearStory private canary runtime"
```

### Task 8: NearStory Elizabeth Flow and Rollback Rehearsal

**Files:**
- Create: `scripts/private-tester-nearstory.ts`
- Create: `tests/private-tester-nearstory.test.mjs`
- Modify: `docs/runbooks/private-tester-rollout.md`

**Interfaces:**
- Consumes: authenticated Elizabeth household, verified child/voice consent, exact release, worker/provider readiness.
- Produces: one short story receipt covering create, moderate, narrate, caption, store, play, cost, delete, kill, and deny.

- [ ] **Step 1: Write failing orchestration tests**

Assert the runner refuses a non-Elizabeth first household, missing verified voice consent, duration above five minutes, missing cost ceiling, absent deletion proof, unreconciled outcome, or kill switch not demonstrated.

- [ ] **Step 2: Run RED, implement, then run GREEN**

Run: `$NODE --import tsx --test tests/private-tester-nearstory.test.mjs`  
Expected before implementation: FAIL; after implementation: PASS.

- [ ] **Step 3: Bind exact receipts**

Persist only hashed household/test identifiers plus provider request IDs, artifact/output checksums, costs, queue/DLQ state, deletion checksum, and timestamps. Do not persist story text, recordings, child name, email, or credentials in the evidence artifact.

- [ ] **Step 4: Commit**

```bash
git add scripts/private-tester-nearstory.ts tests/private-tester-nearstory.test.mjs docs/runbooks/private-tester-rollout.md
git commit -m "feat: rehearse NearStory private tester flow"
```

### Task 9: Go/No-Go Evidence and Daily Observation

**Files:**
- Create: `scripts/private-tester-go-no-go.ts`
- Create: `tests/private-tester-go-no-go.test.mjs`
- Modify: `docs/runbooks/private-tester-rollout.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: baseline, runtime proof, product rehearsal receipts, security/IP approval markers, queue/cost/deletion observations.
- Produces: `no_go`, `nearfamily_go`, or `nearstory_go`; O_EXCL daily evidence artifact.

- [ ] **Step 1: Write failing exact-matrix tests**

Assert unknown/stale/missing evidence is no-go; NearStory cannot be go before NearFamily; high-severity security, cross-household access, missing IP review, consent failure, unbounded spend, DLQ, deletion failure, rollback failure, or expired invitation is no-go.

- [ ] **Step 2: Run RED and implement exact evaluation**

Run: `$NODE --import tsx --test tests/private-tester-go-no-go.test.mjs`  
Expected before implementation: FAIL; after implementation: PASS.

- [ ] **Step 3: Add daily seven-day schedule to the runbook only**

Document a manual daily operator check. Do not add a GitHub cron, Cloud Scheduler job, marketing workflow, or automatic cohort expansion.

- [ ] **Step 4: Commit**

```bash
git add scripts/private-tester-go-no-go.ts tests/private-tester-go-no-go.test.mjs docs/runbooks/private-tester-rollout.md package.json
git commit -m "feat: gate private tester observation"
```

### Task 10: Full Verification, Independent Review, and Controlled Handoff

**Files:**
- Modify: `docs/runbooks/private-tester-rollout.md`
- Modify: `docs/superpowers/specs/2026-08-14-nearstory-nearfamily-private-tester-design.md` only if implementation revealed an approved design correction.

**Interfaces:**
- Consumes: all previous task commits.
- Produces: reviewed release candidate; no automatic deployment or invitation.

- [ ] **Step 1: Run the full fail-fast source gate**

```bash
set -euo pipefail
$NODE --import tsx --test tests/*.test.mjs
$NODE node_modules/typescript/bin/tsc --noEmit --incremental false
$NODE node_modules/eslint/bin/eslint.js app lib scripts tests
$NODE scripts/generate-d1-domain-registry.ts --check
$NODE node_modules/vinext/dist/cli.js build
git diff --check
```

Expected: all tests, types, lint, registry, build, and diff checks pass.

- [ ] **Step 2: Run exact dark/public-denial checks**

Verify unauthenticated, uninvited, expired, revoked, wrong-release, and kill-switched requests receive 404 for both products; verify public marketing pages remain available and no scheduler or percentage rollout exists.

- [ ] **Step 3: Obtain independent security and production review**

Review the exact branch diff for authorization bypass, tenant isolation, consent, provider-call fencing, secrets, rollback, migration safety, evidence authenticity, and public-disclosure scope. All Critical/Important findings block deployment.

- [ ] **Step 4: Complete the pre-disclosure record**

Record exact disclosed copy/features, tester recipients, confidentiality status, release commit, URLs, timestamps, contributors, ownership/assignment/funding/licensing changes, and comparison with provisional application 64/131,861. Do not infer human conception from AI output or approval alone.

- [ ] **Step 5: Create a separate reviewed activation release**

The activation release must contain only the exact reviewed source-mode change and deployment configuration needed for the approved product. Deploy NearFamily first. NearStory activation is a later release after NearFamily evidence and the NearStory rehearsal are green.

---

## Execution Stop Conditions

Stop without inviting testers if any of the following occurs: unexpected D1 ledger or schema; PG catalog/RLS drift; failed identity mapping; OAuth tuple mismatch; cross-household visibility; inability to revoke; provider call after kill; consent ambiguity; unresolved high-severity finding; unbounded provider cost; DLQ/outbox mismatch; deletion failure; missing rollback evidence; or incomplete pre-disclosure review.

## Completion Definition

The plan is complete only when Elizabeth's NearFamily canary is issued, exercised, revoked, and reissued with exact evidence; NearStory then completes the same sequence including one short story and deletion; 1–3 adult tester households complete the seven-day private window without a stop condition; access expires or is revoked; and the final disclosure/test record is appended without claiming public or percentage rollout clearance.
