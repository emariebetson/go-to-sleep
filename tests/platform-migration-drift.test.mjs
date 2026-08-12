import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("platform migration tables are represented in the Drizzle schema", () => {
  const schema = source("db/schema.ts");
  for (const name of ["mobile_entitlement_events", "mobile_account_bindings", "integration_rights_receipts", "encrypted_integration_tokens"]) {
    assert.match(schema, new RegExp(`sqliteTable\\(\\s*["']${name}["']`));
  }
});

test("a blank SQLite database applies 0000 through 0016 without foreign-key damage", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (let index = 0; index <= 16; index += 1) {
    const prefix = String(index).padStart(4, "0");
    const journal = JSON.parse(source("drizzle/meta/_journal.json"));
    const tag = journal.entries.find((entry) => entry.idx === index)?.tag;
    assert.ok(tag, `missing journal entry ${prefix}`);
    const migration = source(`drizzle/${tag}.sql`);
    for (const statement of migration.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) database.exec(statement);
  }
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  for (const table of ["mobile_entitlement_events", "mobile_account_bindings", "integration_rights_receipts", "encrypted_integration_tokens"]) {
    assert.equal(database.prepare("SELECT count(*) count FROM sqlite_master WHERE type='table' AND name=?").get(table).count, 1);
  }
});

test("Drizzle migration metadata tracks every migration through 0016", () => {
  const journal = JSON.parse(source("drizzle/meta/_journal.json"));
  assert.deepEqual(journal.entries.slice(-4).map((entry) => entry.tag), [
    "0013_nearstory_parent_beta",
    "0014_nearlegacy_archive",
    "0015_platform_release_foundation",
    "0016_marketing_waitlist",
  ]);
  for (const index of [13, 14, 15, 16]) {
    const snapshot = JSON.parse(source(`drizzle/meta/${String(index).padStart(4, "0")}_snapshot.json`));
    assert.equal(snapshot.dialect, "sqlite");
  }
});
