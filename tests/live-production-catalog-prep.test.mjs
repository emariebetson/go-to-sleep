import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadPostgresMigrations } from "../scripts/migrate.ts";
import { REQUIRED_CATALOG_KINDS } from "../scripts/check-catalog-manifest.ts";
import { createGcsImmutableCatalogSink, fetchPriorBaselineAttestation, parseLiveCatalogPreparationArgs, prepareLiveProductionCatalog } from "../scripts/prepare-live-production-catalog.ts";
import { promoteCatalogManifest } from "../scripts/promote-catalog-manifest.ts";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const controllerUser = "nearyou-readiness-ctl@nearnight.iam.gserviceaccount.com";
const verifierUser = "nearyou-private-tester-baseline@nearnight.iam.gserviceaccount.com";
const controllerPrincipal = "service:nearyou-readiness-controller";
const verifierPrincipal = "service:nearyou-private-tester-baseline-verifier";
const catalogRows = REQUIRED_CATALOG_KINDS.map((kind, index) => ({ kind, identity: `nearyou.${kind}.${index}`, definition: `definition-${index}` }));
const catalogChecksum = sha256(JSON.stringify(catalogRows));
const baseline = { version: 1, schema: "nearyou", catalogChecksum, generatedFrom: "reviewed-supported-postgresql-16", reviewRequired: false, requiredKinds: REQUIRED_CATALOG_KINDS, requireForcedRls: ["household_members", "tenant_records"], forbidPublicExecute: true, migrationHead: "0006_private_canary_observation" };

async function fixture(overrides = {}) {
  const migrations = await loadPostgresMigrations();
  const ledger = (overrides.ledger ?? migrations.slice(0, 6).map(({ id, checksum }) => ({ id, checksum }))).map((row) => ({ ...row }));
  const events = [];
  const query = async (sql, args = []) => {
    if (sql.includes("current_database()")) return { rows: [overrides.target ?? { database_name: "nearyou", server_version: 160011, database_user: "nearyou_migration_admin", allowed: true }] };
    if (sql.startsWith("SELECT id,checksum FROM nearyou.schema_migrations")) return { rows: ledger };
    if (sql.startsWith("SELECT kind::text,identity::text,definition::text")) return { rows: catalogRows };
    if (sql.includes("public_execute_count")) return { rows: [{ forced_rls: ["household_members", "tenant_records"], public_execute_count: "0" }] };
    if (sql.startsWith("SELECT checksum FROM nearyou.schema_migrations")) return { rows: ledger.find((row) => row.id === args[0]) ? [{ checksum: ledger.find((row) => row.id === args[0]).checksum }] : [] };
    if (sql.startsWith("INSERT INTO nearyou.schema_migrations")) { events.push(`insert:${args[0]}`); ledger.push({ id: args[0], checksum: args[1] }); return { rows: [] }; }
    if (sql.includes("register_rollout_controller_identity")) return { rows: [{ database_user: args[0], principal: args[1], effective: true }] };
    if (sql.includes("register_private_tester_baseline_verifier_identity")) return { rows: [{ database_user: args[0], principal: args[1], effective: true }] };
    if (sql.includes("pg_has_role")) return { rows: [{ ok: true }] };
    return { rows: [] };
  };
  const pg = { transaction: async (run) => run({ query }) };
  const writes = [], baselineWrites=[];
  const priorCore = { migrationHead: "0006_private_canary_observation", catalogChecksum, attestedAt: Date.parse("2026-08-17T18:00:00.000Z"), release: "rel_20260817_private_01", source: { commitSha: "a".repeat(40), imageDigest: `sha256:${"b".repeat(64)}` }, operationId:`op_${"d".repeat(64)}` };
  const result = await prepareLiveProductionCatalog({
    databaseUrl: "postgres://migration-admin@production/nearyou",
    release: "rel_20260817_private_01",
    operationId: `op_${"d".repeat(64)}`,
    operationStartedAt: Date.parse("2026-08-17T18:00:00.000Z"),
    candidateKey: "catalog/rel_20260817_private_01/catalog-manifest.candidate.json",
    controllerDatabaseUser: controllerUser,
    controllerPrincipal,
    verifierDatabaseUser: verifierUser,
    verifierPrincipal,
  }, {
    connect: async () => ({ pg, query, close: async () => events.push("close") }),
    migrations,
    authoritativeSource: { commitSha: "a".repeat(40), imageDigest: `sha256:${"b".repeat(64)}` },
    reviewedBaseline: overrides.baseline ?? baseline,
    ...(overrides.omitPrior ? {} : { priorBaselineAttestation: overrides.priorBaselineAttestation ?? { ...priorCore, uri:"gs://nearyou-private-evidence/catalog/baseline-0006.json",generation:"122", digest: sha256(JSON.stringify(priorCore)) } }),
    now: () => Date.parse("2026-08-17T18:00:00.000Z"),
    immutableSink: overrides.immutableSink ?? { writeOnce: async (entry) => { writes.push(entry); return { uri: `gs://nearyou-evidence/${entry.key}`, generation: "1723917600000000", contentSha256: entry.contentSha256 }; } },
    immutableBaselineSink: { writeOnce: async (entry) => { events.push("baseline-attested");baselineWrites.push(entry); return { uri:`gs://nearyou-evidence/${entry.key}`,generation:"1723917500000000",contentSha256:entry.contentSha256 }; } },
  });
  return { result, writes, baselineWrites, events, migrations };
}

