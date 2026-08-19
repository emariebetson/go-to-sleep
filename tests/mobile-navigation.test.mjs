import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("shared mobile menu is wired into every site navigation surface", () => {
  for (const path of ["components/SiteHeader.tsx", "components/CompanyHeader.tsx", "components/AppShell.tsx"]) {
    assert.match(source(path), /MobileMenu/);
  }
  assert.match(source("components/MobileMenu.tsx"), /aria-expanded/);
  assert.match(source("components/MobileMenu.tsx"), /Escape/);
});

test("mobile navigation keeps the header pinned and exposes the approved menu affordances", () => {
  const css = source("app/globals.css");
  assert.match(css, /\.site-header[^{]*\{[^}]*position:\s*sticky/);
  assert.match(css, /\.mobile-menu-toggle/);
  assert.match(css, /\.mobile-menu-panel/);
  assert.match(css, /safe-area-inset-top/);
  assert.match(css, /\.nav-links > a:not\(\.btn\)/);
});

test("company mobile navigation keeps the product entry concise", () => {
  const companyHeader = source("components/CompanyHeader.tsx");
  assert.match(companyHeader, /href: "\/#products", label: "Products"/);
  assert.doesNotMatch(companyHeader, /href: "\/nearsleep", label: "NearSleep"/);
});

test("site mobile navigation omits recommended while the header omits the bedtime CTA", () => {
  const siteHeader = source("components/SiteHeader.tsx");
  assert.doesNotMatch(siteHeader, /href: "\/nearsleep#recommended", label: "Recommended"/);
  assert.doesNotMatch(siteHeader, /className="btn btn-primary btn-small" href="\/studio">Create a bedtime<\/Link>/);
  assert.match(siteHeader, /primary=\{\{ href: "\/studio", label: "Create a bedtime" \}\}/);
});
