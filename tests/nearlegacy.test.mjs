import assert from "node:assert/strict";
import test from "node:test";

import {
  LEGACY_NO_EVIDENCE_RESPONSE,
  archiveTranscriptionMilliunits,
  buildGroundedArchiveAnswer,
  buildLegacyExportManifest,
  evaluateSyntheticNarration,
  parseLegacyConsent,
  parseTranscriptCorrection,
} from "../lib/nearlegacy.ts";
import { featureFlagsFromEnv, nearLegacyArchiveFlagsEnabled, roleCan } from "../lib/nearyou-foundation.ts";

test("NearLegacy stays dark without every archive safety gate and uses least privilege", () => {
  assert.equal(nearLegacyArchiveFlagsEnabled(featureFlagsFromEnv({ NEARYOU_ENABLE_LEGACY_ARCHIVE: "true" })), false);
  const enabled = featureFlagsFromEnv({ NEARYOU_ENABLE_FOUNDATION_API: "true", NEARYOU_ENABLE_PRODUCTION_UPGRADE_FOUNDATION: "true", NEARYOU_ENABLE_NEARSLEEP_PRODUCTION: "true", NEARYOU_ENABLE_NEARSLEEP_LIBRARY_PRIVACY: "true", NEARYOU_ENABLE_LEGACY_ARCHIVE: "true", NEARYOU_ENABLE_ASYNC_MEDIA_JOBS: "true", NEARYOU_ENABLE_USAGE_RESERVATIONS: "true", NEARYOU_REQUIRE_VERIFIED_VOICE_CONSENT: "true", NEARYOU_ENABLE_VERIFIED_MEDIA_PROBE: "true", NEARYOU_REQUIRE_LEGACY_MFA: "true" });
  assert.equal(nearLegacyArchiveFlagsEnabled(enabled), true);
  assert.equal(roleCan("owner", "archive:custody"), true);
  assert.equal(roleCan("adult_manager", "archive:write"), true);
  assert.equal(roleCan("listener", "archive:write"), false);
});

test("NearLegacy refuses an unsupported memory instead of composing one", () => {
  assert.deepEqual(buildGroundedArchiveAnswer("What was Grandma's first job?", []), {
    answer: LEGACY_NO_EVIDENCE_RESPONSE,
    supported: false,
    sources: [],
  });
});

test("NearLegacy prefers an original recording and cites exact provenance", () => {
  const result = buildGroundedArchiveAnswer("How did you meet Grandpa?", [{
    segmentId: "seg-1",
    recordingId: "rec-1",
    contributorId: "contributor-1",
    recordedAt: "2026-01-04T12:00:00.000Z",
    startMs: 1200,
    endMs: 9100,
    transcript: "I met him at the library after work.",
    score: 0.92,
    provenance: "original_recording",
    status: "ready",
    deletionStatus: "active",
    matchedQuery: "How did you meet Grandpa?",
    checksum: "c".repeat(64),
  }]);
  assert.equal(result.supported, true);
  assert.equal(result.answer, "I met him at the library after work.");
  assert.deepEqual(result.sources, [{ segmentId: "seg-1", transcriptId: null, correctionId: null, recordingId: "rec-1", contributorId: "contributor-1", recordedAt: "2026-01-04T12:00:00.000Z", startMs: 1200, endMs: 9100, checksum: "c".repeat(64), provenance: "original_recording" }]);
});

test("synthetic narration requires active purpose-specific consent and halts on death state", () => {
  const active = { status: "active", version: "legacy-synthetic-v1", purposes: ["private_archive_narration"], audience: "household", expiresAt: null, posthumousUse: false };
  assert.deepEqual(evaluateSyntheticNarration(active, "active", new Date("2026-01-01")), { allowed: true });
  assert.deepEqual(evaluateSyntheticNarration(active, "deceased_pending_review", new Date("2026-01-01")), { allowed: false, reason: "deceased_review_required" });
  assert.deepEqual(evaluateSyntheticNarration({ ...active, status: "revoked" }, "active", new Date("2026-01-01")), { allowed: false, reason: "consent_inactive" });
});

