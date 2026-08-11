import assert from "node:assert/strict";
import test from "node:test";
import { failedProviderCloneCanBeRetired, retireFailedProviderClone } from "../lib/voice-clone-cleanup.ts";

test("a failed activation preserves a provider clone reference when provider deletion is not verified", async () => {
  const persisted = [];
  const result = await retireFailedProviderClone({
    providerVoiceId: "provider_sensitive_clone",
    deleteProviderVoice: async () => false,
    persistCleanup: async (providerVoiceId) => persisted.push(providerVoiceId),
  });
  assert.deepEqual(result, { cleanupPending: true });
  assert.deepEqual(persisted, ["provider_sensitive_clone"]);
});

test("verified provider deletion does not create a cleanup claim", async () => {
  let persisted = false;
  const result = await retireFailedProviderClone({
    providerVoiceId: "provider_deleted_clone",
    deleteProviderVoice: async () => true,
    persistCleanup: async () => { persisted = true; },
  });
  assert.deepEqual(result, { cleanupPending: false });
  assert.equal(persisted, false);
});

test("a lost response after activation never retires the now-current provider clone", () => {
  assert.equal(failedProviderCloneCanBeRetired({
    replacementActivated: false,
    replacementProviderVoiceId: "provider_new",
    currentVoiceProviderVoiceId: "provider_new",
    replacementStatus: "cleanup_pending",
  }), false);
  assert.equal(failedProviderCloneCanBeRetired({
    replacementActivated: false,
    replacementProviderVoiceId: "provider_new",
    currentVoiceProviderVoiceId: undefined,
    replacementStatus: undefined,
  }), false);
  assert.equal(failedProviderCloneCanBeRetired({
    replacementActivated: false,
    replacementProviderVoiceId: "provider_new",
    currentVoiceProviderVoiceId: "provider_old",
    replacementStatus: "provider_created",
  }), true);
});
