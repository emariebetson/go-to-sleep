import assert from "node:assert/strict";
import test from "node:test";

import { getProduct, PRODUCTS } from "../lib/nearyoustill-products.ts";
import { normalizeWaitlistInput } from "../lib/marketing-waitlist.ts";

test("the public product catalog exposes one live product and never sends coming-soon visitors into dark apps", () => {
  assert.deepEqual(PRODUCTS.map(({ slug, availability, path }) => ({ slug, availability, path })), [
    { slug: "nearsleep", availability: "live", path: "/nearsleep" },
    { slug: "nearstory", availability: "coming_soon", path: "/nearstory" },
    { slug: "nearfamily", availability: "coming_soon", path: "/nearfamily" },
    { slug: "nearlegacy", availability: "coming_soon", path: "/nearlegacy" },
  ]);

  assert.equal(getProduct("nearsleep").applicationDestination, "/studio");
  for (const slug of ["nearstory", "nearfamily", "nearlegacy"]) {
    const product = getProduct(slug);
    assert.equal(product.applicationDestination, null);
    assert.equal(product.waitlistSource, slug);
  }
});

test("every future-product hub is accepted as an exact waitlist source", () => {
  for (const source of ["nearstory", "nearfamily", "nearlegacy"]) {
    const result = normalizeWaitlistInput({
      email: "Parent@example.com",
      products: [source],
      source,
      consent: true,
      consentVersion: "marketing-consent-v1",
    });
    assert.equal(result.source, source);
    assert.equal(result.email, "parent@example.com");
  }
});

test("waitlist attribution rejects application routes and unknown sources", () => {
  for (const source of ["stories", "family", "legacy", "near-sleep", "unknown"]) {
    assert.throws(() => normalizeWaitlistInput({
      email: "parent@example.com",
      products: ["nearstory"],
      source,
      consent: true,
      consentVersion: "marketing-consent-v1",
    }), /invalid_source/);
  }
});
