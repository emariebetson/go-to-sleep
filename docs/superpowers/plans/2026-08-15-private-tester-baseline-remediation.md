# Private Tester Baseline Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the exact D1 provider-object defect and authenticate live Sites, rollback, D1, and R2 identities with a KMS-signed deployment manifest before private-tester baseline collection can succeed.

**Architecture:** A deployment-time composer obtains exact deployment/resource facts from the authorized release operation, canonicalizes an exact manifest, and signs its SHA-256 digest with the existing exact-version Cloud KMS RSA-3072 signer. The runtime collector verifies the signature with the pinned public key, checks release/commit/freshness and live D1 invariants, atomically consumes a nonce, and only then emits O_EXCL baseline evidence. No environment value or runtime binding label is accepted as observed control-plane truth.

**Tech Stack:** TypeScript, Cloudflare Sites/Workers, D1/SQLite, Cloud KMS asymmetric signing, PostgreSQL nonce store, Node test runner.

**Local test runtime:** `NODE=/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node`

## Global Constraints

- Public NearFamily and NearStory gates remain dark.
- No migration, deployment, invitation, scheduler, provider call, or product activation occurs in this remediation.
- The exact five reviewed D1 provider-internal object identities are mandatory; absence, addition, or mutation fails closed.
- Manifest facts are exact live Sites version+commit, explicit rollback version+commit, provider-qualified D1 database identity, provider-qualified R2 bucket identity, release ID, issued/not-before/expires timestamps, nonce, signer key/version, and canonical schema version.
- Manifest lifetime is at most 15 minutes and every identity is exact-key, bounded, descriptor-safe, and canonical.
- Signing uses the existing exact-version RSA-3072 Cloud KMS path; verification uses the production public-key client and atomic PostgreSQL nonce store.
- Raw secrets, OAuth tokens, personal information, household identifiers, and tester data never enter the manifest or evidence.
- Unknown, stale, duplicate, mismatched, replayed, or unverifiable inputs fail closed.

---

### Task 1: Exact Live D1 Provider-Internal Object Set

**Files:**
- Modify: `lib/private-tester-baseline-gateway.ts`
- Modify: `scripts/capture-private-tester-baseline.ts`
- Modify: `tests/private-tester-baseline-gateway.test.mjs`
- Modify: `tests/private-tester-baseline.test.mjs`

**Interfaces:**
- Produces: `validateExactD1ProviderObjects(objects): void` shared by gateway and collector.

- [ ] **Step 1: Write RED adversarial tests**

Assert rejection when any one of the five reviewed identities is missing, duplicated, renamed, has the wrong type/table/SQL-nullness, or when an extra object is attached to a provider table.

- [ ] **Step 2: Run focused tests and observe failure**

Run: `$NODE --import tsx --test tests/private-tester-baseline-gateway.test.mjs tests/private-tester-baseline.test.mjs`  
Expected: at least the missing-provider-object test fails.

- [ ] **Step 3: Implement exact set equality**

Define one immutable exact identity tuple and compare canonical `type\0name\0tableName\0sql` records with set size and duplicate rejection before any source-schema hash is accepted.

- [ ] **Step 4: Run focused tests, TypeScript, and lint**

Run: `$NODE --import tsx --test tests/private-tester-baseline-gateway.test.mjs tests/private-tester-baseline.test.mjs && $NODE node_modules/typescript/bin/tsc --noEmit --incremental false && $NODE node_modules/eslint/bin/eslint.js lib/private-tester-baseline-gateway.ts scripts/capture-private-tester-baseline.ts tests/private-tester-baseline*.test.mjs`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/private-tester-baseline-gateway.ts scripts/capture-private-tester-baseline.ts tests/private-tester-baseline-gateway.test.mjs tests/private-tester-baseline.test.mjs
git commit -m "fix: require exact D1 provider schema"
```

### Task 2: KMS-Signed Deployment Manifest

**Files:**
- Create: `lib/private-tester-deployment-manifest.ts`
- Create: `scripts/compose-private-tester-deployment-manifest.ts`
- Create: `tests/private-tester-deployment-manifest.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `parsePrivateTesterDeploymentManifest(input, nowMs)`.
- Produces: `composePrivateTesterDeploymentManifest(observedReleaseOperation, clock, nonceSource)`.
- Produces: a canonical signed envelope `{ claims, signature }` using the existing `CloudKmsEvidenceSigner`.

