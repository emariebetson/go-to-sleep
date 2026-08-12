export const LEGACY_NO_EVIDENCE_RESPONSE = "This archive doesn’t contain that memory.";
export const LEGACY_CONSENT_VERSION = "legacy-consent-v1";
export const LEGACY_SYNTHETIC_CONSENT_VERSION = "legacy-synthetic-v1";
export const LEGACY_RETRIEVAL_MIN_SCORE = 0.72;

const CONTROL = /\p{Cc}/u;
const SHA256 = /^[0-9a-f]{64}$/;

function boundedText(value: unknown, name: string, max: number) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required.`);
  const normalized = value.normalize("NFC").replace(/\s+/g, " ").trim();
  if (CONTROL.test(normalized) || Array.from(normalized).length > max) throw new Error(`${name} must be at most ${max} characters.`);
  return normalized;
}

export type LegacyConsentInput = {
  version: string;
  kind: "recording" | "transcription" | "synthetic";
  audience: "household";
  purposes: Array<"private_archive" | "private_archive_narration">;
  attested: true;
  expiresAt?: string | null;
  posthumousUse?: false;
};

export function parseLegacyConsent(value: Record<string, unknown>, now = new Date()): LegacyConsentInput {
  if (value.attested !== true) throw new Error("Explicit consent is required.");
  if (value.version !== LEGACY_CONSENT_VERSION && value.version !== LEGACY_SYNTHETIC_CONSENT_VERSION) throw new Error("Consent version is invalid.");
  if (!(["recording", "transcription", "synthetic"] as unknown[]).includes(value.kind)) throw new Error("Consent kind is invalid.");
  if (value.audience !== "household") throw new Error("Consent audience must be the private household.");
  if (!Array.isArray(value.purposes) || value.purposes.length !== 1) throw new Error("Exactly one consent purpose is required.");
  const requiredPurpose = value.kind === "synthetic" ? "private_archive_narration" : "private_archive";
  if (value.purposes[0] !== requiredPurpose) throw new Error("Consent purpose does not match its use.");
  if (value.kind === "synthetic" && value.version !== LEGACY_SYNTHETIC_CONSENT_VERSION) throw new Error("Synthetic narration requires separate versioned consent.");
  if (value.kind !== "synthetic" && value.version !== LEGACY_CONSENT_VERSION) throw new Error("Recording and transcription consent require the archive consent version.");
  if (value.posthumousUse === true) throw new Error("Posthumous use requires a separate review and cannot be enabled here.");
  if (value.expiresAt != null && (!Number.isFinite(Date.parse(String(value.expiresAt))) || Date.parse(String(value.expiresAt)) <= now.getTime())) throw new Error("Consent expiry must be in the future.");
  return {
    version: value.version,
    kind: value.kind as LegacyConsentInput["kind"],
    audience: "household",
    purposes: [requiredPurpose] as LegacyConsentInput["purposes"],
    attested: true,
    expiresAt: value.expiresAt == null ? null : new Date(String(value.expiresAt)).toISOString(),
    posthumousUse: false,
  };
}

type SyntheticConsent = {
  status: string;
  version: string;
  purposes: string[];
  audience: string;
  expiresAt: Date | string | null;
  posthumousUse: boolean;
};

export function evaluateSyntheticNarration(consent: SyntheticConsent | null, contributorStatus: string, now = new Date()): { allowed: true } | { allowed: false; reason: string } {
  if (contributorStatus !== "active") return { allowed: false, reason: "deceased_review_required" };
  if (!consent || consent.status !== "active") return { allowed: false, reason: "consent_inactive" };
  if (consent.version !== LEGACY_SYNTHETIC_CONSENT_VERSION || consent.audience !== "household" || !consent.purposes.includes("private_archive_narration")) return { allowed: false, reason: "consent_scope_invalid" };
  if (consent.posthumousUse) return { allowed: false, reason: "posthumous_synthesis_disabled" };
  if (consent.expiresAt && new Date(consent.expiresAt).getTime() <= now.getTime()) return { allowed: false, reason: "consent_expired" };
  return { allowed: true };
}

export type LegacySourceSegment = {
  segmentId: string; transcriptId?: string; correctionId?: string | null; recordingId: string; contributorId: string; recordedAt: string;
  startMs: number; endMs: number; transcript: string; score: number; provenance: "original_recording";
  checksum: string; status: "ready"; deletionStatus: "active"; matchedQuery: string;
};

export function buildGroundedArchiveAnswer(question: string, candidates: LegacySourceSegment[]) {
  const normalizedQuestion = boundedText(question, "question", 500).toLocaleLowerCase();
  const source = candidates
    .filter((item) => item.provenance === "original_recording"
      && item.status === "ready" && item.deletionStatus === "active"
      && Number.isFinite(item.score) && item.score >= LEGACY_RETRIEVAL_MIN_SCORE
      && item.matchedQuery.normalize("NFC").replace(/\s+/g, " ").trim().toLocaleLowerCase() === normalizedQuestion
      && Number.isSafeInteger(item.startMs) && item.startMs >= 0 && Number.isSafeInteger(item.endMs) && item.endMs > item.startMs
      && Number.isFinite(Date.parse(item.recordedAt)) && SHA256.test(item.checksum)
      && Boolean(item.segmentId.trim() && item.recordingId.trim() && item.contributorId.trim()))
    .sort((a, b) => b.score - a.score)[0];
  if (!source) return { answer: LEGACY_NO_EVIDENCE_RESPONSE, supported: false as const, sources: [] };
  const answer = boundedText(source.transcript, "source transcript", 4_000);
  return {
    answer,
    supported: true as const,
    sources: [{ segmentId: source.segmentId, transcriptId: source.transcriptId ?? null, correctionId: source.correctionId ?? null, recordingId: source.recordingId, contributorId: source.contributorId, recordedAt: source.recordedAt, startMs: source.startMs, endMs: source.endMs, checksum: source.checksum, provenance: source.correctionId ? "corrected_transcript" as const : source.provenance }],
  };
}

export function parseTranscriptCorrection(value: Record<string, unknown>) {
  return {
    segmentId: boundedText(value.segmentId, "segmentId", 200),
    correctedText: boundedText(value.correctedText, "correctedText", 4_000),
    speakerContributorId: boundedText(value.speakerContributorId, "speakerContributorId", 200),
    reason: boundedText(value.reason, "reason", 120),
  };
}

export function archiveTranscriptionMilliunits(planId: string, minutes: number) {
  if (!["nearlegacy", "archive_builder"].includes(planId)) throw new Error("NearLegacy creation access is required for archive transcription.");
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 180) throw new Error("Transcription minutes must be from 1 through 180.");
  return minutes * 1_000;
}

async function sha256(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

type ExportFile = { id: string; path: string; checksum: string; byteSize: number; recordingId?: string };
type MetadataFile = ExportFile & { category: string };
type ConsentReceipt = { id: string; contributorId: string; version: "legacy-consent-v1" | "legacy-synthetic-v1"; kind: "recording" | "transcription" | "synthetic"; audience: "household"; purpose: "private_archive" | "private_archive_narration"; status: "active" | "superseded" | "revoked" | "expired"; attestedAt: string; expiresAt: string | null; revokedAt: string | null; evidenceChecksum: string };

export async function buildLegacyExportManifest(input: { householdId: string; generatedAt: string; recordings: ExportFile[]; transcripts: ExportFile[]; photos?: ExportFile[]; metadata?: MetadataFile[]; consentReceipts: ConsentReceipt[] }) {
  boundedText(input.householdId, "householdId", 200);
  if (!Number.isFinite(Date.parse(input.generatedAt))) throw new Error("Export generation time is invalid.");
  const files = [...input.recordings.map((file) => ({ ...file, kind: "original_recording" as const })), ...input.transcripts.map((file) => ({ ...file, kind: "transcript" as const })), ...(input.photos || []).map((file) => ({ ...file, kind: "photo" as const })), ...(input.metadata || []).map((file) => ({ ...file, kind: "metadata" as const }))];
  const paths = new Set<string>(); const ids = new Set<string>();
  for (const file of files) {
    if (!SHA256.test(file.checksum) || !Number.isSafeInteger(file.byteSize) || file.byteSize < 0 || file.path.startsWith("/") || file.path.includes("..")) throw new Error("Export file metadata is invalid.");
    if (paths.has(file.path) || ids.has(file.id)) throw new Error("Export file paths and IDs must be unique.");
    paths.add(file.path); ids.add(file.id);
  }
  const consentReceipts = input.consentReceipts.map((receipt) => {
    if (Object.keys(receipt).some((key) => !["id", "contributorId", "version", "kind", "audience", "purpose", "status", "attestedAt", "expiresAt", "revokedAt", "evidenceChecksum"].includes(key))) throw new Error("Consent receipts cannot include sensitive evidence.");
    boundedText(receipt.id, "consent receipt id", 200); boundedText(receipt.contributorId, "consent contributor id", 200);
    const exactScope = receipt.kind === "synthetic" ? receipt.version === LEGACY_SYNTHETIC_CONSENT_VERSION && receipt.purpose === "private_archive_narration" : receipt.version === LEGACY_CONSENT_VERSION && receipt.purpose === "private_archive";
    if (!exactScope || receipt.audience !== "household" || !["active", "superseded", "revoked", "expired"].includes(receipt.status) || !Number.isFinite(Date.parse(receipt.attestedAt)) || (receipt.expiresAt !== null && !Number.isFinite(Date.parse(receipt.expiresAt))) || (receipt.revokedAt !== null && !Number.isFinite(Date.parse(receipt.revokedAt))) || !SHA256.test(receipt.evidenceChecksum)) throw new Error("Consent receipt metadata is invalid.");
    return { id: receipt.id, contributorId: receipt.contributorId, version: receipt.version, kind: receipt.kind, audience: receipt.audience, purpose: receipt.purpose, status: receipt.status, attestedAt: receipt.attestedAt, expiresAt: receipt.expiresAt, revokedAt: receipt.revokedAt, evidenceChecksum: receipt.evidenceChecksum };
  });
  const base = { version: "nearlegacy-portable-export-v1" as const, householdId: input.householdId, generatedAt: input.generatedAt, files, consentReceipts };
  return { ...base, manifestChecksum: await sha256(JSON.stringify(base)) };
}
