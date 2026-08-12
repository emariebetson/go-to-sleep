#!/usr/bin/env tsx
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

type Phase = "backfill" | "shadow" | "delta" | "cutover" | "rollback";
const phase = process.argv[2] as Phase | undefined;
const allowed = new Set<Phase>(["backfill", "shadow", "delta", "cutover", "rollback"]);
if (!phase || !allowed.has(phase)) throw new Error("Usage: postgres-cutover.ts <backfill|shadow|delta|cutover|rollback>");
if (!process.env.DATABASE_URL?.includes("sslmode=")) throw new Error("A TLS-enforced DATABASE_URL is required.");
if (!process.env.NEARYOU_RELEASE_ID) throw new Error("NEARYOU_RELEASE_ID is required.");

const migration = await readFile(new URL("../postgres/migrations/0001_nearyou_tenant_foundation.sql", import.meta.url));
const schemaChecksum = createHash("sha256").update(migration).digest("hex");

// The deployment runner injects a checked-out PostgreSQL client and D1 export
// manifest. This CLI intentionally refuses to mutate either store when those
// bindings are absent; it is a release contract, not an implicit provisioning tool.
if (!process.env.NEARYOU_CUTOVER_RUNNER) throw new Error(`Cutover ${phase} is dark: NEARYOU_CUTOVER_RUNNER is not configured.`);

process.stdout.write(JSON.stringify({ phase, releaseId: process.env.NEARYOU_RELEASE_ID, schemaChecksum, state: "runner_required" }) + "\n");
