# NearFamily Operational Tier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete NearFamily as the server-owned higher-capacity household tier, including atomic capacity enforcement, safe downgrade restrictions, and an exact dark product summary.

**Architecture:** Preserve the existing canonical `PLAN_CATALOG` and database capacity triggers. Use one statement-time household-capacity projection derived from the current entitlement and actual usage, enforce it in every capacity-consuming mutation, and expose a read-only summary only through the already literal-off NearFamily route. Management, export, deletion, consent revocation, billing, and member departure remain available when over capacity.

**Adversarial-review correction (2026-08-12):** The initially implemented mutable `household_capacity_state` row was rejected because clock-only entitlement/invitation expiry could make it stale and raw D1 writers could fabricate its version/time. Migration 0024 removes that table from current schema authority. The view is now the non-mutable, statement-time authority; all capacity-growing transitions share it, child/voice limits use its canonical entitlement ordering, and signed readiness requires `capacityRemediation`.

**Tech Stack:** TypeScript 5.9, Vinext/React 19, Drizzle ORM, Cloudflare D1/SQLite migrations, Node test runner.

## Global Constraints

- `NEARFAMILY_ROUTE_ENABLED` remains literal `false`.
- No Stripe live-mode, rollout, scheduler, worker, or product flag is enabled.
- Children remain adult-managed non-login records.
- Capacity checks execute in the same D1 transaction as the mutation.
- A downgrade never deletes or silently modifies household data.
- Over-capacity state blocks only new capacity-consuming mutations.
- Existing NearSleep and NearStory compatibility is preserved.

---

### Task 1: Canonical NearFamily capacity policy

**Files:**
- Modify: `lib/nearyou-foundation.ts`
- Create: `lib/nearfamily-capacity.ts`
- Test: `tests/nearfamily-capacity.test.mjs`

**Interfaces:**
- Consumes: `PLAN_CATALOG`, `PlanId` from `lib/nearyou-foundation.ts`.
- Produces:
  ```ts
  export type HouseholdCapacityUsage = { members:number; children:number; voices:number; storageBytes:number };
  export type HouseholdCapacityDecision = { state:"within_limit"|"restricted"; exceeded:("members"|"children"|"voices"|"storageBytes")[]; limits:HouseholdCapacityUsage };
  export function decideHouseholdCapacity(planId:PlanId, usage:HouseholdCapacityUsage):HouseholdCapacityDecision;
  export function capacityMutationAllowed(decision:HouseholdCapacityDecision, operation:"consume"|"delete"|"export"|"revoke"|"billing"|"member_departure"):boolean;
  ```

- [ ] **Step 1: Write the failing capacity-policy test**

  Add tests proving NearFamily accepts exactly 5 members, 5 children, 2 voices, and 25,000,000,000 storage bytes; reports every exceeded dimension; rejects negative/non-integer usage; and permits only non-consuming remediation operations when restricted.

- [ ] **Step 2: Run the focused test and verify RED**

  Run: `tsx --test tests/nearfamily-capacity.test.mjs`
  Expected: FAIL because `lib/nearfamily-capacity.ts` does not exist.

- [ ] **Step 3: Implement the exact policy**

  Implement `decideHouseholdCapacity` by reading only `PLAN_CATALOG[planId].limits`, comparing the exact four dimensions, and returning a frozen result. Implement `capacityMutationAllowed` as `decision.state === "within_limit" || operation !== "consume"` with an exact operation allowlist and no default-allow branch.

- [ ] **Step 4: Run focused and foundation tests**

  Run: `tsx --test tests/nearfamily-capacity.test.mjs tests/platform-release.test.mjs tests/task2b-migration.test.mjs tests/task2c-migration.test.mjs`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add lib/nearyou-foundation.ts lib/nearfamily-capacity.ts tests/nearfamily-capacity.test.mjs
  git commit -m "feat: define NearFamily capacity policy"
  ```

### Task 2: Statement-time over-capacity authority and atomic enforcement

**Files:**
- Create: `drizzle/0023_nearfamily_capacity.sql`
- Modify: `drizzle/meta/_journal.json`
- Modify: `lib/schema.ts`
- Modify: `lib/d1-domain-registry.generated.ts`
- Modify: `drizzle/0018_cutover_inventory_fence.generated.sql`
- Test: `tests/nearfamily-capacity.test.mjs`
- Test: `tests/d1-domain-registry.test.mjs`

**Interfaces:**
- Consumes: current active/grace entitlement ordering and existing capacity triggers from migrations 0011/0012.
- Produces the authoritative view:
  ```sql
  household_capacity_projection(
    household_id, plan_id, members, children, voices, storage_bytes,
    member_limit, child_limit, voice_limit, storage_limit, state, exceeded_json
  )
  ```
  and a transaction-local recalculation trigger path for entitlement, membership, child, voice, and ready-media changes.

- [ ] **Step 1: Add a failing executable SQLite test**

  Extend `tests/nearfamily-capacity.test.mjs` to apply migrations through 0023 and prove:
  - a Family household at exact limits is `within_limit`;
  - a downgrade to Plus with five children becomes `restricted` without deleting children;
  - new child/member/voice/ready-media inserts fail while restricted;
  - deleting a child or media object remains possible;
  - returning within all limits changes state back to `within_limit`;
  - concurrent/stale version writes cannot clear restriction.

- [ ] **Step 2: Run the test and verify RED**

  Run: `tsx --test tests/nearfamily-capacity.test.mjs`
  Expected: FAIL because migration 0023 and schema state are absent.

- [ ] **Step 3: Implement migration and schema**

  Add exact JSON generated by SQL and BEFORE triggers so capacity-consuming operations require the statement-time projection to be within the current plan; do not block DELETE, consent revocation, export, billing, or member departure. Do not persist time-sensitive current authority in a mutable row.

- [ ] **Step 4: Regenerate the domain registry and fences**

  Run: `tsx scripts/generate-d1-domain-registry.ts`
  Expected: generated registry, maintenance fences, and exact table count update together.

- [ ] **Step 5: Run migration and registry suites**

  Run: `tsx --test tests/nearfamily-capacity.test.mjs tests/d1-domain-registry.test.mjs tests/task2b-migration.test.mjs tests/task2c-migration.test.mjs`
  Expected: PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add drizzle/0023_nearfamily_capacity.sql drizzle/meta/_journal.json lib/schema.ts lib/d1-domain-registry.generated.ts drizzle/0018_cutover_inventory_fence.generated.sql tests/nearfamily-capacity.test.mjs tests/d1-domain-registry.test.mjs
  git commit -m "feat: enforce NearFamily capacity state"
  ```

