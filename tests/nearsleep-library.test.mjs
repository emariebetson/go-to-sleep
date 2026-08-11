import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { decodeLibraryCursor, encodeLibraryCursor, parseLibrarySessionUpdate, portableConsentEvidence, safeAudioFilename, sha256Hex } from "../lib/nearsleep-library.ts";
import { exportArtifactPlan, repeatDeadlineForState, settleStoredRequestId, stableStoredRequestId, storedSecret, clearStoredSecret } from "../lib/task2c-client-state.ts";
import { tarHeader } from "../lib/nearsleep-tar.ts";

test("library updates set explicit favorite and repeat state", () => {
  assert.deepEqual(parseLibrarySessionUpdate({ favorite: true, repeatMinutes: 30 }), { favorite: true, repeatMinutes: 30 });
  assert.deepEqual(parseLibrarySessionUpdate({ favorite: false, repeatMinutes: null }), { favorite: false, repeatMinutes: null });
  assert.throws(() => parseLibrarySessionUpdate({ favorite: "toggle" }), /favorite/i);
  assert.throws(() => parseLibrarySessionUpdate({ favorite: true, repeatMinutes: 20 }), /repeat/i);
});

test("download filenames cannot inject headers or unsafe path characters", () => {
  assert.equal(safeAudioFilename("  Nana's / Moon\r\n.mp3  ", "session-id"), "nanas-moon.mp3");
  assert.equal(safeAudioFilename("✨", "abc/def"), "nearsleep-abc-def.mp3");
});

test("portable export checksums use lowercase SHA-256", async () => {
  assert.equal(await sha256Hex(new TextEncoder().encode("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("library cursors are opaque compounds of timestamp and stable id", () => {
  const cursor = encodeLibraryCursor({ createdAt: 1_786_400_000_000, id: "session:same-millisecond" });
  assert.doesNotMatch(cursor, /session:same/);
  assert.deepEqual(decodeLibraryCursor(cursor), { createdAt: 1_786_400_000_000, id: "session:same-millisecond" });
  assert.throws(() => decodeLibraryCursor("not-a-cursor"), /cursor/i);
});

test("ambiguous UI mutations retain their durable UUID across remounts", () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
  const first = stableStoredRequestId(storage, "playlist:create", () => "12345678-1234-4234-8234-123456789abc");
  assert.equal(stableStoredRequestId(storage, "playlist:create", () => "87654321-4321-4321-8321-cba987654321"), first);
  settleStoredRequestId(storage, "playlist:create", 503);
  assert.equal(stableStoredRequestId(storage, "playlist:create", () => "87654321-4321-4321-8321-cba987654321"), first);
  settleStoredRequestId(storage, "playlist:create", 201);
  assert.equal(stableStoredRequestId(storage, "playlist:create", () => "87654321-4321-4321-8321-cba987654321"), "87654321-4321-4321-8321-cba987654321");
});

test("changing repeat while media plays installs a fresh active deadline", () => {
  assert.equal(repeatDeadlineForState(1_000, 30, true), 1_801_000);
  assert.equal(repeatDeadlineForState(1_000, null, true), null);
  assert.equal(repeatDeadlineForState(1_000, 30, false), null);
});

test("Google sign-in forces credential reauthentication for deletion step-up", () => {
  const oauth = readFileSync(new URL("../lib/oauth.ts", import.meta.url), "utf8");
  assert.match(oauth, /prompt:\s*"login"/);
  assert.doesNotMatch(oauth, /prompt:\s*"select_account"/);
});

test("portable consent receipts retain safe verification provenance but omit provider and internal identifiers", () => {
  assert.deepEqual(portableConsentEvidence({ kind: "live_phrase", verified: true, liveness: true, challengeId: "internal", challengeVersion: "live-v1", transcriptionRequestId: "provider-secret", phraseHash: "hash", audioSha256: "audio-hash", transcriptMatch: "exact", cloneBoundToChallengeRecording: true, replacementProviderVoiceId: "provider-secret", posthumousSynthesis: false }), {
    kind: "live_phrase",
    challengeVersion: "live-v1",
    phraseHash: "hash",
    audioSha256: "audio-hash",
    transcriptMatch: "exact",
    verified: true,
    liveness: true,
    cloneBoundToChallengeRecording: true,
    posthumousSynthesis: false,
  });
});

test("full export download enumerates every metadata page and media part", () => {
  assert.deepEqual(exportArtifactPlan("export:id", { metadataPages: { count: 1 }, integrityCatalog: { count: 1 }, mediaParts: { count: 2 } }), [
    { kind: "manifest", id: "manifest", url: "/api/account/export/export%3Aid" },
    { kind: "metadata", id: "0", url: "/api/account/export/export%3Aid/metadata/0" },
    { kind: "metadata", id: "1", url: "/api/account/export/export%3Aid/metadata/1" },
    { kind: "part", id: "export:id:part:00000000", url: "/api/account/export/export%3Aid/parts/export%3Aid%3Apart%3A00000000" },
    { kind: "part", id: "export:id:part:00000001", url: "/api/account/export/export%3Aid/parts/export%3Aid%3Apart%3A00000001" },
  ]);
});

test("deletion receipt and request identifiers survive remount until explicitly cleared", () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
  assert.equal(storedSecret(storage, "receipt", () => "secret-one"), "secret-one");
  assert.equal(storedSecret(storage, "receipt", () => "secret-two"), "secret-one");
  clearStoredSecret(storage, "receipt");
  assert.equal(storedSecret(storage, "receipt", () => "secret-two"), "secret-two");
});

test("privacy controls provide full package download, owner role gating, and grace cancellation", () => {
  const source = readFileSync(new URL("../app/account/ProductionPrivacyControls.tsx", import.meta.url), "utf8");
  assert.match(source, /exportArtifactPlan/);
  assert.match(source, /crypto\.subtle\.digest/);
  assert.match(source, /showDirectoryPicker/);
  assert.match(source, /createWritable/);
  assert.doesNotMatch(source, /createObjectURL/);
  assert.match(source, /method:\s*"PATCH"/);
  assert.match(source, /Cancel deletion/);
  assert.match(source, /role !== "owner"/);
  assert.match(source, /sessionStorage/);
});

test("portable export fallback emits a valid ustar header without buffering the archive", () => {
  const header = tarHeader("metadata-00000000.json", 3);
  assert.equal(header.byteLength, 512);
  assert.equal(new TextDecoder().decode(header.slice(257, 262)), "ustar");
  assert.equal(new TextDecoder().decode(header.slice(0, 22)).replace(/\0+$/, ""), "metadata-00000000.json");
});

test("Stripe webhook cannot query Task 2C tombstones while migration is dark", () => {
  const source = readFileSync(new URL("../app/api/webhooks/stripe/production.ts", import.meta.url), "utf8");
  assert.match(source, /terminalDeletionAcknowledges[\s\S]*?if \(!nearSleepLibraryPrivacyEnabled\(featureFlagsFromEnv\(process\.env\)\)\) return false;[\s\S]*?from\(accountDeletionBillingTombstones\)/);
});

test("checkout expiration cannot write Task 2C tombstones while migration is dark", () => {
  const source = readFileSync(new URL("../app/api/billing/checkout/production.ts", import.meta.url), "utf8");
  assert.match(source, /stripePost[\s\S]*?if \(!nearSleepLibraryPrivacyEnabled\(featureFlagsFromEnv\(process\.env\)\)\) return;[\s\S]*?insert\(accountDeletionBillingTombstones\)/);
});
