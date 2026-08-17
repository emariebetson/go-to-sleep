import assert from "node:assert/strict";
import test from "node:test";
import { AccountBootstrapError, accountBootstrapCauseClassName, runAccountBootstrap } from "../lib/account-bootstrap.ts";

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

test("bootstrap diagnostics use cause class names for non-Error failures", () => {
  assert.equal(accountBootstrapCauseClassName(new TypeError("database detail")), "TypeError");
  assert.equal(accountBootstrapCauseClassName("database detail"), "String");
});
