import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("global 404 uses the umbrella identity and keeps session-aware My Nights behavior", () => {
  const page = readFileSync(new URL("../app/not-found.tsx", import.meta.url), "utf8");
  assert.match(page, /404 · A little farther than near/);
  assert.match(page, /This page isn&apos;t here\. We still are\./);
  assert.match(page, /Nothing was changed or deleted\./);
  assert.match(page, /href="\/nearsleep"/);
  assert.match(page, /href="\/">Return to NearYou Still<\/Link>/);
  assert.match(page, /myNightsHref\(user\)/);
});
