import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { applyPostgresMigrations, loadPostgresMigrations, type MigrationFile } from "./migrate";
import { registerRolloutController, type AdminPg } from "./register-rollout-controller";
import { registerPrivateTesterBaselineVerifier } from "./register-private-tester-baseline-verifier";
import { collectLiveCatalog, verifyLiveCatalogSecurity } from "./postgres-catalog";
import { REQUIRED_CATALOG_KINDS } from "./check-catalog-manifest";

const HASH = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const RELEASE = /^rel_[A-Za-z0-9_-]{8,100}$/;
const IMAGE = /^sha256:[a-f0-9]{64}$/;
const OPERATION = /^op_[a-f0-9]{64}$/;
const KEY = /^[A-Za-z0-9_./-]{10,500}catalog-manifest\.candidate\.json$/;
const BASELINE_KEY = /^[A-Za-z0-9_./-]{10,500}baseline-0006\.json$/;
const BASELINE_CANDIDATE_KEY = /^[A-Za-z0-9_./-]{10,500}baseline-0006\.candidate\.json$/;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const migrationChecksum = (files: MigrationFile[]) => sha256(files.map((file) => `${file.id}:${file.checksum}`).join("\n"));

type Query = { query<T>(sql: string, args?: unknown[]): Promise<{ rows: T[] }> };
type Connection = Query & { pg: AdminPg; close(): Promise<void> };
type ReviewedBaseline = { version: number; schema: string; catalogChecksum: string; generatedFrom: string; reviewRequired?: boolean; migrationHead: string; requiredKinds: readonly string[]; requireForcedRls: readonly string[]; forbidPublicExecute: boolean };
type SinkEntry = { key: string; body: string; contentSha256: string };
type SinkReceipt = { uri: string; generation: string; contentSha256: string };

type CliOptions = { release: string; operationId:string; operationStartedAt:number; candidateKey: string; databaseUrlFile: string };
const PRODUCTION_IDENTITIES = Object.freeze({ controllerDatabaseUser: "nearyou-readiness-ctl@nearnight.iam.gserviceaccount.com", controllerPrincipal: "service:nearyou-readiness-controller", verifierDatabaseUser: "nearyou-private-tester-baseline@nearnight.iam.gserviceaccount.com", verifierPrincipal: "service:nearyou-private-tester-baseline-verifier" });

export function parseLiveCatalogPreparationArgs(args: string[]): CliOptions {
  const allowed = new Set(["--release", "--operation-id", "--operation-started-at", "--candidate-key", "--database-url-file"]), values = new Map<string, string>();
  let mode = false;
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index]!;
    if (key === "--prepare-live-production-catalog") { if (mode) throw new Error("live catalog preparation arguments invalid"); mode = true; continue; }
    if (!allowed.has(key) || values.has(key) || !args[index + 1] || args[index + 1]!.startsWith("--")) throw new Error("live catalog preparation arguments invalid");
    values.set(key, args[++index]!);
  }
  const result = { release: values.get("--release") ?? "", operationId:values.get("--operation-id")??"", operationStartedAt:Number(values.get("--operation-started-at")), candidateKey: values.get("--candidate-key") ?? "", databaseUrlFile: values.get("--database-url-file") ?? "" };
  if (!mode || !RELEASE.test(result.release) || !OPERATION.test(result.operationId) || !Number.isSafeInteger(result.operationStartedAt) || result.operationStartedAt<1 || !KEY.test(result.candidateKey) || !result.databaseUrlFile.startsWith("/")) throw new Error("live catalog preparation arguments invalid");
  return result;
}

