import test from "node:test";
import assert from "node:assert/strict";
import { parseByteRange } from "../lib/http-range.ts";

test("parses bounded, open-ended, and suffix byte ranges", () => {
  assert.deepEqual(parseByteRange("bytes=10-19", 100), { start: 10, end: 19 });
  assert.deepEqual(parseByteRange("bytes=90-", 100), { start: 90, end: 99 });
  assert.deepEqual(parseByteRange("bytes=-12", 100), { start: 88, end: 99 });
});

test("rejects invalid, multiple, and unsatisfiable byte ranges", () => {
  for (const value of ["bytes=100-", "bytes=20-10", "bytes=0-1,4-5", "items=0-2", "bytes=-0"]) {
    assert.equal(parseByteRange(value, 100), "unsatisfiable", value);
  }
});

test("returns null when no byte range was requested", () => {
  assert.equal(parseByteRange(null, 100), null);
});
