import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadPostgresMigrations } from "../scripts/migrate.ts";
import { REQUIRED_CATALOG_KINDS } from "../scripts/check-catalog-manifest.ts";
import { bootstrapMigrationFailureCode, controllerRegistrationFailureCode, createGcsImmutableCatalogSink, databaseConnectionFailureCode, fetchGoogleMetadataAccessToken, fetchPriorBaselineAttestation, finalMigrationFailureCode, liveCatalogPreparationFailureCode, parseLiveCatalogPreparationArgs, prepareLiveProductionCatalog } from "../scripts/prepare-live-production-catalog.ts";
import { registerRolloutController } from "../scripts/register-rollout-controller.ts";
import { promoteCatalogManifest } from "../scripts/promote-catalog-manifest.ts";
import { promoteLiveBaselineCatalog } from "../scripts/promote-live-baseline-catalog.ts";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const controllerUser = "nearyou-readiness-ctl@nearnight.iam";
const verifierUser = "nearyou-pt-baseline@nearnight.iam";
const controllerPrincipal = "service:nearyou-readiness-controller";
const verifierPrincipal = "service:nearyou-private-tester-baseline-verifier";
const catalogRows = REQUIRED_CATALOG_KINDS.map((kind, index) => ({ kind, identity: `nearyou.${kind}.${index}`, definition: kind==="policy"?"nearyou_policy_owner|SELECT|true|":`definition-${index}` }));
const catalogChecksum = sha256(JSON.stringify(catalogRows));
const baseline = { version: 1, schema: "nearyou", catalogChecksum, generatedFrom: "reviewed-live-production-postgresql-16", reviewRequired: false, requiredKinds: REQUIRED_CATALOG_KINDS, requireForcedRls: ["household_members", "tenant_records"], forbidPublicExecute: true, migrationHead: "0006_private_canary_observation" };
const retiredChecksums = [
  "ae9a5e8f26190063382d76eae25565a6a991523edf6ceefa1abd74b1fd88a194",
  "7ec295cb252f9d8cf54d951e899a59ddb834a1204de951a7d967eeeaf67c11f8",
  "ed449236853519c58fabbd13eca2587c515447bdff81b3a6153d9afe0436aede",
  "481c48d0b1ca224decdf5b049325ec44c048b7dcc90572c24a66dd2d1e5301c9",
];

async function fixture(overrides = {}) {
  const migrations = await loadPostgresMigrations();
  const ledger = (overrides.ledger ?? migrations.slice(0, 6).map(({ id, checksum }) => ({ id, checksum }))).map((row) => ({ ...row }));
  const events = [];let ledgerReads=0;
  const query = async (sql, args = []) => {
    if (overrides.queryFailure?.test(sql)) throw new Error(overrides.queryFailureMessage ?? "provider detail must not escape");
    if (sql.includes("current_database()")) return { rows: [overrides.target ?? { database_name: "nearyou", server_version: 160011, database_user: "nearyou_migration_admin", allowed: true, pristine: false, vector_available: true }] };
    if (sql.startsWith("SELECT id,checksum FROM nearyou.schema_migrations")){ledgerReads+=1;if(overrides.failFinalLedger&&ledgerReads>1)throw new Error("secret final ledger provider detail");return { rows: ledger };}
    if (sql.startsWith("SELECT kind::text,identity::text,definition::text")) return { rows: catalogRows };
    if (sql.includes("public_execute_count")) return { rows: [{ forced_rls: ["household_members", "tenant_records"], public_execute_count: "0" }] };
    if (sql.startsWith("SELECT checksum FROM nearyou.schema_migrations")) return { rows: ledger.find((row) => row.id === args[0]) ? [{ checksum: ledger.find((row) => row.id === args[0]).checksum }] : [] };
    if (sql.startsWith("INSERT INTO nearyou.schema_migrations")) { events.push(`insert:${args[0]}`); ledger.push({ id: args[0], checksum: args[1] }); return { rows: [] }; }
    if (sql.includes("r.rolname='nearyou_migration'")) return { rows: [{ admin_option:false,inherit_option:true,set_option: true }] };
    if (sql.includes("r.rolname='nearyou_rollout_controller'")||sql.includes("r.rolname='nearyou_private_tester_baseline_verifier'")) return { rows: [{ admin_option:false,inherit_option:true,set_option:true,sensitive_extra_count:"0" }] };
    if (sql.includes("register_rollout_controller_identity")) return { rows: [{ database_user: args[0], principal: args[1], effective: true }] };
    if (sql.includes("register_private_tester_baseline_verifier_identity")) return { rows: [{ database_user: args[0], principal: args[1], effective: true }] };
    if (sql.includes("pg_has_role")) return { rows: [{ ok: true }] };
    return { rows: [] };
  };
  const pg = { transaction: async (run) => run({ query }) };
  const writes = [], baselineWrites=[];
  const priorCore = { migrationHead: "0006_private_canary_observation", catalogChecksum, attestedAt: Date.parse("2026-08-17T18:00:00.000Z"), release: "rel_20260817_private_01", source: { commitSha: "a".repeat(40), imageDigest: `sha256:${"b".repeat(64)}` }, operationId:`op_${"d".repeat(64)}` };
  const priorAttestation=overrides.priorBaselineAttestation ?? { ...priorCore, uri:"gs://nearyou-private-evidence/catalog/baseline-0006.json",generation:"122",objectSha256:"e".repeat(64), digest: sha256(JSON.stringify(priorCore)) };
  const result = await prepareLiveProductionCatalog({
    databaseUrl: "postgres://migration-admin@production/nearyou",
    release: "rel_20260817_private_01",
    operationId: `op_${"d".repeat(64)}`,
    operationStartedAt: Date.parse("2026-08-17T18:00:00.000Z"),
    candidateKey: "catalog/rel_20260817_private_01/catalog-manifest.candidate.json",
    controllerDatabaseUser: controllerUser,
    controllerPrincipal,
    verifierDatabaseUser: verifierUser,
    verifierPrincipal,
  }, {
    connect: async () => ({ pg, query, close: async () => events.push("close") }),
    migrations,
    authoritativeMigrationDatabaseUser:"nearyou_migration_admin",
    authoritativeSource: { commitSha: "a".repeat(40), imageDigest: `sha256:${"b".repeat(64)}` },
    authoritativePredecessorSource: overrides.authoritativePredecessorSource ?? { commitSha: "a".repeat(40), imageDigest: `sha256:${"b".repeat(64)}` },
    expectedPredecessorAttestation:overrides.expectedPredecessorAttestation??{uri:priorAttestation.uri,generation:priorAttestation.generation,objectSha256:priorAttestation.objectSha256},
    reviewedBaseline: overrides.baseline ?? baseline,
    ...(overrides.omitPrior ? {} : { priorBaselineAttestation:priorAttestation }),
    now: () => Date.parse("2026-08-17T18:00:00.000Z"),
    immutableSink: overrides.immutableSink ?? { writeOnce: async (entry) => { writes.push(entry); return { uri: `gs://nearyou-evidence/${entry.key}`, generation: "1723917600000000", contentSha256: entry.contentSha256 }; } },
    immutableBaselineSink: { writeOnce: async (entry) => { events.push("baseline-attested");baselineWrites.push(entry); return { uri:`gs://nearyou-evidence/${entry.key}`,generation:"1723917500000000",contentSha256:entry.contentSha256 }; } },
  });
  return { result, writes, baselineWrites, events, migrations };
}

