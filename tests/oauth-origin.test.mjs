import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { canonicalAuthRedirect } from "../lib/oauth-origin.ts";

test("auth requests from the Sites alias redirect before Better Auth creates state", () => {
  const response = canonicalAuthRedirect(new Request("https://nearnight.ebetson.chatgpt.site/api/auth/sign-in/social", { method: "POST" }), "https://nearyoustill.com");
  assert.equal(response?.status, 307);
  assert.equal(response?.headers.get("location"), "https://nearyoustill.com/api/auth/sign-in/social");
  assert.equal(response?.headers.get("cache-control"), "no-store");
});

test("canonical auth requests are handled without a redirect", () => {
  const response = canonicalAuthRedirect(new Request("https://nearyoustill.com/api/auth/callback/google?state=opaque"), "https://nearyoustill.com");
  assert.equal(response, null);
});

test("auth redirect never carries an alias origin or rewrites the callback path", () => {
  const response = canonicalAuthRedirect(new Request("https://www.nearyoustill.com/api/auth/callback/google?state=opaque&code=redacted"), "https://nearyoustill.com");
  assert.equal(response?.headers.get("location"), "https://nearyoustill.com/api/auth/callback/google?state=opaque&code=redacted");
});

test("the Better Auth route applies canonicalization before creating or reading state", () => {
  const source = readFileSync(new URL("../app/api/auth/[...all]/route.ts", import.meta.url), "utf8");
  assert.match(source, /canonicalAuthRedirect\(request, baseURL\)/);
  assert.match(source, /if \(redirect\) return redirect/);
});
