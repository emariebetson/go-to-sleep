import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("public waitlist route is bounded, same-origin, encrypted, and atomically outboxed", async () => {
  const source = await readFile(new URL("../app/api/v1/marketing/waitlist/route.ts", import.meta.url), "utf8");
  const service = await readFile(new URL("../lib/marketing-waitlist.ts", import.meta.url), "utf8");
  assert.match(source, /assertTrustedMutationOrigin\(request\)/);
  assert.match(source, /idempotency-key/);
  assert.match(source, /recordWaitlistSignup/);
  assert.match(source, /readJsonObject\(request, 4_096\)/);
  assert.match(source, /normalizeWaitlistInput/);
  assert.match(service, /emailLookupHash/);
  assert.match(service, /encryptWaitlistEmail/);
  assert.match(service, /marketing_waitlist_sync/);
  assert.match(service, /database\.batch/);
  assert.match(service, /ensureMarketingWaitlistSchema/);
  assert.doesNotMatch(source, /console\.(log|error)\([^)]*email/);
});

test("sync route requires a bearer secret and uses fenced Google row updates", async () => {
  const route = await readFile(new URL("../app/api/internal/marketing-waitlist-sync/route.ts", import.meta.url), "utf8");
  const adapter = await readFile(new URL("../lib/marketing-waitlist-google.ts", import.meta.url), "utf8");
  assert.match(route, /authorization/);
  assert.match(route, /MARKETING_SYNC_SECRET/);
  assert.match(adapter, /attempt_token/);
  assert.match(adapter, /GOOGLE_WAITLIST_SHEET_ID/);
  assert.match(adapter, /hidden_contact_id/);
  assert.match(adapter, /spreadsheets\/.*values/);
});
