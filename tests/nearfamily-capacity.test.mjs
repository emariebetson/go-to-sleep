import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { decideHouseholdCapacity, capacityMutationAllowed } from "../lib/nearfamily-capacity.ts";
import { createNearFamilySummaryService } from "../lib/nearfamily-service.ts";

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

const migrations = [
  "0000_nearnight_foundation.sql", "0001_google_apple_auth.sql", "0002_sharp_shinobi_shaw.sql",
  "0003_white_groot.sql", "0004_salty_sugar_man.sql", "0005_pronunciation_frequency_layers.sql",
  "0006_nearyou_shared_foundation.sql", "0007_nearsleep_production_upgrade.sql",
  "0008_nearsleep_live_integration.sql", "0009_nearsleep_audio_atomic.sql",
  "0010_child_profile_pronunciation.sql", "0011_household_billing_accounts.sql",
  "0012_nearsleep_library_privacy.sql", "0023_nearfamily_capacity.sql",
];

function applyMigration(database, name) {
  const source = readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
  for (const statement of source.split("--> statement-breakpoint").map(value => value.trim()).filter(Boolean)) database.exec(statement);
}

function familyDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON");
  for (const migration of migrations) applyMigration(database, migration);
  const now = Date.now();
  database.prepare("INSERT INTO users(id,email,subscription_status,credits_remaining,created_at,updated_at) VALUES('adult_1','one@example.test','active',1,?,?)").run(now, now);
  database.prepare("INSERT INTO households(id,name,owner_user_id,created_at,updated_at) VALUES('house_1','One','adult_1',?,?)").run(now, now);
  database.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,created_at,updated_at) VALUES('member_1','house_1','adult_1','owner','active',?,?)").run(now, now);
  database.prepare("INSERT INTO entitlements(id,household_id,plan_id,source,status,allowance_milliunits,remaining_milliunits,valid_from,created_at,updated_at) VALUES('grant_1','house_1','nearyou_family','manual','active',120000,120000,?,?,?)").run(now - 1000, now, now);
  for (let index = 0; index < 5; index += 1) database.prepare("INSERT INTO child_profiles(id,household_id,nickname,normalized_nickname,pronunciation,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(`child_${index}`, "house_1", `Child ${index}`, `child-${index}`, "", now, now);
  return database;
}

test("a downgrade restricts new capacity without deleting data and remediation clears the restriction", () => {
  const database = familyDatabase();
  const initial=database.prepare("SELECT state,exceeded_json,version FROM household_capacity_state WHERE household_id='house_1'").get();
  assert.equal(initial.state,"within_limit");assert.equal(initial.exceeded_json,"[]");assert.ok(initial.version>0);
  database.prepare("UPDATE entitlements SET plan_id='nearyou_plus',updated_at=updated_at+1 WHERE id='grant_1'").run();
  const restricted = database.prepare("SELECT state,exceeded_json,version FROM household_capacity_state WHERE household_id='house_1'").get();
  assert.equal(restricted.state, "restricted");
  assert.deepEqual(JSON.parse(restricted.exceeded_json), ["children"]);
  assert.equal(database.prepare("SELECT count(*) count FROM child_profiles WHERE household_id='house_1' AND archived_at IS NULL").get().count, 5);
  const now = Date.now();
  assert.throws(() => database.prepare("INSERT INTO child_profiles(id,household_id,nickname,normalized_nickname,pronunciation,created_at,updated_at) VALUES('child_new','house_1','New','new','',?,?)").run(now, now), /household_capacity_restricted|household_child_limit_reached/);
  database.prepare("DELETE FROM child_profiles WHERE id='child_4'").run();
  const afterDelete=database.prepare("SELECT state,exceeded_json,version FROM household_capacity_state WHERE household_id='house_1'").get();
  assert.equal(afterDelete.state,"restricted");assert.deepEqual(JSON.parse(afterDelete.exceeded_json),["children"]);assert.ok(afterDelete.version>restricted.version);
  for (let index = 2; index < 4; index += 1) database.prepare("UPDATE child_profiles SET archived_at=?,updated_at=? WHERE id=?").run(now, now, `child_${index}`);
  const remediated=database.prepare("SELECT state,exceeded_json FROM household_capacity_state WHERE household_id='house_1'").get();assert.equal(remediated.state,"within_limit");assert.equal(remediated.exceeded_json,"[]");
  assert.throws(() => database.prepare("UPDATE household_capacity_state SET version=1,state='within_limit',exceeded_json='[]' WHERE household_id='house_1'").run(), /capacity_state_authoritative/);
});

test("NearFamily summary returns the exact safe bundle shape", async () => {
  const calls=[];
  const db={prepare(sql){calls.push(sql);return{bind(householdId){assert.equal(householdId,"house_1");return{first:async()=>({
    plan_id:"nearyou_family",state:"restricted",exceeded_json:'["children"]',members:4,children:6,voices:2,storage_bytes:25_000_000_000,
    member_limit:5,child_limit:5,voice_limit:2,storage_limit:25_000_000_000,
  })}}}}};
  const summary=await createNearFamilySummaryService(db)("house_1");
  assert.deepEqual(summary,{
    planId:"nearyou_family",
    capacity:{state:"restricted",usage:{members:4,children:6,voices:2,storageBytes:25_000_000_000},limits:{members:5,children:5,voices:2,storageBytes:25_000_000_000},exceeded:["children"]},
    features:{nearsleep:true,nearstoryParentControlled:true,childAccounts:false,childMicrophone:false,posthumousSynthesis:false},
  });
  assert.equal(calls.length,1);assert.match(calls[0],/household_capacity_projection/);assert.match(calls[0],/household_capacity_state/);
});

test("NearFamily summary rejects missing and non-Family effective entitlements",async()=>{
  for(const row of [null,{plan_id:"nearyou_plus",state:"within_limit",exceeded_json:"[]",members:1,children:1,voices:1,storage_bytes:1,member_limit:2,child_limit:2,voice_limit:1,storage_limit:5_000_000_000}]){
    const db={prepare(){return{bind(){return{first:async()=>row}}}}};
    await assert.rejects(()=>createNearFamilySummaryService(db)("house_1"),/NearFamily entitlement required/);
  }
});
