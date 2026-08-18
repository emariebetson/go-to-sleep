import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { decideHouseholdCapacity, capacityMutationAllowed } from "../lib/nearfamily-capacity.ts";
import { createNearFamilySummaryService } from "../lib/nearfamily-service.ts";
import { upsertLegacyChildProfile } from "../lib/legacy-child-profile.ts";

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
  "0012_nearsleep_library_privacy.sql", "0023_nearfamily_capacity.sql", "0024_nearfamily_capacity_authority.sql", "0025_nearfamily_tenant_binding.sql",
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

class D1Fixture {
  constructor(database) {
    this.database = database;
  }

  prepare(query) {
    return {
      bind: (...parameters) => ({
        first: async () => this.database.prepare(query).get(...parameters) || null,
        run: async () => {
          const result = this.database.prepare(query).run(...parameters);
          return { success: true, meta: { changes: result.changes } };
        },
      }),
    };
  }
}

test("legacy child profile persistence updates an existing child at the current plan limit", async () => {
  const database = familyDatabase();
  const db = new D1Fixture(database);
  const existing = database.prepare("SELECT id FROM child_profiles WHERE household_id='house_1' AND normalized_nickname='child-0'").get();
  database.prepare(`INSERT INTO children
    (id, user_id, household_id, nickname, normalized_nickname, pronunciation, age_months, bedtime_challenge, created_at, updated_at)
    VALUES ('legacy-child-0', 'adult_1', 'house_1', 'Child Zero', 'child-0', '', 61, 'night waking', 1700000000000, 1700000000000)`).run();

  const profileId = await upsertLegacyChildProfile(db, {
    id: "replacement-id",
    householdId: "house_1",
    legacyChildId: "legacy-child-0",
    nickname: "Child Zero",
    normalizedNickname: "child-0",
    ageMonths: 61,
    bedtimeChallenge: "night waking",
    now: new Date(1700000001000),
  });

  assert.equal(profileId, existing.id);
  assert.deepEqual({ ...database.prepare("SELECT id, legacy_child_id, nickname, age_months, bedtime_challenge, updated_at FROM child_profiles WHERE id=?").get(existing.id) }, {
    id: existing.id,
    legacy_child_id: "legacy-child-0",
    nickname: "Child Zero",
    age_months: 61,
    bedtime_challenge: "night waking",
    updated_at: 1700000001000,
  });
  assert.equal(database.prepare("SELECT count(*) count FROM child_profiles WHERE household_id='house_1'").get().count, 5);
});

test("legacy child profile persistence still rejects a new child over the current plan limit", async () => {
  const database = familyDatabase();
  const db = new D1Fixture(database);

  await assert.rejects(() => upsertLegacyChildProfile(db, {
    id: "child-new",
    householdId: "house_1",
    legacyChildId: "legacy-child-new",
    nickname: "New child",
    normalizedNickname: "new-child",
    ageMonths: 36,
    bedtimeChallenge: null,
    now: new Date(1700000001000),
  }), /household_capacity_restricted|household_child_limit_reached/);
});

test("a downgrade restricts new capacity without deleting data and remediation clears the restriction", () => {
  const database = familyDatabase();
  const initial=database.prepare("SELECT state,exceeded_json FROM household_capacity_projection WHERE household_id='house_1'").get();
  assert.equal(initial.state,"within_limit");assert.equal(initial.exceeded_json,"[]");
  database.prepare("UPDATE entitlements SET plan_id='nearyou_plus',updated_at=updated_at+1 WHERE id='grant_1'").run();
  const restricted = database.prepare("SELECT state,exceeded_json FROM household_capacity_projection WHERE household_id='house_1'").get();
  assert.equal(restricted.state, "restricted");
  assert.deepEqual(JSON.parse(restricted.exceeded_json), ["children"]);
  assert.equal(database.prepare("SELECT count(*) count FROM child_profiles WHERE household_id='house_1' AND archived_at IS NULL").get().count, 5);
  const now = Date.now();
  assert.throws(() => database.prepare("INSERT INTO child_profiles(id,household_id,nickname,normalized_nickname,pronunciation,created_at,updated_at) VALUES('child_new','house_1','New','new','',?,?)").run(now, now), /household_capacity_restricted|household_child_limit_reached/);
  database.prepare("DELETE FROM child_profiles WHERE id='child_4'").run();
  const afterDelete=database.prepare("SELECT state,exceeded_json FROM household_capacity_projection WHERE household_id='house_1'").get();
  assert.equal(afterDelete.state,"restricted");assert.deepEqual(JSON.parse(afterDelete.exceeded_json),["children"]);
  for (let index = 2; index < 4; index += 1) database.prepare("UPDATE child_profiles SET archived_at=?,updated_at=? WHERE id=?").run(now, now, `child_${index}`);
  const remediated=database.prepare("SELECT state,exceeded_json FROM household_capacity_projection WHERE household_id='house_1'").get();assert.equal(remediated.state,"within_limit");assert.equal(remediated.exceeded_json,"[]");
  assert.throws(() => database.prepare("UPDATE household_capacity_projection SET state='within_limit' WHERE household_id='house_1'").run(), /cannot modify household_capacity_projection because it is a view/);
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
  assert.equal(calls.length,1);assert.match(calls[0],/household_capacity_projection/);assert.doesNotMatch(calls[0],/household_capacity_state/);
});

