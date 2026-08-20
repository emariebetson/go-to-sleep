import { createPrivateTesterActivationTestController, createPrivateTesterActivationTestStore, type PrivateTesterActivationResult } from "../lib/private-tester-activation";
import { createPostgresHouseholdProductAccess } from "../lib/product-release-readiness-service";
import { createHash } from "node:crypto";

type Input={mode?:"preflight"|"post-issue";releaseId:string;invitedHouseholdHash:string;deniedHouseholdHash:string;maxHeartbeatAgeMs:number};
type BoundInput=Readonly<Input>;
type Deps={now():Promise<number>;sourceGates(input:BoundInput):Promise<{family:boolean;canaryRoute:boolean;story:boolean}>;d1(input:BoundInput):Promise<{migration:string;migrationCount:number;immutableTriggers:number;preOperationRows:number;activeCanaryRows?:number;releaseIssueRows?:number;releaseRevokeRows?:number;outboxPending:number;outboxDeadLetters:number}>;pg(input:BoundInput):Promise<{releaseId:string;mode:string;killSwitch:boolean;invitedAllowed:boolean;deniedAllowed:boolean;inviteExpiresAt:number}>;story(input:BoundInput):Promise<{activationStatus:string;migrationVersion:string;heartbeatAt:number;providerPrerequisites:boolean}>;rollback(input:BoundInput):Promise<{killSwitchDenied:boolean;newStoryPaused:boolean;deletionAvailable:boolean;remediationAvailable:boolean;priorVersionRetained:boolean;artifact:string}>};
const HASH=/^[a-f0-9]{64}$/,RELEASE=/^rel_[A-Za-z0-9_-]{8,96}$/;
/** Pure observation-schema assessment. This is not authenticated release evidence. */
export async function assessPrivateCanaryObservations(input:Input,provided:Partial<Deps>){if(!RELEASE.test(input.releaseId)||!HASH.test(input.invitedHouseholdHash)||!HASH.test(input.deniedHouseholdHash)||input.invitedHouseholdHash===input.deniedHouseholdHash||!Number.isSafeInteger(input.maxHeartbeatAgeMs)||input.maxHeartbeatAgeMs<60_000||input.maxHeartbeatAgeMs>900_000)throw new Error("private canary smoke input invalid");for(const name of ["now","sourceGates","d1","pg","story","rollback"]as const)if(typeof provided[name]!=="function")throw new Error("live private canary observations unavailable");const deps=provided as Deps,bound=Object.freeze({...input}),[now,gates,d1,pg,story,rollback]=await Promise.all([deps.now(),deps.sourceGates(bound),deps.d1(bound),deps.pg(bound),deps.story(bound),deps.rollback(bound)]);const failures:string[]=[];if(!Number.isSafeInteger(now))failures.push("clock");if(gates.family||gates.canaryRoute||gates.story)failures.push("source_gates");if(d1.migration!=="0026_canary_entitlements"||d1.migrationCount!==1||d1.immutableTriggers!==2||d1.outboxPending!==0||(input.mode==="preflight"&&(d1.activeCanaryRows!==0||d1.releaseIssueRows!==0||d1.releaseRevokeRows!==0))||(input.mode==="post-issue"&&(d1.activeCanaryRows!==0||d1.releaseIssueRows!==1||d1.releaseRevokeRows!==1))||d1.outboxDeadLetters!==0)failures.push("d1");if(pg.releaseId!==input.releaseId||pg.mode!=="canary"||pg.killSwitch||!pg.invitedAllowed||pg.deniedAllowed||!Number.isSafeInteger(pg.inviteExpiresAt)||pg.inviteExpiresAt<=now)failures.push("rollout");if(story.activationStatus!=="ready"||story.migrationVersion!=="0013"||!story.providerPrerequisites||!Number.isSafeInteger(story.heartbeatAt)||story.heartbeatAt>now||now-story.heartbeatAt>input.maxHeartbeatAgeMs)failures.push("story");if(!rollback.killSwitchDenied||!rollback.newStoryPaused||!rollback.deletionAvailable||!rollback.remediationAvailable||!rollback.priorVersionRetained||!HASH.test(rollback.artifact))failures.push("rollback");if(failures.length)throw new Error(`private canary smoke failed: ${failures.join(",")}`);return Object.freeze({version:1,passed:true,releaseId:input.releaseId,observedAt:now,gatesRemainOff:true,d1,rollout:pg,story,rollback})}

