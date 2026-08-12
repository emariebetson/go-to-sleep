import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { decryptWaitlistEmail, emailLookupHash, encryptWaitlistEmail, normalizeWaitlistInput } from "../lib/marketing-waitlist.ts";

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
});
