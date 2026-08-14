import assert from "node:assert/strict";
import test from "node:test";

import { canonicalRedirect } from "../lib/canonical-host.ts";

test("canonical redirects preserve page paths and only approved campaign fields", () => {
  const response = canonicalRedirect(new Request("https://www.nearyoustill.com/nearstory?utm_source=launch&utm_campaign=fall&code=secret&state=secret&returnTo=%2Flibrary"), true);
  assert.equal(response?.status, 308);
  assert.equal(response?.headers.get("location"), "https://nearyoustill.com/nearstory?utm_source=launch&utm_campaign=fall&returnTo=%2Flibrary");
});

test("the former host drains pages but never redirects authentication, APIs, assets, or mutations", () => {
  assert.equal(canonicalRedirect(new Request("https://nearnight.ebetson.chatgpt.site/nearsleep"), true)?.headers.get("location"), "https://nearyoustill.com/nearsleep");
  for (const request of [
    new Request("https://nearnight.ebetson.chatgpt.site/api/auth/callback/google?code=private&state=private"),
    new Request("https://nearnight.ebetson.chatgpt.site/api/v1/marketing/waitlist"),
    new Request("https://nearnight.ebetson.chatgpt.site/api"),
    new Request("https://nearnight.ebetson.chatgpt.site/auth/callback"),
    new Request("https://nearnight.ebetson.chatgpt.site/sign-in"),
    new Request("https://nearnight.ebetson.chatgpt.site/_next/static/chunk.js"),
    new Request("https://nearnight.ebetson.chatgpt.site/og.png"),
    new Request("https://nearnight.ebetson.chatgpt.site/og-nearyoustill.png"),
    new Request("https://nearnight.ebetson.chatgpt.site/nearsleep", { method: "POST" }),
  ]) assert.equal(canonicalRedirect(request, true), null);
});

test("canonical redirects scrub sensitive fields nested inside safe return paths", () => {
  const response = canonicalRedirect(new Request("https://www.nearyoustill.com/nearsleep?returnTo=%2Flibrary%3Futm_source%3Dlaunch%26token%3Dprivate%26code%3Doauth%26state%3Dprivate"), true);
  assert.equal(response?.headers.get("location"), "https://nearyoustill.com/nearsleep?returnTo=%2Flibrary%3Futm_source%3Dlaunch");
});

test("canonical redirect is an exact default-off host boundary", () => {
  assert.equal(canonicalRedirect(new Request("https://www.nearyoustill.com/nearsleep"), false), null);
  assert.equal(canonicalRedirect(new Request("http://localhost:3000/nearsleep"), true), null);
  assert.equal(canonicalRedirect(new Request("https://attacker.example/nearsleep"), true), null);
});
