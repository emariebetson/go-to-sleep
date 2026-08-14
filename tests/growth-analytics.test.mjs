import assert from "node:assert/strict";
import test from "node:test";

import { normalizeGrowthEvent } from "../lib/growth-analytics.ts";

test("Growth OS accepts only the three approved website events and anonymous attribution", () => {
  assert.deepEqual(normalizeGrowthEvent({ event: "landing_view", properties: { product: "nearstory", landingVariant: "product-hub", source: "direct", campaign: "launch" } }), {
    event: "landing_view",
    properties: { product: "nearstory", landingVariant: "product-hub", source: "direct", campaign: "launch" },
  });
  assert.deepEqual(normalizeGrowthEvent({ event: "creation_started", properties: { product: "nearsleep", landingVariant: "nearsleep-hub" } }), {
    event: "creation_started",
    properties: { product: "nearsleep", landingVariant: "nearsleep-hub" },
  });
  assert.deepEqual(normalizeGrowthEvent({ event: "expansion_interest_confirmed", properties: { product: "nearfamily", source: "nearfamily" } }), {
    event: "expansion_interest_confirmed",
    properties: { product: "nearfamily", source: "nearfamily" },
  });
});

test("Growth OS rejects PII, authentication, household, child, voice, story, memory, and payment fields", () => {
  for (const forbidden of ["email", "name", "householdId", "childId", "voiceId", "storyText", "recording", "memory", "payment", "token", "state"]) {
    assert.throws(() => normalizeGrowthEvent({ event: "landing_view", properties: { product: "nearsleep", [forbidden]: "private" } }), /invalid_growth_event/);
  }
  assert.throws(() => normalizeGrowthEvent({ event: "payment_completed", properties: { product: "nearsleep" } }), /invalid_growth_event/);
  for (const properties of [
    { product: "nearstory", landingVariant: "product-hub", source: "parent@example.com" },
    { product: "nearstory", landingVariant: "product-hub", campaign: "access_token=private" },
    { product: "nearstory", landingVariant: "product-hub", source: "direct/../../private" },
    { product: "nearstory", landingVariant: "product-hub", source: "elizabeth_betson" },
    { product: "nearstory", landingVariant: "product-hub", campaign: "3125551212" },
    { product: "nearstory", landingVariant: "product-hub", campaign: "ssn_123_45_6789" },
  ]) assert.throws(() => normalizeGrowthEvent({ event: "landing_view", properties }), /invalid_growth_event/);
});

test("Growth OS binds exact products and property shapes to each approved event", () => {
  for (const input of [
    { event: "landing_view", properties: { product: "company", landingVariant: "product-hub" } },
    { event: "landing_view", properties: { product: "nearstory", landingVariant: "company-home" } },
    { event: "creation_started", properties: { product: "nearlegacy", landingVariant: "product-hub" } },
    { event: "creation_started", properties: { product: "nearsleep", landingVariant: "nearsleep-hub", source: "direct" } },
    { event: "expansion_interest_confirmed", properties: { product: "company", source: "company" } },
    { event: "expansion_interest_confirmed", properties: { product: "nearstory", source: "nearfamily" } },
  ]) assert.throws(() => normalizeGrowthEvent(input), /invalid_growth_event/);
});