test("pristine production database applies only reviewed 0001-0006 and stops with immutable live baseline candidate", async () => {
  const migrations = await loadPostgresMigrations(), ledger = [], writes = [], events = [];
  const query = async (sql, args = []) => {
    if (sql.includes("current_database()")) return { rows: [{ database_name:"nearyou",server_version:160011,database_user:"nearyou_migration_admin",allowed:true,pristine:true,vector_available:true }] };
    if (sql.startsWith("SELECT id,checksum FROM nearyou.schema_migrations")) return { rows: ledger };
    if (sql.startsWith("SELECT checksum FROM nearyou.schema_migrations")) return { rows: [] };
    if (sql.startsWith("INSERT INTO nearyou.schema_migrations")) { ledger.push({id:args[0],checksum:args[1]}); events.push(`insert:${args[0]}`); return {rows:[]}; }
    if (sql.startsWith("SELECT kind::text,identity::text,definition::text")) return {rows:catalogRows};
    if (sql.includes("public_execute_count")) return {rows:[{forced_rls:["household_members","tenant_records"],public_execute_count:"0"}]};
    return {rows:[]};
  };
  await assert.rejects(() => prepareLiveProductionCatalog({databaseUrl:"postgres://admin/x",release:"rel_20260817_private_01",operationId:`op_${"d".repeat(64)}`,operationStartedAt:1,candidateKey:"catalog/x/catalog-manifest.candidate.json",controllerDatabaseUser:controllerUser,controllerPrincipal,verifierDatabaseUser:verifierUser,verifierPrincipal},{connect:async()=>({pg:{transaction:async run=>run({query})},query,close:async()=>{}}),migrations,authoritativeMigrationDatabaseUser:"nearyou_migration_admin",authoritativeSource:{commitSha:"a".repeat(40),imageDigest:`sha256:${"b".repeat(64)}`},reviewedBaseline:baseline,now:()=>1,immutableSink:{writeOnce:async entry=>{writes.push(entry);return{uri:`gs://bucket/${entry.key}`,generation:"1",contentSha256:entry.contentSha256}}}}), /baseline-review-required/);
  assert.deepEqual(events, migrations.slice(0,6).map(file=>`insert:${file.id}`));
  assert.equal(writes.length,1);
  const candidate=JSON.parse(writes[0].body);
  assert.equal(candidate.migrationHead,"0006_private_canary_observation");
  assert.equal(candidate.generatedFrom,"live-production-postgresql-16");
  assert.equal(candidate.reviewRequired,true);
  assert.equal(candidate.catalogChecksum,catalogChecksum);
  assert.equal(candidate.rows.length,catalogRows.length);
  assert.equal(candidate.provenance.operationStartedAt,1);
  assert.deepEqual(candidate.provenance.migrationLedger,migrations.slice(0,6).map(({id,checksum})=>({id,checksum})));
  const directory=await mkdtemp(join(tmpdir(),"prepared-baseline-"));try{const candidatePath=join(directory,"catalog-manifest.baseline.candidate.json"),receiptPath=join(directory,"catalog-manifest.baseline.receipt.json"),output=join(directory,"catalog-manifest.baseline.reviewed.json"),receipt={uri:"gs://bucket/catalog/x/catalog-manifest.baseline.candidate.json",generation:"1",contentSha256:writes[0].contentSha256};await writeFile(candidatePath,writes[0].body);await writeFile(receiptPath,JSON.stringify(receipt));const reviewed=await promoteLiveBaselineCatalog({candidate:candidatePath,receipt:receiptPath,output,expectedCommitSha:"a".repeat(40),expectedImageDigest:`sha256:${"b".repeat(64)}`,expectedRelease:"rel_20260817_private_01",expectedOperationId:`op_${"d".repeat(64)}`,expectedOperationStartedAt:1,expectedDatabaseName:"nearyou",expectedDatabaseUser:"nearyou_migration_admin",expectedReceiptUri:receipt.uri,expectedReceiptGeneration:receipt.generation,expectedReceiptContentSha256:receipt.contentSha256});assert.equal(reviewed.catalogChecksum,candidate.catalogChecksum)}finally{await rm(directory,{recursive:true,force:true})}
});

