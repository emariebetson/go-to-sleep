import {
  createSyntheticPrivateTesterAuthorizationSession,
  createSyntheticPrivateTesterFixture,
  type SyntheticPrivateTesterFixture,
  type SyntheticPrivateTesterInput,
} from "./private-canary-smoke";

type SyntheticDarkGates = { nearstory: false; nearfamily: false; scheduler: false };

export type SyntheticPrivateTesterRollbackDependencies = {
  darkGates(): Promise<SyntheticDarkGates>;
  queue: {
    enqueueBeforeKill(fixture: SyntheticPrivateTesterFixture): Promise<{ queueId: string; householdHash: string }>;
    kill(fixture: SyntheticPrivateTesterFixture): Promise<{ killed: boolean }>;
    enqueueAfterKill(fixture: SyntheticPrivateTesterFixture): Promise<boolean>;
    processQueued(queue: { queueId: string; householdHash: string }, fixture: SyntheticPrivateTesterFixture): Promise<"fenced" | "processed">;
  };
  recovery: {
    delete(fixture: SyntheticPrivateTesterFixture): Promise<boolean>;
    remediateCapacity(fixture: SyntheticPrivateTesterFixture): Promise<boolean>;
  };
  sites: { redeployPriorVersion(version: string, fixture: SyntheticPrivateTesterFixture): Promise<boolean> };
  integrity(fixture: SyntheticPrivateTesterFixture): Promise<{ d1AuditTriggers: number; deadLetters: number; r2ScopePrefix: string; noCrossHouseholdReads: boolean }>;
};

const encoder = new TextEncoder();

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, stable(entry)]));
}

async function immutableHash(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(stable(value))));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function runSyntheticPrivateTesterRollbackDrill(input: SyntheticPrivateTesterInput, deps: SyntheticPrivateTesterRollbackDependencies) {
  const fixture = await createSyntheticPrivateTesterFixture(input);
  const authorization = await createSyntheticPrivateTesterAuthorizationSession(fixture);
  const failures: string[] = [];
  const observed: Record<string, unknown> = {};
  try {
    const [nearStoryBeforeKill, nearFamilyBeforeRevoke, gates, queued] = await Promise.all([authorization.productAccess("nearstory", fixture.invitedHouseholdId), authorization.productAccess("nearfamily", fixture.invitedHouseholdId), deps.darkGates(), deps.queue.enqueueBeforeKill(fixture)]);
    observed.before = { nearStoryBeforeKill, nearFamilyBeforeRevoke, gates, queued };
    if (!nearStoryBeforeKill || !nearFamilyBeforeRevoke) failures.push("initial_authorization");
    if (gates.nearstory !== false || gates.nearfamily !== false || gates.scheduler !== false) failures.push("dark_gates");
    if (queued.queueId !== fixture.jobId || queued.householdHash !== fixture.invitedHouseholdHash) failures.push("queue");
    const [controllerKill, queueKill, nearFamilyRevocation] = await Promise.all([authorization.killNearStory(), deps.queue.kill(fixture), authorization.revokeNearFamily()]);
    observed.transitions = { controllerKill, queueKill, nearFamilyRevocation };
    if (controllerKill.status !== "killed" || !queueKill.killed) failures.push("kill");
    if (nearFamilyRevocation.status !== "revoked") failures.push("family_revoke");
    const [nearStoryAuthorizedAfterKill, nearFamilyAuthorizedAfterRevoke, newWorkAllowed, queuedDisposition, deleted, remediated, redeployed, integrity] = await Promise.all([
      authorization.productAccess("nearstory", fixture.invitedHouseholdId),
      authorization.productAccess("nearfamily", fixture.invitedHouseholdId),
      deps.queue.enqueueAfterKill(fixture),
      deps.queue.processQueued(queued, fixture),
      deps.recovery.delete(fixture),
      deps.recovery.remediateCapacity(fixture),
      deps.sites.redeployPriorVersion(fixture.priorSitesVersion, fixture),
      deps.integrity(fixture),
    ]);
    observed.after = { nearStoryAuthorizedAfterKill, nearFamilyAuthorizedAfterRevoke, newWorkAllowed, queuedDisposition, deleted, remediated, redeployed, integrity };
    if (nearStoryAuthorizedAfterKill || nearFamilyAuthorizedAfterRevoke || newWorkAllowed) failures.push("new_work");
    if (queuedDisposition !== "fenced") failures.push("queued_work");
    if (!deleted || !remediated) failures.push("recovery");
    if (!redeployed) failures.push("prior_sites_version");
    if (integrity.d1AuditTriggers !== 2 || integrity.deadLetters !== 0 || integrity.r2ScopePrefix !== fixture.r2ScopePrefix || !integrity.noCrossHouseholdReads) failures.push("integrity");
  } catch {
    failures.push("execution");
  }
  if (failures.length) throw new Error(`synthetic private tester rollback failed: ${Array.from(new Set(failures)).join(",")}`);
  const observations = Object.freeze({ ...observed });
  return Object.freeze({ version: 1, passed: true as const, releaseId: fixture.releaseId, gatesRemainOff: true as const, fixture, observations, resultHash: await immutableHash({ fixture, observations }) });
}
