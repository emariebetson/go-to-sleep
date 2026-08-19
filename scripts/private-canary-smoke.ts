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
};

export type SyntheticPrivateTesterFixture = Readonly<{
  version: 1;
  releaseId: string;
  invitedHouseholdHash: string;
  deniedHouseholdHash: string;
  priorSitesVersion: string;
  jobId: string;
  requestHash: string;
  r2ScopePrefix: string;
}>;

type SyntheticController = {
  authorize(input: { product: "nearstory" | "nearfamily"; householdHash: string }): Promise<boolean>;
};

type SyntheticDarkGates = { nearstory: false; nearfamily: false; scheduler: false };
type SyntheticStoryRecord = { persisted: boolean; jobId: string; objectKey: string; digest: string };

export type SyntheticPrivateTesterSmokeDependencies = {
  controller: SyntheticController;
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
  return RELEASE.test(input.releaseId) && HASH.test(input.invitedHouseholdHash) && HASH.test(input.deniedHouseholdHash) && input.invitedHouseholdHash !== input.deniedHouseholdHash && SITES_VERSION.test(input.priorSitesVersion);
}

export async function createSyntheticPrivateTesterFixture(input: SyntheticPrivateTesterInput): Promise<SyntheticPrivateTesterFixture> {
  if (!validSyntheticInput(input)) throw new Error("synthetic private tester fixture invalid");
  const jobId = `synthetic-${input.releaseId}-${input.invitedHouseholdHash.slice(0, 12)}`;
  const requestHash = await syntheticHash({ version: 1, releaseId: input.releaseId, householdHash: input.invitedHouseholdHash, jobId });
  return Object.freeze({ version: 1, ...input, jobId, requestHash, r2ScopePrefix: `private-tester/${input.releaseId}/${input.invitedHouseholdHash}/` });
}

function collectSyntheticFailure(failures: string[], condition: boolean, name: string): void {
  if (!condition) failures.push(name);
}

export async function runSyntheticPrivateTesterSmoke(input: SyntheticPrivateTesterInput, deps: SyntheticPrivateTesterSmokeDependencies) {
  const fixture = await createSyntheticPrivateTesterFixture(input);
  const failures: string[] = [];
  let record: SyntheticStoryRecord | undefined;
  try {
    const [gates, nearStoryInvited, nearStoryDenied, nearFamilyInvited, nearFamilyDenied] = await Promise.all([
      deps.darkGates(),
      deps.controller.authorize({ product: "nearstory", householdHash: fixture.invitedHouseholdHash }),
      deps.controller.authorize({ product: "nearstory", householdHash: fixture.deniedHouseholdHash }),
      deps.controller.authorize({ product: "nearfamily", householdHash: fixture.invitedHouseholdHash }),
      deps.controller.authorize({ product: "nearfamily", householdHash: fixture.deniedHouseholdHash }),
    ]);
    collectSyntheticFailure(failures, gates.nearstory === false && gates.nearfamily === false && gates.scheduler === false, "dark_gates");
    collectSyntheticFailure(failures, nearStoryInvited && !nearStoryDenied && nearFamilyInvited && !nearFamilyDenied, "controller");
    const job = await deps.story.create(fixture);
    collectSyntheticFailure(failures, job.jobId === fixture.jobId && job.householdHash === fixture.invitedHouseholdHash && job.releaseId === fixture.releaseId && job.requestHash === fixture.requestHash, "create");
    const processed = await deps.story.process({ jobId: job.jobId });
    collectSyntheticFailure(failures, processed.processed && processed.jobId === fixture.jobId, "process");
    record = await deps.story.persist({ jobId: job.jobId }, fixture);
    collectSyntheticFailure(failures, record.persisted && record.jobId === fixture.jobId && record.objectKey.startsWith(fixture.r2ScopePrefix) && HASH.test(record.digest), "persist");
    const played = await deps.story.play(record);
    collectSyntheticFailure(failures, played.played && played.objectKey === record.objectKey, "play");
    const outcome = await deps.story.deliverOutcome({ jobId: job.jobId });
    collectSyntheticFailure(failures, outcome.delivered && outcome.jobId === fixture.jobId && HASH.test(outcome.digest), "outcome");
    const [identity, memberAccess, entitlement, crossHouseholdRead, remediation, integrity] = await Promise.all([
      deps.family.identity(fixture),
      deps.family.memberAccess(fixture),
      deps.family.invitedEntitlement(fixture),
      deps.family.crossHouseholdRead(fixture),
      deps.family.capacityRemediation(fixture),
      deps.integrity(fixture),
    ]);
    collectSyntheticFailure(failures, identity.synthetic && identity.householdHash === fixture.invitedHouseholdHash && memberAccess && entitlement, "family_access");
    collectSyntheticFailure(failures, !crossHouseholdRead && integrity.noCrossHouseholdReads, "privacy");
    collectSyntheticFailure(failures, remediation, "capacity_remediation");
    collectSyntheticFailure(failures, integrity.d1AuditTriggers === 2 && integrity.deadLetters === 0 && integrity.r2ScopePrefix === fixture.r2ScopePrefix, "integrity");
  } catch {
    failures.push("execution");
  } finally {
    if (record) {
      try {
        const deleted = await deps.story.delete(record);
        collectSyntheticFailure(failures, deleted.deleted && deleted.objectKey === record.objectKey, "delete");
      } catch {
        failures.push("delete");
      }
    }
  }
  if (failures.length) throw new Error(`synthetic private tester smoke failed: ${Array.from(new Set(failures)).join(",")}`);
  const result = Object.freeze({ version: 1, passed: true as const, releaseId: fixture.releaseId, gatesRemainOff: true as const, fixture, resultHash: await syntheticHash({ fixture, proof: "create-process-persist-play-outcome-delete-family" }) });
  return result;
}