test("NearFamily summary rejects missing and non-Family effective entitlements",async()=>{
  for(const row of [null,{plan_id:"nearyou_plus",state:"within_limit",exceeded_json:"[]",members:1,children:1,voices:1,storage_bytes:1,member_limit:2,child_limit:2,voice_limit:1,storage_limit:5_000_000_000}]){
    const db={prepare(){return{bind(){return{first:async()=>row}}}}};
    await assert.rejects(()=>createNearFamilySummaryService(db)("house_1"),/NearFamily entitlement required/);
  }
});

test("restriction in one dimension blocks growth in every other capacity dimension",()=>{
  const database=familyDatabase(),now=Date.now();
  database.prepare("UPDATE entitlements SET plan_id='nearyou_plus',updated_at=updated_at+1 WHERE id='grant_1'").run();
  assert.equal(database.prepare("SELECT state FROM household_capacity_projection WHERE household_id='house_1'").get().state,"restricted");
  database.prepare("INSERT INTO users(id,email,subscription_status,credits_remaining,created_at,updated_at) VALUES('adult_2','two@example.test','active',1,?,?)").run(now,now);
  assert.throws(()=>database.prepare("INSERT INTO household_invitations(id,household_id,invited_by_user_id,invited_email,role,status,token_hash,expires_at,created_at,updated_at) VALUES('invite_1','house_1','adult_1','two@example.test','adult_manager','pending','token',?,?,?)").run(now+60_000,now,now),/household_capacity_restricted/);
  assert.throws(()=>database.prepare("INSERT INTO voices(id,user_id,household_id,provider_voice_id,name,status,consent_attested_at,created_at) VALUES('voice_1','adult_1','house_1','provider_1','One','processing',?,?)").run(now,now),/household_capacity_restricted/);
  database.prepare("INSERT INTO media_assets(id,household_id,owner_user_id,kind,status,storage_key,content_type,byte_size,private,created_at,updated_at) VALUES('media_1','house_1','adult_1','narration','processing','private/media-1','audio/mpeg',1000,1,?,?)").run(now,now);
  assert.throws(()=>database.prepare("INSERT INTO household_storage_reservations(id,household_id,media_asset_id,byte_size,status,created_at,updated_at) VALUES('storage_1','house_1','media_1',1000,'reserved',?,?)").run(now,now),/household_capacity_restricted/);
});

test("canonical entitlement tie-break and clock expiry drive projection without persisted refresh",async()=>{
  const database=familyDatabase(),now=Date.now();
  database.prepare("UPDATE entitlements SET valid_until=?,updated_at=? WHERE id='grant_1'").run(now+80,now);
  database.prepare("INSERT INTO entitlements(id,household_id,plan_id,source,status,allowance_milliunits,remaining_milliunits,valid_from,created_at,updated_at) VALUES('grant_0','house_1','nearyou_plus','manual','active',120000,120000,?,?,?)").run(now-1000,now,now);
  assert.equal(database.prepare("SELECT plan_id FROM household_capacity_projection WHERE household_id='house_1'").get().plan_id,"nearyou_family");
  await new Promise(resolve=>setTimeout(resolve,120));
  const expired=database.prepare("SELECT plan_id,state,exceeded_json FROM household_capacity_projection WHERE household_id='house_1'").get();
  assert.equal(expired.plan_id,"nearyou_plus");assert.equal(expired.state,"restricted");assert.deepEqual(JSON.parse(expired.exceeded_json),["children"]);
  assert.throws(()=>database.prepare("INSERT INTO child_profiles(id,household_id,nickname,normalized_nickname,pronunciation,created_at,updated_at) VALUES('child_after_expiry','house_1','After','after','',?,?)").run(now,now),/household_capacity_restricted|household_child_limit_reached/);
});

test("counted household records cannot bypass capacity by tenant reassignment",()=>{
  const database=familyDatabase(),now=Date.now();
  database.prepare("INSERT INTO users(id,email,subscription_status,credits_remaining,created_at,updated_at) VALUES('adult_2','two@example.test','active',1,?,?)").run(now,now);
  database.prepare("INSERT INTO households(id,name,owner_user_id,created_at,updated_at) VALUES('house_2','Two','adult_2',?,?)").run(now,now);
  database.prepare("INSERT INTO household_members(id,household_id,user_id,role,status,created_at,updated_at) VALUES('member_2','house_2','adult_2','owner','active',?,?)").run(now,now);
  database.prepare("INSERT INTO entitlements(id,household_id,plan_id,source,status,allowance_milliunits,remaining_milliunits,valid_from,created_at,updated_at) VALUES('grant_2','house_2','nearyou_family','manual','active',120000,120000,?,?,?)").run(now-1000,now,now);
  database.prepare("INSERT INTO child_profiles(id,household_id,nickname,normalized_nickname,pronunciation,created_at,updated_at) VALUES('child_other','house_2','Other','other','',?,?)").run(now,now);
  database.prepare("INSERT INTO household_invitations(id,household_id,invited_by_user_id,invited_email,role,status,token_hash,expires_at,created_at,updated_at) VALUES('invite_other','house_2','adult_2','invite@example.test','listener','pending','token-other',?,?,?)").run(now+60_000,now,now);
  database.prepare("UPDATE entitlements SET plan_id='nearyou_plus',updated_at=updated_at+1 WHERE id='grant_1'").run();
  for(const statement of [
    "UPDATE child_profiles SET household_id='house_1' WHERE id='child_other'",
    "UPDATE household_members SET household_id='house_1' WHERE id='member_2'",
    "UPDATE household_invitations SET household_id='house_1' WHERE id='invite_other'",
  ])assert.throws(()=>database.exec(statement),/household_binding_immutable/);
  assert.equal(database.prepare("SELECT children FROM household_capacity_projection WHERE household_id='house_1'").get().children,5);
});
