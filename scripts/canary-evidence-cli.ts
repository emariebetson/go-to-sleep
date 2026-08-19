import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const RELEASE = /^rel_[A-Za-z0-9_-]{8,100}$/;
const BUILD = /^build_[A-Za-z0-9_-]{8,100}$/;
const DEPLOYMENT = /^deploy_[A-Za-z0-9_-]{8,100}$/;
const HASH = /^[a-f0-9]{64}$/;
const INTERVAL_MS = 15 * 60_000;
const WINDOW_SAMPLES = 96;
const MAX_HEARTBEAT_AGE_MS = 5 * 60_000;
const MAX_ERROR_RATE_BPS = 100;

export type PrivateTesterCanaryIdentity = Readonly<{ releaseId: string; buildId: string; deploymentId: string; startedAt: number }>;
export type PrivateTesterCanaryProof = Readonly<{
  releaseId: string; buildId: string; deploymentId: string; scheduledAt: number; observedAt: number;
  nearStoryInvited: boolean; nearStoryDenied: boolean; nearFamilyInvited: boolean; nearFamilyDenied: boolean;
  dataIntegrity: boolean; deadLetters: number; workerFailures: number; errorRateBps: number; heartbeatAt: number;
}>;
export type PrivateTesterCanarySample = Readonly<PrivateTesterCanaryProof & { version: 1; slot: number; windowKey: string }>;
export type Task6RollbackProof = Readonly<{ version: 1; passed: true; releaseId: string; gatesRemainOff: true; resultHash: string }>;
export type PrivateTesterCanaryStore = {
  insert(windowKey: string, sample: PrivateTesterCanarySample): Promise<{ created: boolean; existing?: PrivateTesterCanarySample }>;
  list(windowKey: string): Promise<PrivateTesterCanarySample[]>;
  writeReceipt(windowKey: string, raw: string): Promise<{ created: boolean; existing?: string }>;
};

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stable(item)]));
}
function canonical(value: unknown): string { return `${JSON.stringify(stable(value))}\n`; }
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function validIdentity(identity: PrivateTesterCanaryIdentity): boolean { return RELEASE.test(identity.releaseId) && BUILD.test(identity.buildId) && DEPLOYMENT.test(identity.deploymentId) && Number.isSafeInteger(identity.startedAt); }
function sameIdentity(left: Pick<PrivateTesterCanaryIdentity, "releaseId" | "buildId" | "deploymentId">, right: Pick<PrivateTesterCanaryIdentity, "releaseId" | "buildId" | "deploymentId">): boolean { return left.releaseId === right.releaseId && left.buildId === right.buildId && left.deploymentId === right.deploymentId; }
export function privateTesterCanaryWindowKey(identity: PrivateTesterCanaryIdentity): string { if (!validIdentity(identity)) throw new Error("private tester canary input invalid"); return sha256(canonical(identity)); }

async function failClosed(requestKill: (reason: string) => Promise<void>, reason: string): Promise<never> {
  try { await requestKill(reason); } catch { /* A failing local proof adapter must never reopen the evidence gate. */ }
  throw new Error(`private tester canary failed: ${reason}`);
}
function sampleFor(identity: PrivateTesterCanaryIdentity, proof: PrivateTesterCanaryProof): PrivateTesterCanarySample | undefined {
  if (!sameIdentity(identity, proof) || !Number.isSafeInteger(proof.scheduledAt) || !Number.isSafeInteger(proof.observedAt) || !Number.isSafeInteger(proof.heartbeatAt)) return undefined;
  const slot = (proof.scheduledAt - identity.startedAt) / INTERVAL_MS;
  if (!Number.isSafeInteger(slot) || slot < 0 || slot >= WINDOW_SAMPLES) return undefined;
  return Object.freeze({ version: 1, slot, windowKey: privateTesterCanaryWindowKey(identity), ...proof });
}
function failedProofReason(sample: PrivateTesterCanarySample): string | undefined {
  if (sample.observedAt < sample.scheduledAt || sample.observedAt - sample.scheduledAt >= INTERVAL_MS) return "late";
  if (!sample.nearStoryInvited || sample.nearStoryDenied || !sample.nearFamilyInvited || sample.nearFamilyDenied) return "authorization";
  if (!sample.dataIntegrity) return "integrity";
  if (!Number.isSafeInteger(sample.deadLetters) || sample.deadLetters !== 0) return "dead_letters";
  if (!Number.isSafeInteger(sample.workerFailures) || sample.workerFailures !== 0) return "worker";
  if (!Number.isSafeInteger(sample.errorRateBps) || sample.errorRateBps < 0 || sample.errorRateBps > MAX_ERROR_RATE_BPS) return "errors";
  if (sample.heartbeatAt > sample.observedAt || sample.observedAt - sample.heartbeatAt > MAX_HEARTBEAT_AGE_MS) return "heartbeat";
  return undefined;
}

/** File-only generation-zero storage for disposable/local evidence. */
export function createLocalGenerationZeroCanaryStore(directory: string): PrivateTesterCanaryStore {
  const base = join(directory, "private-tester-canary");
  async function writeOnce(path: string, raw: string): Promise<{ created: boolean; existing?: string }> {
    await mkdir(base, { recursive: true });
    try { await writeFile(path, raw, { encoding: "utf8", flag: "wx" }); return { created: true }; }
    catch (error: unknown) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      return { created: false, existing: await readFile(path, "utf8") };
    }
  }
  return Object.freeze({
    async insert(windowKey, sample) {
      const raw = canonical(sample), result = await writeOnce(join(base, `${windowKey}.sample-${String(sample.slot).padStart(3, "0")}.json`), raw);
      return result.created ? { created: true } : { created: false, existing: JSON.parse(result.existing ?? "") as PrivateTesterCanarySample };
    },
    async list(windowKey) {
      try {
        const names = (await readdir(base)).filter((name) => new RegExp(`^${windowKey}\\.sample-\\d{3}\\.json$`).test(name)).sort();
        return Promise.all(names.map(async (name) => JSON.parse(await readFile(join(base, name), "utf8")) as PrivateTesterCanarySample));
      } catch (error: unknown) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
        throw error;
      }
    },
    async writeReceipt(windowKey, raw) { return writeOnce(join(base, `${windowKey}.final.json`), raw); },
  });
}