test("prepares a review-required catalog from exact live PostgreSQL 16 state and records immutable provenance", async () => {
  const { result, writes, events, migrations } = await fixture();
  assert.equal(result.candidate.generatedFrom, "live-production-postgresql-16");
  assert.equal(result.candidate.reviewRequired, true);
  assert.equal(result.candidate.migrationHead, "0007_private_tester_deployment_manifest");
  assert.deepEqual(result.candidate.provenance.migrationLedger, migrations.map(({ id, checksum }) => ({ id, checksum })));
  assert.deepEqual(result.candidate.provenance.source, { commitSha: "a".repeat(40), imageDigest: `sha256:${"b".repeat(64)}` });
  assert.deepEqual(result.candidate.provenance.baseline, { migrationHead: "0006_private_canary_observation", catalogChecksum });
  assert.deepEqual(result.candidate.provenance.identities, { controllerDatabaseUser: controllerUser, controllerPrincipal, verifierDatabaseUser: verifierUser, verifierPrincipal });
  assert.equal(Object.hasOwn(result.candidate, "ready"), false);
  assert.equal(Object.hasOwn(result.candidate, "gate"), false);
  assert.deepEqual(events.filter((event) => event.startsWith("insert:")), ["insert:0007_private_tester_deployment_manifest"]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].contentSha256, sha256(writes[0].body));
  assert.equal(result.receipt.contentSha256, writes[0].contentSha256);
});

test("fails before mutation unless database, authority, historical ledger, and reviewed baseline are exact", async () => {
  for (const overrides of [
    { target: { database_name: "postgres", server_version: 160011, database_user: "nearyou_migration_admin", allowed: true } },
    { target: { database_name: "nearyou", server_version: 150015, database_user: "nearyou_migration_admin", allowed: true } },
    { target: { database_name: "nearyou", server_version: 160011, database_user: "app", allowed: true } },
    { target: { database_name: "nearyou", server_version: 160011, database_user: "nearyou_migration_admin", allowed: false } },
    { ledger: [] },
    { baseline: { ...baseline, migrationHead: "0007_private_tester_deployment_manifest" } },
    { baseline: { ...baseline, catalogChecksum: "f".repeat(64) } },
  ]) await assert.rejects(() => fixture(overrides), /live catalog preparation precondition failed/);
});

test("fails closed when the immutable sink does not attest the exact bytes", async () => {
  await assert.rejects(() => fixture({ immutableSink: { writeOnce: async (entry) => ({ uri: "gs://bucket/object", generation: "1", contentSha256: `0${entry.contentSha256.slice(1)}` }) } }), /immutable catalog sink failed/);
});

test("resumes exact 0007 state without replaying migration and converges registrations", async () => {
  const migrations = await loadPostgresMigrations();
  const { events, result } = await fixture({ ledger: migrations.map(({ id, checksum }) => ({ id, checksum })) });
  assert.deepEqual(events.filter((event) => event.startsWith("insert:")), []);
  assert.equal(result.candidate.migrationHead, migrations.at(-1).id);
});