export type SyntheticPrivateTesterInput = {
  releaseId: string;
  invitedHouseholdHash: string;
  deniedHouseholdHash: string;
  priorSitesVersion: string;
  fixtureNamespace: "task6-private-tester";
  fixtureMarker: string;
};

export type SyntheticPrivateTesterFixture = Readonly<{
  version: 1;
  releaseId: string;
  invitedHouseholdHash: string;
  deniedHouseholdHash: string;
  priorSitesVersion: string;
  fixtureNamespace: "task6-private-tester";
  fixtureMarker: string;
  invitedHouseholdId: string;
  deniedHouseholdId: string;
  jobId: string;
  requestHash: string;
  r2ScopePrefix: string;
}>;

type SyntheticDarkGates = { nearstory: false; nearfamily: false; scheduler: false };
type SyntheticStoryRecord = { persisted: boolean; jobId: string; objectKey: string; digest: string };

export type SyntheticPrivateTesterSmokeDependencies = {
  darkGates(): Promise<SyntheticDarkGates>;
  story: {
    create(fixture: SyntheticPrivateTesterFixture): Promise<{ jobId: string; householdHash: string; releaseId: string; requestHash: string }>;
    process(job: { jobId: string }): Promise<{ processed: boolean; jobId: string }>;
    persist(job: { jobId: string }, fixture: SyntheticPrivateTesterFixture): Promise<SyntheticStoryRecord>;
    play(record: SyntheticStoryRecord): Promise<{ played: boolean; objectKey: string }>;
    deliverOutcome(job: { jobId: string }): Promise<{ delivered: boolean; jobId: string; digest: string }>;
    delete(record: SyntheticStoryRecord): Promise<{ deleted: boolean; objectKey: string }>;
  };
  family: {
    identity(fixture: SyntheticPrivateTesterFixture): Promise<{ synthetic: boolean; householdHash: string }>;
    memberAccess(fixture: SyntheticPrivateTesterFixture): Promise<boolean>;
    invitedEntitlement(fixture: SyntheticPrivateTesterFixture): Promise<boolean>;
    crossHouseholdRead(fixture: SyntheticPrivateTesterFixture): Promise<boolean>;
    capacityRemediation(fixture: SyntheticPrivateTesterFixture): Promise<boolean>;
  };
  integrity(fixture: SyntheticPrivateTesterFixture): Promise<{ d1AuditTriggers: number; deadLetters: number; r2ScopePrefix: string; noCrossHouseholdReads: boolean }>;
};

const SITES_VERSION = /^sites_[A-Za-z0-9_-]{8,100}$/;
const encoder = new TextEncoder();

export function syntheticPrivateTesterHouseholdHash(releaseId: string, subject: "invited" | "denied"): string {
  return createHash("sha256").update(`task6-private-tester/synthetic:${releaseId}/${subject}`).digest("hex");
}

function stableSyntheticValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableSyntheticValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, stableSyntheticValue(entry)]));
}

async function syntheticHash(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(stableSyntheticValue(value))));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validSyntheticInput(input: SyntheticPrivateTesterInput): boolean {
  return RELEASE.test(input.releaseId) && HASH.test(input.invitedHouseholdHash) && HASH.test(input.deniedHouseholdHash) && input.invitedHouseholdHash === syntheticPrivateTesterHouseholdHash(input.releaseId, "invited") && input.deniedHouseholdHash === syntheticPrivateTesterHouseholdHash(input.releaseId, "denied") && SITES_VERSION.test(input.priorSitesVersion) && input.fixtureNamespace === "task6-private-tester" && input.fixtureMarker === `synthetic:${input.releaseId}`;
}