export function createGcsImmutableCatalogSink(input: { bucket: string; accessToken: string; fetch?: typeof fetch }) {
  if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(input.bucket) || !/^[A-Za-z0-9._-]{20,4096}$/.test(input.accessToken)) throw new Error("immutable catalog sink configuration invalid");
  const request = input.fetch ?? fetch;
  return { writeOnce: async (entry: SinkEntry): Promise<SinkReceipt> => {
    if (!(KEY.test(entry.key) || BASELINE_KEY.test(entry.key) || BASELINE_CANDIDATE_KEY.test(entry.key)) || !HASH.test(entry.contentSha256) || sha256(entry.body) !== entry.contentSha256) throw new Error("immutable catalog sink failed");
    const boundary = `nearyou-${crypto.randomUUID()}`;
    const metadata = JSON.stringify({ name: entry.key, metadata: { contentSha256: entry.contentSha256 } });
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${entry.body}\r\n--${boundary}--`;
    let response = await request(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(input.bucket)}/o?uploadType=multipart&ifGenerationMatch=0`, { method: "POST", headers: { authorization: `Bearer ${input.accessToken}`, "content-type": `multipart/related; boundary=${boundary}` }, body });
    let recovered: { bucket?: string; name?: string; generation?: string; metadata?: { contentSha256?: string } } | undefined;
    if (response.status === 412) {
      response = await request(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(input.bucket)}/o/${encodeURIComponent(entry.key)}?fields=bucket,name,generation,metadata`, { headers: { authorization: `Bearer ${input.accessToken}` } });
      if (!response.ok) throw new Error("immutable catalog sink failed");
      recovered = await response.json() as { bucket?: string; name?: string; generation?: string; metadata?: { contentSha256?: string } };
      if (!recovered.generation || !/^[1-9][0-9]{0,30}$/.test(recovered.generation)) throw new Error("immutable catalog sink failed");
      const media = await request(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(input.bucket)}/o/${encodeURIComponent(entry.key)}?alt=media&generation=${encodeURIComponent(recovered.generation)}`, { headers: { authorization: `Bearer ${input.accessToken}` } });
      if (!media.ok || sha256(await media.text()) !== entry.contentSha256) throw new Error("immutable catalog sink failed");
    }
    if (!response.ok) throw new Error("immutable catalog sink failed");
    const result = recovered ?? await response.json() as { bucket?: string; name?: string; generation?: string; metadata?: { contentSha256?: string } };
    if (result.bucket !== input.bucket || result.name !== entry.key || result.metadata?.contentSha256 !== entry.contentSha256 || !result.generation) throw new Error("immutable catalog sink failed");
    return { uri: `gs://${result.bucket}/${result.name}`, generation: result.generation, contentSha256: entry.contentSha256 };
  } };
}

export async function fetchGoogleMetadataAccessToken(input: { fetch?: typeof fetch } = {}) {
  const response = await (input.fetch ?? fetch)("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", { headers: { "Metadata-Flavor": "Google" } });
  if (!response.ok) throw new Error("metadata token invalid");
  const value = await response.json() as { access_token?: string; expires_in?: number; token_type?: string };
  if (value.token_type !== "Bearer" || typeof value.access_token !== "string" || !/^[A-Za-z0-9._-]{40,4096}$/.test(value.access_token) || !Number.isInteger(value.expires_in) || value.expires_in! < 300 || value.expires_in! > 3600) throw new Error("metadata token invalid");
  return value.access_token;
}

