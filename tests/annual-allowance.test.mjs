import assert from "node:assert/strict";
import test from "node:test";
import { annualAllowanceBoundary } from "../lib/annual-allowance-core.ts";

test("annual subscriptions refill on calendar-month boundaries without date drift", () => {
  const january31 = Date.UTC(2026, 0, 31, 12) / 1000;
  const february = annualAllowanceBoundary(january31);
  assert.equal(new Date(february * 1000).toISOString(), "2026-02-28T12:00:00.000Z");
  assert.equal(new Date(annualAllowanceBoundary(february, january31) * 1000).toISOString(), "2026-03-31T12:00:00.000Z");
  assert.throws(() => annualAllowanceBoundary(0), /invalid/);
});