test("prepares a review-required catalog from exact live PostgreSQL 16 state and records immutable provenance", async () => {
  const { result, writes, events, migrations } = await fixture();
  assert.equal(result.candidate.generatedFrom, "live-production-postgresql-16");
  assert.equal(result.candidate.reviewRequired, true);
  assert.equal(result.candidate.migrationHead, "0009_cloud_sql_verifier_identity_limit");
  assert.deepEqual(result.candidate.provenance.migrationLedger, migrations.map(({ id, checksum }) => ({ id, checksum })));
  assert.deepEqual(result.candidate.provenance.source, { commitSha: "a".repeat(40), imageDigest: `sha256:${"b".repeat(64)}` });
  assert.equal(result.candidate.provenance.baseline.migrationHead,"0006_private_canary_observation");assert.equal(result.candidate.provenance.baseline.catalogChecksum,catalogChecksum);
  assert.deepEqual(result.candidate.provenance.identities, { controllerDatabaseUser: controllerUser, controllerPrincipal, verifierDatabaseUser: verifierUser, verifierPrincipal });
  assert.equal(Object.hasOwn(result.candidate, "ready"), false);
  assert.equal(Object.hasOwn(result.candidate, "gate"), false);
  assert.deepEqual(events.filter((event) => event.startsWith("insert:")), ["insert:0007_private_tester_deployment_manifest","insert:0008_cloud_sql_iam_database_usernames","insert:0009_cloud_sql_verifier_identity_limit"]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].contentSha256, sha256(writes[0].body));
  assert.equal(result.receipt.contentSha256, writes[0].contentSha256);
});

test("fails before mutation unless database, authority, historical ledger, and reviewed baseline are exact", async () => {
  for (const overrides of [
    { target: { database_name: "postgres", server_version: 160011, database_user: "nearyou_migration_admin", allowed: true } },
    { target: { database_name: "nearyou", server_version: 150015, database_user: "nearyou_migration_admin", allowed: true } },
    { target: { database_name: "nearyou", server_version: 160011, database_user: "app", allowed: true } },
    { target: { database_name: "nearyou", server_version: 160011, database_user: "nearyou_migration_admin", allowed: false } },
    { ledger: [] },
    { baseline: { ...baseline, migrationHead: "0007_private_tester_deployment_manifest" } },
    { baseline: { ...baseline, catalogChecksum: "f".repeat(64) } },
  ]) await assert.rejects(() => fixture(overrides), /live catalog preparation (?:target-authority-invalid|ledger-state-invalid|precondition|baseline-review-required)/);
});

test("maps provider failures to the exact non-sensitive preparation stage", async () => {
  const migrations = await loadPostgresMigrations();
  await assert.rejects(
    () => prepareLiveProductionCatalog({ databaseUrl: "postgres://admin/x", release: "rel_20260817_private_01", operationId:`op_${"d".repeat(64)}`, operationStartedAt:1, candidateKey:"catalog/x/catalog-manifest.candidate.json", controllerDatabaseUser:controllerUser, controllerPrincipal, verifierDatabaseUser:verifierUser, verifierPrincipal }, { migrations, authoritativeMigrationDatabaseUser:"nearyou_migration_admin",authoritativeSource:{commitSha:"a".repeat(40),imageDigest:`sha256:${"b".repeat(64)}`}, now:()=>1, connect:async()=>{throw new Error("opaque provider failure")}, immutableSink:{writeOnce:async()=>{throw new Error("unused")}} }),
    /live catalog preparation database-connect-failed/,
  );
  await assert.rejects(
    () => fixture({ queryFailure: /current_database\(\)/ }),
    /live catalog preparation target-authority-invalid/,
  );
  await assert.rejects(
    () => fixture({ queryFailure: /^SELECT id,checksum FROM nearyou\.schema_migrations/ }),
    /live catalog preparation ledger-state-invalid/,
  );
  await assert.rejects(
    () => fixture({ queryFailure: /^SELECT kind::text,identity::text,definition::text/ }),
    /live catalog preparation baseline-state-invalid/,
  );
});