export async function fetchPriorBaselineAttestation(input:{uri:string;generation:string;expectedObjectSha256:string;accessToken:string;fetch?:typeof fetch}) {
  const match = /^gs:\/\/([a-z0-9][a-z0-9._-]{1,220}[a-z0-9])\/(.+baseline-0006\.json)$/.exec(input.uri);
  if (!match || !/^[1-9][0-9]{0,30}$/.test(input.generation) || !HASH.test(input.expectedObjectSha256) || !/^[A-Za-z0-9._-]{20,4096}$/.test(input.accessToken)) throw new Error("baseline attestation invalid");
  const response = await (input.fetch ?? fetch)(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(match[1]!)}/o/${encodeURIComponent(match[2]!)}?alt=media&generation=${input.generation}`, { headers:{authorization:`Bearer ${input.accessToken}`} });
  const body = await response.text();
  if (!response.ok || sha256(body) !== input.expectedObjectSha256) throw new Error("baseline attestation invalid");
  return { ...JSON.parse(body), uri:input.uri, generation:input.generation };
}

export type LiveCatalogPreparationInput = {
  databaseUrl: string;
  release: string;
  operationId:string;
  operationStartedAt:number;
  candidateKey: string;
  controllerDatabaseUser: string;
  controllerPrincipal: string;
  verifierDatabaseUser: string;
  verifierPrincipal: string;
};

type Dependencies = {
  connect(url: string): Promise<Connection>;
  migrations?: MigrationFile[];
  authoritativeSource: { commitSha: string; imageDigest: string };
  reviewedBaseline?: ReviewedBaseline;
  priorBaselineAttestation?: { migrationHead:string;catalogChecksum:string;uri:string;generation:string;attestedAt:number;release:string;operationId:string;source:{commitSha:string;imageDigest:string};digest:string };
  now(): number;
  immutableSink: { writeOnce(entry: SinkEntry): Promise<SinkReceipt> };
  immutableBaselineSink?: { writeOnce(entry: SinkEntry): Promise<SinkReceipt> };
};

function precondition(value: unknown, code = "precondition"): asserts value {
  if (!value) throw new Error(`live catalog preparation ${code}`);
}

async function atStage<T>(code: "database-connect-failed" | "target-authority-invalid" | "ledger-state-invalid" | "baseline-state-invalid" | "bootstrap-migration-failed", operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) { throw new Error(`live catalog preparation ${code}`, { cause: error }); }
}

export function databaseConnectionFailureCode(error: unknown) {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  if (["ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "EHOSTUNREACH", "ETIMEDOUT", "ENOTFOUND"].includes(code)) return "database-connect-network";
  if (["28P01", "28000"].includes(code)) return "database-connect-auth";
  if (code === "3D000") return "database-connect-database";
  return "database-connect-unknown";
}

export function bootstrapMigrationFailureCode(error: unknown) {
  const cause=error instanceof Error&&error.cause?error.cause:error, code=typeof cause==="object"&&cause!==null&&"code" in cause?String(cause.code):"", match=error instanceof Error?/migration execution failed:(000[1-6]_[a-z0-9_]+)/.exec(error.message):null, suffix=match?`-${match[1]!.slice(0,4)}`:"";
  if(code==="42501")return `bootstrap-migration-privilege${suffix}`;
  if(code==="0A000"||code==="58P01")return `bootstrap-migration-feature${suffix}`;
  if(code==="42P17"||code==="42601")return `bootstrap-migration-definition${suffix}`;
  if(["42P06","42P07","42710","23505"].includes(code))return `bootstrap-migration-collision${suffix}`;
  return `bootstrap-migration-unknown${suffix}`;
}

export function liveCatalogPreparationFailureCode(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (message === "live catalog preparation database-connect-failed" && error instanceof Error && error.cause)
    return databaseConnectionFailureCode(error.cause);
  if (message === "live catalog preparation bootstrap-migration-failed" && error instanceof Error && error.cause)
    return bootstrapMigrationFailureCode(error.cause);
  for (const code of ["input-invalid", "source-invalid", "identity-invalid", "migration-set-invalid", "database-connect-failed", "target-authority-invalid", "ledger-state-invalid", "baseline-state-invalid", "baseline-review-required"])
    if (message === `live catalog preparation ${code}`) return code;
  if (/connect|ECONN|timeout|ENOTFOUND|password authentication/i.test(message)) return "database-connect-failed";
  if (/metadata token invalid/.test(message)) return "workload-token-failed";
  if (/immutable catalog sink/.test(message)) return "storage-invalid";
  return "preparation-failed";
}

function exactBaseline(value: ReviewedBaseline, checksum: string) {
  precondition(value.version === 1 && value.schema === "nearyou" && value.generatedFrom === "reviewed-live-production-postgresql-16" && value.reviewRequired !== true);
  precondition(value.migrationHead === "0006_private_canary_observation" && value.catalogChecksum === checksum && HASH.test(value.catalogChecksum));
  precondition(JSON.stringify(value.requiredKinds) === JSON.stringify(REQUIRED_CATALOG_KINDS));
  precondition(JSON.stringify(value.requireForcedRls) === JSON.stringify(["household_members", "tenant_records"]) && value.forbidPublicExecute === true);
}

export async function prepareLiveProductionCatalog(input: LiveCatalogPreparationInput, dependencies: Dependencies) {
  precondition(/^postgres(?:ql)?:\/\//.test(input.databaseUrl) && RELEASE.test(input.release) && OPERATION.test(input.operationId) && Number.isSafeInteger(input.operationStartedAt) && input.operationStartedAt>0 && KEY.test(input.candidateKey), "input-invalid");
  precondition(COMMIT.test(dependencies.authoritativeSource.commitSha) && IMAGE.test(dependencies.authoritativeSource.imageDigest), "source-invalid");
  precondition(JSON.stringify({ controllerDatabaseUser: input.controllerDatabaseUser, controllerPrincipal: input.controllerPrincipal, verifierDatabaseUser: input.verifierDatabaseUser, verifierPrincipal: input.verifierPrincipal }) === JSON.stringify(PRODUCTION_IDENTITIES), "identity-invalid");
  const files = dependencies.migrations ?? await loadPostgresMigrations();
  precondition(files.length === 7 && files[5]?.id === "0006_private_canary_observation" && files[6]?.id === "0007_private_tester_deployment_manifest", "migration-set-invalid");
  const historical = files.slice(0, 6).map(({ id, checksum }) => ({ id, checksum }));
  const connection = await atStage("database-connect-failed", () => dependencies.connect(input.databaseUrl));
  try {
    const target = (await atStage("target-authority-invalid", () => connection.query<{ database_name: string; server_version: number; database_user: string; allowed: boolean; pristine:boolean; vector_available:boolean; can_set_cloudsqlsuperuser:boolean }>(
      "SELECT current_database()::text AS database_name,current_setting('server_version_num')::integer AS server_version,current_user::text AS database_user,(rolcreaterole AND (rolsuper OR pg_has_role(current_user,'cloudsqlsuperuser','USAGE'))) AS allowed,to_regnamespace('nearyou') IS NULL AS pristine,EXISTS(SELECT 1 FROM pg_available_extensions WHERE name='vector') AS vector_available,(rolsuper OR pg_has_role(current_user,'cloudsqlsuperuser','SET')) AS can_set_cloudsqlsuperuser FROM pg_roles WHERE rolname=current_user",
      [],
    ))).rows[0];
    precondition(target?.database_name === "nearyou" && target.server_version >= 160000 && target.server_version < 170000 && target.allowed === true && target.vector_available === true && target.can_set_cloudsqlsuperuser === true && /migration|postgres|admin/i.test(target.database_user), "target-authority-invalid");
    if (target.pristine === true) await atStage("bootstrap-migration-failed",()=>applyPostgresMigrations(connection.pg, files.slice(0,6), migrationChecksum(files.slice(0,6)),{setLocalRole:"cloudsqlsuperuser"}));
    const liveLedger = (await atStage("ledger-state-invalid", () => connection.query<{ id: string; checksum: string }>("SELECT id,checksum FROM nearyou.schema_migrations ORDER BY id COLLATE \"C\"", []))).rows;
    const expectedLedger = files.map(({ id, checksum }) => ({ id, checksum }));
    const from0006 = JSON.stringify(liveLedger) === JSON.stringify(historical), from0007 = JSON.stringify(liveLedger) === JSON.stringify(expectedLedger);
    precondition(from0006 || from0007, "ledger-state-invalid");
    const reviewedBaseline = dependencies.reviewedBaseline ?? JSON.parse(await readFile(new URL("../postgres/catalog-manifest.json", import.meta.url), "utf8")) as ReviewedBaseline;
    if (from0006) {
      const baselineRows = await atStage("baseline-state-invalid", () => collectLiveCatalog(connection)), baselineChecksum = sha256(JSON.stringify(baselineRows));
      if (target.pristine === true || reviewedBaseline.generatedFrom !== "reviewed-live-production-postgresql-16" || reviewedBaseline.catalogChecksum !== baselineChecksum) {
        const security = await atStage("baseline-state-invalid", () => verifyLiveCatalogSecurity(connection));
        const baselineCandidate = { version:1,schema:"nearyou",catalogChecksum:baselineChecksum,generatedFrom:"live-production-postgresql-16",reviewRequired:true,requiredKinds:REQUIRED_CATALOG_KINDS,requireForcedRls:["household_members","tenant_records"],forbidPublicExecute:true,migrationHead:"0006_private_canary_observation",security,provenance:{database:{name:"nearyou",serverVersion:target.server_version,migrationAdmin:target.database_user},source:dependencies.authoritativeSource,release:input.release,operationId:input.operationId,capturedAt:input.operationStartedAt},rows:baselineRows };
        const body=`${JSON.stringify(baselineCandidate,null,2)}\n`, contentSha256=sha256(body), key=input.candidateKey.replace(/catalog-manifest\.candidate\.json$/, "baseline-0006.candidate.json");
        const receipt=await dependencies.immutableSink.writeOnce({key,body,contentSha256});
        precondition(receipt.contentSha256===contentSha256,"baseline-state-invalid");
        throw new Error("live catalog preparation baseline-review-required");
      }
      exactBaseline(reviewedBaseline, baselineChecksum);
      precondition(dependencies.immutableBaselineSink);
      const baselineCore = { migrationHead:reviewedBaseline.migrationHead,catalogChecksum:reviewedBaseline.catalogChecksum,release:input.release,source:dependencies.authoritativeSource,attestedAt:input.operationStartedAt,operationId:input.operationId }, baselineRecord = { ...baselineCore,digest:sha256(JSON.stringify(baselineCore)) }, baselineBody = `${JSON.stringify(baselineRecord)}\n`, baselineKey = input.candidateKey.replace(/catalog-manifest\.candidate\.json$/, "baseline-0006.json"), baselineBodyChecksum = sha256(baselineBody);
      const baselineReceipt = await dependencies.immutableBaselineSink.writeOnce({key:baselineKey,body:baselineBody,contentSha256:baselineBodyChecksum});
      precondition(baselineReceipt.contentSha256 === baselineBodyChecksum && /^[1-9][0-9]{0,30}$/.test(baselineReceipt.generation));
    } else {
      exactBaseline(reviewedBaseline, reviewedBaseline.catalogChecksum);
      precondition(dependencies.priorBaselineAttestation);
      const { digest,uri,generation,...attestation } = dependencies.priorBaselineAttestation;
      precondition(attestation.migrationHead === reviewedBaseline.migrationHead && attestation.catalogChecksum === reviewedBaseline.catalogChecksum && attestation.release === input.release && attestation.operationId===input.operationId && attestation.attestedAt===input.operationStartedAt && JSON.stringify(attestation.source) === JSON.stringify(dependencies.authoritativeSource) && /^gs:\/\//.test(uri) && /^[1-9][0-9]{0,30}$/.test(generation) && digest === sha256(JSON.stringify(attestation)));
    }

    const migration = await applyPostgresMigrations(connection.pg, files, migrationChecksum(files));
    const controller = await registerRolloutController(connection.pg, input.controllerDatabaseUser, input.controllerPrincipal);
    const verifier = await registerPrivateTesterBaselineVerifier(connection.pg, input.verifierDatabaseUser, input.verifierPrincipal);
    precondition(controller.controllerMappingVerified === true && verifier.baselineVerifierMappingVerified === true);
    const finalLedger = (await connection.query<{ id: string; checksum: string }>("SELECT id,checksum FROM nearyou.schema_migrations ORDER BY id COLLATE \"C\"", [])).rows;
    precondition(JSON.stringify(finalLedger) === JSON.stringify(expectedLedger));
    const rows = await collectLiveCatalog(connection);
    const security = await verifyLiveCatalogSecurity(connection);
    precondition(REQUIRED_CATALOG_KINDS.every((kind) => rows.some((row) => row.kind === kind)));
    const provenance = {
      database: { name: "nearyou", serverVersion: target.server_version, migrationAdmin: target.database_user },
      source: dependencies.authoritativeSource,
      baseline: { migrationHead: reviewedBaseline.migrationHead, catalogChecksum: reviewedBaseline.catalogChecksum },
      migrationLedger: expectedLedger,
      migrationLedgerChecksum: migration.migrationLedgerChecksum,
      identities: { controllerDatabaseUser: input.controllerDatabaseUser, controllerPrincipal: input.controllerPrincipal, verifierDatabaseUser: input.verifierDatabaseUser, verifierPrincipal: input.verifierPrincipal },
      release: input.release,
      operationId:input.operationId,
      capturedAt: input.operationStartedAt,
    };
    const candidate = {
      version: 1,
      reviewRequired: true,
      generatedFrom: "live-production-postgresql-16",
      migrationHead: files[6].id,
      schema: "nearyou",
      catalogChecksum: sha256(JSON.stringify(rows)),
      requiredKinds: REQUIRED_CATALOG_KINDS,
      requireForcedRls: ["household_members", "tenant_records"],
      forbidPublicExecute: true,
      security,
      provenance,
      provenanceChecksum: sha256(JSON.stringify(provenance)),
      rows,
    } as const;
    const body = `${JSON.stringify(candidate, null, 2)}\n`, contentSha256 = sha256(body);
    const receipt = await dependencies.immutableSink.writeOnce({ key: input.candidateKey, body, contentSha256 });
    if (!receipt || receipt.contentSha256 !== contentSha256 || !/^gs:\/\/[A-Za-z0-9._-]{3,222}\/[A-Za-z0-9_./-]{1,1024}$/.test(receipt.uri) || !/^[1-9][0-9]{0,30}$/.test(receipt.generation)) throw new Error("immutable catalog sink failed");
    return { candidate, receipt };
  } finally {
    await connection.close();
  }
}

async function defaultConnect(connectionString: string): Promise<Connection> {
  const moduleName = "pg", { Pool } = await import(moduleName) as { Pool: new (input: { connectionString: string }) => { connect(): Promise<{ query<T>(sql: string, args?: unknown[]): Promise<{ rows: T[] }>; release(): void }>; end(): Promise<void> } };
  const pool = new Pool({ connectionString }), client = await pool.connect();
  const pg: AdminPg = { transaction: async (run) => { await client.query("BEGIN"); try { const result = await run({ query: (sql, args = []) => client.query(sql, args) }); await client.query("COMMIT"); return result; } catch (error) { await client.query("ROLLBACK"); throw error; } } };
  return { pg, query: (sql, args = []) => client.query(sql, args), close: async () => { client.release(); await pool.end(); } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const options = parseLiveCatalogPreparationArgs(process.argv.slice(2)), secret = (await readFile(options.databaseUrlFile, "utf8")).trim(), environment = process.env;
    if (!/^postgres(?:ql)?:\/\//.test(secret) || Buffer.byteLength(secret) > 8192 || !environment.NEARYOU_DEPLOYED_SOURCE_COMMIT || !environment.NEARYOU_DEPLOYED_IMAGE_DIGEST || !environment.NEARYOU_CATALOG_EVIDENCE_BUCKET) throw new Error("live catalog preparation configuration invalid");
    const accessToken = await fetchGoogleMetadataAccessToken();
    const priorCoordinates=[environment.NEARYOU_PRIOR_BASELINE_ATTESTATION_URI,environment.NEARYOU_PRIOR_BASELINE_ATTESTATION_GENERATION,environment.NEARYOU_PRIOR_BASELINE_ATTESTATION_SHA256];
    if(priorCoordinates.some(Boolean)&&!priorCoordinates.every(Boolean))throw new Error("live catalog preparation configuration invalid");
    const priorBaselineAttestation=priorCoordinates.every(Boolean)?await fetchPriorBaselineAttestation({uri:priorCoordinates[0]!,generation:priorCoordinates[1]!,expectedObjectSha256:priorCoordinates[2]!,accessToken}):undefined;
    const sink=createGcsImmutableCatalogSink({ bucket: environment.NEARYOU_CATALOG_EVIDENCE_BUCKET, accessToken });
    const result = await prepareLiveProductionCatalog({ databaseUrl: secret, release: options.release, operationId:options.operationId, operationStartedAt:options.operationStartedAt, candidateKey: options.candidateKey, ...PRODUCTION_IDENTITIES }, { connect: defaultConnect, authoritativeSource: { commitSha: environment.NEARYOU_DEPLOYED_SOURCE_COMMIT, imageDigest: environment.NEARYOU_DEPLOYED_IMAGE_DIGEST }, priorBaselineAttestation, now: () => options.operationStartedAt, immutableSink:sink,immutableBaselineSink:sink });
    process.stdout.write(`${JSON.stringify({ receipt: result.receipt, catalogChecksum: result.candidate.catalogChecksum, reviewRequired: true })}\n`);
  })().catch((error) => { process.stderr.write(`live catalog preparation failed: ${liveCatalogPreparationFailureCode(error)}\n`); process.exitCode = 1; });
}