export async function recordPrivateTesterCanarySample(identity: PrivateTesterCanaryIdentity, proof: PrivateTesterCanaryProof, deps: { store: PrivateTesterCanaryStore; currentBinding(): Promise<PrivateTesterCanaryIdentity>; requestKill(reason: string): Promise<void> }) {
  if (!validIdentity(identity) || !sameIdentity(identity, await deps.currentBinding())) return failClosed(deps.requestKill, "binding");
  const sample = sampleFor(identity, proof);
  if (!sample) return failClosed(deps.requestKill, "binding");
  const reason = failedProofReason(sample);
  if (reason) return failClosed(deps.requestKill, reason);
  let inserted: { created: boolean; existing?: PrivateTesterCanarySample };
  try { inserted = await deps.store.insert(sample.windowKey, sample); } catch { return failClosed(deps.requestKill, "storage"); }
  if (!inserted.created) {
    if (canonical(inserted.existing) !== canonical(sample)) return failClosed(deps.requestKill, "duplicate");
    return Object.freeze({ recorded: false as const, resumed: true as const, sample: inserted.existing });
  }
  return Object.freeze({ recorded: true as const, resumed: false as const, sample });
}

function validRollback(identity: PrivateTesterCanaryIdentity, result: Task6RollbackProof): boolean { return result.version === 1 && result.passed === true && result.releaseId === identity.releaseId && result.gatesRemainOff === true && HASH.test(result.resultHash); }
export async function finalizePrivateTesterCanaryWindow(identity: PrivateTesterCanaryIdentity, deps: { store: PrivateTesterCanaryStore; rollbackRecheck(): Promise<Task6RollbackProof>; signReceipt(raw: string): Promise<{ keyId: string; signature: string }>; requestKill(reason: string): Promise<void> }) {
  if (!validIdentity(identity)) return failClosed(deps.requestKill, "binding");
  const windowKey = privateTesterCanaryWindowKey(identity);
  let samples: PrivateTesterCanarySample[];
  try { samples = await deps.store.list(windowKey); } catch { return failClosed(deps.requestKill, "storage"); }
  if (samples.length !== WINDOW_SAMPLES) return failClosed(deps.requestKill, "discontinuity");
  for (let slot = 0; slot < WINDOW_SAMPLES; slot++) {
    const sample = samples[slot];
    if (!sample || sample.slot !== slot || sample.windowKey !== windowKey || !sameIdentity(identity, sample) || sample.scheduledAt !== identity.startedAt + slot * INTERVAL_MS || failedProofReason(sample)) return failClosed(deps.requestKill, "discontinuity");
  }
  let rollback: Task6RollbackProof;
  try { rollback = await deps.rollbackRecheck(); } catch { return failClosed(deps.requestKill, "rollback"); }
  if (!validRollback(identity, rollback)) return failClosed(deps.requestKill, "rollback");
  const coveredUntil = identity.startedAt + WINDOW_SAMPLES * INTERVAL_MS;
  const unsigned = canonical({ version: 1, kind: "private-tester-canary-window", identity, windowKey, sampleCount: WINDOW_SAMPLES, coveredUntil, samplesSha256: sha256(canonical(samples)), rollbackResultHash: rollback.resultHash });
  let signature: { keyId: string; signature: string };
  try { signature = await deps.signReceipt(unsigned); } catch { return failClosed(deps.requestKill, "signature"); }
  if (!/^[A-Za-z0-9._-]{3,160}$/.test(signature.keyId) || !/^[A-Za-z0-9+/_=-]{16,8192}$/.test(signature.signature)) return failClosed(deps.requestKill, "signature");
  const receipt = Object.freeze({ version: 1 as const, kind: "private-tester-canary-window" as const, identity, windowKey, passed: true as const, sampleCount: WINDOW_SAMPLES, coveredUntil, samplesSha256: sha256(canonical(samples)), rollbackResultHash: rollback.resultHash, signature, receiptSha256: sha256(unsigned) });
  const raw = canonical(receipt);
  let written: { created: boolean; existing?: string };
  try { written = await deps.store.writeReceipt(windowKey, raw); } catch { return failClosed(deps.requestKill, "storage"); }
  if (!written.created && written.existing !== raw) return failClosed(deps.requestKill, "receipt_conflict");
  return receipt;
}

async function main(): Promise<void> {
  if (process.env.LOCAL_CANARY_EVIDENCE !== "true") throw new Error("local canary evidence requires explicit local mode");
  const [command, directory, identityRaw, proofRaw] = process.argv.slice(2);
  if (command !== "sample-local" || !directory || !identityRaw || !proofRaw) throw new Error("local canary evidence input invalid");
  const identity = JSON.parse(identityRaw) as PrivateTesterCanaryIdentity, proof = JSON.parse(proofRaw) as PrivateTesterCanaryProof;
  await recordPrivateTesterCanarySample(identity, proof, { store: createLocalGenerationZeroCanaryStore(directory), currentBinding: async () => identity, requestKill: async () => { throw new Error("local evidence cannot invoke a kill switch"); } });
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch(() => { process.stderr.write("local private tester canary evidence failed\n"); process.exitCode = 1; });
