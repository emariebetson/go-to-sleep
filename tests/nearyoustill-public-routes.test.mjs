import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import CompanyHome, { metadata as companyMetadata } from "../app/page.tsx";
import NearStory, { metadata as storyMetadata } from "../app/nearstory/page.tsx";
import NearFamily, { metadata as familyMetadata } from "../app/nearfamily/page.tsx";
import NearLegacy, { metadata as legacyMetadata } from "../app/nearlegacy/page.tsx";
import sitemap from "../app/sitemap.ts";
import robots from "../app/robots.ts";

test("company and coming-soon hubs render distinct accessible public experiences", () => {
  const company = renderToStaticMarkup(React.createElement(CompanyHome));
  assert.match(company, /<h1[^>]*>Near you, <em>still\.<\/em><\/h1>/);
  assert.match(company, /href="\/nearsleep"/);

  for (const [Component, product, gatedPath] of [
    [NearStory, "NearStory", "/stories"],
    [NearFamily, "NearFamily", "/family"],
    [NearLegacy, "NearLegacy", "/legacy"],
  ]) {
    const html = renderToStaticMarkup(React.createElement(Component));
    assert.match(html, new RegExp(`<h1[^>]*>${product}</h1>`));
    assert.match(html, /Coming soon/);
    assert.match(html, /Join waitlist/);
    assert.doesNotMatch(html, new RegExp(`href="${gatedPath}"`));
  }
});

test("canonical metadata, sitemap, and robots expose hubs while keeping applications private", () => {
  assert.equal(companyMetadata.alternates.canonical, "/");
  assert.equal(storyMetadata.alternates.canonical, "/nearstory");
  assert.equal(familyMetadata.alternates.canonical, "/nearfamily");
  assert.equal(legacyMetadata.alternates.canonical, "/nearlegacy");
  const urls = sitemap().map((entry) => entry.url);
  assert.deepEqual(urls.slice(0, 5), [
    "https://nearyoustill.com",
    "https://nearyoustill.com/nearsleep",
    "https://nearyoustill.com/nearstory",
    "https://nearyoustill.com/nearfamily",
    "https://nearyoustill.com/nearlegacy",
  ]);
  const policy = robots();
  assert.equal(policy.sitemap, "https://nearyoustill.com/sitemap.xml");
  assert.ok(policy.rules.disallow.includes("/stories"));
  assert.ok(policy.rules.disallow.includes("/family"));
  assert.ok(policy.rules.disallow.includes("/legacy"));
});
