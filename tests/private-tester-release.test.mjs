import assert from "node:assert/strict";
import test from "node:test";
import { parsePrivateTesterRelease } from "../lib/private-tester-release.ts";

const now = Date.parse("2026-08-14T18:00:00.000Z");
const release = () => ({
  releaseId: "rel_20260814_private_01",
  commitSha: "a".repeat(40),
  sitesVersion: "appgprj_example~appgver_example",
  startsAt: "2026-08-14T18:00:00.000Z",
  expiresAt: "2026-08-21T18:00:00.000Z",
  products: ["nearfamily", "nearstory"],
});

test("accepts one exact seven-day NearFamily-then-NearStory release", () => {
  const value = parsePrivateTesterRelease(release(), now);
  assert.deepEqual(value.products, ["nearfamily", "nearstory"]);
});

test("rejects a release whose product order is not NearFamily then NearStory", () => {
  assert.throws(() => parsePrivateTesterRelease({ ...release(), products: ["nearstory", "nearfamily"] }, now), /release invalid/);
});

test("rejects a release window that is not exactly seven days", () => {
  assert.throws(() => parsePrivateTesterRelease({ ...release(), expiresAt: "2026-08-21T17:59:59.999Z" }, now), /release invalid/);
});

test("rejects a commit SHA that is not exactly 40 lowercase hexadecimal characters", () => {
  assert.throws(() => parsePrivateTesterRelease({ ...release(), commitSha: "A".repeat(40) }, now), /release invalid/);
});

test("rejects unknown release properties", () => {
  assert.throws(() => parsePrivateTesterRelease({ ...release(), unexpected: true }, now), /release invalid/);
});

test("rejects a non-enumerable unknown release property", () => {
  const input = release();
  Object.defineProperty(input, "unexpected", { value: true });
  assert.throws(() => parsePrivateTesterRelease(input, now), /release invalid/);
});

test("rejects symbol release properties", () => {
  const input = release();
  input[Symbol("unexpected")] = true;
  assert.throws(() => parsePrivateTesterRelease(input, now), /release invalid/);
});

test("rejects accessor release properties", () => {
  const input = release();
  Object.defineProperty(input, "releaseId", { enumerable: true, get: () => "rel_20260814_private_01" });
  assert.throws(() => parsePrivateTesterRelease(input, now), /release invalid/);
});

test("rejects a start more than five minutes before the current time", () => {
  assert.throws(() => parsePrivateTesterRelease({ ...release(), startsAt: "2026-08-14T17:54:59.999Z", expiresAt: "2026-08-21T17:54:59.999Z" }, now), /release invalid/);
});

test("rejects an expiry beyond seven days from the current time", () => {
  assert.throws(() => parsePrivateTesterRelease({ ...release(), startsAt: "2026-08-14T18:00:00.001Z", expiresAt: "2026-08-21T18:00:00.001Z" }, now), /release invalid/);
});
