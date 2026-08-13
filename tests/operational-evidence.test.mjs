import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildOperationalEvidence, validateCanaryWindow } from "../scripts/operational-evidence.ts";
import { collectHttpLoad, collectRestore, collectCanary, collectAccessibility, collectMedia, collectSecurity, CanarySampleStore } from "../scripts/collect-operational-gate.ts";
import { createPostgresCanarySampleStore } from "../lib/postgres-canary-evidence.ts";
import { reportProductOutcome } from "../lib/product-outcome-telemetry.ts";
import { catalogCandidateFailureCode, generateCatalogCandidate } from "../scripts/catalog-candidate.ts";
import { REQUIRED_CATALOG_KINDS } from "../scripts/check-catalog-manifest.ts";
import { promoteCatalogManifest } from "../scripts/promote-catalog-manifest.ts";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeReleaseClaims } from "../scripts/compose-release-claims.ts";
import { operationalArtifact } from "../scripts/evidence-artifact.ts";
import { canonicalEvidence } from "../lib/asymmetric-release-evidence.ts";
import { buildRlsEvidence } from "../scripts/rls-evidence.ts";
import { LIVE_CATALOG_QUERY } from "../scripts/postgres-catalog.ts";

const hash = (c) => c.repeat(64);
const base = { releaseId: "rel_12345678", artifact: hash("a"), schemaChecksum: hash("b"), startedAt: 1_700_000_000_000, endedAt: 1_700_086_400_000 };

test("canonical Story job IDs cross telemetry, HTTP, and PostgreSQL authority boundaries", async () => {
  const jobId=`job:${"a".repeat(64)}`,requests=[];
  assert.equal(await reportProductOutcome({endpoint:"https://evidence.example.test/outcomes",token:async()=>"signed-token",fetch:async(_url,init)=>{requests.push(JSON.parse(init.body));return new Response(null,{status:200})},releaseId:"rel_12345678",releaseVersion:1,product:"nearstory",jobId,householdId:"household_123",attemptToken:"attempt_123",inputChecksum:hash("b"),evidenceChecksum:hash("c"),operation:"attempt_started"}),true);
  assert.equal(requests[0].jobId,jobId);
  for(const malformed of ["job:abc","x:aaaaaaaa","job:"+"A".repeat(64),"job:"+"a".repeat(65)])assert.equal(await reportProductOutcome({endpoint:"https://evidence.example.test/outcomes",token:async()=>"signed-token",fetch:async()=>new Response(null,{status:200}),releaseId:"rel_12345678",releaseVersion:1,product:"nearstory",jobId:malformed,householdId:"household_123",attemptToken:"attempt_123",inputChecksum:hash("b"),evidenceChecksum:hash("c"),operation:"attempt_started"}),false);
  const route=readFileSync(new URL("../app/api/internal/product-outcomes/route.ts",import.meta.url),"utf8"),sql=readFileSync(new URL("../postgres/migrations/0005_operational_evidence.sql",import.meta.url),"utf8");
  assert.match(route,/job:\[a-f0-9\]\{64\}/);assert.equal((sql.match(/job:\[a-f0-9\]\{64\}/g)??[]).length,3);
});

