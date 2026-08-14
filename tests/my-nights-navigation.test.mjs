import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mock, test } from "node:test";

mock.module("@/lib/auth", {
  exports: {
    signInPath(returnTo) {
      return `/sign-in?returnTo=${encodeURIComponent(returnTo)}`;
    },
  },
});

test("My nights opens the private dashboard for an authenticated user", async () => {
  const { myNightsHref } = await import("../lib/my-nights-navigation.ts");
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

test("My nights sends an unauthenticated user through sign in and back to the library", async () => {
  const { myNightsHref } = await import("../lib/my-nights-navigation.ts");
  assert.equal(myNightsHref(null), "/sign-in?returnTo=%2Flibrary");
});

test("SiteHeader resolves My nights from the current session", () => {
  const source = readFileSync(new URL("../components/SiteHeader.tsx", import.meta.url), "utf8");
  assert.match(source, /import\s+\{\s*getAppUser\s*\}\s+from\s+["']@\/lib\/auth["']/);
  assert.match(source, /import\s+\{\s*myNightsHref\s*\}\s+from\s+["']@\/lib\/my-nights-navigation["']/);
  assert.match(source, /export\s+async\s+function\s+SiteHeader\s*\(\s*\)\s*\{[\s\S]*?await\s+getAppUser\s*\(\s*\)/);
  assert.match(source, /myNightsHref\s*\(\s*user\s*\)/);
  assert.match(source, /<Link\s+className="btn btn-secondary btn-small"\s+href=\{nightsHref\}>My nights<\/Link>/);
});
