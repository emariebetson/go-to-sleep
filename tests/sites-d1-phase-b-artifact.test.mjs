import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {readFileSync} from "node:fs";
import test from "node:test";
import {SITES_D1_PHASE_A_ARTIFACT} from "../lib/sites-d1-phase-a-artifact.generated.ts";
import {SITES_D1_PHASE_B_ARTIFACT} from "../lib/sites-d1-phase-b-artifact.generated.ts";

const root=new URL("../",import.meta.url);
const probe="/tmp/d1-convergence-probes-post0009-local.json";
const sha256=value=>createHash("sha256").update(value).digest("hex");

test("generated Phase B artifact is reproducible from exact Phase A and probe evidence",()=>{
  execFileSync(process.execPath,["--import","tsx","scripts/generate-sites-d1-phase-b-artifact.ts","--check"],{cwd:root,env:{...process.env,D1_PHASE_A_SCHEMA_EVIDENCE:"/tmp/d1-convergence-schema-local.json",D1_PHASE_B_PROBE_EVIDENCE:probe}});
  const raw=readFileSync(probe),body=JSON.parse(raw).body;
  assert.equal(SITES_D1_PHASE_B_ARTIFACT.privateInputSha256.probes,sha256(raw));
  assert.equal(SITES_D1_PHASE_B_ARTIFACT.probeContentSha256,sha256(JSON.stringify(body)));
  assert.equal(SITES_D1_PHASE_B_ARTIFACT.probeAffectedSetSha256,sha256(JSON.stringify(body.stages)));
  assert.deepEqual(SITES_D1_PHASE_B_ARTIFACT.phaseAPredecessor,SITES_D1_PHASE_A_ARTIFACT.schemaCheckpoints.at(-1));
});

test("artifact packages only 0010 through 0012 with separate Phase B bootstrap checkpoints",()=>{
  assert.deepEqual(SITES_D1_PHASE_B_ARTIFACT.migrations.map(value=>value.id),[
    "0010_child_profile_pronunciation","0011_household_billing_accounts","0012_nearsleep_library_privacy",
  ]);
  assert.deepEqual(SITES_D1_PHASE_B_ARTIFACT.schemaCheckpoints.map(value=>value.head),["0009","0009+phase-b-operation","0010","0011","0012"]);
  assert.equal(SITES_D1_PHASE_B_ARTIFACT.bootstrap.length,6);
  assert.match(SITES_D1_PHASE_B_ARTIFACT.bootstrap.join("\n"),/nearyou_d1_phase_b_operations/);
  assert.doesNotMatch(SITES_D1_PHASE_B_ARTIFACT.bootstrap.join("\n"),/__appgarden_migrations|_cf_KV/);
  for(const migration of SITES_D1_PHASE_B_ARTIFACT.migrations)assert.equal(migration.sha256,sha256(migration.sql));
});

test("committed Phase B artifact contains no private user values",()=>{
  const source=readFileSync(new URL("../lib/sites-d1-phase-b-artifact.generated.ts",import.meta.url),"utf8");
  assert.doesNotMatch(source,/"(?:observedAt|principal|subject|audience|issuer|rootPage|rowCounts|foreignKeyViolations)":/);
  assert.deepEqual(Object.keys(SITES_D1_PHASE_B_ARTIFACT.probeBinding.stages[0]).sort(),["projectionSha256","rowCount","stage","violationCount"]);
});
