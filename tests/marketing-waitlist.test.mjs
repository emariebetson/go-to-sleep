import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { decryptWaitlistEmail, emailLookupHash, encryptWaitlistEmail, normalizeWaitlistInput, recordWaitlistSignup } from "../lib/marketing-waitlist.ts";

class Bound {
  constructor(database, sql, values = []) { this.database = database; this.sql = sql; this.values = values; }
  bind(...values) { return new Bound(this.database, this.sql, values); }
  async run() { return this.database.prepare(this.sql).run(...this.values); }
  async first() { return this.database.prepare(this.sql).get(...this.values) ?? null; }
}
class D1 {
  constructor(database, loseAtBatch = 0) { this.database = database; this.loseAtBatch = loseAtBatch; this.batchCount = 0; }
  prepare(sql) { return new Bound(this.database, sql); }
  async batch(statements) {
    this.batchCount += 1;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = [];
      for (const statement of statements) result.push(await statement.run());
      this.database.exec("COMMIT");
      if (this.batchCount === this.loseAtBatch) throw new Error("lost response");
      return result;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

class FirstReadBarrierD1 extends D1 {
  constructor(database) { super(database); this.reads = 0; this.release = null; this.barrier = new Promise((resolve) => { this.release = resolve; }); this.batchTail = Promise.resolve(); }
  prepare(sql) {
    const bound = super.prepare(sql);
    if (!sql.startsWith("SELECT error_code marker")) return bound;
    const originalFirst = bound.first.bind(bound);
    bound.first = async () => {
      this.reads += 1;
      if (this.reads === 2) this.release();
      await this.barrier;
      return originalFirst();
    };
    return bound;
  }
  async batch(statements) {
    const prior = this.batchTail;
    let release;
    this.batchTail = new Promise((resolve) => { release = resolve; });
    await prior;
    try { return await super.batch(statements); } finally { release(); }
  }
}

test("waitlist input is bounded and product allowlisted", () => {
  assert.deepEqual(normalizeWaitlistInput({ email: "  Parent@Example.COM ", products: ["nearstory", "nearfamily"], source: "home", consent: true, consentVersion: "marketing-consent-v1" }), {
    email: "parent@example.com", products: ["nearstory", "nearfamily"], source: "home", consentVersion: "marketing-consent-v1",
  });
  assert.throws(() => normalizeWaitlistInput({ email: "bad", products: ["nearstory"], source: "home", consent: true, consentVersion: "marketing-consent-v1" }));
  assert.throws(() => normalizeWaitlistInput({ email: "a@b.com", products: ["nearsleep"], source: "home", consent: true, consentVersion: "marketing-consent-v1" }));
  assert.throws(() => normalizeWaitlistInput({ email: "a@b.com", products: ["nearstory"], source: "home", consent: false, consentVersion: "marketing-consent-v1" }));
});

test("email is encrypted and addressed by a keyed lookup hash", async () => {
  const key = "11".repeat(32);
  const lookup = await emailLookupHash("parent@example.com", key);
  assert.match(lookup, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(lookup, /parent/);
  const sealed = await encryptWaitlistEmail("Parent@example.com", key);
  assert.equal(await decryptWaitlistEmail(sealed, key), "Parent@example.com");
  await assert.rejects(() => decryptWaitlistEmail(sealed, "22".repeat(32)));
});

test("0016 creates additive authoritative contacts, interests, and sync outbox", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON");
  for (let index = 0; index <= 16; index += 1) {
    const journal = JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
    const tag = journal.entries.find((entry) => entry.idx === index)?.tag;
    assert.ok(tag, `journal ${index}`);
    const sql = readFileSync(new URL(`../drizzle/${tag}.sql`, import.meta.url), "utf8");
    for (const statement of sql.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) database.exec(statement);
  }
  for (const table of ["marketing_waitlist_contacts", "marketing_waitlist_interests", "marketing_waitlist_sync"]) assert.equal(database.prepare("SELECT count(*) count FROM sqlite_master WHERE type='table' AND name=?").get(table).count, 1);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  const repeat = readFileSync(new URL("../drizzle/0016_marketing_waitlist.sql", import.meta.url), "utf8");
  for (const statement of repeat.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) database.exec(statement);
  assert.equal(database.prepare("SELECT count(*) count FROM marketing_waitlist_contacts").get().count, 0);
});

test("waitlist request replay is immutable, convergent, and rejects changed payload reuse", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON");
  const d1 = new D1(database);
  const key = "11".repeat(32);
  const requestId = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
  const input = normalizeWaitlistInput({ email: "parent@example.com", products: ["nearstory", "nearfamily"], source: "home", consent: true, consentVersion: "marketing-consent-v1" });

  await recordWaitlistSignup(d1, input, key, requestId);
  const before = database.prepare("SELECT version,email_ciphertext FROM marketing_waitlist_contacts").get();
  await recordWaitlistSignup(d1, input, key, requestId);
  assert.deepEqual(database.prepare("SELECT version,email_ciphertext FROM marketing_waitlist_contacts").get(), before);
  assert.equal(database.prepare("SELECT count(*) count FROM marketing_waitlist_sync").get().count, 1);
  assert.equal(database.prepare("SELECT count(*) count FROM marketing_waitlist_interests").get().count, 2);

  await assert.rejects(() => recordWaitlistSignup(d1, { ...input, products: ["nearlegacy"] }, key, requestId), /idempotency_conflict/);
});

test("waitlist committed-lost response reloads the exact immutable replay", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON");
  const d1 = new D1(database);
  const key = "22".repeat(32);
  const requestId = "6ba7b811-9dad-41d1-80b4-00c04fd430c8";
  const input = normalizeWaitlistInput({ email: "parent@example.com", products: ["nearstory"], source: "nearstory", consent: true, consentVersion: "marketing-consent-v1" });
  await d1.batch([
    d1.prepare("CREATE TABLE marketing_waitlist_contacts (id TEXT PRIMARY KEY NOT NULL,email_lookup_hash TEXT NOT NULL UNIQUE,email_ciphertext TEXT NOT NULL,email_iv TEXT NOT NULL,consent_version TEXT NOT NULL,consented_at INTEGER NOT NULL,unsubscribed_at INTEGER,version INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
    d1.prepare("CREATE TABLE marketing_waitlist_interests (id TEXT PRIMARY KEY NOT NULL,contact_id TEXT NOT NULL REFERENCES marketing_waitlist_contacts(id) ON DELETE CASCADE,product TEXT NOT NULL,signup_source TEXT NOT NULL,joined_at INTEGER NOT NULL,UNIQUE(contact_id,product))"),
    d1.prepare("CREATE TABLE marketing_waitlist_sync (id TEXT PRIMARY KEY NOT NULL,contact_id TEXT NOT NULL REFERENCES marketing_waitlist_contacts(id) ON DELETE CASCADE,contact_version INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempt_token TEXT,lease_expires_at INTEGER,attempt_count INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER,error_code TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(contact_id,contact_version))"),
  ]);
  d1.loseAtBatch = 3;
  assert.deepEqual(await recordWaitlistSignup(d1, input, key, requestId), { products: ["nearstory"], replayed: true });
  assert.equal(database.prepare("SELECT count(*) count FROM marketing_waitlist_contacts").get().count, 1);
  assert.equal(database.prepare("SELECT count(*) count FROM marketing_waitlist_sync").get().count, 1);
});

test("concurrent first use converges and conflicting payload leaves no orphan contact", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON");
  const setup = new D1(database);
  const key = "33".repeat(32);
  const requestId = "6ba7b812-9dad-41d1-80b4-00c04fd430c8";
  const first = normalizeWaitlistInput({ email: "first@example.com", products: ["nearstory"], source: "nearstory", consent: true, consentVersion: "marketing-consent-v1" });
  const second = normalizeWaitlistInput({ email: "second@example.com", products: ["nearfamily"], source: "nearfamily", consent: true, consentVersion: "marketing-consent-v1" });
  await recordWaitlistSignup(setup, first, key, crypto.randomUUID());
  database.exec("DELETE FROM marketing_waitlist_sync; DELETE FROM marketing_waitlist_interests; DELETE FROM marketing_waitlist_contacts;");

  const d1 = new FirstReadBarrierD1(database);
  const results = await Promise.allSettled([recordWaitlistSignup(d1, first, key, requestId), recordWaitlistSignup(d1, second, key, requestId)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected" && /idempotency_conflict/.test(result.reason?.message)).length, 1);
  assert.equal(database.prepare("SELECT count(*) count FROM marketing_waitlist_contacts").get().count, 1);
  assert.equal(database.prepare("SELECT count(*) count FROM marketing_waitlist_contacts WHERE version=0").get().count, 0);
});

test("concurrent identical first use returns one creation and one replay", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON");
  const setup = new D1(database);
  const key = "44".repeat(32);
  const requestId = "6ba7b813-9dad-41d1-80b4-00c04fd430c8";
  const input = normalizeWaitlistInput({ email: "parent@example.com", products: ["nearlegacy"], source: "nearlegacy", consent: true, consentVersion: "marketing-consent-v1" });
  await recordWaitlistSignup(setup, input, key, crypto.randomUUID());
  database.exec("DELETE FROM marketing_waitlist_sync; DELETE FROM marketing_waitlist_interests; DELETE FROM marketing_waitlist_contacts;");

  const d1 = new FirstReadBarrierD1(database);
  const results = await Promise.all([recordWaitlistSignup(d1, input, key, requestId), recordWaitlistSignup(d1, input, key, requestId)]);
  assert.deepEqual(results.map((result) => result.replayed).sort(), [false, true]);
  assert.equal(database.prepare("SELECT count(*) count FROM marketing_waitlist_contacts").get().count, 1);
  assert.equal(database.prepare("SELECT count(*) count FROM marketing_waitlist_sync").get().count, 1);
});