export async function createSyntheticPrivateTesterFixture(input: SyntheticPrivateTesterInput): Promise<SyntheticPrivateTesterFixture> {
  if (!validSyntheticInput(input)) throw new Error("synthetic private tester fixture invalid");
  const jobId = `synthetic-${input.releaseId}-${input.invitedHouseholdHash.slice(0, 12)}`;
  const requestHash = await syntheticHash({ version: 1, releaseId: input.releaseId, householdHash: input.invitedHouseholdHash, jobId });
  return Object.freeze({ version: 1, ...input, invitedHouseholdId: `${input.fixtureNamespace}/${input.fixtureMarker}/invited`, deniedHouseholdId: `${input.fixtureNamespace}/${input.fixtureMarker}/denied`, jobId, requestHash, r2ScopePrefix: `private-tester/${input.releaseId}/${input.invitedHouseholdHash}/` });
}

export async function createSyntheticPrivateTesterAuthorizationSession(fixture: SyntheticPrivateTesterFixture) {
  const now = 1_800_000_000_000;
  const baselineHash = await syntheticHash({ fixture, kind: "promoted-baseline" });
  const evidenceDigest = await syntheticHash({ fixture, kind: "release-evidence" });
  const mappingArtifact = await syntheticHash({ fixture, kind: "controller-mapping" });
  const store = createPrivateTesterActivationTestStore({ promotedBaselines: [{ sha256: baselineHash, releaseId: fixture.releaseId, darkGates: { nearfamily: false, nearstory: false, scheduler: false } }], products: ["nearstory", "nearfamily"] });
  const controller = createPrivateTesterActivationTestController({ store, now: () => now, verifyReleaseEvidence: async (evidence) => evidence.digest === evidenceDigest });
  const request = (product: "nearstory" | "nearfamily", action: "activate" | "revoke" | "kill", invites: { householdHash: string; expiresAt: number }[]) => ({
    action,
    operationId: `synthetic-${action}-${product}-0001`,
    principal: "service:readiness",
    product,
    expectedVersion: store.state(product).version,
    promotedBaselineSha256: baselineHash,
    releaseEvidence: { digest: evidenceDigest, releaseId: fixture.releaseId, product, expiresAt: now + 60_000, controllerMapping: { verified: true as const, principal: "service:readiness", artifact: mappingArtifact } },
    invites,
  });
  const invited = { householdHash: fixture.invitedHouseholdHash, expiresAt: now + 30_000 };
  await controller(request("nearstory", "activate", [invited]));
  await controller(request("nearfamily", "activate", [invited]));
  const productAccess = createPostgresHouseholdProductAccess({ query: async () => { throw new Error("synthetic authorization must not query rollout infrastructure"); } }, controller);
  return Object.freeze({
    productAccess,
    revokeNearFamily: async (): Promise<PrivateTesterActivationResult> => controller(request("nearfamily", "revoke", [invited])),
    killNearStory: async (): Promise<PrivateTesterActivationResult> => controller(request("nearstory", "kill", [])),
  });
}

function collectSyntheticFailure(failures: string[], condition: boolean, name: string): void {
  if (!condition) failures.push(name);
}

