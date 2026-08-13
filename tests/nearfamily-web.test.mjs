import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

import { createNearFamilyAvailability, createNearFamilyGetHandler, createNearFamilyPageAvailability } from "../lib/nearfamily-route.ts";
import { nearFamilySourceActivated } from "../lib/nearfamily-activation.ts";
import { FamilyDashboard } from "../app/family/FamilyDashboard.tsx";
import { appNavigationLinks, resolveFamilyNavigationAvailability } from "../components/app-navigation.ts";

const summary = {
  planId: "nearyou_family",
  capacity: {
    state: "within_limit",
    usage: { members: 2, children: 3, voices: 1, storageBytes: 2_000_000_000 },
    limits: { members: 5, children: 5, voices: 2, storageBytes: 25_000_000_000 },
    exceeded: [],
  },
  features: {
    nearsleep: true,
    nearstoryParentControlled: true,
    childAccounts: false,
    childMicrophone: false,
    posthumousSynthesis: false,
  },
};

function handler(overrides = {}) {
  return createNearFamilyGetHandler({
    sourceActivated: () => true,
    requireHousehold: async () => "house_one",
    authorizeProduct: async () => true,
    loadSummary: async () => summary,
    ...overrides,
  });
}

test("NearFamily source activation is default-off and cannot be enabled by environment", () => {
  assert.equal(nearFamilySourceActivated(), false);
  assert.equal(nearFamilySourceActivated({ NEARYOU_ENABLE_FAMILY: "true", NEARFAMILY_ROUTE_ENABLED: "true" }), false);
});

test("NearFamily route stays dark before authentication when source activation is off", async () => {
  let authenticated = false;
  const response = await handler({ sourceActivated: () => false, requireHousehold: async () => { authenticated = true; return "house_one"; } })(new Request("https://app.test/api/v1/family"));
  assert.equal(response.status, 404);
  assert.equal(authenticated, false);
});

test("NearFamily route hides unauthorized and kill-switched households", async () => {
  for (const authorizeProduct of [async () => false, async () => false]) {
    const response = await handler({ authorizeProduct })(new Request("https://app.test/api/v1/family"));
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "NearFamily is not available." });
  }
});

test("NearFamily route returns the invited household summary", async () => {
  const response = await handler()(new Request("https://app.test/api/v1/family"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), summary);
});

test("NearFamily page availability denies unauthorized and kill-switched households", async () => {
  for (const authorized of [false, false]) {
    let authorizationChecks = 0;
    const availability = createNearFamilyAvailability({
      sourceActivated: () => true,
      requireHousehold: async () => "house_one",
      authorizeProduct: async () => { authorizationChecks += 1; return authorized; },
    });
    assert.deepEqual(await availability(new Request("https://app.test/family")), { available: false });
    assert.equal(authorizationChecks, 1);
    assert.equal(appNavigationLinks({ showStories: true, showLegacy: true, familyAvailable: false }).some(([, href]) => href === "/family"), false);
  }
});

test("NearFamily page converts an authenticated non-member denial into hidden availability", async () => {
  const availability = createNearFamilyPageAvailability(createNearFamilyAvailability({ sourceActivated: () => true, requireHousehold: async () => { throw new Response("Forbidden", { status: 403 }); }, authorizeProduct: async () => true }));
  assert.deepEqual(await availability(new Request("https://app.test/family")), { available: false });
});

test("NearFamily invited page decision is reused by navigation without another rollout sample", async () => {
  let authorizationChecks = 0;
  const availability = createNearFamilyAvailability({ sourceActivated: () => true, requireHousehold: async () => "house_one", authorizeProduct: async () => { authorizationChecks += 1; return true; } });
  const decision = await availability(new Request("https://app.test/family"));
  assert.deepEqual(decision, { available: true, householdId: "house_one" });
  assert.equal(appNavigationLinks({ showStories: false, showLegacy: false, familyAvailable: decision.available }).some(([, href]) => href === "/family"), true);
  assert.equal(authorizationChecks, 1);
});

test("non-Family pages load exact household availability for invited and denied navigation", async () => {
  for (const available of [true, false]) {
    let calls = 0;
    const resolved = await resolveFamilyNavigationAvailability(undefined, async () => { calls += 1; return { available }; });
    assert.equal(resolved, available);
    assert.equal(calls, 1);
    assert.equal(appNavigationLinks({ showStories: false, showLegacy: false, familyAvailable: resolved }).some(([, href]) => href === "/family"), available);
  }
});

test("Family page explicit decision prevents a second rollout sample", async () => {
  let calls = 0;
  assert.equal(await resolveFamilyNavigationAvailability(true, async () => { calls += 1; return { available: false }; }), true);
  assert.equal(calls, 0);
});

test("NearFamily dashboard shows exact capacity, adult safety boundaries and existing remediation links", () => {
  const restricted = {
    ...summary,
    capacity: {
      state: "restricted",
      usage: { members: 5, children: 6, voices: 2, storageBytes: 25_000_000_000 },
      limits: summary.capacity.limits,
      exceeded: ["children"],
    },
  };
  const markup = renderToStaticMarkup(React.createElement(FamilyDashboard, { initialSummary: restricted }));
  for (const text of ["NearFamily", "5 of 5", "6 of 5", "2 of 2", "25 GB of 25 GB", "Capacity needs attention", "Children remain non-login profiles", "Child microphones are disabled", "Posthumous voice synthesis is disabled"]) assert.match(markup, new RegExp(text));
  assert.match(markup, /href="\/account"/);
  assert.match(markup, /href="\/pricing"/);
  assert.match(markup, /href="\/studio"/);
  assert.doesNotMatch(markup, /method="post"|method="delete"/i);
});

test("NearFamily page passes its authorized decision into navigation", () => {
  const page = readFileSync(new URL("../app/family/page.tsx", import.meta.url), "utf8");
  const shell = readFileSync(new URL("../components/AppShell.tsx", import.meta.url), "utf8");
  assert.match(page, /nearFamilyPageAvailability/);
  assert.match(page, /familyAvailable=\{decision\.available\}/);
  assert.match(page, /<FamilyDashboard/);
  assert.match(shell, /familyAvailable/);
});
