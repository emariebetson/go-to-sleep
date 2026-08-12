import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const sql = fs.readFileSync(new URL("../drizzle/0014_nearlegacy_archive.sql", import.meta.url), "utf8");

test("NearLegacy migration adds the archive domain and dark activation gate", () => {
  for (const table of ["legacy_activation_state", "legacy_custodians", "legacy_consents", "legacy_interviews", "legacy_recordings", "legacy_transcripts", "legacy_transcript_segments", "legacy_transcript_corrections", "legacy_memories", "legacy_people", "legacy_places", "legacy_photos", "legacy_tags", "legacy_memory_tags", "legacy_timeline_events", "legacy_collections", "legacy_collection_items", "legacy_query_receipts", "legacy_deletion_operations"]) {
    assert.match(sql, new RegExp("CREATE TABLE `" + table + "`"));
  }
  assert.match(sql, /posthumous_synthesis_disabled/);
  assert.match(sql, /legacy_consent_revocation_fence/);
  assert.match(sql, /legacy_cross_household/);
  assert.match(sql, /account_deletion_operations/);
  assert.match(sql, /CREATE TABLE `legacy_liveness_challenges`/);
  assert.match(sql, /CREATE TABLE `legacy_media_probe_receipts`/);
  assert.match(sql, /CREATE TABLE `legacy_evidence_retention`/);
  assert.match(sql, /legacy_consent_requires_verified_liveness/);
  assert.match(sql, /legacy_media_probe_consume/);
  assert.match(sql, /`next_attempt_at` integer/);
  assert.match(sql, /`dead_lettered_at` integer/);
  assert.match(sql, /`inventory_stage` text DEFAULT 'recordings'/);
});
