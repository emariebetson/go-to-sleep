import assert from "node:assert/strict";
import test from "node:test";
import { shouldPreserveGenerationRequest } from "../lib/studio-generation-retry.ts";

test("Studio preserves request IDs only for ambiguous durable outcomes", () => {
  assert.equal(shouldPreserveGenerationRequest(409, "generation_in_progress"), true);
  assert.equal(shouldPreserveGenerationRequest(503, "generation_result_reconciliation"), true);
  assert.equal(shouldPreserveGenerationRequest(503, "edited_narration_moderation_unavailable"), false);
  assert.equal(shouldPreserveGenerationRequest(503, "provider_unavailable"), false);
  assert.equal(shouldPreserveGenerationRequest(409, "idempotency_conflict"), false);
});