### Task 3: Dark NearFamily household summary

**Files:**
- Modify: `app/api/v1/family/route.ts`
- Create: `lib/nearfamily-service.ts`
- Test: `tests/nearfamily-capacity.test.mjs`
- Test: `tests/product-release-readiness.test.mjs`

**Interfaces:**
- Consumes: authenticated household context, PostgreSQL rollout authorization, D1 entitlement/capacity projection.
- Produces:
  ```ts
  export type NearFamilySummary={planId:"nearyou_family";capacity:{state:"within_limit"|"restricted";usage:HouseholdCapacityUsage;limits:HouseholdCapacityUsage;exceeded:string[]};features:{nearsleep:true;nearstoryParentControlled:true;childAccounts:false;childMicrophone:false;posthumousSynthesis:false}};
  export function createNearFamilySummaryService(db:NearFamilyDb):(householdId:string)=>Promise<NearFamilySummary>;
  ```

- [ ] **Step 1: Write failing service and route tests**

  Prove the service exact-shapes its result, rejects a non-Family effective entitlement, exposes no child login/billing/voice-clone capability, and returns restricted state without hiding remediation access. Prove the route returns 404 before authentication while `NEARFAMILY_ROUTE_ENABLED=false`.

- [ ] **Step 2: Run focused tests and verify RED**

  Run: `tsx --test tests/nearfamily-capacity.test.mjs tests/product-release-readiness.test.mjs`
  Expected: FAIL because `createNearFamilySummaryService` is absent.

- [ ] **Step 3: Implement the read service and route branch**

  Keep the literal-off guard as the first executable statement. In the unreachable enabled branch, require authenticated household context, exact PostgreSQL `nearfamily` authorization, effective Family entitlement, and current D1 capacity projection before returning `Cache-Control: no-store` JSON.

- [ ] **Step 4: Run route, product, and type gates**

  Run:
  ```bash
  tsx --test tests/nearfamily-capacity.test.mjs tests/product-release-readiness.test.mjs tests/api-v1-input.test.mjs
  tsc --noEmit --incremental false
  eslint app/api/v1/family/route.ts lib/nearfamily-service.ts lib/nearfamily-capacity.ts tests/nearfamily-capacity.test.mjs
  ```
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add app/api/v1/family/route.ts lib/nearfamily-service.ts tests/nearfamily-capacity.test.mjs tests/product-release-readiness.test.mjs
  git commit -m "feat: add dark NearFamily household summary"
  ```

### Task 4: Full NearFamily verification and review

**Files:**
- Modify: `docs/runbooks/production-release.md`
- Modify: `docs/plans/2026-08-11-nearyou-production-expansion.md`
- Test: all repository tests.

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: source-verification evidence and explicit remaining live gates.

- [ ] **Step 1: Document exact activation prerequisites**

  Add the required signed identity/member/entitlement/invite/privacy probes, iOS+Android readiness, downgrade remediation test, rollout evidence, and zero unresolved capacity conflicts. State that source completion does not enable NearFamily.

- [ ] **Step 2: Run fail-fast repository verification**

  Run:
  ```bash
  set -euo pipefail
  tsc --noEmit --incremental false
  WRANGLER_LOG_PATH=.wrangler/wrangler.log vinext build
  tsx --test tests/*.test.mjs
  eslint . --ignore-pattern dist --ignore-pattern .next
  tsx scripts/generate-d1-domain-registry.ts --check
  git diff --check
  ```
  Expected: all commands PASS.

- [ ] **Step 3: Independent adversarial review**

  Review exact-limit races, downgrade state, effective-entitlement ordering, raw D1 mutation resistance, route dark-first behavior, cross-household access, and remediation availability. Any blocker returns to the relevant TDD task.

- [ ] **Step 4: Commit reviewed documentation/fixes**

  ```bash
  git add docs/runbooks/production-release.md docs/plans/2026-08-11-nearyou-production-expansion.md
  git commit -m "docs: gate NearFamily production activation"
  ```

## Completion evidence

This plan is complete only when Tasks 1–4 are committed, all repository gates pass, independent review reports source-clear, `NEARFAMILY_ROUTE_ENABLED` is still literal false, Terraform service/scheduler readiness remains false, and no rollout state has changed.
