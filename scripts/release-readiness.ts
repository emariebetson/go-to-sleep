#!/usr/bin/env tsx
import { readFile } from "node:fs/promises";
const required = ["releaseId", "schemaChecksum", "backfillChecksum", "rlsNegativeTest", "shadowReads", "mediaWorker", "restoreDrill", "loadGate", "accessibilityGate", "securityGate"];
const raw = process.argv[2];
if (!raw) throw new Error("Provide a path to a non-secret release evidence JSON file.");
const evidence = JSON.parse(await readFile(raw, "utf8"));
const verificationFields = new Set(["rlsNegativeTest", "shadowReads", "mediaWorker", "restoreDrill", "loadGate", "accessibilityGate", "securityGate"]);
const missing = required.filter((key) => !evidence[key] || (verificationFields.has(key) && evidence[key] !== "verified"));
if (missing.length) process.stderr.write(`EVIDENCE SHAPE INVALID: ${missing.join(", ")}\n`);
else process.stdout.write(`EVIDENCE SHAPE VALID: ${evidence.releaseId} ${evidence.schemaChecksum}\n`);
process.stderr.write("BLOCKED: this lint does not authenticate evidence or authorize a deployment. The managed release verifier must validate CI identity, signatures, artifact hashes, freshness, and durable database rows.\n");
process.exitCode = 1;