test("catalog candidate and promotion bind complete live security to the current migration head",async()=>{const directory=await mkdtemp(join(tmpdir(),"nearyou-catalog-")),output=join(directory,"catalog-manifest.candidate.json"),reviewedOutput=join(directory,"catalog-manifest.reviewed.json"),rows=REQUIRED_CATALOG_KINDS.map((kind,index)=>({kind,identity:`nearyou.${kind}.${index}`,definition:`definition-${index}`})),connect=async()=>({query:async(sql)=>({rows:sql.includes("public_execute_count")?[{forced_rls:["household_members","tenant_records"],public_execute_count:"0"}]:rows}),close:async()=>{}}),candidate=await generateCatalogCandidate({databaseUrl:"postgres://fixture",output,connect});try{assert.equal(candidate.migrationHead,"0005_operational_evidence");assert.deepEqual(candidate.requiredKinds,REQUIRED_CATALOG_KINDS);assert.deepEqual(candidate.security,{forcedRls:["household_members","tenant_records"],publicExecuteCount:0});assert.match(candidate.catalogChecksum,/^[a-f0-9]{64}$/);assert.notEqual(candidate.catalogChecksum,"0".repeat(64));assert.deepEqual(JSON.parse(await readFile(output,"utf8")),candidate);const reviewed=await promoteCatalogManifest({candidate:output,output:reviewedOutput});assert.equal(reviewed.generatedFrom,"reviewed-supported-postgresql-16");assert.equal(reviewed.reviewRequired,false);assert.equal(reviewed.catalogChecksum,candidate.catalogChecksum);await assert.rejects(()=>generateCatalogCandidate({databaseUrl:"postgres://fixture",output,connect}),/EEXIST/);const tampered={...candidate,security:{forcedRls:["household_members"],publicExecuteCount:0}},tamperedPath=join(directory,"tampered-catalog-manifest.candidate.json");await import("node:fs/promises").then(fs=>fs.writeFile(tamperedPath,JSON.stringify(tampered)));await assert.rejects(()=>promoteCatalogManifest({candidate:tamperedPath,output:join(directory,"tampered-catalog-manifest.reviewed.json")}),/promotion/)}finally{await rm(directory,{recursive:true,force:true})}});

test("catalog records the reviewed absence of NearYou role memberships",()=>{
  assert.match(LIVE_CATALOG_QUERY,/SELECT 'membership','<none>',''/);
  assert.match(LIVE_CATALOG_QUERY,/NOT EXISTS[\s\S]*pg_auth_members/);
});

test("catalog CLI reports only bounded failure classes",()=>{
  assert.equal(catalogCandidateFailureCode(new Error("catalog candidate incomplete")),"catalog-candidate-incomplete");
  assert.equal(catalogCandidateFailureCode(new Error("catalog security invariant failed")),"catalog-security-invariant");
  assert.equal(catalogCandidateFailureCode(new Error("catalog security invariant failed:public-execute:nearyou.safe_name(text)")),"catalog-public-execute:nearyou.safe_name(text)");
  assert.equal(catalogCandidateFailureCode(new Error("catalog security invariant failed:public-execute:postgres://secret")),"catalog-security-invariant");
  assert.equal(catalogCandidateFailureCode(new Error("postgres://secret unexpected syntax")),"catalog-query-failed");
});

test("catalog candidate rejects missing FORCE RLS and PUBLIC function execution",async()=>{const rows=REQUIRED_CATALOG_KINDS.map((kind,index)=>({kind,identity:`i${index}`,definition:`d${index}`})),directory=await mkdtemp(join(tmpdir(),"nearyou-catalog-security-"));try{for(const security of [{forced_rls:["household_members"],public_execute_count:"0"},{forced_rls:["household_members","tenant_records"],public_execute_count:"1"}])await assert.rejects(()=>generateCatalogCandidate({databaseUrl:"postgres://fixture",output:join(directory,`${Math.random()}-catalog-manifest.candidate.json`),connect:async()=>({query:async sql=>({rows:sql.includes("public_execute_count")?[security]:rows}),close:async()=>{}})}),/security invariant/)}finally{await rm(directory,{recursive:true,force:true})}});

test("operational evidence is exact, bounded, release-bound and fail closed", () => {
  assert.throws(() => buildOperationalEvidence({ ...base, load: null, restore: null, accessibility: null, security: null, media: null, canary: null }), /evidence incomplete/);
  const evidence = buildOperationalEvidence({ ...base,
    load: { artifact: hash("c"), requests: 10_000, p95Ms: 450, maxP95Ms: 500, errorRateBps: 5, maxErrorRateBps: 10 },
    restore: { artifact: hash("d"), targetTime: base.startedAt - 1_000, restoredAt: base.startedAt + 1_000, checksum: hash("e"), rowCount: 50 },
    accessibility: { artifact: hash("f"), pages: 5, violations: 0 },
    security: { artifact: hash("1"), dependencyFindings: 0, secretFindings: 0, sastFindings: 0 },
    media: { artifact: hash("2"), story: true, legacy: true, workerOidc: true },
    canary: { artifact: hash("3"), heartbeatCount: 1440, deadLetters: 0, completedJobs: 100, failedJobs: 0 },
  });
  assert.equal(evidence.kind, "nearyou-operational-evidence-v1");
  assert.equal(evidence.releaseId, base.releaseId);
  assert.throws(() => buildOperationalEvidence({ ...evidence, extra: true }), /evidence invalid/);
  const unsigned = Object.fromEntries(Object.entries(evidence).filter(([key]) => key !== "kind"));
  assert.throws(() => buildOperationalEvidence({ ...unsigned, load: { ...evidence.load, p95Ms: 501 } }), /threshold/);
});

