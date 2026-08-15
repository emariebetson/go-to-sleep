import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import {
  canonicalPrivateTesterDeploymentClaims,
  canonicalPrivateTesterReleaseOperation,
  composePrivateTesterDeploymentManifest,
  verifyPrivateTesterDeploymentManifestSignature,
  type PrivateTesterDeploymentEnvelope,
} from "../lib/private-tester-deployment-manifest";
import { CloudKmsEvidenceSigner, CloudKmsPublicKeyClient } from "../lib/release-evidence-adapters";

const MAX_INPUT_BYTES = 16 * 1024;
const TOKEN_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
type ExclusiveIo = {
  writeFile(path: string, body: string, options: { flag: "wx" }): Promise<unknown>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
};

function outputBody(envelope: PrivateTesterDeploymentEnvelope): string {
  return `{"claims":${canonicalPrivateTesterDeploymentClaims(envelope.claims)},"signature":${JSON.stringify(envelope.signature)}}\n`;
}
export async function writePrivateTesterDeploymentManifestExclusive(outputPath: string, envelope: PrivateTesterDeploymentEnvelope, io: ExclusiveIo = { writeFile, readFile }): Promise<PrivateTesterDeploymentEnvelope> {
  if (typeof outputPath !== "string" || outputPath.length < 1 || outputPath.length > 4_096) throw new Error("private tester deployment output invalid");
  const body = outputBody(envelope);
  try { await io.writeFile(outputPath, body, { flag: "wx" }); }
  catch {
    let existing: string;
    try { existing = await io.readFile(outputPath, "utf8"); } catch { throw new Error("private tester deployment output failed"); }
    if (existing !== body) throw new Error("private tester deployment output conflict");
  }
  return envelope;
}

function environmentValue(environment: NodeJS.ProcessEnv, name: string, pattern: RegExp): string {
  const value = environment[name];
  if (!value || !pattern.test(value)) throw new Error("private tester deployment configuration missing");
  return value;
}
async function metadataAccessToken(fetcher: typeof fetch): Promise<string> {
  let response: Response;
  try { response = await fetcher(TOKEN_URL, { headers: { "metadata-flavor": "Google" }, signal: AbortSignal.timeout(5_000) }); }
  catch { throw new Error("private tester deployment identity unavailable"); }
  const raw = await response.text();
  if (!response.ok || new TextEncoder().encode(raw).byteLength > 16_384) throw new Error("private tester deployment identity unavailable");
  try {
    const value = JSON.parse(raw) as { access_token?: unknown; expires_in?: unknown };
    if (typeof value.access_token !== "string" || !/^[A-Za-z0-9._~-]{20,4096}$/.test(value.access_token) || !Number.isSafeInteger(value.expires_in) || Number(value.expires_in) < 60 || Number(value.expires_in) > 3_600) throw new Error();
    return value.access_token;
  } catch { throw new Error("private tester deployment identity unavailable"); }
}

export async function composePrivateTesterDeploymentManifestFile(inputPath: string, outputPath: string, environment: NodeJS.ProcessEnv = process.env, dependencies: { fetch?: typeof fetch; now?: () => number; nonce?: () => string; io?: ExclusiveIo } = {}): Promise<PrivateTesterDeploymentEnvelope> {
  if (!inputPath || inputPath.length > 4_096) throw new Error("private tester deployment input invalid");
  const raw = await readFile(inputPath, "utf8");
  if (Buffer.byteLength(raw) > MAX_INPUT_BYTES) throw new Error("private tester deployment input invalid");
  let observed: unknown;
  try { observed = JSON.parse(raw); } catch { throw new Error("private tester deployment input invalid"); }
  if (raw.trim() !== canonicalPrivateTesterReleaseOperation(observed)) throw new Error("private tester deployment input invalid");
  const claims = composePrivateTesterDeploymentManifest(observed, dependencies.now ?? Date.now, dependencies.nonce ?? (() => randomBytes(32).toString("base64url")));
  const project = environmentValue(environment, "KMS_PROJECT", /^[a-z][a-z0-9-]{2,62}$/), location = environmentValue(environment, "KMS_LOCATION", /^[A-Za-z0-9_-]{1,255}$/), keyRing = environmentValue(environment, "KMS_KEY_RING", /^[A-Za-z0-9_-]{1,255}$/), key = environmentValue(environment, "KMS_KEY", /^[A-Za-z0-9_-]{1,255}$/), principal = environmentValue(environment, "EVIDENCE_PRINCIPAL", /^[A-Za-z0-9_:/.@-]{3,200}$/), keyId = environmentValue(environment, "EVIDENCE_KEY_ID", /^[A-Za-z0-9_:/.@-]{3,200}$/), version = Number(environment.EVIDENCE_KEY_VERSION);
  if (!Number.isSafeInteger(version) || version < 1 || claims.principal !== principal || claims.keyId !== keyId || claims.keyVersion !== version) throw new Error("private tester deployment signer mismatch");
  let token: string | undefined;
  const accessToken = async () => token ??= await metadataAccessToken(dependencies.fetch ?? fetch);
  const versionedKeyName = `projects/${project}/locations/${location}/keyRings/${keyRing}/cryptoKeys/${key}/cryptoKeyVersions/${version}`;
  const signature = await new CloudKmsEvidenceSigner({ versionedKeyName, accessToken, fetch: dependencies.fetch }).sign(canonicalPrivateTesterDeploymentClaims(claims));
  const publicKeys = new CloudKmsPublicKeyClient({ project, location, keyRing, key, principal, keyId, accessToken, fetch: dependencies.fetch });
  const record = await publicKeys.lookup(principal, keyId, version), envelope = { claims, signature };
  await verifyPrivateTesterDeploymentManifestSignature(envelope, (dependencies.now ?? Date.now)(), record);
  return writePrivateTesterDeploymentManifestExclusive(outputPath, envelope, dependencies.io);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath || !outputPath) throw new Error("private tester deployment configuration missing");
  composePrivateTesterDeploymentManifestFile(inputPath, outputPath).catch(() => { process.stderr.write("private tester deployment manifest failed\n"); process.exitCode = 1; });
}