test("classifies database connection failures without exposing provider messages", () => {
  assert.equal(databaseConnectionFailureCode(Object.assign(new Error("connect ETIMEDOUT 10.0.0.1"), { code: "ETIMEDOUT" })), "database-connect-network");
  assert.equal(databaseConnectionFailureCode(Object.assign(new Error("password authentication failed for user secret"), { code: "28P01" })), "database-connect-auth");
  assert.equal(databaseConnectionFailureCode(Object.assign(new Error("database secret does not exist"), { code: "3D000" })), "database-connect-database");
  assert.equal(databaseConnectionFailureCode(new Error("opaque provider failure")), "database-connect-unknown");
});

test("classifies bootstrap SQL failures without exposing provider messages", () => {
  assert.equal(bootstrapMigrationFailureCode(Object.assign(new Error("secret role detail"),{code:"42501"})),"bootstrap-migration-privilege");
  assert.equal(bootstrapMigrationFailureCode(Object.assign(new Error("secret extension detail"),{code:"0A000"})),"bootstrap-migration-feature");
  assert.equal(bootstrapMigrationFailureCode(Object.assign(new Error("secret definition detail"),{code:"42P17"})),"bootstrap-migration-definition");
  assert.equal(bootstrapMigrationFailureCode(Object.assign(new Error("secret collision detail"),{code:"42P07"})),"bootstrap-migration-collision");
  assert.equal(bootstrapMigrationFailureCode(new Error("secret unknown detail")),"bootstrap-migration-unknown");
  assert.equal(bootstrapMigrationFailureCode(new Error("migration execution failed:0001_nearyou_tenant_foundation",{cause:Object.assign(new Error("secret role detail"),{code:"42501"})})),"bootstrap-migration-privilege-0001");
  assert.equal(bootstrapMigrationFailureCode(new Error("migration execution failed:0001_nearyou_tenant_foundation:position-123:routine-have_createrole_privilege",{cause:Object.assign(new Error("secret role detail"),{code:"42501"})})),"bootstrap-migration-privilege-0001-p123-rhave_createrole_privilege");
  assert.equal(bootstrapMigrationFailureCode(new Error("migration execution failed:0001_nearyou_tenant_foundation:step-extension_vector",{cause:Object.assign(new Error("secret extension detail"),{code:"42501"})})),"bootstrap-migration-privilege-0001-sextension_vector");
});

test("classifies every post-baseline stage without provider detail",()=>{const sql=Object.assign(new Error("secret SQL and provider detail"),{code:"42501"}),migration=new Error("migration execution failed:0007_private_tester_deployment_manifest:position-42:routine-aclcheck_error",{cause:sql});assert.equal(finalMigrationFailureCode(migration),"final-migration-privilege-0007-p42-raclcheck_error");assert.equal(liveCatalogPreparationFailureCode(new Error("live catalog preparation controller-registration-failed",{cause:new Error("secret provider detail")})),"controller-registration-unknown");for(const code of ["verifier-registration-failed","final-ledger-invalid","final-catalog-invalid","candidate-write-failed"])assert.equal(liveCatalogPreparationFailureCode(new Error(`live catalog preparation ${code}`,{cause:new Error("secret provider detail")})),code);const staged=new Error("live catalog preparation final-migration-failed",{cause:migration});assert.equal(liveCatalogPreparationFailureCode(staged),"final-migration-privilege-0007-p42-raclcheck_error")});
test("classifies forward migration 0008 without provider detail",()=>{const cause=Object.assign(new Error("secret provider detail"),{code:"42501"}),migration=new Error("migration execution failed:0008_cloud_sql_iam_database_usernames:position-17:routine-aclcheck_error",{cause});assert.equal(finalMigrationFailureCode(migration),"final-migration-privilege-0008-p17-raclcheck_error")});
test("classifies forward migration 0009 without provider detail",()=>{const cause=Object.assign(new Error("secret provider detail"),{code:"42501"}),migration=new Error("migration execution failed:0009_cloud_sql_verifier_identity_limit:position-17:routine-aclcheck_error",{cause});assert.equal(finalMigrationFailureCode(migration),"final-migration-privilege-0009-p17-raclcheck_error")});

