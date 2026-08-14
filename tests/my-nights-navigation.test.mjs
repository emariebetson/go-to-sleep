import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { safeRelativeReturnPath, signInPath } from "../lib/auth-navigation.ts";
import { myNightsHref } from "../lib/my-nights-navigation.ts";

test("My nights opens the private dashboard for an authenticated user", () => {
  assert.equal(
    myNightsHref({
      userId: "u",
      email: "p@example.test",
      displayName: "Parent",
      fullName: "Parent",
    }),
    "/library",
  );
});

test("My nights sends an unauthenticated user through sign in and back to the library", () => {
  assert.equal(myNightsHref(null), "/sign-in?returnTo=%2Flibrary");
});

test("sign-in navigation preserves safe relative destinations and rejects auth or external destinations", () => {
  assert.equal(signInPath("/pricing?plan=plus#checkout"), "/sign-in?returnTo=%2Fpricing%3Fplan%3Dplus%23checkout");
  assert.equal(safeRelativeReturnPath("https://attacker.example/library"), "/studio");
  assert.equal(safeRelativeReturnPath("//attacker.example/library"), "/studio");
  assert.equal(safeRelativeReturnPath("/api/auth/callback/google"), "/studio");
  assert.equal(safeRelativeReturnPath("/sign-in"), "/studio");
});

test("SiteHeader resolves My nights from the current session", () => {
  const source = readFileSync(new URL("../components/SiteHeader.tsx", import.meta.url), "utf8");
  assert.match(source, /import\s+\{\s*getAppUser\s*\}\s+from\s+["']@\/lib\/auth["']/);
  assert.match(source, /import\s+\{\s*myNightsHref\s*\}\s+from\s+["']@\/lib\/my-nights-navigation["']/);
  assert.match(source, /export\s+async\s+function\s+SiteHeader\s*\(\s*\)\s*\{[\s\S]*?await\s+getAppUser\s*\(\s*\)/);
  assert.match(source, /myNightsHref\s*\(\s*user\s*\)/);
  assert.match(source, /<Link\s+className="btn btn-secondary btn-small"\s+href=\{nightsHref\}>My nights<\/Link>/);
});
