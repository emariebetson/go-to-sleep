# NearSleep Free Recording Bootstrap Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an already-provisioned NearSleep account load and submit its first recording without re-running failing account-scaffold inserts, while emitting a privacy-safe stage identifier if account bootstrap still fails.

**Architecture:** Extract the sequencing of legacy account bootstrap into a small adapter-driven function. It updates the user, checks whether the deterministic household, membership, and entitlement already exist, returns immediately for a complete scaffold, and creates only missing records in dependency order. `ensureUser` remains the public entry point and supplies Drizzle-backed operations.

**Tech Stack:** TypeScript, Drizzle ORM/D1, Node test runner through `tsx`, vinext/Sites.

## Global Constraints

- Keep all five NearSleep production gates dark; do not enable the production-upgrade flow or apply schema migrations in this fix.
- Preserve the legacy `/api/voices` request and response contract and the visible consent flow.
- Never log user IDs, email addresses, recording metadata, provider keys, provider response bodies, or audio.
- Keep concurrent first-request provisioning safe with conflict-tolerant inserts.
- Follow strict TDD: observe the focused regression test fail before changing production code.
- Use Node 24 from `/Users/elizabethbetson/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin` when running npm scripts on this machine.

---

### Task 1: Make legacy account bootstrap read-before-create and stage-diagnostic

**Files:**
- Create: `lib/account-bootstrap.ts`
- Modify: `lib/data.ts`
- Test: `tests/account-bootstrap.test.mjs`

**Interfaces:**
- Produces: `AccountBootstrapOperations`, with `upsertUser`, `hasHousehold`, `hasMembership`, `hasEntitlement`, `createHousehold`, `createMembership`, and `createEntitlement`, each returning a promise.
- Produces: `AccountBootstrapStage`, a literal union naming each operation above.
- Produces: `AccountBootstrapError`, carrying a public `stage: AccountBootstrapStage` and the original error as `cause`.
- Produces: `runAccountBootstrap(operations: AccountBootstrapOperations): Promise<void>`.
- Preserves: `ensureUser(user: AppUser): Promise<{ householdId: string }>`.

- [ ] **Step 1: Write the failing orchestration tests**

Create `tests/account-bootstrap.test.mjs` with three behavioral tests:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { AccountBootstrapError, runAccountBootstrap } from "../lib/account-bootstrap.ts";

function scaffold(initial = {}) {
  const state = {
    user: false,
    household: false,
    membership: false,
    entitlement: false,
    ...initial,
  };
  const creates = [];
  return {
    state,
    creates,
    operations: {
      async upsertUser() { state.user = true; },
      async hasHousehold() { return state.household; },
      async hasMembership() { return state.membership; },
      async hasEntitlement() { return state.entitlement; },
      async createHousehold() { creates.push("household"); state.household = true; },
      async createMembership() {
        assert.equal(state.household, true);
        creates.push("membership");
        state.membership = true;
      },
      async createEntitlement() {
        assert.equal(state.household, true);
        creates.push("entitlement");
        state.entitlement = true;
      },
    },
  };
}

test("a complete account scaffold performs no redundant create operations", async () => {
  const fixture = scaffold({ household: true, membership: true, entitlement: true });
  await runAccountBootstrap(fixture.operations);
  assert.equal(fixture.state.user, true);
  assert.deepEqual(fixture.creates, []);
});

test("a partial account scaffold creates only missing records in dependency order", async () => {
  const fixture = scaffold({ membership: false, entitlement: false });
  await runAccountBootstrap(fixture.operations);
  assert.deepEqual(fixture.creates, ["household", "membership", "entitlement"]);
  assert.deepEqual(fixture.state, { user: true, household: true, membership: true, entitlement: true });
});

test("a bootstrap failure reports the failing stage without account data", async () => {
  const fixture = scaffold({ household: true, membership: true, entitlement: true });
  fixture.operations.hasEntitlement = async () => { throw new TypeError("database detail"); };
  await assert.rejects(
    () => runAccountBootstrap(fixture.operations),
    (error) => error instanceof AccountBootstrapError
      && error.stage === "hasEntitlement"
      && error.cause instanceof TypeError
      && !error.message.includes("database detail"),
  );
});
```

The production change that should make the first test fail is restoring unconditional scaffold inserts for an already-complete account. The second catches missing dependency ordering. The third catches a return to opaque bootstrap failures.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
env PATH=/Users/elizabethbetson/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Applications/ChatGPT.app/Contents/Resources/cua_node/bin:/usr/bin:/bin npx tsx --test tests/account-bootstrap.test.mjs
```

Expected: FAIL because `lib/account-bootstrap.ts` does not exist.

- [ ] **Step 3: Implement the minimal bootstrap orchestrator**

Create `lib/account-bootstrap.ts` so `runAccountBootstrap`:

1. Executes `upsertUser` through a stage wrapper.
2. Executes the three `has*` checks through the same wrapper.
3. Returns without calling any `create*` operation when all three checks are true.
4. Creates a missing household first, then a missing membership, then a missing entitlement.
5. Wraps any thrown non-`AccountBootstrapError` in `AccountBootstrapError` with a generic message such as `Account bootstrap failed during hasEntitlement.`; do not append the cause message.

- [ ] **Step 4: Wire `ensureUser` to the orchestrator**

In `lib/data.ts`:

1. Keep the deterministic `householdIdForUser` ID and current user upsert semantics.
2. Add Drizzle-backed `has*` operations selecting only `id` from `households`, `householdMembers`, and `entitlements` using their deterministic IDs.
3. Reuse the existing conflict-tolerant insert values for the three `create*` operations.
4. Catch `AccountBootstrapError`, log exactly one structured event containing only `stage` and the cause's class name, and rethrow it. Do not log identifiers or raw error messages.
5. Return `{ householdId }` after `runAccountBootstrap` resolves.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run the command from Step 2.

Expected: 3 tests pass, 0 fail.

- [ ] **Step 6: Run mutation checks and the affected route tests**

Temporarily change the complete-scaffold branch to call one `create*` operation and confirm the first test fails; restore the implementation and confirm it passes again. Then run:

```bash
env PATH=/Users/elizabethbetson/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Applications/ChatGPT.app/Contents/Resources/cua_node/bin:/usr/bin:/bin npx tsx --test tests/account-bootstrap.test.mjs tests/elevenlabs-errors.test.mjs tests/pronunciation-guess.test.mjs
```

Expected: all focused tests pass.

- [ ] **Step 7: Run full verification**

Run:

```bash
env PATH=/Users/elizabethbetson/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Applications/ChatGPT.app/Contents/Resources/cua_node/bin:/usr/bin:/bin npm test
```

Expected: type-check, build, and all repository tests pass.

- [ ] **Step 8: Commit**

```bash
git add lib/account-bootstrap.ts lib/data.ts tests/account-bootstrap.test.mjs
git commit -m "fix: avoid redundant account bootstrap writes"
```