test("PostgreSQL canary ledger exposes narrow replay-safe functions",async()=>{const calls=[],pg={query:async(sql,args)=>{calls.push({sql,args});return sql.includes("record_canary")?{rows:[{inserted:true}]}:{rows:[]}}},store=createPostgresCanarySampleStore(pg,"rel_12345678");assert.equal(await store.record({at:base.startedAt,deadLetters:0,completedJobs:1,failedJobs:0}),true);const sql=readFileSync(new URL("../postgres/migrations/0005_operational_evidence.sql",import.meta.url),"utf8");assert.match(sql,/SECURITY DEFINER/);assert.match(sql,/REVOKE ALL ON nearyou\.canary_evidence_samples/);assert.match(sql,/UNIQUE\(release_id,sample_digest\)/)});

test("accessibility security media and durable canary collectors fail closed", async () => {
  assert.deepEqual(await collectAccessibility({urls:["https://app.test/studio"],runAxe:async()=>({checks:12,violations:0})}),{checks:12,violations:0,pages:1});
  await assert.rejects(()=>collectMedia({storyUrl:"https://media/story",legacyUrl:"https://media/legacy",token:"secret-token",fetch:async()=>new Response("bad",{status:503})}),/media failed/);
  assert.throws(()=>collectSecurity({npmAudit:{metadata:{vulnerabilities:{high:1,critical:0}}},secretFindings:0,sastFindings:0}),/security failed/);
  const rows=[];const store=new CanarySampleStore({insert:async sample=>{if(rows.some(r=>r.at===sample.at))return false;rows.push(sample);return true},list:async()=>rows});
  assert.equal(await store.record({at:base.startedAt,deadLetters:0,completedJobs:1,failedJobs:0}),true);
  assert.equal(await store.record({at:base.startedAt,deadLetters:0,completedJobs:1,failedJobs:0}),false);
});

test("collectors execute requests and enforce provider truth", async () => {
  let calls=0;const load=await collectHttpLoad({urls:["https://service.test/story","https://service.test/legacy"],requests:10,maxP95Ms:500,maxErrorRateBps:10,fetch:async()=>{calls++;return new Response("ok")},now:(()=>{let n=0;return()=>n++})()});
  assert.equal(load.requests,10);assert.equal(calls,10);
  await assert.rejects(()=>collectRestore({project:"project-12345",operationId:"op",expectedChecksum:hash("a"),token:"token",fetch:async()=>new Response(JSON.stringify({status:"DONE",checksum:hash("b"),rowCount:1}),{headers:{"content-type":"application/json"}})}),/restore failed/);
  assert.throws(()=>collectCanary([{at:base.startedAt,deadLetters:0,completedJobs:1,failedJobs:0},{at:base.endedAt,deadLetters:0,completedJobs:2,failedJobs:0}]),/canary failed/);
});