test("exact 0006 first run does not require a prior baseline attestation", async () => {
  const { events } = await fixture({ omitPrior: true });
  assert.ok(events.indexOf("baseline-attested") < events.indexOf("insert:0007_private_tester_deployment_manifest"));
});

test("first run baseline record supports byte-identical resume after a lost response", async () => {
  const first=await fixture({omitPrior:true}), record=JSON.parse(first.baselineWrites[0].body), prior={...record,uri:"gs://nearyou-evidence/catalog/rel_20260817_private_01/baseline-0006.json",generation:"1723917500000000"};
  const resumed=await fixture({ledger:first.migrations.map(({id,checksum})=>({id,checksum})),priorBaselineAttestation:prior});
  assert.equal(resumed.writes[0].body,first.writes[0].body);
  assert.equal(resumed.writes[0].contentSha256,first.writes[0].contentSha256);
});

test("rejects non-production, swapped, or equal identity tuples before mutation", async () => {
  const migrations = await loadPostgresMigrations(), base = { databaseUrl: "postgres://admin/x", release: "rel_20260817_private_01", candidateKey: "catalog/x/catalog-manifest.candidate.json", controllerDatabaseUser: controllerUser, controllerPrincipal, verifierDatabaseUser: verifierUser, verifierPrincipal };
  const dependencies = { migrations, authoritativeSource: { commitSha: "a".repeat(40), imageDigest: `sha256:${"b".repeat(64)}` }, reviewedBaseline: baseline, now: () => 1, connect: async () => { throw new Error("must not connect"); }, immutableSink: { writeOnce: async () => { throw new Error("must not write"); } } };
  for (const input of [{ ...base, controllerDatabaseUser: verifierUser }, { ...base, verifierPrincipal: controllerPrincipal }, { ...base, verifierDatabaseUser: controllerUser }]) await assert.rejects(() => prepareLiveProductionCatalog(input, dependencies), /precondition failed/);
});