- [ ] **Step 1: Write RED exact-schema and signature tests**

Cover happy RSA-3072 sign/verify; wrong live or rollback commit; same live/rollback version; wrong D1/R2 resource; stale/future/over-15-minute claims; weak/wrong key; tamper; duplicate/hidden/accessor/symbol keys; nonce replay; and O_EXCL lost-response recovery.

- [ ] **Step 2: Run focused tests and observe failure**

Run: `$NODE --import tsx --test tests/private-tester-deployment-manifest.test.mjs`  
Expected: FAIL because the manifest module is absent.

- [ ] **Step 3: Implement canonical claims and deployment-owned composer**

The production CLI must accept a bounded JSON file emitted by the authorized deployment operation, not environment facts. Require exact provider-qualified resource formats and exact commit/version relationships. Canonicalize, hash, KMS-sign, locally verify signature/CRC/key version, and write with `flag: 'wx'`.

- [ ] **Step 4: Run focused tests and static gates**

Run: `$NODE --import tsx --test tests/private-tester-deployment-manifest.test.mjs && $NODE node_modules/typescript/bin/tsc --noEmit --incremental false && $NODE node_modules/eslint/bin/eslint.js lib/private-tester-deployment-manifest.ts scripts/compose-private-tester-deployment-manifest.ts tests/private-tester-deployment-manifest.test.mjs && git diff --check`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/private-tester-deployment-manifest.ts scripts/compose-private-tester-deployment-manifest.ts tests/private-tester-deployment-manifest.test.mjs package.json
git commit -m "feat: sign exact private tester deployment manifest"
```

### Task 3: Baseline Verification and Breaker Closure

**Files:**
- Modify: `scripts/capture-private-tester-baseline.ts`
- Modify: `tests/private-tester-baseline.test.mjs`
- Modify: `docs/runbooks/private-canary-runtime.md`
- Modify: `docs/runbooks/private-tester-rollout.md`

**Interfaces:**
- Consumes: signed deployment manifest, `CloudKmsPublicKeyClient`, `verifyReleaseEvidence`-compatible trust rules, `PostgresNonceStore`, exact live D1 object evidence.
- Produces: production baseline only after signature, nonce, release, resource, schema, and freshness equality.

- [ ] **Step 1: Write RED end-to-end verification tests**

Prove an unsigned/self-asserted Sites response cannot unblock collection; a valid signed manifest can; wrong live/rollback/resource/commit/schema, replay, stale evidence, missing D1 internal object, and committed-lost nonce response all fail or converge safely.

- [ ] **Step 2: Run focused tests and observe failure**

Run: `$NODE --import tsx --test tests/private-tester-baseline.test.mjs tests/private-tester-deployment-manifest.test.mjs`  
Expected: new baseline-unblock test fails before integration.

- [ ] **Step 3: Integrate production verification**

Remove the unconditional control-plane blocker only after the signed manifest is verified and nonce consumption succeeds. Exact-compare manifest facts with release descriptor, gateway D1 schema/ledger, PG identity, and provider inventories. Preserve O_EXCL output and read-only behavior.

- [ ] **Step 4: Run full fail-fast verification**

```bash
set -euo pipefail
$NODE --import tsx --test tests/*.test.mjs
$NODE node_modules/typescript/bin/tsc --noEmit --incremental false
$NODE node_modules/eslint/bin/eslint.js app lib scripts tests
$NODE scripts/generate-d1-domain-registry.ts --check
git diff --check
```

Expected: all tests and static gates pass. The supported-environment production build remains a separate required release gate.

- [ ] **Step 5: Independent review and commit**

Require spec-compliance and security-quality approval before marking the original Task 2 blocker closed.

```bash
git add scripts/capture-private-tester-baseline.ts tests/private-tester-baseline.test.mjs docs/runbooks/private-canary-runtime.md docs/runbooks/private-tester-rollout.md
git commit -m "feat: verify signed private tester baseline"
```

---

## Completion Definition

The remediation is complete only when exact D1 provider-object equality is enforced, a real deployment-operation fact set is signed and verified with the pinned KMS key, nonce replay is impossible, baseline output remains immutable/read-only, all source gates pass, and independent review confirms no self-asserted control-plane fact can produce a baseline. This source completion does not itself deploy the manifest composer, produce a production manifest, invite testers, or activate either product.
