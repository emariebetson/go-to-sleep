import test from "node:test";
import assert from "node:assert/strict";
import { decideHouseholdCapacity, capacityMutationAllowed } from "../lib/nearfamily-capacity.ts";

const exactFamilyUsage = {
  members: 5,
  children: 5,
  voices: 2,
  storageBytes: 25_000_000_000,
};

test("NearFamily capacity accepts exact limits and reports every exceeded dimension", () => {
  assert.deepEqual(decideHouseholdCapacity("nearyou_family", exactFamilyUsage), {
    state: "within_limit",
    exceeded: [],
    limits: exactFamilyUsage,
  });
  assert.deepEqual(decideHouseholdCapacity("nearyou_family", {
    members: 6,
    children: 6,
    voices: 3,
    storageBytes: 25_000_000_001,
  }), {
    state: "restricted",
    exceeded: ["members", "children", "voices", "storageBytes"],
    limits: exactFamilyUsage,
  });
});

test("NearFamily capacity rejects unsafe usage values", () => {
  for (const usage of [
    { ...exactFamilyUsage, members: -1 },
    { ...exactFamilyUsage, children: 1.5 },
    { ...exactFamilyUsage, voices: Number.NaN },
    { ...exactFamilyUsage, storageBytes: Number.MAX_SAFE_INTEGER + 1 },
  ]) assert.throws(() => decideHouseholdCapacity("nearyou_family", usage), /capacity usage invalid/);
});

test("restricted households retain remediation operations but cannot consume more capacity", () => {
  const restricted = decideHouseholdCapacity("nearyou_plus", exactFamilyUsage);
  assert.equal(restricted.state, "restricted");
  assert.equal(capacityMutationAllowed(restricted, "consume"), false);
  for (const operation of ["delete", "export", "revoke", "billing", "member_departure"]) {
    assert.equal(capacityMutationAllowed(restricted, operation), true);
  }
  assert.throws(() => capacityMutationAllowed(restricted, "unknown"), /capacity operation invalid/);
});
