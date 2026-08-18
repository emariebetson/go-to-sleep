import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { upsertLegacyChildProfile } from "../lib/legacy-child-profile.ts";
import * as legacyEntitlementBootstrap from "../lib/legacy-entitlement-bootstrap.ts";
import { createLegacyVoice } from "../lib/legacy-voice-insert.ts";
import { loadStudioBootstrap } from "../lib/studio-bootstrap.ts";

const migrations = [
  "0000_nearnight_foundation.sql",
  "0001_google_apple_auth.sql",
  "0002_sharp_shinobi_shaw.sql",
  "0003_white_groot.sql",
  "0004_salty_sugar_man.sql",
  "0005_pronunciation_frequency_layers.sql",
  "0006_nearyou_shared_foundation.sql",
];

function applyMigration(database, name) {
  const source = readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
  for (const statement of source.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) database.exec(statement);
}

class D1Fixture {
  constructor(database) {
    this.database = database;
    this.batchCalls = 0;
  }

  prepare(query) {
    return {
      bind: (...parameters) => ({
        run: async () => {
          const result = this.database.prepare(query).run(...parameters);
          return { success: true, meta: { changes: result.changes } };
        },
        all: async () => ({ success: true, results: this.database.prepare(query).all(...parameters) }),
      }),
    };
  }

  async batch(statements) {
    this.batchCalls += 1;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function legacyFixture() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of migrations) applyMigration(database, migration);
  database.exec(`
    INSERT INTO users (id, email, display_name, subscription_status, credits_remaining, created_at, updated_at)
    VALUES ('new-user', 'new-user@example.com', 'New user', 'free', 1, 1700000000000, 1700000000000);
    INSERT INTO households (id, name, owner_user_id, created_at, updated_at)
    VALUES ('household:new-user', 'New user''s household', 'new-user', 1700000000000, 1700000000000);
  `);
  return { database, db: new D1Fixture(database) };
}

test("legacy free entitlement bootstrap writes only pre-0011 entitlement columns", async () => {
  const { database, db } = legacyFixture();
  assert.equal(database.prepare("SELECT count(*) AS count FROM pragma_table_info('entitlements') WHERE name = 'billing_period_start'").get().count, 0);

  const input = { id: "entitlement:legacy:new-user", householdId: "household:new-user", now: new Date(1700000000000) };
  await legacyEntitlementBootstrap.createLegacyFreeEntitlement(db, input);
  await legacyEntitlementBootstrap.createLegacyFreeEntitlement(db, input);

  assert.deepEqual({ ...database.prepare(`SELECT id, household_id, plan_id, source, status, allowance_milliunits, remaining_milliunits, legacy_credits_remaining
    FROM entitlements WHERE id = ?`).get(input.id) }, {
    id: "entitlement:legacy:new-user",
    household_id: "household:new-user",
    plan_id: "nearsleep_free",
    source: "legacy",
    status: "active",
    allowance_milliunits: 3000,
    remaining_milliunits: 3000,
    legacy_credits_remaining: 3,
  });
  assert.equal(database.prepare("SELECT count(*) AS count FROM entitlements WHERE id = ?").get(input.id).count, 1);
});

test("existing free accounts receive exactly two additional lifetime credits once", async () => {
  const { database, db } = legacyFixture();
  const grant = legacyEntitlementBootstrap.grantLegacyFreeGenerationCredits;
  assert.equal(typeof grant, "function", "the idempotent free-credit grant must exist");
  if (typeof grant !== "function") return;
  await legacyEntitlementBootstrap.createLegacyFreeEntitlement(db, {
    id: "entitlement:legacy:new-user",
    householdId: "household:new-user",
    now: new Date(1700000000000),
  });
  database.prepare("UPDATE users SET credits_remaining = 0 WHERE id = 'new-user'").run();
  database.prepare("UPDATE entitlements SET allowance_milliunits = 1000, remaining_milliunits = 0, legacy_credits_remaining = 0 WHERE id = 'entitlement:legacy:new-user'").run();

  const input = { userId: "new-user", householdId: "household:new-user", entitlementId: "entitlement:legacy:new-user", now: new Date(1700000001000) };
  await grant(db, input);
  await grant(db, { ...input, now: new Date(1700000002000) });

  assert.equal(database.prepare("SELECT credits_remaining value FROM users WHERE id = 'new-user'").get().value, 2);
  assert.deepEqual({ ...database.prepare("SELECT allowance_milliunits, remaining_milliunits, legacy_credits_remaining FROM entitlements WHERE id = 'entitlement:legacy:new-user'").get() }, {
    allowance_milliunits: 3000,
    remaining_milliunits: 2000,
    legacy_credits_remaining: 2,
  });
  assert.equal(database.prepare("SELECT count(*) value FROM usage_events WHERE type = 'free_generation_credit_grant'").get().value, 1);
});