test("controller registration exposes only bounded transaction substages",()=>{for(const stage of ["verify-migration-membership","verify-controller-membership","set-migration-role","register-identity","reset-role","verify-membership"])assert.equal(controllerRegistrationFailureCode(new Error(`controller registration failed:${stage}`,{cause:new Error("secret SQL provider detail")})),`controller-registration-${stage}`);assert.equal(controllerRegistrationFailureCode(new Error("secret provider detail")),"controller-registration-unknown");const staged=new Error("live catalog preparation controller-registration-failed",{cause:new Error("controller registration failed:register-identity",{cause:new Error("secret")})});assert.equal(liveCatalogPreparationFailureCode(staged),"controller-registration-register-identity")});

test("controller registration bounds every query failure to its non-secret substage",async()=>{
  const expected=["verify-migration-membership","verify-controller-membership","set-migration-role","register-identity","reset-role","verify-membership"];
  for(let failAt=1;failAt<=expected.length;failAt++){
    let calls=0;
    const pg={transaction:run=>run({query:async sql=>{
      calls+=1;
      if(calls===failAt)throw new Error("secret SQL provider detail");
      if(sql.includes("r.rolname='nearyou_migration'"))return{rows:[{admin_option:false,inherit_option:true,set_option:true}]};
      if(sql.includes("r.rolname='nearyou_rollout_controller'"))return{rows:[{admin_option:false,inherit_option:true,set_option:true,sensitive_extra_count:"0"}]};
      if(sql.includes("register_rollout_controller_identity"))return{rows:[{database_user:"migration-admin",principal:"service:rollout-controller",effective:true}]};
      if(sql.includes("pg_has_role"))return{rows:[{ok:true}]};
      return{rows:[]};
    }})};
    await assert.rejects(()=>registerRolloutController(pg,"migration-admin","service:rollout-controller"),error=>error instanceof Error&&error.message===`controller registration failed:${expected[failAt-1]}`);
  }
});

test("executes every bounded post-baseline failure boundary",async()=>{const migrations=await loadPostgresMigrations(),finalLedger=migrations.map(({id,checksum})=>({id,checksum}));for(const [overrides,code] of [[{queryFailure:/consume_private_tester_deployment_manifest/},"final-migration-failed"],[{ledger:finalLedger,queryFailure:/register_rollout_controller_identity/},"controller-registration-failed"],[{ledger:finalLedger,queryFailure:/register_private_tester_baseline_verifier_identity/},"verifier-registration-failed"],[{failFinalLedger:true},"final-ledger-invalid"],[{ledger:finalLedger,queryFailure:/SELECT kind::text/},"final-catalog-invalid"]])await assert.rejects(()=>fixture(overrides),new RegExp(`live catalog preparation ${code}`))});

test("fails closed when the immutable sink does not attest the exact bytes", async () => {
  await assert.rejects(() => fixture({ immutableSink: { writeOnce: async (entry) => ({ uri: "gs://bucket/object", generation: "1", contentSha256: `0${entry.contentSha256.slice(1)}` }) } }), /live catalog preparation candidate-write-failed/);
});

test("resumes exact 0007 state without replaying migration and converges registrations", async () => {
  const migrations = await loadPostgresMigrations();
  const { events, result } = await fixture({ ledger: migrations.map(({ id, checksum }) => ({ id, checksum })) });
  assert.deepEqual(events.filter((event) => event.startsWith("insert:")), []);
  assert.equal(result.candidate.migrationHead, migrations.at(-1).id);
});

test("legacy 0001-0004 ledger is remediated through 0009 and preserved exactly in provenance", async () => {
  const migrations = await loadPostgresMigrations();
  const legacyLedger = migrations.slice(0, 6).map(({ id, checksum }, index) => ({ id, checksum: retiredChecksums[index] ?? checksum }));
  const { result, events } = await fixture({ ledger: legacyLedger });
  assert.deepEqual(events.filter((event) => event.startsWith("insert:")), ["insert:0007_private_tester_deployment_manifest","insert:0008_cloud_sql_iam_database_usernames","insert:0009_cloud_sql_verifier_identity_limit"]);
  assert.deepEqual(result.candidate.provenance.migrationLedger, [...legacyLedger, ...migrations.slice(6).map(({id,checksum})=>({id,checksum}))]);
  assert.equal(result.candidate.provenance.migrationLedgerChecksum, sha256(result.candidate.provenance.migrationLedger.map(({ id, checksum }) => `${id}:${checksum}`).join("\n")));
});

test("exact 0006 first run does not require a prior baseline attestation", async () => {
  const { events } = await fixture({ omitPrior: true });
  assert.ok(events.indexOf("baseline-attested") < events.indexOf("insert:0007_private_tester_deployment_manifest"));
});

test("first run baseline record supports byte-identical resume after a lost response", async () => {
  const first=await fixture({omitPrior:true}), record=JSON.parse(first.baselineWrites[0].body), prior={...record,uri:"gs://nearyou-evidence/catalog/rel_20260817_private_01/baseline-0006.json",generation:"1723917500000000",objectSha256:first.baselineWrites[0].contentSha256};
  const resumed=await fixture({ledger:first.migrations.map(({id,checksum})=>({id,checksum})),priorBaselineAttestation:prior});
  assert.equal(resumed.writes[0].body,first.writes[0].body);
  assert.equal(resumed.writes[0].contentSha256,first.writes[0].contentSha256);
});