test("versioned legacy consent rejects implied, unbounded, or posthumous synthetic permission", () => {
  assert.throws(() => parseLegacyConsent({ version: "legacy-consent-v1", kind: "synthetic", audience: "household", purposes: ["private_archive_narration"], attested: false }), /explicit consent/i);
  assert.throws(() => parseLegacyConsent({ version: "legacy-consent-v1", kind: "synthetic", audience: "public", purposes: ["private_archive_narration"], attested: true }), /audience/i);
  assert.throws(() => parseLegacyConsent({ version: "legacy-synthetic-v1", kind: "synthetic", audience: "household", purposes: ["private_archive_narration"], attested: true, posthumousUse: true }), /separate review/i);
  assert.throws(() => parseLegacyConsent({ version: "legacy-synthetic-v1", kind: "recording", audience: "household", purposes: ["private_archive"], attested: true }), /version/i);
});

test("grounded retrieval rejects mismatched-query and incomplete lifecycle candidates", () => {
  const base = { segmentId: "seg-1", recordingId: "rec-1", contributorId: "contributor-1", recordedAt: "2026-01-04T12:00:00.000Z", startMs: 0, endMs: 1000, transcript: "A memory", score: .99, provenance: "original_recording", status: "ready", deletionStatus: "active", matchedQuery: "another question", checksum: "c".repeat(64) };
  assert.equal(buildGroundedArchiveAnswer("this question", [base]).supported, false);
  assert.equal(buildGroundedArchiveAnswer("another question", [{ ...base, status: "deleted" }]).supported, false);
});

test("speaker corrections are bounded and preserve the original transcript", () => {
  const correction = parseTranscriptCorrection({ segmentId: "seg-1", correctedText: "Grandpa and I met at the library.", speakerContributorId: "contributor-1", reason: "speaker_and_wording" });
  assert.equal(correction.correctedText, "Grandpa and I met at the library.");
  assert.throws(() => parseTranscriptCorrection({ segmentId: "seg-1", correctedText: "x".repeat(4001), speakerContributorId: "contributor-1", reason: "speaker_and_wording" }), /4000/);
});

test("transcription usage is weighted and portable export manifests include checksums and consent receipts", async () => {
  assert.equal(archiveTranscriptionMilliunits("nearlegacy", 90), 90_000);
  assert.throws(() => archiveTranscriptionMilliunits("nearyou_family", 5), /NearLegacy/);
  const manifest = await buildLegacyExportManifest({
    householdId: "household-1",
    generatedAt: "2026-01-01T00:00:00.000Z",
    recordings: [{ id: "rec-1", path: "recordings/rec-1.m4a", checksum: "a".repeat(64), byteSize: 42 }],
    transcripts: [{ id: "tr-1", recordingId: "rec-1", path: "transcripts/tr-1.json", checksum: "b".repeat(64), byteSize: 21 }],
    metadata: [{ id: "metadata-1", category: "interviews", path: "metadata/interviews-1.json", checksum: "d".repeat(64), byteSize: 31 }],
    consentReceipts: [{ id: "consent-1", contributorId: "contributor-1", version: "legacy-consent-v1", kind: "recording", audience: "household", purpose: "private_archive", status: "active", attestedAt: "2026-01-01T00:00:00.000Z", expiresAt: null, revokedAt: null, evidenceChecksum: "c".repeat(64) }],
  });
  assert.equal(manifest.version, "nearlegacy-portable-export-v1");
  assert.equal(manifest.files.length, 3);
  assert.equal(manifest.consentReceipts[0].id, "consent-1");
  assert.equal(manifest.consentReceipts[0].evidenceChecksum, "c".repeat(64));
  assert.match(manifest.manifestChecksum, /^[0-9a-f]{64}$/);
});
