import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { operationalArtifact } from "./evidence-artifact";

type ObservedRls = {
  fixtureTenants: number;
  positiveControls: number;
  crossTenantChecks: number;
  mutationDenials: number;
  crossTenantViolations: number;
};

export function validateObservedRls(value: unknown): ObservedRls {
  const result = value as Record<string, unknown>;
  const keys = ["crossTenantChecks", "crossTenantViolations", "fixtureTenants", "mutationDenials", "positiveControls"];
  if (!result || Object.getPrototypeOf(result) !== Object.prototype || JSON.stringify(Object.keys(result).sort()) !== JSON.stringify(keys)) throw new Error("rls evidence invalid");
  for (const key of keys) if (!Number.isSafeInteger(result[key]) || Number(result[key]) < 0) throw new Error("rls evidence invalid");
  if (result.fixtureTenants !== 2 || result.positiveControls !== 5 || result.crossTenantChecks !== 5 || result.mutationDenials !== 2 || result.crossTenantViolations !== 0) throw new Error("rls evidence invalid");
  return result as ObservedRls;
}

export async function buildRlsEvidence(observedRaw: string, environment: Record<string, string | undefined> = process.env) {
  if (Buffer.byteLength(observedRaw) > 4096) throw new Error("rls evidence invalid");
  const observed = validateObservedRls(JSON.parse(observedRaw));
  const sql = await readFile(new URL("./postgres-rls-gate.sql", import.meta.url), "utf8");
  return operationalArtifact({ ...observed, sourceChecksum: createHash("sha256").update(sql).digest("hex") }, environment);
}

async function main() {
  const [observedPath, output] = process.argv.slice(2);
  if (!observedPath || !output) throw new Error("rls evidence invalid");
  const evidence = await buildRlsEvidence(await readFile(observedPath, "utf8"));
  await writeFile(output, `${JSON.stringify(evidence)}\n`, { flag: "wx" });
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(() => { process.stderr.write("rls evidence failed\n"); process.exitCode = 1; });
