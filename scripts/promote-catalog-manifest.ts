import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { currentPostgresMigrationHead, REQUIRED_CATALOG_KINDS } from "./check-catalog-manifest";
import { validateCatalogRows } from "./postgres-catalog";

const sha256 = (value:string) => createHash("sha256").update(value).digest("hex");

export async function promoteCatalogManifest(input:{candidate:string;receipt?:string;output:string;expectedCommitSha?:string;expectedImageDigest?:string;expectedBaselineChecksum?:string;expectedMigrationLedgerChecksum?:string}) {
  if (!input.candidate.endsWith("catalog-manifest.candidate.json") || !input.output.endsWith("catalog-manifest.reviewed.json")) throw new Error("catalog promotion invalid");
  const candidateBody = await readFile(input.candidate, "utf8"), candidate = JSON.parse(candidateBody) as Record<string,unknown>, rows = candidate.rows, source = candidate.generatedFrom, provenance = candidate.provenance;
  if (!Array.isArray(rows) || candidate.version !== 1 || candidate.reviewRequired !== true || source !== "live-production-postgresql-16" || candidate.migrationHead !== await currentPostgresMigrationHead() || candidate.schema !== "nearyou" || JSON.stringify(candidate.requiredKinds) !== JSON.stringify(REQUIRED_CATALOG_KINDS) || JSON.stringify(candidate.requireForcedRls) !== JSON.stringify(["household_members", "tenant_records"]) || candidate.forbidPublicExecute !== true || JSON.stringify(candidate.security) !== JSON.stringify({ forcedRls:["household_members", "tenant_records"], publicExecuteCount:0 })) throw new Error("catalog promotion invalid");
  if (source === "live-production-postgresql-16") {
    if (!input.receipt?.endsWith("catalog-manifest.receipt.json") || !provenance || typeof provenance !== "object" || Array.isArray(provenance) || candidate.provenanceChecksum !== sha256(JSON.stringify(provenance))) throw new Error("catalog promotion invalid");
    const receipt = JSON.parse(await readFile(input.receipt, "utf8")) as Record<string,unknown>;
    if (JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify(["contentSha256", "generation", "uri"]) || receipt.contentSha256 !== sha256(candidateBody) || typeof receipt.uri !== "string" || !/^gs:\/\/[A-Za-z0-9._-]{3,222}\/[A-Za-z0-9_./-]+catalog-manifest\.candidate\.json$/.test(receipt.uri) || typeof receipt.generation !== "string" || !/^[1-9][0-9]{0,30}$/.test(receipt.generation)) throw new Error("catalog promotion invalid");
    const p = provenance as Record<string,unknown>, database = p.database as Record<string,unknown>|undefined, baseline = p.baseline as Record<string,unknown>|undefined, sourceFacts = p.source as Record<string,unknown>|undefined, identities = p.identities as Record<string,unknown>|undefined, ledger = p.migrationLedger;
    const exactIdentities = { controllerDatabaseUser:"nearyou-readiness-ctl@nearnight.iam.gserviceaccount.com", controllerPrincipal:"service:nearyou-readiness-controller", verifierDatabaseUser:"nearyou-private-tester-baseline@nearnight.iam.gserviceaccount.com", verifierPrincipal:"service:nearyou-private-tester-baseline-verifier" };
    if (sourceFacts?.commitSha !== input.expectedCommitSha || sourceFacts?.imageDigest !== input.expectedImageDigest || baseline?.catalogChecksum !== input.expectedBaselineChecksum || p.migrationLedgerChecksum !== input.expectedMigrationLedgerChecksum) throw new Error("catalog promotion invalid");
    if (database?.name !== "nearyou" || typeof database.serverVersion !== "number" || database.serverVersion < 160000 || database.serverVersion >= 170000 || typeof database.migrationAdmin !== "string" || !/migration|postgres|admin/i.test(database.migrationAdmin) || baseline?.migrationHead !== "0006_private_canary_observation" || typeof baseline.catalogChecksum !== "string" || !/^[a-f0-9]{64}$/.test(baseline.catalogChecksum) || typeof sourceFacts?.commitSha !== "string" || !/^[a-f0-9]{40}$/.test(sourceFacts.commitSha) || typeof sourceFacts.imageDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(sourceFacts.imageDigest) || JSON.stringify(identities) !== JSON.stringify(exactIdentities) || !Array.isArray(ledger) || ledger.length !== 7 || ledger.at(-1)?.id !== candidate.migrationHead || ledger.some((item,index) => !item || typeof item !== "object" || Object.keys(item).length !== 2 || !/^000[1-7]_[a-z0-9_]+$/.test(item.id) || !/^[a-f0-9]{64}$/.test(item.checksum) || index > 0 && item.id <= ledger[index-1].id) || p.migrationLedgerChecksum !== sha256(ledger.map((item) => `${item.id}:${item.checksum}`).join("\n"))) throw new Error("catalog promotion invalid");
  }
  validateCatalogRows(rows);
  const checksum = sha256(JSON.stringify(rows));
  if (candidate.catalogChecksum !== checksum || checksum === "0".repeat(64)) throw new Error("catalog promotion invalid");
  const reviewed = { version:1, schema:"nearyou", catalogChecksum:checksum, generatedFrom:source === "live-production-postgresql-16" ? "reviewed-live-production-postgresql-16" : "reviewed-supported-postgresql-16", reviewRequired:false, requiredKinds:REQUIRED_CATALOG_KINDS, requireForcedRls:["household_members", "tenant_records"], forbidPublicExecute:true, migrationHead:candidate.migrationHead };
  await writeFile(input.output, `${JSON.stringify(reviewed)}\n`, { flag:"wx" });
  return reviewed;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const candidate = process.argv[2], receipt = process.argv[3], output = process.argv[4];
  const expectedCommitSha = process.env.NEARYOU_DEPLOYED_SOURCE_COMMIT, expectedImageDigest = process.env.NEARYOU_DEPLOYED_IMAGE_DIGEST, expectedBaselineChecksum = process.env.NEARYOU_REVIEWED_0006_CATALOG_CHECKSUM, expectedMigrationLedgerChecksum = process.env.NEARYOU_REVIEWED_0007_LEDGER_CHECKSUM;
  if (!candidate || !receipt || !output || !expectedCommitSha || !expectedImageDigest || !expectedBaselineChecksum || !expectedMigrationLedgerChecksum) throw new Error("catalog promotion configuration missing");
  promoteCatalogManifest({ candidate, receipt, output, expectedCommitSha, expectedImageDigest, expectedBaselineChecksum, expectedMigrationLedgerChecksum }).catch(() => { process.stderr.write("catalog promotion failed\n"); process.exitCode = 1; });
}