test("cross-version resume binds exact predecessor attestation and distinct current source",async()=>{const migrations=await loadPostgresMigrations(),ledger=migrations.map(({id,checksum})=>({id,checksum})),predecessor={commitSha:"c".repeat(40),imageDigest:`sha256:${"d".repeat(64)}`},core={migrationHead:"0006_private_canary_observation",catalogChecksum,attestedAt:Date.parse("2026-08-17T18:00:00.000Z"),release:"rel_20260817_private_01",source:predecessor,operationId:`op_${"d".repeat(64)}`},prior={...core,uri:"gs://nearyou-private-evidence/catalog/predecessor-baseline-0006.json",generation:"77",objectSha256:"e".repeat(64),digest:sha256(JSON.stringify(core))},expectedPredecessorAttestation={uri:prior.uri,generation:prior.generation,objectSha256:prior.objectSha256},result=await fixture({ledger,authoritativePredecessorSource:predecessor,expectedPredecessorAttestation,priorBaselineAttestation:prior});assert.deepEqual(result.result.candidate.provenance.source,{commitSha:"a".repeat(40),imageDigest:`sha256:${"b".repeat(64)}`});assert.deepEqual(result.result.candidate.provenance.baseline.attestation,{uri:prior.uri,generation:prior.generation,objectSha256:prior.objectSha256,core,digest:prior.digest});for(const changed of [{...prior,source:{...predecessor,commitSha:"a".repeat(40)}},{...prior,release:"rel_wrong_12345678"},{...prior,operationId:`op_${"f".repeat(64)}`},{...prior,attestedAt:prior.attestedAt+1},{...prior,catalogChecksum:"f".repeat(64)},{...prior,generation:"78"}])await assert.rejects(()=>fixture({ledger,authoritativePredecessorSource:predecessor,expectedPredecessorAttestation,priorBaselineAttestation:{...changed,digest:prior.digest}}),/precondition/);await assert.rejects(()=>fixture({ledger,authoritativePredecessorSource:{commitSha:"a".repeat(40),imageDigest:predecessor.imageDigest},expectedPredecessorAttestation,priorBaselineAttestation:prior}),/precondition/)});

test("rejects non-production, swapped, or equal identity tuples before mutation", async () => {
  const migrations = await loadPostgresMigrations(), base = { databaseUrl: "postgres://admin/x", release: "rel_20260817_private_01", operationId:`op_${"d".repeat(64)}`, operationStartedAt:1, candidateKey: "catalog/x/catalog-manifest.candidate.json", controllerDatabaseUser: controllerUser, controllerPrincipal, verifierDatabaseUser: verifierUser, verifierPrincipal };
  const dependencies = { migrations, authoritativeMigrationDatabaseUser:"nearyou_migration_admin",authoritativeSource: { commitSha: "a".repeat(40), imageDigest: `sha256:${"b".repeat(64)}` }, reviewedBaseline: baseline, now: () => 1, connect: async () => { throw new Error("must not connect"); }, immutableSink: { writeOnce: async () => { throw new Error("must not write"); } } };
  for (const input of [{ ...base, controllerDatabaseUser: verifierUser }, { ...base, verifierPrincipal: controllerPrincipal }, { ...base, verifierDatabaseUser: controllerUser }]) await assert.rejects(() => prepareLiveProductionCatalog(input, dependencies), /identity-invalid/);
});