test("restore requires restored database attestation and media requires exact output receipts",async()=>{
 const checksum=hash("a"),catalog=hash("b");
 assert.deepEqual(await collectRestore({project:"project-12345",operationId:"op",expectedChecksum:checksum,token:"token",fetch:async()=>new Response('{"status":"DONE"}'),verifyRestoredDatabase:async()=>({rowChecksum:checksum,catalogChecksum:catalog,rowCount:2}),expectedCatalogChecksum:catalog}),{checksum,rowCount:2,catalogChecksum:catalog});
 await assert.rejects(()=>collectMedia({storyUrl:"https://media/story",legacyUrl:"https://media/legacy",token:"service-jwt",releaseId:"rel_12345678",fetch:async()=>new Response(JSON.stringify({releaseId:"rel_12345678",product:"wrong",persisted:true,artifactChecksum:checksum,outputChecksum:catalog}),{headers:{"content-type":"application/json"}})}),/media failed/);
});

test("canary requires a complete 24 hour monotonic observation window", () => {
  assert.equal(validateCanaryWindow(base.startedAt, base.endedAt, 1440), true);
  assert.equal(validateCanaryWindow(base.startedAt, base.endedAt - 1, 1440), false);
  assert.equal(validateCanaryWindow(base.startedAt, base.endedAt, 2), false);
});

test("CI provisions PostgreSQL 16 and produces review-only operational artifacts", () => {
  const workflow = readFileSync(new URL("../.github/workflows/production-evidence.yml", import.meta.url), "utf8");
  assert.match(workflow, /pgvector\/pgvector@sha256:[a-f0-9]{64}/);
  assert.match(workflow, /postgres-rls-gate\.sql/);
  assert.match(workflow, /catalog-manifest\.candidate\.json/);
  assert.doesNotMatch(workflow, /cp .*candidate.*postgres\/catalog-manifest\.json/);
  for (const gate of ["load", "restore", "accessibility", "security", "media", "canary"]) assert.match(workflow, new RegExp(`operational-evidence.*${gate}|${gate}.*operational-evidence`, "s"));
});

test("Story dead-letter telemetry retains the exact rollout grant and Cloudflare declares its identity bindings",()=>{
  const story=readFileSync(new URL("../lib/nearstory-stage-worker.ts",import.meta.url),"utf8");
  const migration=readFileSync(new URL("../drizzle/0021_story_rollout_telemetry.sql",import.meta.url),"utf8");
  const hosting=JSON.parse(readFileSync(new URL("../.openai/hosting.json",import.meta.url),"utf8"));
  assert.match(story,/rolloutReleaseId:grant\.releaseId,rolloutVersion:grant\.version/);
  assert.match(story,/releaseId:record\.rolloutReleaseId,releaseVersion:record\.rolloutVersion/);
  assert.doesNotMatch(story,/rel_worker_exhausted/);
  assert.match(migration,/rollout_release_id/);assert.match(migration,/rollout_version/);
  for(const name of ["OUTCOME_RUNTIME","OUTCOME_ENDPOINT","OUTCOME_AUDIENCE","OUTCOME_WIF_AUDIENCE","OUTCOME_SERVICE_ACCOUNT"])assert.ok(hosting.required_worker_bindings.vars.includes(name));
  assert.deepEqual(hosting.required_worker_bindings.services,["OUTCOME_SUBJECT_TOKEN"]);
  const migrationJob=readFileSync(new URL("../infra/production/storage-queues.tf",import.meta.url),"utf8");
  const migrationContainer=migrationJob.slice(migrationJob.indexOf('command = ["node", "/app/dist/scripts/migrate.js"]'),migrationJob.indexOf("NEARYOU_READINESS_DATABASE_USER"));
  assert.doesNotMatch(migrationContainer,/OUTCOME_|EVIDENCE_COLLECTION_APPROVED/);
});

