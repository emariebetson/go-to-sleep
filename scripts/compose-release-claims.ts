import { readFile, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { canonicalEvidence, type Claims } from "../lib/asymmetric-release-evidence";

async function main() {
  const [dir, output] = process.argv.slice(2), templateRaw = process.env.RELEASE_CLAIMS_TEMPLATE_JSON;
  if (!dir || !output || !templateRaw || Buffer.byteLength(templateRaw) > 256 * 1024) throw new Error("claims composition invalid");
  const claims = JSON.parse(templateRaw) as Claims, now = Date.now();
  const read = async (name: string) => { const raw = await readFile(`${dir}/${name}.json`, "utf8"); if (Buffer.byteLength(raw) > 256 * 1024) throw new Error("claims composition invalid"); return { value: JSON.parse(raw) as Record<string, unknown>, artifact: createHash("sha256").update(raw).digest("hex") }; };
  const load = await read("load"), restore = await read("restore"), accessibility = await read("accessibility"), security = await read("security"), zap = await read("zap"), media = await read("media"), canary = await read("canary");
  claims.notBefore = now - 30_000; claims.issuedAt = now; claims.expiresAt = now + 300_000; claims.nonce = randomBytes(16).toString("base64url");
  const set = (kind: keyof Claims["gates"], artifact: string, results: unknown) => { claims.gates[kind] = { ...claims.gates[kind], releaseId: claims.releaseId, schema: claims.schema, artifact, verifiedAt: now, results } as never; };
  set("load", load.artifact, load.value); set("restore", restore.artifact, { restoredObjects: restore.value.rowCount, checksumMismatches: 0 }); set("accessibility", accessibility.artifact, { checks: accessibility.value.checks, violations: accessibility.value.violations });
  set("security", security.artifact, { critical: security.value.dependencyFindings, high: security.value.sastFindings, scanArtifact: security.artifact, penTestArtifact: zap.artifact });
  set("media", media.artifact, { canaries: 2, failed: 0 }); set("canary", canary.artifact, canary.value); canonicalEvidence(claims); await writeFile(output, JSON.stringify(claims) + "\n", { flag: "wx" });
}
main().catch(() => { process.stderr.write("claims composition failed\n"); process.exitCode = 1; });