test("promotion accepts exact live-production provenance and rejects tampering", async () => {
  const directory = await mkdtemp(join(tmpdir(), "live-catalog-promotion-"));
  try {
    const { result } = await fixture();
    const candidate = join(directory, "catalog-manifest.candidate.json"), receipt = join(directory, "catalog-manifest.receipt.json"), reviewed = join(directory, "catalog-manifest.reviewed.json"), candidateBody = `${JSON.stringify(result.candidate, null, 2)}\n`;
    await writeFile(candidate, candidateBody);
    await writeFile(receipt, `${JSON.stringify(result.receipt)}\n`);
    const baselineAttestation=result.candidate.provenance.baseline.attestation,authority = { expectedCommitSha: "a".repeat(40), expectedImageDigest: `sha256:${"b".repeat(64)}`, expectedBaselineChecksum: catalogChecksum, expectedMigrationLedgerChecksum: result.candidate.provenance.migrationLedgerChecksum,expectedReceiptUri:result.receipt.uri,expectedReceiptGeneration:result.receipt.generation,expectedReceiptContentSha256:result.receipt.contentSha256,expectedRelease:"rel_20260817_private_01",expectedOperationId:`op_${"d".repeat(64)}`,expectedOperationStartedAt:Date.parse("2026-08-17T18:00:00.000Z"),expectedPredecessorCommitSha:"a".repeat(40),expectedPredecessorImageDigest:`sha256:${"b".repeat(64)}`,expectedPredecessorAttestationUri:baselineAttestation.uri,expectedPredecessorAttestationGeneration:baselineAttestation.generation,expectedPredecessorAttestationObjectSha256:baselineAttestation.objectSha256,expectedPredecessorAttestationDigest:baselineAttestation.digest };
    const promoted = await promoteCatalogManifest({ candidate, receipt, output: reviewed, ...authority });
    assert.equal(promoted.generatedFrom, "reviewed-live-production-postgresql-16");
    const tampered = join(directory, "tampered-catalog-manifest.candidate.json");
    await writeFile(tampered, `${JSON.stringify({ ...result.candidate, provenance: { ...result.candidate.provenance, source: { ...result.candidate.provenance.source, commitSha: "c".repeat(40) } } })}\n`);
    await assert.rejects(() => promoteCatalogManifest({ candidate: tampered, receipt, output: join(directory, "tampered-catalog-manifest.reviewed.json"), ...authority }), /catalog promotion invalid/);
    const wrongReceipt = join(directory, "wrong-catalog-manifest.receipt.json");
    await writeFile(wrongReceipt, `${JSON.stringify({ ...result.receipt, contentSha256: "0".repeat(64) })}\n`);
    await assert.rejects(() => promoteCatalogManifest({ candidate, receipt: wrongReceipt, output: join(directory, "wrong-catalog-manifest.reviewed.json"), ...authority }), /catalog promotion invalid/);
    await assert.rejects(() => promoteCatalogManifest({ candidate, receipt, output: join(directory, "wrong-authority.reviewed.json"), ...authority, expectedCommitSha: "c".repeat(40) }), /catalog promotion invalid/);
    for(const [name,override] of [["swapped-predecessor",{expectedPredecessorCommitSha:"c".repeat(40)}],["unrelated-attestation",{expectedPredecessorAttestationUri:"gs://other/baseline.json"}],["changed-release",{expectedRelease:"rel_changed_12345678"}],["changed-operation",{expectedOperationId:`op_${"f".repeat(64)}`}],["changed-time",{expectedOperationStartedAt:authority.expectedOperationStartedAt+1}],["receipt-substitution",{expectedReceiptGeneration:"999"}]])await assert.rejects(()=>promoteCatalogManifest({candidate,receipt,output:join(directory,`${name}-catalog-manifest.reviewed.json`),...authority,...override}),/catalog promotion invalid/);
    for(const [name,changeCore] of [["extra-baseline",false],["wrong-core-head",true]]){const original=result.candidate.provenance,originalAttestation=original.baseline.attestation,core=changeCore?{...originalAttestation.core,migrationHead:"0005_operational_evidence"}:originalAttestation.core,attestation={...originalAttestation,core,digest:sha256(JSON.stringify(core))},baseline=changeCore?{...original.baseline,attestation}:{...original.baseline,attestation,extra:true},provenance={...original,baseline},value={...result.candidate,provenance,provenanceChecksum:sha256(JSON.stringify(provenance))},path=join(directory,`${name}-catalog-manifest.candidate.json`),receiptPath=join(directory,`${name}-catalog-manifest.receipt.json`),body=`${JSON.stringify(value,null,2)}\n`,newReceipt={uri:`gs://nearyou-evidence/catalog/${name}-catalog-manifest.candidate.json`,generation:"777",contentSha256:sha256(body)};await writeFile(path,body);await writeFile(receiptPath,JSON.stringify(newReceipt));await assert.rejects(()=>promoteCatalogManifest({candidate:path,receipt:receiptPath,output:join(directory,`${name}-catalog-manifest.reviewed.json`),...authority,expectedReceiptUri:newReceipt.uri,expectedReceiptGeneration:newReceipt.generation,expectedReceiptContentSha256:newReceipt.contentSha256,expectedPredecessorAttestationDigest:attestation.digest}),/catalog promotion invalid/)}
    assert.equal(JSON.parse(await readFile(reviewed, "utf8")).catalogChecksum, result.candidate.catalogChecksum);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("GCS sink creates one generation-zero object and verifies provider metadata", async () => {
  const contentSha256 = sha256("candidate\n");
  let request;
  const sink = createGcsImmutableCatalogSink({ bucket: "nearyou-private-evidence", accessToken: "token_abcdefghijklmnopqrstuvwxyz", fetch: async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify({ bucket: "nearyou-private-evidence", name: "catalog/release/catalog-manifest.candidate.json", generation: "123", metadata: { contentSha256 } }), { status: 200, headers: { "content-type": "application/json" } });
  } });
  const receipt = await sink.writeOnce({ key: "catalog/release/catalog-manifest.candidate.json", body: "candidate\n", contentSha256 });
  assert.match(request.url, /ifGenerationMatch=0/);
  assert.equal(request.init.method, "POST");
  assert.match(request.init.headers.authorization, /^Bearer /);
  assert.match(request.init.body, /candidate/);
  assert.deepEqual(receipt, { uri: "gs://nearyou-private-evidence/catalog/release/catalog-manifest.candidate.json", generation: "123", contentSha256 });
});

test("GCS sink converges after an upload response is lost", async () => {
  const contentSha256 = sha256("candidate\n"), calls = [];
  const sink = createGcsImmutableCatalogSink({ bucket: "nearyou-private-evidence", accessToken: "token_abcdefghijklmnopqrstuvwxyz", fetch: async (url, init) => {
    calls.push({ url, method: init?.method ?? "GET" });
    if (init?.method === "POST") return new Response("conflict", { status: 412 });
    if (url.includes("alt=media")) return new Response("candidate\n", { status: 200 });
    return new Response(JSON.stringify({ bucket: "nearyou-private-evidence", name: "catalog/release/catalog-manifest.candidate.json", generation: "123", metadata: { contentSha256 } }), { status: 200, headers: { "content-type": "application/json" } });
  } });
  const receipt = await sink.writeOnce({ key: "catalog/release/catalog-manifest.candidate.json", body: "candidate\n", contentSha256 });
  assert.equal(receipt.generation, "123");
  assert.deepEqual(calls.map((call) => call.method), ["POST", "GET", "GET"]);
  assert.match(calls[2].url, /[?&]generation=123(?:&|$)/);
});

test("CLI parser rejects ambiguous secrets and requires exact provenance", () => {
  const args = ["--prepare-live-production-catalog", "--release", "rel_20260817_private_01", "--operation-id", `op_${"d".repeat(64)}`, "--operation-started-at", "1786993200000", "--candidate-key", "catalog/release/catalog-manifest.candidate.json", "--database-url-file", "/secret/database-url"];
  assert.deepEqual(parseLiveCatalogPreparationArgs(args).release, "rel_20260817_private_01");
  assert.throws(() => parseLiveCatalogPreparationArgs([...args, "--source-commit", "c".repeat(40)]), /arguments invalid/);
});

test("prior baseline core is downloaded from its exact immutable generation and bound to trusted coordinates", async () => {
  const core = { migrationHead:"0006_private_canary_observation", catalogChecksum, attestedAt:1, release:"rel_20260817_private_01", source:{commitSha:"a".repeat(40),imageDigest:`sha256:${"b".repeat(64)}`},operationId:`op_${"d".repeat(64)}` }, value = { ...core, digest:sha256(JSON.stringify(core)) }, body = `${JSON.stringify(value)}\n`, expectedObjectSha256 = sha256(body), uri="gs://nearyou-private-evidence/catalog/baseline-0006.json", generation="122";
  let url;
  const loaded = await fetchPriorBaselineAttestation({ uri, generation, expectedObjectSha256, accessToken:"token_abcdefghijklmnopqrstuvwxyz", fetch:async (input)=>{url=input;return new Response(body,{status:200})} });
  assert.match(url, /generation=122/);
  assert.deepEqual(loaded, { ...value, uri, generation,objectSha256:expectedObjectSha256 });
});

test("production storage access uses a bounded workload metadata token", async () => {
  let request;
  const token = await fetchGoogleMetadataAccessToken({ fetch: async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify({ access_token: `ya29.${"a".repeat(80)}`, expires_in: 900, token_type: "Bearer" }), { status: 200, headers: { "content-type": "application/json" } });
  } });
  assert.match(request.url, /metadata\.google\.internal/);
  assert.equal(request.init.headers["Metadata-Flavor"], "Google");
  assert.match(token, /^ya29\./);
  await assert.rejects(() => fetchGoogleMetadataAccessToken({ fetch: async () => new Response(JSON.stringify({ access_token: "short", expires_in: 60, token_type: "Bearer" }), { status: 200 }) }), /metadata token invalid/);
});

test("production failures expose only bounded non-secret classes", () => {
  assert.equal(liveCatalogPreparationFailureCode(new Error("live catalog preparation target-authority-invalid")), "target-authority-invalid");
  assert.equal(liveCatalogPreparationFailureCode(new Error("password authentication failed for user secret-value")), "database-connect-failed");
  assert.equal(liveCatalogPreparationFailureCode(new Error("arbitrary provider detail")), "preparation-failed");
});

test("CLI setup failures expose only bounded non-secret stages",()=>{
  for(const stage of ["cli-config-invalid","cli-metadata-token-failed","cli-predecessor-fetch-failed","cli-predecessor-source-invalid","cli-sink-setup-failed","cli-core-prepare-failed"]){
    const error=new Error(`live catalog preparation ${stage}`,{cause:new Error("secret token gs://private/object?generation=123 provider detail")});
    assert.equal(liveCatalogPreparationFailureCode(error),stage);
    assert.doesNotMatch(liveCatalogPreparationFailureCode(error),/secret|provider|gs:\/\//);
  }
  assert.equal(liveCatalogPreparationFailureCode(new Error("live catalog preparation target-authority-invalid")),"target-authority-invalid");
});
