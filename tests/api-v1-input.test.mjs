import assert from "node:assert/strict";
import test from "node:test";
import {
  parseChildProfileInput,
  parseHouseholdInput,
  parseInvitationAcceptanceInput,
  parseInvitationInput,
  parseActiveHouseholdInput,
  parseJobInput,
  parsePlaylistInput,
  parseOwnershipTransferInput,
  parseVoiceConsentInput,
} from "../lib/api-v1-input.ts";

const requestId = "12345678-1234-4123-8123-123456789abc";

test("household input is bounded and normalized", () => {
  assert.deepEqual(parseHouseholdInput({ name: "  Mia's family  " }), { name: "Mia's family" });
  assert.throws(() => parseHouseholdInput({ name: "" }), /name/i);
});

test("active household selection accepts only a bounded stable ID", () => {
  assert.deepEqual(parseActiveHouseholdInput({ householdId: "household:user_1" }), { householdId: "household:user_1" });
  assert.throws(() => parseActiveHouseholdInput({ householdId: "../other" }), /householdId/i);
});

test("ownership transfer requires a bounded target adult user ID", () => {
  assert.deepEqual(parseOwnershipTransferInput({ newOwnerUserId: "user_2" }), { newOwnerUserId: "user_2" });
  assert.throws(() => parseOwnershipTransferInput({ newOwnerUserId: "" }), /newOwnerUserId/i);
});

test("household invitations allow only non-owner adult roles", () => {
  assert.deepEqual(parseInvitationInput({ requestId, email: "  CARE@example.com ", role: "listener" }), {
    requestId,
    email: "care@example.com",
    role: "listener",
  });
  assert.throws(() => parseInvitationInput({ requestId, email: "care@example.com", role: "owner" }), /role/i);
  assert.deepEqual(parseInvitationAcceptanceInput({ token: "a".repeat(64) }), { token: "a".repeat(64) });
});

test("child profile input is adult-managed and idempotent", () => {
  assert.deepEqual(parseChildProfileInput({ requestId, nickname: "  Mia  ", ageMonths: 18 }), {
    requestId,
    nickname: "Mia",
    normalizedNickname: "mia",
    ageMonths: 18,
    bedtimeChallenge: null,
  });
  assert.throws(() => parseChildProfileInput({ requestId, nickname: "Mia", email: "child@example.com" }), /child accounts are disabled/i);
  assert.throws(() => parseChildProfileInput({ nickname: "Mia" }), /requestId/i);
});

test("voice consent is restricted to a living adult's own voice", () => {
  assert.deepEqual(parseVoiceConsentInput({
    requestId,
    voiceId: "22345678-1234-4123-8123-123456789abc",
    consentVersion: "voice-v1",
    adultSelfAttestation: true,
    attestation: "I confirm this is my voice and I consent to private narration in my household.",
    allowPosthumousSynthesis: false,
  }), {
    requestId,
    voiceId: "22345678-1234-4123-8123-123456789abc",
    consentVersion: "voice-v1",
    scope: "adult_self_private_narration",
  });
  assert.throws(() => parseVoiceConsentInput({
    requestId,
    voiceId: "22345678-1234-4123-8123-123456789abc",
    consentVersion: "voice-v1",
    adultSelfAttestation: true,
    attestation: "I confirm this is my voice and I consent to private narration in my household.",
    allowPosthumousSynthesis: true,
  }), /posthumous synthesis is disabled/i);
  assert.throws(() => parseVoiceConsentInput({
    requestId,
    voiceId: "22345678-1234-4123-8123-123456789abc",
    consentVersion: "voice-v999",
    adultSelfAttestation: true,
    attestation: "I confirm this is my voice and I consent to private narration in my household.",
    allowPosthumousSynthesis: false,
  }), /consent version/i);
});

test("playlist and job creation require stable request IDs and safe job types", () => {
  assert.deepEqual(parsePlaylistInput({ requestId, name: "  Bedtime favorites  " }), {
    requestId,
    name: "Bedtime favorites",
  });
  assert.deepEqual(parseJobInput({ requestId, type: "nearsleep_audio", input: { sessionId: "session_1" } }), {
    requestId,
    type: "nearsleep_audio",
    input: { sessionId: "session_1" },
  });
  assert.throws(() => parseJobInput({ requestId, type: "child_microphone", input: {} }), /job type/i);
  assert.throws(() => parseJobInput({ requestId, type: "posthumous_synthesis", input: {} }), /job type/i);
});