test("promotion accepts exact live-production provenance and rejects tampering", async () => {
  const directory = await mkdtemp(join(tmpdir(), "live-catalog-promotion-"));
  try {
    const { result } = await fixture();
    const candidate = join(directory, "catalog-manifest.candidate.json"), receipt = join(directory, "catalog-manifest.receipt.json"), reviewed = join(directory, "catalog-manifest.reviewed.json"), candidateBody = `${JSON.stringify(result.candidate, null, 2)}\n`;
    await writeFile(candidate, candidateBody);
    await writeFile(receipt, `${JSON.stringify(result.receipt)}\n`);
    const authority = { expectedCommitSha: "a".repeat(40), expectedImageDigest: `sha256:${"b".repeat(64)}`, expectedBaselineChecksum: catalogChecksum, expectedMigrationLedgerChecksum: result.candidate.provenance.migrationLedgerChecksum };
    const promoted = await promoteCatalogManifest({ candidate, receipt, output: reviewed, ...authority });
    assert.equal(promoted.generatedFrom, "reviewed-live-production-postgresql-16");
    const tampered = join(directory, "tampered-catalog-manifest.candidate.json");
    await writeFile(tampered, `${JSON.stringify({ ...result.candidate, provenance: { ...result.candidate.provenance, source: { ...result.candidate.provenance.source, commitSha: "c".repeat(40) } } })}\n`);
    await assert.rejects(() => promoteCatalogManifest({ candidate: tampered, receipt, output: join(directory, "tampered-catalog-manifest.reviewed.json"), ...authority }), /catalog promotion invalid/);
    const wrongReceipt = join(directory, "wrong-catalog-manifest.receipt.json");
    await writeFile(wrongReceipt, `${JSON.stringify({ ...result.receipt, contentSha256: "0".repeat(64) })}\n`);
    await assert.rejects(() => promoteCatalogManifest({ candidate, receipt: wrongReceipt, output: join(directory, "wrong-catalog-manifest.reviewed.json"), ...authority }), /catalog promotion invalid/);
    await assert.rejects(() => promoteCatalogManifest({ candidate, receipt, output: join(directory, "wrong-authority.reviewed.json"), ...authority, expectedCommitSha: "c".repeat(40) }), /catalog promotion invalid/);
    assert.equal(JSON.parse(await readFile(reviewed, "utf8")).catalogChecksum, result.candidate.catalogChecksum);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("GCS sink creates one generation-zero object and verifies provider metadata", async () => {
  const contentSha256 = sha256("candidate\n");
  let request;
  const sink = createGcsImmutableCatalogSink({ bucket: "nearyou-private-evidence", accessToken: "token_abcdefghijklmnopqrstuvwxyz", fetch: async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify({ bucket: "nearyou-private-evidence", name: "catalog/release/catalog-manifest.candidate.json", generation: "123", metadata: { contentSha256 } }), { status: 200, headers: { "content-type": "application/json" } });
  } });
  const receipt = await sink.writeOnce({ key: "catalog/release/catalog-manifest.candidate.json", body: "candidate\n", contentSha256 });
  assert.match(request.url, /ifGenerationMatch=0/);
  assert.equal(request.init.method, "POST");
  assert.match(request.init.headers.authorization, /^Bearer /);
  assert.match(request.init.body, /candidate/);
  assert.deepEqual(receipt, { uri: "gs://nearyou-private-evidence/catalog/release/catalog-manifest.candidate.json", generation: "123", contentSha256 });
});

test("GCS sink converges after an upload response is lost", async () => {
  const contentSha256 = sha256("candidate\n"), calls = [];
  const sink = createGcsImmutableCatalogSink({ bucket: "nearyou-private-evidence", accessToken: "token_abcdefghijklmnopqrstuvwxyz", fetch: async (url, init) => {
    calls.push({ url, method: init?.method ?? "GET" });
    if (init?.method === "POST") return new Response("conflict", { status: 412 });
    if (url.includes("alt=media")) return new Response("candidate\n", { status: 200 });
    return new Response(JSON.stringify({ bucket: "nearyou-private-evidence", name: "catalog/release/catalog-manifest.candidate.json", generation: "123", metadata: { contentSha256 } }), { status: 200, headers: { "content-type": "application/json" } });
  } });
  const receipt = await sink.writeOnce({ key: "catalog/release/catalog-manifest.candidate.json", body: "candidate\n", contentSha256 });
  assert.equal(receipt.generation, "123");
  assert.deepEqual(calls.map((call) => call.method), ["POST", "GET", "GET"]);
  assert.match(calls[2].url, /[?&]generation=123(?:&|$)/);
});

test("CLI parser rejects ambiguous secrets and requires exact provenance", () => {
  const args = ["--prepare-live-production-catalog", "--release", "rel_20260817_private_01", "--operation-id", `op_${"d".repeat(64)}`, "--operation-started-at", "1786993200000", "--candidate-key", "catalog/release/catalog-manifest.candidate.json", "--database-url-file", "/secret/database-url"];
  assert.deepEqual(parseLiveCatalogPreparationArgs(args).release, "rel_20260817_private_01");
  assert.throws(() => parseLiveCatalogPreparationArgs([...args, "--source-commit", "c".repeat(40)]), /arguments invalid/);
});

test("prior baseline core is downloaded from its exact immutable generation and bound to trusted coordinates", async () => {
  const core = { migrationHead:"0006_private_canary_observation", catalogChecksum, attestedAt:1, release:"rel_20260817_private_01", source:{commitSha:"a".repeat(40),imageDigest:`sha256:${"b".repeat(64)}`},operationId:`op_${"d".repeat(64)}` }, value = { ...core, digest:sha256(JSON.stringify(core)) }, body = `${JSON.stringify(value)}\n`, expectedObjectSha256 = sha256(body), uri="gs://nearyou-private-evidence/catalog/baseline-0006.json", generation="122";
  let url;
  const loaded = await fetchPriorBaselineAttestation({ uri, generation, expectedObjectSha256, accessToken:"token_abcdefghijklmnopqrstuvwxyz", fetch:async (input)=>{url=input;return new Response(body,{status:200})} });
  assert.match(url, /generation=122/);
  assert.deepEqual(loaded, { ...value, uri, generation });
});
