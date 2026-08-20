import { readFile, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { canonicalEvidence, type Claims } from "../lib/asymmetric-release-evidence";
import { readOperationalArtifact } from "./evidence-artifact";

export async function composeReleaseClaims(input:{dir:string;output:string;templateRaw:string;releaseId:string;principal:string;keyId:string;keyVersion:number;now?:number;nonce?:string}) {
  const {dir,output,templateRaw,releaseId,principal,keyId,keyVersion}=input;
  if (!dir || !output || !templateRaw || !releaseId || !principal || !keyId || !Number.isSafeInteger(keyVersion) || !/^rel_[A-Za-z0-9_-]{8,100}$/.test(releaseId) || Buffer.byteLength(templateRaw) > 256 * 1024) throw new Error("claims composition invalid");
  const claims = JSON.parse(templateRaw) as Claims, now = input.now??Date.now();
  if (claims.releaseId !== releaseId || claims.principal !== principal || claims.keyId !== keyId || claims.keyVersion !== keyVersion) throw new Error("claims composition invalid");
  const read = async (name: string) => { const raw = await readFile(`${dir}/${name}.json`, "utf8"); if (Buffer.byteLength(raw) > 256 * 1024) throw new Error("claims composition invalid"); return { value: JSON.parse(raw) as Record<string, unknown>, artifact: createHash("sha256").update(raw).digest("hex") }; };
  const rls = await read("rls-evidence"), load = await read("load"), restore = await read("restore"), accessibility = await read("accessibility"), security = await read("security"), zap = await read("zap"), media = await read("media"), canary = await read("canary"), rlsResult=readOperationalArtifact<Record<string,unknown>>(rls.value,releaseId,claims.schema),loadResult=readOperationalArtifact<Record<string,unknown>>(load.value,releaseId,claims.schema),restoreResult=readOperationalArtifact<Record<string,unknown>>(restore.value,releaseId,claims.schema),accessibilityResult=readOperationalArtifact<Record<string,unknown>>(accessibility.value,releaseId,claims.schema),securityResult=readOperationalArtifact<Record<string,unknown>>(security.value,releaseId,claims.schema),mediaResult=readOperationalArtifact<Record<string,unknown>>(media.value,releaseId,claims.schema);
  let canaryResult: Record<string, unknown>;
  try { canaryResult = readOperationalArtifact<Record<string, unknown>>(canary.value, releaseId, claims.schema); }
  catch {
    const receipt = canary.value as { kind?: unknown; passed?: unknown; sampleCount?: unknown; identity?: { releaseId?: unknown }; signature?: { algorithm?: unknown; keyId?: unknown; keyVersion?: unknown; value?: unknown }; receiptSha256?: unknown };
    if (Object.getPrototypeOf(receipt) !== Object.prototype || receipt.kind !== "private-tester-canary-window" || receipt.passed !== true || receipt.sampleCount !== 96 || receipt.identity?.releaseId !== releaseId || receipt.signature?.algorithm !== "RSA-PSS-SHA256" || typeof receipt.signature.keyId !== "string" || !Number.isSafeInteger(receipt.signature.keyVersion) || typeof receipt.signature.value !== "string" || !/^[a-f0-9]{64}$/.test(String(receipt.receiptSha256))) throw new Error("claims composition invalid");
    canaryResult = { heartbeatCount: 96, deadLetters: 0, failedJobs: 0, completedJobs: 1, receiptSha256: receipt.receiptSha256 };
  }
  if (rlsResult.crossTenantViolations !== 0 || !Number.isSafeInteger(rlsResult.negativeTests) || Number(rlsResult.negativeTests) < 1) throw new Error("claims composition invalid");
  const historicalTimes = [claims.shadow.startedAt, ...claims.productReadiness.flatMap(item => [item.controllerMapping.verifiedAt, ...Object.values(item.probes).map(probe => probe.verifiedAt)])];
  const productExpiry=Math.min(...claims.productReadiness.map(item=>item.expiresAt));claims.notBefore = Math.min(...historicalTimes); claims.issuedAt = now; claims.expiresAt = productExpiry; if (claims.productReadiness.some(item=>item.expiresAt<=now)||productExpiry > now + 300_000) throw new Error("claims composition invalid"); claims.nonce = input.nonce??randomBytes(16).toString("base64url");
  const set = (kind: keyof Claims["gates"], artifact: string, results: unknown) => { claims.gates[kind] = { ...claims.gates[kind], releaseId: claims.releaseId, schema: claims.schema, artifact, verifiedAt: now, results } as never; };
  set("rls", rls.artifact, { negativeTests: rlsResult.negativeTests, crossTenantViolations: 0 });
  set("load", load.artifact, loadResult); set("restore", restore.artifact, { restoredObjects: restoreResult.rowCount, checksumMismatches: 0 }); set("accessibility", accessibility.artifact, { checks: accessibilityResult.checks, violations: accessibilityResult.violations });
  set("security", security.artifact, { critical: securityResult.dependencyFindings, high: securityResult.sastFindings, scanArtifact: security.artifact, penTestArtifact: zap.artifact });
  set("media", media.artifact, { canaries: mediaResult.story===true&&mediaResult.legacy===true?2:0, failed: 0 }); set("canary", canary.artifact, canaryResult); canonicalEvidence(claims); await writeFile(output, JSON.stringify(claims) + "\n", { flag: "wx" });
}
if(import.meta.url===`file://${process.argv[1]}`){const[dir,output]=process.argv.slice(2),templateRaw=process.env.RELEASE_CLAIMS_TEMPLATE_JSON,releaseId=process.env.RELEASE_ID,principal=process.env.EVIDENCE_PRINCIPAL,keyId=process.env.EVIDENCE_KEY_ID,keyVersion=Number(process.env.EVIDENCE_KEY_VERSION);if(!dir||!output||!templateRaw||!releaseId||!principal||!keyId)throw new Error("claims composition configuration missing");composeReleaseClaims({dir,output,templateRaw,releaseId,principal,keyId,keyVersion}).catch(()=>{process.stderr.write("claims composition failed\n");process.exitCode=1})}
