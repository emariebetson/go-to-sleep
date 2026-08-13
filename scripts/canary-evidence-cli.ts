/* eslint-disable @typescript-eslint/no-explicit-any -- runtime-only pg is dynamically loaded */
import { createHash } from "node:crypto";
import { createPostgresCanarySampleStore } from "../lib/postgres-canary-evidence";
import { reconcileOutcomeLedgers } from "../lib/outcome-reconciliation";
import { operationalArtifact } from "./evidence-artifact";

async function main() {
  const mode = process.argv[2], release = process.env.RELEASE_ID;
  if (!release || !new Set(["sample", "finalize"]).has(mode)) throw new Error("canary configuration missing");
  if (mode === "sample") {
    const endpoint = process.env.CANARY_METRICS_URL ?? "", token = process.env.CANARY_METRICS_TOKEN ?? "";
    if (!/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{2,5})?\//.test(endpoint) || token.length < 100 || token.split(".").length !== 3) throw new Error("canary sample configuration invalid");
    const response = await fetch(endpoint, { method: "POST", redirect: "error", headers: { authorization: `Bearer ${token}` } }), raw = await response.text();
    if (!response.ok || raw.length > 4096 || typeof (JSON.parse(raw) as { inserted?: unknown }).inserted !== "boolean") throw new Error("canary sample failed");
    return;
  }
  const url = process.env.READINESS_CONTROL_DATABASE_URL;
  if (!url) throw new Error("canary configuration missing");
  const name = "pg", { Pool } = await import(name) as any, pool = new Pool({ connectionString: url }), store = createPostgresCanarySampleStore(pool, release);
  try {
    const endpoint = process.env.OUTCOME_RECONCILIATION_URL ?? "", audience = process.env.OUTCOME_RECONCILIATION_AUDIENCE ?? "", token = process.env.CANARY_METRICS_TOKEN ?? "";
    if (!/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{2,5})?\//.test(endpoint) || !/^https:\/\//.test(audience) || token.length < 100 || token.split(".").length !== 3) throw new Error("reconciliation configuration invalid");
    const response = await fetch(endpoint, { redirect: "error", headers: { authorization: `Bearer ${token}` } }), raw = await response.text();
    if (!response.ok || raw.length > 65536) throw new Error("reconciliation failed");
    const d1 = JSON.parse(raw), pg = (await pool.query("SELECT terminal_count::text,terminal_digest FROM nearyou.load_operational_outcome_reconciliation($1)", [release])).rows[0], reconciliation = await reconcileOutcomeLedgers({ d1, pg: { terminalCount: Number(pg.terminal_count), terminalDigest: String(pg.terminal_digest) } }), canary = await store.finalize(), reconciliationArtifact = createHash("sha256").update(raw).digest("hex");
    process.stdout.write(JSON.stringify(operationalArtifact({ ...canary, ...reconciliation, reconciliationArtifact, outboxDeadLetters: reconciliation.deadLetters })) + "\n");
  } finally { await pool.end(); }
}
main().catch(() => { process.stderr.write("canary evidence failed\n"); process.exitCode = 1; });
