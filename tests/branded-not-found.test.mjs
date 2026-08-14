import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("global 404 uses approved NearSleep copy and safe destinations", () => {
  const page = readFileSync(new URL("../app/not-found.tsx", import.meta.url), "utf8");
  assert.match(page, /404 · A quiet detour/);
  assert.match(page, /This page wandered off to sleep\./);
  assert.match(page, /Nothing was changed or deleted\./);
  assert.match(page, /href="\/studio"/);
  assert.match(page, /<Link className="btn btn-secondary" href="\/">Return home<\/Link>/);
  assert.match(page, /myNightsHref\(user\)/);
});
