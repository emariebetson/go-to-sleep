import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PRODUCTS } from "../lib/nearyoustill-products.ts";

const text = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("public UI consistently presents NearSleep and the coming-soon family", async () => {
  const files = [
    "app/page.tsx", "app/pricing/page.tsx", "app/layout.tsx", "app/sign-in/page.tsx",
    "app/account/page.tsx", "app/safety/page.tsx", "app/privacy/page.tsx", "app/terms/page.tsx",
    "components/Brand.tsx", "components/SiteFooter.tsx", "components/SleepVisualizer.tsx",
    "app/studio/SleepStudio.tsx", "lib/sleep-session.ts", "lib/nearsleep-audio.ts", "lib/elevenlabs.ts", "lib/oauth.ts",
  ];
  const sources = await Promise.all(files.map(text));
  for (let index = 0; index < files.length; index += 1) {
    const publicCopy = sources[index].replace(/"nearyou-compatible-product":\s*"Nearnight",?/, "");
    assert.doesNotMatch(publicCopy, /NearNight|Nearnight|Near Night/, files[index]);
  }
  assert.deepEqual(PRODUCTS.map((product) => product.name), ["NearSleep", "NearStory", "NearFamily", "NearLegacy"]);
  assert.equal(PRODUCTS.filter((product) => product.availability === "live").length, 1);
  assert.ok(PRODUCTS.filter((product) => product.availability === "coming_soon").every((product) => product.applicationDestination === null));
});

test("waitlist form requires explicit consent and exposes accessible status", async () => {
  const form = await text("components/WaitlistForm.tsx");
  assert.match(form, /type="email"/);
  assert.match(form, /autoComplete="email"/);
  assert.match(form, /type="checkbox"/);
  assert.match(form, /aria-live="polite"/);
  assert.match(form, /marketing-consent-v1/);
  assert.match(form, /\/privacy/);
  assert.match(form, /\/terms/);
  assert.match(form, /crypto\.randomUUID/);
});

test("coming-soon product cards reveal an accessible animated waitlist invitation", async () => {
  const [family, styles, home, pricing, nearSleep] = await Promise.all([
    text("components/ProductFamily.tsx"),
    text("app/globals.css"),
    text("app/page.tsx"),
    text("app/pricing/page.tsx"),
    text("app/nearsleep/page.tsx"),
  ]);
  assert.match(home, /<ProductFamily source="home" animatedWaitlistCta \/>/);
  assert.doesNotMatch(pricing, /animatedWaitlistCta/);
  assert.doesNotMatch(nearSleep, /animatedWaitlistCta/);
  assert.match(family, /animatedWaitlistCta && product\.availability === "coming_soon"/);
  assert.match(family, /product\.availability === "coming_soon"/);
  assert.match(family, /className="btn btn-secondary product-waitlist-cta"/);
  assert.match(family, /className="product-waitlist-cta-default"/);
  assert.match(family, /className="product-waitlist-cta-hover"/);
  assert.match(family, /aria-hidden="true"/);
  assert.match(family, /Join the waitlist/);
  assert.match(family, /href=\{product\.path\}/);
  assert.match(styles, /\.product-waitlist-cta/);
  assert.match(styles, /\.product-waitlist-cta:hover/);
  assert.match(styles, /\.product-waitlist-cta:focus-visible/);
  assert.match(styles, /@media \(hover: hover\) and \(pointer: fine\)/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.ok(styles.indexOf(".product-waitlist-cta:focus-visible") < styles.indexOf("@media (hover: hover) and (pointer: fine)"));
  assert.ok(styles.lastIndexOf(".product-waitlist-cta:hover") > styles.indexOf("@media (hover: hover) and (pointer: fine)"));
});