test("paid accounts skip the free-credit write batch", async () => {
  const { database, db } = legacyFixture();
  database.prepare("UPDATE users SET subscription_status = 'active' WHERE id = 'new-user'").run();
  const grant = legacyEntitlementBootstrap.grantLegacyFreeGenerationCredits;
  assert.equal(typeof grant, "function");
  if (typeof grant !== "function") return;
  await grant(db, { userId: "new-user", householdId: "household:new-user", entitlementId: "entitlement:legacy:new-user", now: new Date(1700000001000) });
  assert.equal(db.batchCalls, 0);
});

test("legacy voice insert writes only pre-0011 voice columns", async () => {
  const { database, db } = legacyFixture();
  assert.equal(database.prepare("SELECT count(*) AS count FROM pragma_table_info('voices') WHERE name = 'creation_request_id'").get().count, 0);

  await createLegacyVoice(db, {
    id: "voice:legacy:new-user",
    userId: "new-user",
    householdId: "household:new-user",
    providerVoiceId: "elevenlabs-voice-1",
    name: "Parent voice",
    status: "ready",
    consentAttestedAt: new Date(1700000000000),
    createdAt: new Date(1700000000000),
  });

  assert.deepEqual({ ...database.prepare(`SELECT id, user_id, household_id, current_consent_id, provider_voice_id, name, status, consent_attested_at, created_at, deleted_at
    FROM voices WHERE id = ?`).get("voice:legacy:new-user") }, {
    id: "voice:legacy:new-user",
    user_id: "new-user",
    household_id: "household:new-user",
    current_consent_id: null,
    provider_voice_id: "elevenlabs-voice-1",
    name: "Parent voice",
    status: "ready",
    consent_attested_at: 1700000000000,
    created_at: 1700000000000,
    deleted_at: null,
  });
});

test("legacy session save upserts child profiles without the post-0006 pronunciation column", async () => {
  const { database, db } = legacyFixture();
  assert.equal(database.prepare("SELECT count(*) AS count FROM pragma_table_info('child_profiles') WHERE name = 'pronunciation'").get().count, 0);
  database.prepare(`INSERT INTO children
    (id, user_id, household_id, nickname, normalized_nickname, pronunciation, age_months, bedtime_challenge, created_at, updated_at)
    VALUES ('child-1', 'new-user', 'household:new-user', 'Lachlan', 'lachlan', 'LOCK-lin', 48, 'settling', 1700000000000, 1700000000000)`).run();

  await upsertLegacyChildProfile(db, {
    id: "child-profile:child-1",
    householdId: "household:new-user",
    legacyChildId: "child-1",
    nickname: "Lachlan",
    normalizedNickname: "lachlan",
    ageMonths: 48,
    bedtimeChallenge: "settling",
    now: new Date(1700000000000),
  });
  await upsertLegacyChildProfile(db, {
    id: "child-profile:replacement-id",
    householdId: "household:new-user",
    legacyChildId: "child-1",
    nickname: "Lachlan B.",
    normalizedNickname: "lachlan",
    ageMonths: 49,
    bedtimeChallenge: "night waking",
    now: new Date(1700000001000),
  });

  assert.deepEqual({ ...database.prepare(`SELECT id, household_id, legacy_child_id, nickname, normalized_nickname,
      age_months, bedtime_challenge, created_at, updated_at
    FROM child_profiles WHERE household_id = 'household:new-user' AND normalized_nickname = 'lachlan'`).get() }, {
    id: "child-profile:child-1",
    household_id: "household:new-user",
    legacy_child_id: "child-1",
    nickname: "Lachlan B.",
    normalized_nickname: "lachlan",
    age_months: 49,
    bedtime_challenge: "night waking",
    created_at: 1700000000000,
    updated_at: 1700000001000,
  });
});

test("Studio bootstrap requests production-only endpoints only in production mode", async () => {
  const calls = [];
  const fetcher = async (input) => {
    calls.push(String(input));
    return Response.json({ endpoint: input });
  };

  const legacy = await loadStudioBootstrap(false, fetcher);
  assert.deepEqual(calls, ["/api/voices"]);
  assert.equal(legacy.onboarding, null);
  assert.equal(legacy.children, null);
  assert.equal(legacy.voices.ok, true);

  calls.length = 0;
  const production = await loadStudioBootstrap(true, fetcher);
  assert.deepEqual(calls, ["/api/onboarding", "/api/v1/children", "/api/voices"]);
  assert.equal(production.onboarding?.ok, true);
  assert.equal(production.children?.ok, true);
  assert.equal(production.voices.ok, true);
});