test("operational evidence uses authoritative outcomes, unique server minute buckets, and strict scanners",()=>{
  const sql=readFileSync(new URL("../postgres/migrations/0005_operational_evidence.sql",import.meta.url),"utf8"),route=readFileSync(new URL("../app/api/internal/operational-evidence/sample/route.ts",import.meta.url),"utf8"),outcome=readFileSync(new URL("../app/api/internal/product-outcomes/route.ts",import.meta.url),"utf8"),workflow=readFileSync(new URL("../.github/workflows/production-evidence.yml",import.meta.url),"utf8"),composer=readFileSync(new URL("../scripts/compose-release-claims.ts",import.meta.url),"utf8");
  assert.match(sql,/statement_timestamp\(\)/);assert.match(sql,/date_trunc\('minute'/);assert.match(sql,/PRIMARY KEY\(release_id,minute_bucket\)/);assert.match(sql,/FROM nearyou\.operational_job_outcomes/);
  assert.doesNotMatch(route,/request\.json|deadLetters|completedJobs/);assert.match(outcome,/record_operational_worker_attempt\(\$1,\$2,\$3,\$4,\$5,\$6,\$7,\$8,\$9,\$10\)/);assert.match(sql,/terminal_status IS NULL/);
  assert.match(workflow,/psql .*ON_ERROR_STOP=1 .*postgres-rls-gate\.sql/);assert.doesNotMatch(workflow,/zap-baseline[^\n]* -I/);assert.match(workflow,/security-evidence-cli\.ts .*zap\.json/);
  assert.doesNotMatch(composer,/critical:\s*0,high:\s*0/);
});

test("Story and Legacy register exact authenticated attempts before one-time terminal evidence",()=>{
  const sql=readFileSync(new URL("../postgres/migrations/0005_operational_evidence.sql",import.meta.url),"utf8"),story=readFileSync(new URL("../lib/nearstory-stage-worker.ts",import.meta.url),"utf8"),legacy=readFileSync(new URL("../lib/nearlegacy-worker.ts",import.meta.url),"utf8");
  assert.match(sql,/CREATE TABLE nearyou\.operational_worker_attempts/);assert.match(sql,/terminal_status IS NULL/);assert.match(sql,/p_operation='attempt_started'/);assert.match(sql,/input_checksum=p_checksum/);
  for(const source of [story,legacy]){assert.match(source,/operation:\s*"attempt_started"/);assert.match(source,/operation:\s*"terminal"/);assert.match(source,/request_hash|requestHash/);assert.match(source,/attemptToken|worker_attempt_token/)}
  assert.match(legacy,/operational_outcome_outbox/);assert.doesNotMatch(legacy,/new Map/);
});

test("D1 outcome outbox is leased replay-safe and terminal evidence is never memory-only",()=>{const migration=readFileSync(new URL("../drizzle/0022_operational_outcome_outbox.sql",import.meta.url),"utf8"),runtime=readFileSync(new URL("../lib/operational-outcome-outbox.ts",import.meta.url),"utf8"),story=readFileSync(new URL("../lib/nearstory-production-worker.ts",import.meta.url),"utf8");assert.match(migration,/UNIQUE \(`product`,`job_id`,`attempt_token`,`operation`\)/);assert.match(migration,/delivery_status.*dead_letter/);assert.match(runtime,/lease_token/);assert.match(runtime,/attempts\s*>=\s*12/);assert.match(runtime,/payload_checksum=excluded\.payload_checksum/);assert.match(story,/operationalOutcomeOutbox/)});

test("canary signature requires exact D1 and PostgreSQL terminal reconciliation",()=>{const verifier=readFileSync(new URL("../lib/asymmetric-release-evidence.ts",import.meta.url),"utf8"),cli=readFileSync(new URL("../scripts/canary-evidence-cli.ts",import.meta.url),"utf8"),sql=readFileSync(new URL("../postgres/migrations/0005_operational_evidence.sql",import.meta.url),"utf8");for(const field of ["reconciliationArtifact","terminalCount","terminalDigest","pending","outboxDeadLetters"])assert.match(verifier,new RegExp(field));assert.match(cli,/reconcileOutcomeLedgers/);assert.match(sql,/string_agg\(evidence_checksum,'' ORDER BY product,job_id,attempt_token\)/)});

test("workflow mints a fresh exact-audience token immediately before reconciliation",()=>{const workflow=readFileSync(new URL("../.github/workflows/production-evidence.yml",import.meta.url),"utf8"),cli=readFileSync(new URL("../scripts/canary-evidence-cli.ts",import.meta.url),"utf8"),auth=workflow.indexOf("id: reconciliation-auth"),finalize=workflow.indexOf("finalize durable 24h canary");assert.ok(auth>0&&finalize>auth);assert.match(workflow,/token_format: id_token/);assert.match(workflow,/id_token_audience: \$\{\{ vars\.OUTCOME_RECONCILIATION_AUDIENCE \}\}/);assert.match(workflow,/OUTCOME_RECONCILIATION_URL: \$\{\{ vars\.OUTCOME_RECONCILIATION_URL \}\}/);assert.match(workflow,/CANARY_METRICS_TOKEN: \$\{\{ steps\.reconciliation-auth\.outputs\.id_token \}\}/);assert.match(cli,/OUTCOME_RECONCILIATION_AUDIENCE/);assert.match(cli,/token\.split\("\."\)\.length\s*!==\s*3/)});

test("production workflow creates artifacts, binds RLS, and uses authenticated server sampling",()=>{const workflow=readFileSync(new URL("../.github/workflows/production-evidence.yml",import.meta.url),"utf8"),sampler=readFileSync(new URL("../.github/workflows/canary-evidence-sampler.yml",import.meta.url),"utf8"),route=readFileSync(new URL("../app/api/internal/operational-evidence/sample/route.ts",import.meta.url),"utf8"),restore=readFileSync(new URL("../scripts/collect-operational-gate.ts",import.meta.url),"utf8"),security=readFileSync(new URL("../scripts/security-evidence-cli.ts",import.meta.url),"utf8"),composer=readFileSync(new URL("../scripts/compose-release-claims.ts",import.meta.url),"utf8");assert.match(workflow,/mkdir -p evidence/);assert.match(workflow,/needs: postgres-contract/);assert.match(workflow,/rls-evidence-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);assert.match(workflow,/actions\/download-artifact@[a-f0-9]{40}/);assert.match(workflow,/npm audit --json > evidence\/npm-audit\.json/);assert.doesNotMatch(security,/npm_execpath|npm-cli/);assert.match(restore,/sql\/v1beta4\/projects\/\$\{encodeURIComponent\(input\.project\)\}\/operations/);assert.doesNotMatch(sampler,/READINESS_CONTROL_DATABASE_URL/);assert.match(route,/set_config\('nearyou\.service_principal'/);assert.match(route,/transaction/);assert.match(composer,/readOperationalArtifact/);assert.match(composer,/claims\.releaseId !== releaseId/);for(const source of [workflow,sampler])for(const action of source.matchAll(/uses:\s*([^\s#]+)/g))assert.match(action[1],/@[a-f0-9]{40}$/)});

test("RLS evidence requires observed seeded positive and negative controls",async()=>{const sql=readFileSync(new URL("../scripts/postgres-rls-gate.sql",import.meta.url),"utf8"),environment={RELEASE_ID:"rel_12345678",SCHEMA_CHECKSUM:hash("a")};for(const fixture of ["hh_a","hh_b","record_a","record_b","job_a","job_b"])assert.match(sql,new RegExp(fixture));assert.match(sql,/positive control failed/);const observed={fixtureTenants:2,positiveControls:5,crossTenantChecks:5,mutationDenials:2,crossTenantViolations:0},evidence=await buildRlsEvidence(JSON.stringify(observed),environment);assert.deepEqual(evidence.result,{...observed,sourceChecksum:evidence.result.sourceChecksum});await assert.rejects(()=>buildRlsEvidence(JSON.stringify({...observed,positiveControls:0}),environment),/rls evidence invalid/);await assert.rejects(()=>buildRlsEvidence(JSON.stringify({...observed,crossTenantViolations:1}),environment),/rls evidence invalid/)});

test("claims composer binds scoped artifacts without collapsing the historical evidence window",async()=>{const now=1_800_000_000_000,releaseId="rel_12345678",schema=hash("a"),products=["nearstory","nearfamily","nearlegacy"].map((product,index)=>({product,environment:"production",region:"us-central1",releaseId,artifact:hash("b"),imageDigest:hash("c"),expiresAt:now+(index+1)*60000,controllerMapping:{verified:true,artifact:hash("d"),verifiedAt:now-1000},secretVersions:{runtime:"projects/prod/secrets/runtime/versions/1"},probes:Object.fromEntries((product==="nearfamily"?["identity","member","entitlement","invite","privacy","capacityRemediation"]:["worker","scheduler","processor"]).map(name=>[name,{identity:`probe:${name}`,passed:true,verifiedAt:now-1000}])),capacity:{queueDepth:1,maxQueueDepth:10,errorRateBps:0,maxErrorRateBps:10,soakStartedAt:now-3700000,soakEndedAt:now-1000},mobilePlatforms:product==="nearfamily"?["ios","android"]:[]})),results={rls:{negativeTests:1,crossTenantViolations:0},media:{canaries:2,failed:0},restore:{restoredObjects:1,checksumMismatches:0},load:{requests:10,errorRateBps:0,p95Ms:10,maxErrorRateBps:1,maxP95Ms:20},accessibility:{checks:10,violations:0},security:{critical:0,high:0,scanArtifact:hash("f"),penTestArtifact:hash("1")},canary:{startedAt:now-86400000,endedAt:now,heartbeatCount:1440,deadLetters:0,completedJobs:1,failedJobs:0,reconciliationArtifact:hash("2"),terminalCount:1,terminalDigest:hash("3"),pending:0,outboxDeadLetters:0}},template={version:1,principal:"ci://github/nearyou/release",keyId:"kms-release",keyVersion:2,releaseId,schema,backfill:hash("4"),highWater:1,fence:1,notBefore:now-70000,issuedAt:now-1000,expiresAt:now+120000,nonce:"abcdefghijklmnopqrstuv",productReadiness:products,gates:Object.fromEntries(Object.entries(results).map(([kind,value])=>[kind,{kind,policyVersion:1,releaseId,schema,artifact:hash("e"),verifiedAt:now-1000,results:value}])),shadow:{kind:"shadow",policyVersion:1,releaseId,schema,artifact:hash("5"),startedAt:now-65000,endedAt:now-1000,sourceChecksum:hash("4"),targetChecksum:hash("4"),sampleCount:3,observedRows:1,mismatchCount:0}},directory=await mkdtemp(join(tmpdir(),"nearyou-compose-")),artifacts={"rls-evidence":{negativeTests:7,crossTenantViolations:0,sourceChecksum:hash("6")},load:results.load,restore:{rowCount:5},accessibility:results.accessibility,security:{dependencyFindings:0,sastFindings:0},media:{story:true,legacy:true},canary:results.canary};try{for(const[name,value]of Object.entries(artifacts))await writeFile(join(directory,`${name}.json`),JSON.stringify(operationalArtifact(value,{RELEASE_ID:releaseId,SCHEMA_CHECKSUM:schema}))+"\n");await writeFile(join(directory,"zap.json"),JSON.stringify({site:[]}));const output=join(directory,"claims.json");await composeReleaseClaims({dir:directory,output,templateRaw:JSON.stringify(template),releaseId,principal:template.principal,keyId:template.keyId,keyVersion:2,now,nonce:"zyxwvutsrqponmlkjihgfe"});const claims=JSON.parse(await readFile(output,"utf8"));assert.equal(claims.notBefore,template.shadow.startedAt);assert.equal(claims.expiresAt,now+60000);assert.equal(claims.gates.rls.results.negativeTests,7);assert.doesNotThrow(()=>canonicalEvidence(claims));await assert.rejects(()=>composeReleaseClaims({dir:directory,output:join(directory,"bad.json"),templateRaw:JSON.stringify(template),releaseId:"rel_wrong_12345678",principal:template.principal,keyId:template.keyId,keyVersion:2,now}),/composition/);const expired={...template,productReadiness:template.productReadiness.map((item,index)=>index===0?{...item,expiresAt:now}:item)};await assert.rejects(()=>composeReleaseClaims({dir:directory,output:join(directory,"expired.json"),templateRaw:JSON.stringify(expired),releaseId,principal:template.principal,keyId:template.keyId,keyVersion:2,now}),/composition/)}finally{await rm(directory,{recursive:true,force:true})}});
