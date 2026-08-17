# NearSleep Legacy Schema Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore new-account legacy voice setup on the deployed pre-0011 D1 schema and remove production-only Studio probes while production gates are off.

**Architecture:** A dedicated prepared-statement helper owns the migration-0006-compatible Free entitlement insert. Server-rendered Studio mode selects a small client bootstrap loader that fetches only the endpoints valid for that mode.

**Tech Stack:** TypeScript, Vinext/React, Cloudflare D1, Drizzle ORM, Node test runner, `node:sqlite`, Sites.

## Global Constraints

- Do not add, apply, or package any D1 migration.
- Do not change Sites environment values or NearSleep feature flags.
- Do not call OpenAI or ElevenLabs in tests.
- Preserve deterministic account IDs and the existing Free entitlement values.
- Use bound prepared statements; never interpolate account data into SQL text.
- Existing-schema release archives must contain zero migration files.

---

### Task 1: Legacy entitlement compatibility and mode-aware Studio bootstrap

**Files:**
- Create: `lib/legacy-entitlement-bootstrap.ts`
- Create: `lib/studio-bootstrap.ts`
- Modify: `lib/data.ts`
- Modify: `app/studio/page.tsx`
- Modify: `app/studio/SleepStudio.tsx`
- Create: `tests/legacy-schema-compatibility.test.mjs`

**Interfaces:**
- Produces: `createLegacyFreeEntitlement(db, input): Promise<void>` where `input` carries `id`, `householdId`, and `now`.
- Produces: `loadStudioBootstrap(productionMode, fetcher?)` returning nullable onboarding/children responses plus the required voices response.
- Consumes: the server-evaluated `nearSleepProductionEnabled(featureFlagsFromEnv(process.env))` boolean.

- [ ] **Step 1: Write the failing entitlement regression**

Create an in-memory SQLite fixture by applying migrations `0000` through `0006`, then insert a user and household after migration backfill. Wrap the database with the minimal D1 `prepare().bind().run()` surface, call `createLegacyFreeEntitlement`, and assert this literal row:

```js
{
  id: "entitlement:legacy:new-user",
  household_id: "household:new-user",
  plan_id: "nearsleep_free",
  source: "legacy",
  status: "active",
  allowance_milliunits: 1000,
  remaining_milliunits: 1000,
  legacy_credits_remaining: 1,
}
```

Also assert that the fixture has no `billing_period_start` column and that a second call does not create a duplicate.

- [ ] **Step 2: Write the failing Studio endpoint-selection regression**

Use a recording fetcher that returns successful `Response` objects. Assert that legacy mode requests exactly `['/api/voices']` and production mode requests exactly `['/api/onboarding', '/api/v1/children', '/api/voices']`.

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
tsx --test tests/legacy-schema-compatibility.test.mjs
```

Expected: FAIL because the two production helpers do not exist.

- [ ] **Step 4: Implement the minimal legacy entitlement writer**

Use one bound statement with this fixed column list:

```sql
INSERT INTO entitlements
  (id, household_id, plan_id, source, status, allowance_milliunits,
   remaining_milliunits, legacy_credits_remaining, external_ref,
   valid_from, valid_until, created_at, updated_at)
VALUES (?, ?, 'nearsleep_free', 'legacy', 'active', 1000,
        1000, 1, NULL, ?, NULL, ?, ?)
ON CONFLICT DO NOTHING
```

Call it from `ensureUser.createEntitlement` with the deterministic ID and timestamp already computed there.

- [ ] **Step 5: Implement mode-aware Studio loading**

Compute the production boolean in `app/studio/page.tsx` and pass it as `initialProductionMode`. In `loadStudioBootstrap`, fetch only voices for `false`; fetch onboarding, children, and voices in parallel for `true`. Replace the unconditional `Promise.all` in `SleepStudio` with this helper while preserving current response parsing and validation.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
tsx --test tests/legacy-schema-compatibility.test.mjs tests/account-bootstrap.test.mjs tests/task2b-live-integration.test.mjs
```

Expected: all tests pass with no provider calls.

- [ ] **Step 7: Mutation-check the regression**

Temporarily replace the compatibility insert with the broad Drizzle entitlement insert and confirm the pre-0011 regression fails on `billing_period_start`; restore the compatibility writer and confirm GREEN again.

- [ ] **Step 8: Run the full release suite**

Run `npm test` and require typecheck, production build, and every test to pass.

- [ ] **Step 9: Commit**

```bash
git add lib/legacy-entitlement-bootstrap.ts lib/studio-bootstrap.ts lib/data.ts app/studio/page.tsx app/studio/SleepStudio.tsx tests/legacy-schema-compatibility.test.mjs docs/superpowers/specs/2026-08-17-nearsleep-legacy-schema-compatibility-design.md docs/superpowers/plans/2026-08-17-nearsleep-legacy-schema-compatibility.md
git commit -m "fix: support legacy NearSleep entitlement schema"
```

After independent task and branch reviews, merge to `main`, push the exact verified source, build an existing-schema archive containing zero migrations, deploy it, and verify fresh authenticated Studio requests in production logs.
