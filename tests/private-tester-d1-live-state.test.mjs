import assert from "node:assert/strict";
import test from "node:test";
import { createPrivateTesterBaselineRuntime } from "../lib/private-tester-baseline-gateway.ts";
import { SITES_D1_PHASE_A_ARTIFACT } from "../lib/sites-d1-phase-a-artifact.generated.ts";
import { SITES_D1_PHASE_B_ARTIFACT } from "../lib/sites-d1-phase-b-artifact.generated.ts";
import { SITES_D1_PHASE_C_ARTIFACT } from "../lib/sites-d1-phase-c-artifact.generated.ts";
import { SITES_D1_FORWARD_ARTIFACT } from "../lib/sites-d1-forward-artifact.generated.ts";
import { verifyPrivateTesterD1LiveState } from "../scripts/private-tester-d1-live-state.ts";

const release={releaseId:"rel_20260818_private_02",commitSha:"a".repeat(40),sitesVersion:"appgprj_6a79f8a66eb4819198bb42a2b26addea~appgver_example",startsAt:"2026-08-18T00:00:00.000Z",expiresAt:"2026-08-25T00:00:00.000Z",products:["nearfamily","nearstory"]};
const environment=(DB)=>({DB,PRIVATE_TESTER_BASELINE_RELEASE_JSON:JSON.stringify(release),GOOGLE_CLIENT_ID:"619793096923-2hspnuckl0j99p3jrfb6qd21aatb0pep.apps.googleusercontent.com",BETTER_AUTH_URL:"https://nearyoustill.com",PUBLIC_APP_URL:"https://nearyoustill.com",NEARYOU_ENABLE_STORY:"false",NEARYOU_ENABLE_LEGACY_ARCHIVE:"false",PRIVATE_TESTER_SCHEDULER_ENABLED:"false"});

test("binds the reviewed live lineage to exactly 0000 through 0026",async()=>{const state=await verifyPrivateTesterD1LiveState();assert.equal(state.sources.length,27);assert.equal(state.sources[0].id,"0000_nearnight_foundation");assert.equal(state.sources[26].id,"0026_canary_entitlements");assert.equal(state.schemaDefinitionHash,SITES_D1_FORWARD_ARTIFACT.schemaCheckpoints.find(x=>x.head==="0026").definitionsSha256)});

test("reads provider plus all immutable repair ledgers as one exact live lineage",async()=>{
 const groups=new Map([["phase_a",SITES_D1_PHASE_A_ARTIFACT.migrations],["phase_b",SITES_D1_PHASE_B_ARTIFACT.migrations],["phase_c",SITES_D1_PHASE_C_ARTIFACT.migrations],["forward",SITES_D1_FORWARD_ARTIFACT.migrations]]);let time=1787000000000;
 const DB={prepare(sql){return{all:async()=>{if(sql.includes("FROM d1_migrations"))return{results:SITES_D1_PHASE_A_ARTIFACT.providerMigrationRows};for(const[key,items]of groups)if(sql.includes(`nearyou_d1_${key}_migrations`))return{results:items.map(item=>({migration_id:item.id,source_sha256:item.sha256,applied_at:++time,status:"complete"}))};throw new Error(sql)}}}};
 const runtime=createPrivateTesterBaselineRuntime(environment(DB),{now:()=>Date.parse(release.startsAt),fetch});const result=await runtime.read("d1-ledger");assert.equal(result.appliedMigrations.length,27);assert.equal(result.appliedMigrations[26].name,"0026_canary_entitlements.sql");
});

test("rejects any repaired migration hash drift",async()=>{const DB={prepare(sql){return{all:async()=>{if(sql.includes("FROM d1_migrations"))return{results:SITES_D1_PHASE_A_ARTIFACT.providerMigrationRows};const group=sql.includes("phase_a")?SITES_D1_PHASE_A_ARTIFACT.migrations:sql.includes("phase_b")?SITES_D1_PHASE_B_ARTIFACT.migrations:sql.includes("phase_c")?SITES_D1_PHASE_C_ARTIFACT.migrations:SITES_D1_FORWARD_ARTIFACT.migrations;return{results:group.map((item,index)=>({migration_id:item.id,source_sha256:index===0?"0".repeat(64):item.sha256,applied_at:1787000000000+index,status:"complete"}))}}}}};await assert.rejects(()=>createPrivateTesterBaselineRuntime(environment(DB),{now:()=>Date.parse(release.startsAt),fetch}).read("d1-ledger"),/evidence unavailable/)});
