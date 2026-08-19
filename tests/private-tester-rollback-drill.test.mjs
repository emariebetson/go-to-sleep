import assert from "node:assert/strict";
import test from "node:test";
import { runSyntheticPrivateTesterSmoke } from "../scripts/private-canary-smoke.ts";
import { runSyntheticPrivateTesterRollbackDrill } from "../scripts/private-tester-rollback-drill.ts";

const releaseId = "rel_20260819_smoke_01";
const invitedHouseholdHash = "a".repeat(64);
const deniedHouseholdHash = "b".repeat(64);
const priorSitesVersion = "sites_20260818_01";

function smokeInput(overrides = {}) {
  return { releaseId, invitedHouseholdHash, deniedHouseholdHash, priorSitesVersion, ...overrides };
}

function smokeDeps(overrides = {}) {
  const calls = [];
  const controller = { authorize: async ({ householdHash }) => householdHash === invitedHouseholdHash };
  const story = {
    create: async (fixture) => { calls.push("create"); return { jobId: fixture.jobId, householdHash: fixture.invitedHouseholdHash, releaseId: fixture.releaseId, requestHash: fixture.requestHash }; },
    process: async (job) => { calls.push("process"); return { processed: true, jobId: job.jobId }; },
    persist: async (job, fixture) => { calls.push("persist"); return { persisted: true, jobId: job.jobId, objectKey: `${fixture.r2ScopePrefix}audio.mp3`, digest: "c".repeat(64) }; },
    play: async (record) => { calls.push("play"); return { played: true, objectKey: record.objectKey }; },
    deliverOutcome: async (job) => { calls.push("outcome"); return { delivered: true, jobId: job.jobId, digest: "d".repeat(64) }; },
    delete: async (record) => { calls.push("delete"); return { deleted: true, objectKey: record.objectKey }; },
  };
  return {
    calls,
    controller,
    darkGates: async () => ({ nearstory: false, nearfamily: false, scheduler: false }),
    story,
    family: {
      identity: async (fixture) => ({ synthetic: true, householdHash: fixture.invitedHouseholdHash }),
      memberAccess: async () => true,
      invitedEntitlement: async () => true,
      crossHouseholdRead: async () => false,
      capacityRemediation: async () => true,
    },
    integrity: async (fixture) => ({ d1AuditTriggers: 2, deadLetters: 0, r2ScopePrefix: fixture.r2ScopePrefix, noCrossHouseholdReads: true }),
    ...overrides,
  };
}

test("synthetic private tester smoke creates, processes, persists, plays, delivers, and cleans up a non-personal fixture", async () => {
  const deps = smokeDeps();
  const authorizationCalls = [];
  deps.controller = { authorize: async (input) => { authorizationCalls.push(input); return input.householdHash === invitedHouseholdHash; } };
  const first = await runSyntheticPrivateTesterSmoke(smokeInput(), deps);
  const second = await runSyntheticPrivateTesterSmoke(smokeInput(), smokeDeps());

  assert.equal(first.passed, true);
  assert.match(first.resultHash, /^[a-f0-9]{64}$/);
  assert.equal(first.resultHash, second.resultHash);
  assert.deepEqual(deps.calls, ["create", "process", "persist", "play", "outcome", "delete"]);
  assert.deepEqual(authorizationCalls, [
    { product: "nearstory", householdHash: invitedHouseholdHash },
    { product: "nearstory", householdHash: deniedHouseholdHash },
    { product: "nearfamily", householdHash: invitedHouseholdHash },
    { product: "nearfamily", householdHash: deniedHouseholdHash },
  ]);
  assert.equal(first.gatesRemainOff, true);
});

test("synthetic smoke fails closed for authorization, dark-gate, privacy, dead-letter, and R2-scope leaks", async () => {
  for (const override of [
    { controller: { authorize: async () => false } },
    { darkGates: async () => ({ nearstory: true, nearfamily: false, scheduler: false }) },
    { family: { ...smokeDeps().family, crossHouseholdRead: async () => true } },
    { integrity: async (fixture) => ({ d1AuditTriggers: 2, deadLetters: 1, r2ScopePrefix: fixture.r2ScopePrefix, noCrossHouseholdReads: true }) },
    { story: { ...smokeDeps().story, persist: async (job) => ({ persisted: true, jobId: job.jobId, objectKey: "other-scope/audio.mp3", digest: "c".repeat(64) }) } },
  ]) {
    await assert.rejects(() => runSyntheticPrivateTesterSmoke(smokeInput(), smokeDeps(override)), /synthetic private tester smoke failed/);
  }
});

test("synthetic smoke deterministically deletes a persisted object when a later outcome check fails", async () => {
  const deps = smokeDeps();
  deps.story = { ...deps.story, deliverOutcome: async () => ({ delivered: false, jobId: "synthetic-job", digest: "d".repeat(64) }) };
  await assert.rejects(() => runSyntheticPrivateTesterSmoke(smokeInput(), deps), /synthetic private tester smoke failed/);
  assert.ok(deps.calls.includes("delete"));
});

function rollbackDeps(overrides = {}) {
  const calls = [];
  let killed = false;
  return {
    calls,
    controller: { authorize: async ({ householdHash }) => !killed && householdHash === invitedHouseholdHash },
    darkGates: async () => ({ nearstory: false, nearfamily: false, scheduler: false }),
    queue: {
      enqueueBeforeKill: async (fixture) => ({ queueId: fixture.jobId, householdHash: fixture.invitedHouseholdHash }),
      kill: async () => { killed = true; calls.push("kill"); return { killed: true }; },
      enqueueAfterKill: async () => false,
      processQueued: async () => "fenced",
    },
    recovery: {
      delete: async () => { calls.push("delete"); return true; },
      remediateCapacity: async () => { calls.push("remediate"); return true; },
    },
    sites: { redeployPriorVersion: async (version) => { calls.push(`redeploy:${version}`); return true; } },
    integrity: async (fixture) => ({ d1AuditTriggers: 2, deadLetters: 0, r2ScopePrefix: fixture.r2ScopePrefix, noCrossHouseholdReads: true }),
    ...overrides,
  };
}

test("rollback drill kills new work, fences queued work, retains recovery, and permits the pinned prior Sites version", async () => {
  const deps = rollbackDeps();
  const result = await runSyntheticPrivateTesterRollbackDrill(smokeInput(), deps);
  const replay = await runSyntheticPrivateTesterRollbackDrill(smokeInput(), rollbackDeps());

  assert.equal(result.passed, true);
  assert.match(result.resultHash, /^[a-f0-9]{64}$/);
  assert.equal(result.resultHash, replay.resultHash);
  assert.deepEqual(deps.calls, ["kill", "delete", "remediate", `redeploy:${priorSitesVersion}`]);
});

test("rollback drill rejects a queue leak, incomplete recovery, integrity drift, or a failed prior-version redeploy", async () => {
  for (const override of [
    { queue: { ...rollbackDeps().queue, enqueueAfterKill: async () => true } },
    { recovery: { delete: async () => false, remediateCapacity: async () => true } },
    { integrity: async (fixture) => ({ d1AuditTriggers: 1, deadLetters: 0, r2ScopePrefix: fixture.r2ScopePrefix, noCrossHouseholdReads: true }) },
    { sites: { redeployPriorVersion: async () => false } },
  ]) {
    await assert.rejects(() => runSyntheticPrivateTesterRollbackDrill(smokeInput(), rollbackDeps(override)), /synthetic private tester rollback failed/);
  }
});
