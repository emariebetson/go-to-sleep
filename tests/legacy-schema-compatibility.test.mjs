import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createLegacyFreeEntitlement } from "../lib/legacy-entitlement-bootstrap.ts";
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
  }

  prepare(query) {
    return {
      bind: (...parameters) => ({
        run: async () => {
          const result = this.database.prepare(query).run(...parameters);
          return { success: true, meta: { changes: result.changes } };
        },
      }),
    };
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
  await createLegacyFreeEntitlement(db, input);
  await createLegacyFreeEntitlement(db, input);

  assert.deepEqual({ ...database.prepare(`SELECT id, household_id, plan_id, source, status, allowance_milliunits, remaining_milliunits, legacy_credits_remaining
    FROM entitlements WHERE id = ?`).get(input.id) }, {
    id: "entitlement:legacy:new-user",
    household_id: "household:new-user",
    plan_id: "nearsleep_free",
    source: "legacy",
    status: "active",
    allowance_milliunits: 1000,
    remaining_milliunits: 1000,
    legacy_credits_remaining: 1,
  });
  assert.equal(database.prepare("SELECT count(*) AS count FROM entitlements WHERE id = ?").get(input.id).count, 1);
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