export async function runSyntheticPrivateTesterSmoke(input: SyntheticPrivateTesterInput, deps: SyntheticPrivateTesterSmokeDependencies) {
  const fixture = await createSyntheticPrivateTesterFixture(input);
  const authorization = await createSyntheticPrivateTesterAuthorizationSession(fixture);
  const failures: string[] = [];
  let record: SyntheticStoryRecord | undefined;
  let cleanup: { deleted: boolean; objectKey: string } | undefined;
  const observed: Record<string, unknown> = {};
  try {
    const [gates, nearStoryInvited, nearStoryDenied, nearFamilyInvited, nearFamilyDenied] = await Promise.all([
      deps.darkGates(),
      authorization.productAccess("nearstory", fixture.invitedHouseholdId),
      authorization.productAccess("nearstory", fixture.deniedHouseholdId),
      authorization.productAccess("nearfamily", fixture.invitedHouseholdId),
      authorization.productAccess("nearfamily", fixture.deniedHouseholdId),
    ]);
    observed.authorization = { gates, nearStoryInvited, nearStoryDenied, nearFamilyInvited, nearFamilyDenied };
    collectSyntheticFailure(failures, gates.nearstory === false && gates.nearfamily === false && gates.scheduler === false, "dark_gates");
    collectSyntheticFailure(failures, nearStoryInvited && !nearStoryDenied && nearFamilyInvited && !nearFamilyDenied, "controller");
    const job = await deps.story.create(fixture);
    observed.create = job;
    collectSyntheticFailure(failures, job.jobId === fixture.jobId && job.householdHash === fixture.invitedHouseholdHash && job.releaseId === fixture.releaseId && job.requestHash === fixture.requestHash, "create");
    const processed = await deps.story.process({ jobId: job.jobId });
    observed.process = processed;
    collectSyntheticFailure(failures, processed.processed && processed.jobId === fixture.jobId, "process");
    record = await deps.story.persist({ jobId: job.jobId }, fixture);
    observed.persist = record;
    collectSyntheticFailure(failures, record.persisted && record.jobId === fixture.jobId && record.objectKey.startsWith(fixture.r2ScopePrefix) && HASH.test(record.digest), "persist");
    const played = await deps.story.play(record);
    observed.play = played;
    collectSyntheticFailure(failures, played.played && played.objectKey === record.objectKey, "play");
    const outcome = await deps.story.deliverOutcome({ jobId: job.jobId });
    observed.outcome = outcome;
    collectSyntheticFailure(failures, outcome.delivered && outcome.jobId === fixture.jobId && HASH.test(outcome.digest), "outcome");
    const [identity, memberAccess, entitlement, crossHouseholdRead, remediation, integrity] = await Promise.all([
      deps.family.identity(fixture),
      deps.family.memberAccess(fixture),
      deps.family.invitedEntitlement(fixture),
      deps.family.crossHouseholdRead(fixture),
      deps.family.capacityRemediation(fixture),
      deps.integrity(fixture),
    ]);
    observed.family = { identity, memberAccess, entitlement, crossHouseholdRead, remediation };
    observed.integrity = integrity;
    collectSyntheticFailure(failures, identity.synthetic && identity.householdHash === fixture.invitedHouseholdHash && memberAccess && entitlement, "family_access");
    collectSyntheticFailure(failures, !crossHouseholdRead && integrity.noCrossHouseholdReads, "privacy");
    collectSyntheticFailure(failures, remediation, "capacity_remediation");
    collectSyntheticFailure(failures, integrity.d1AuditTriggers === 2 && integrity.deadLetters === 0 && integrity.r2ScopePrefix === fixture.r2ScopePrefix, "integrity");
  } catch {
    failures.push("execution");
  } finally {
    if (record) {
      try {
        cleanup = await deps.story.delete(record);
        observed.cleanup = cleanup;
        collectSyntheticFailure(failures, cleanup.deleted && cleanup.objectKey === record.objectKey, "delete");
      } catch {
        failures.push("delete");
      }
    }
  }
  if (failures.length) throw new Error(`synthetic private tester smoke failed: ${Array.from(new Set(failures)).join(",")}`);
  const observations = Object.freeze({ ...observed });
  const result = Object.freeze({ version: 1, passed: true as const, releaseId: fixture.releaseId, gatesRemainOff: true as const, fixture, observations, resultHash: await syntheticHash({ fixture, observations }) });
  return result;
}
