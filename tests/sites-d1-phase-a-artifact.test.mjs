import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {readFileSync} from "node:fs";
import test from "node:test";
import {SITES_D1_PHASE_A_ARTIFACT} from "../lib/sites-d1-phase-a-artifact.generated.ts";

const root=new URL("../",import.meta.url);
const evidence={
  ledger:"/tmp/d1-convergence-ledger-local.json",
  schema:"/tmp/d1-convergence-schema-local.json",
  shape:"/tmp/d1-convergence-shape-local.json",
};
const sha256=value=>createHash("sha256").update(value).digest("hex");

test("generated Phase A artifact is reproducible from the three exact private inputs",()=>{
  execFileSync(process.execPath,["--import","tsx","scripts/generate-sites-d1-phase-a-artifact.ts","--check"],{cwd:root,env:{...process.env,D1_PHASE_A_LEDGER_EVIDENCE:evidence.ledger,D1_PHASE_A_SCHEMA_EVIDENCE:evidence.schema,D1_PHASE_A_SHAPE_EVIDENCE:evidence.shape}});
  assert.deepEqual(SITES_D1_PHASE_A_ARTIFACT.privateInputSha256,{
    ledger:sha256(readFileSync(evidence.ledger)),
    schema:sha256(readFileSync(evidence.schema)),
    shape:sha256(readFileSync(evidence.shape)),
  });
});

test("artifact binds exact live 0006 state and only the 0007 through 0009 transition",()=>{
  const ledger=JSON.parse(readFileSync(evidence.ledger,"utf8")).body.providerMigrationRows;
  const shape=JSON.parse(readFileSync(evidence.shape,"utf8")).body;
  assert.deepEqual(SITES_D1_PHASE_A_ARTIFACT.providerMigrationRows,ledger);
  assert.equal(SITES_D1_PHASE_A_ARTIFACT.predecessorShapeSha256,sha256(JSON.stringify(shape)));
  assert.deepEqual(SITES_D1_PHASE_A_ARTIFACT.migrations.map(value=>value.id),[
    "0007_nearsleep_production_upgrade",
    "0008_nearsleep_live_integration",
    "0009_nearsleep_audio_atomic",
  ]);
  assert.deepEqual(SITES_D1_PHASE_A_ARTIFACT.schemaCheckpoints.map(value=>value.head),["0006","0006+operation","0007","0008","0009"]);
  for(const migration of SITES_D1_PHASE_A_ARTIFACT.migrations){
    assert.equal(migration.sha256,sha256(migration.sql));
    assert.equal(migration.statements.join("\n--> statement-breakpoint\n")+"\n",migration.sql);
  }
});

test("committed artifact contains hashes and counts, not private predecessor definitions or user values",()=>{
  const artifact=readFileSync(new URL("../lib/sites-d1-phase-a-artifact.generated.ts",import.meta.url),"utf8");
  for(const checkpoint of SITES_D1_PHASE_A_ARTIFACT.schemaCheckpoints)assert.deepEqual(Object.keys(checkpoint).sort(),["definitionsSha256","head","objectCount"]);
  assert.doesNotMatch(artifact,/rootPage|root_page|rowCounts|foreignKeyViolations|observedAt|principal|subject|audience|issuer/);
  assert.doesNotMatch(artifact,/providerObjects/);
});
