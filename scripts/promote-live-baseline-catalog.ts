import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { REQUIRED_CATALOG_KINDS } from "./check-catalog-manifest";
import { loadPostgresMigrations } from "./migrate";
import { canonicalPolicyDefinition, validateCatalogRows } from "./postgres-catalog";

const sha256=(value:string)=>createHash("sha256").update(value).digest("hex");
const invalid=()=>new Error("baseline catalog promotion invalid");

type Input={candidate:string;receipt:string;output:string;expectedCommitSha:string;expectedImageDigest:string;expectedRelease:string;expectedOperationId:string;expectedOperationStartedAt:number;expectedDatabaseName:string;expectedDatabaseUser:string;expectedReceiptUri:string;expectedReceiptGeneration:string;expectedReceiptContentSha256:string};

export async function promoteLiveBaselineCatalog(input:Input){
  if(!input.candidate.endsWith("catalog-manifest.baseline.candidate.json")||!input.receipt.endsWith("catalog-manifest.baseline.receipt.json")||!input.output.endsWith("catalog-manifest.baseline.reviewed.json")||!/^rel_[A-Za-z0-9_-]{8,100}$/.test(input.expectedRelease)||!/^op_[a-f0-9]{64}$/.test(input.expectedOperationId)||!Number.isSafeInteger(input.expectedOperationStartedAt)||!/[a-z]/i.test(input.expectedDatabaseUser)||!/^gs:\/\//.test(input.expectedReceiptUri)||!/^[1-9][0-9]{0,30}$/.test(input.expectedReceiptGeneration)||!/^[a-f0-9]{64}$/.test(input.expectedReceiptContentSha256))throw invalid();
  const body=await readFile(input.candidate,"utf8"),candidate=JSON.parse(body)as Record<string,unknown>,rows=candidate.rows,provenance=candidate.provenance as Record<string,unknown>|undefined;
  const receipt=JSON.parse(await readFile(input.receipt,"utf8"))as Record<string,unknown>;
  if(JSON.stringify(Object.keys(receipt).sort())!==JSON.stringify(["contentSha256","generation","uri"])||receipt.uri!==input.expectedReceiptUri||receipt.generation!==input.expectedReceiptGeneration||receipt.contentSha256!==input.expectedReceiptContentSha256||receipt.contentSha256!==sha256(body)||typeof receipt.uri!=="string"||!/^gs:\/\/[A-Za-z0-9._-]{3,222}\/[A-Za-z0-9_./-]*catalog-manifest\.baseline\.candidate\.json$/.test(receipt.uri))throw invalid();
  if(candidate.version!==1||candidate.reviewRequired!==true||candidate.generatedFrom!=="live-production-postgresql-16"||candidate.migrationHead!=="0006_private_canary_observation"||candidate.schema!=="nearyou"||JSON.stringify(candidate.requiredKinds)!==JSON.stringify(REQUIRED_CATALOG_KINDS)||JSON.stringify(candidate.requireForcedRls)!==JSON.stringify(["household_members","tenant_records"])||candidate.forbidPublicExecute!==true||JSON.stringify(candidate.security)!==JSON.stringify({forcedRls:["household_members","tenant_records"],publicExecuteCount:0})||!provenance||Array.isArray(provenance)||candidate.provenanceChecksum!==sha256(JSON.stringify(provenance)))throw invalid();
  try{validateCatalogRows(rows)}catch{throw invalid()}
  for(const row of rows.filter(row=>row.kind==="policy")){const parts=row.definition.split("|");if(parts.length!==4||!/^(?:ALL|SELECT|INSERT|UPDATE|DELETE)$/.test(parts[1]!))throw invalid();const roles=parts[0]!.split(",");if(!parts[0]||new Set(roles).size!==roles.length||roles.some(role=>!/^PUBLIC$|^[a-z_][a-z0-9_]{0,62}$/.test(role))||canonicalPolicyDefinition({roles,cmd:parts[1]!,qual:parts[2]||null,withCheck:parts[3]||null})!==row.definition)throw invalid()}
  const catalogChecksum=sha256(JSON.stringify(rows));
  if(candidate.catalogChecksum!==catalogChecksum||catalogChecksum==="0".repeat(64))throw invalid();
  const database=provenance.database as Record<string,unknown>|undefined,source=provenance.source as Record<string,unknown>|undefined,ledger=provenance.migrationLedger;
  if(database?.name!==input.expectedDatabaseName||database?.migrationAdmin!==input.expectedDatabaseUser||typeof database.serverVersion!=="number"||database.serverVersion<160000||database.serverVersion>=170000||source?.commitSha!==input.expectedCommitSha||source?.imageDigest!==input.expectedImageDigest||provenance.release!==input.expectedRelease||provenance.operationId!==input.expectedOperationId||provenance.operationStartedAt!==input.expectedOperationStartedAt||!Array.isArray(ledger))throw invalid();
  const migrations=(await loadPostgresMigrations()).slice(0,6).map(({id,checksum})=>({id,checksum}));
  if(JSON.stringify(ledger)!==JSON.stringify(migrations)||provenance.migrationLedgerChecksum!==sha256(migrations.map(row=>`${row.id}:${row.checksum}`).join("\n")))throw invalid();
  const reviewed={version:1,schema:"nearyou",catalogChecksum,generatedFrom:"reviewed-live-production-postgresql-16",reviewRequired:false,requiredKinds:REQUIRED_CATALOG_KINDS,requireForcedRls:["household_members","tenant_records"],forbidPublicExecute:true,migrationHead:"0006_private_canary_observation"};
  await writeFile(input.output,`${JSON.stringify(reviewed)}\n`,{flag:"wx"});
  return reviewed;
}

if(import.meta.url===`file://${process.argv[1]}`){const[candidate,receipt,output]=process.argv.slice(2),environment=process.env;const input={candidate:candidate??"",receipt:receipt??"",output:output??"",expectedCommitSha:environment.NEARYOU_DEPLOYED_SOURCE_COMMIT??"",expectedImageDigest:environment.NEARYOU_DEPLOYED_IMAGE_DIGEST??"",expectedRelease:environment.NEARYOU_RELEASE_ID??"",expectedOperationId:environment.NEARYOU_OPERATION_ID??"",expectedOperationStartedAt:Number(environment.NEARYOU_OPERATION_STARTED_AT),expectedDatabaseName:environment.NEARYOU_DATABASE_NAME??"",expectedDatabaseUser:environment.NEARYOU_MIGRATION_DATABASE_USER??"",expectedReceiptUri:environment.NEARYOU_BASELINE_RECEIPT_URI??"",expectedReceiptGeneration:environment.NEARYOU_BASELINE_RECEIPT_GENERATION??"",expectedReceiptContentSha256:environment.NEARYOU_BASELINE_RECEIPT_CONTENT_SHA256??""};promoteLiveBaselineCatalog(input).catch(()=>{process.stderr.write("baseline catalog promotion failed\n");process.exitCode=1})}
