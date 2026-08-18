import {createHash} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {readFileSync,writeFileSync} from "node:fs";
import {splitD1Migration} from "../lib/sites-d1-forward-operation";
import {SITES_D1_PHASE_A_BOOTSTRAP} from "../lib/sites-d1-phase-a-operation";

const root=new URL("../",import.meta.url);
const HASH=/^[a-f0-9]{64}$/;
const migrationIds=["0007_nearsleep_production_upgrade","0008_nearsleep_live_integration","0009_nearsleep_audio_atomic"] as const;
const evidencePaths={
  ledger:process.env.D1_PHASE_A_LEDGER_EVIDENCE,
  schema:process.env.D1_PHASE_A_SCHEMA_EVIDENCE,
  shape:process.env.D1_PHASE_A_SHAPE_EVIDENCE,
};
const providerIdentities=new Set([
  "index\u0000sqlite_autoindex___appgarden_migrations_1\u0000__appgarden_migrations",
  "table\u0000__appgarden_migrations\u0000__appgarden_migrations",
  "table\u0000_cf_KV\u0000_cf_KV",
  "table\u0000sqlite_sequence\u0000sqlite_sequence",
  "table\u0000sqlite_stat1\u0000sqlite_stat1",
]);
const canonical=(value:unknown)=>JSON.stringify(value);
const sha256=(value:string|Buffer)=>createHash("sha256").update(value).digest("hex");
const plain=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
const exactKeys=(value:Record<string,unknown>,keys:string[])=>canonical(Object.keys(value).sort())===canonical([...keys].sort());

function loadEvidence(kind:keyof typeof evidencePaths,bodyKeys:string[]){
  const path=evidencePaths[kind];
  if(!path)throw new Error(`D1 Phase A ${kind} evidence path missing`);
  const bytes=readFileSync(path),value=JSON.parse(bytes.toString("utf8")) as unknown;
  if(!plain(value)||!exactKeys(value,["audience","body","issuer","observedAt","principal","release","subject"])||!plain(value.body)||!exactKeys(value.body,bodyKeys))throw new Error(`D1 Phase A ${kind} evidence invalid`);
  return{bytes,value:value as Record<string,unknown>&{body:Record<string,unknown>}};
}

const ledgerEvidence=loadEvidence("ledger",["providerMigrationRows"]);
const schemaEvidence=loadEvidence("schema",["objects"]);
const shapeEvidence=loadEvidence("shape",["foreignKeyViolations","foreignKeys","indexColumns","indexes","rowCounts","tables"]);
for(const key of["audience","issuer","principal","release","subject"] as const)if(canonical(ledgerEvidence.value[key])!==canonical(schemaEvidence.value[key])||canonical(ledgerEvidence.value[key])!==canonical(shapeEvidence.value[key]))throw new Error("D1 Phase A evidence trust identity mismatch");

const providerMigrationRows=ledgerEvidence.value.body.providerMigrationRows;
if(!Array.isArray(providerMigrationRows)||providerMigrationRows.length!==7)throw new Error("D1 Phase A provider ledger invalid");
for(const [index,row] of providerMigrationRows.entries()){
  if(!plain(row)||!exactKeys(row,["applied_at","id","name"])||row.id!==index+1||row.name!==`${String(index).padStart(4,"0")}_${["nearnight_foundation","google_apple_auth","sharp_shinobi_shaw","white_groot","salty_sugar_man","pronunciation_frequency_layers","nearyou_shared_foundation"][index]}.sql`||typeof row.applied_at!=="string")throw new Error("D1 Phase A provider ledger invalid");
}

type SchemaObject={type:string;name:string;tableName:string;rootPage:number;sql:string|null};
const rawObjects=schemaEvidence.value.body.objects;
if(!Array.isArray(rawObjects)||!rawObjects.length)throw new Error("D1 Phase A schema evidence invalid");
const objects=rawObjects.map((row):SchemaObject=>{
  if(!plain(row)||!exactKeys(row,["name","rootPage","sql","tableName","type"])||typeof row.type!=="string"||typeof row.name!=="string"||typeof row.tableName!=="string"||!Number.isSafeInteger(row.rootPage)||(row.sql!==null&&typeof row.sql!=="string"))throw new Error("D1 Phase A schema evidence invalid");
  return row as SchemaObject;
});
for(const identity of providerIdentities)if(!objects.some(row=>`${row.type}\u0000${row.name}\u0000${row.tableName}`===identity))throw new Error("D1 Phase A exact provider object missing");
const sourceDefinitions=objects.filter(row=>!providerIdentities.has(`${row.type}\u0000${row.name}\u0000${row.tableName}`)).map(({type,name,tableName,sql})=>({type,name,tableName,sql}));

for(const key of["tables","foreignKeys","indexes","indexColumns","rowCounts","foreignKeyViolations"] as const)if(!Array.isArray(shapeEvidence.value.body[key]))throw new Error("D1 Phase A shape evidence invalid");
const predecessorShapeSha256=sha256(canonical(shapeEvidence.value.body));

const db=new DatabaseSync(":memory:");
db.exec("PRAGMA foreign_keys=OFF");
for(const type of["table","index","trigger","view"]){
  for(const object of objects.filter(row=>row.type===type&&!providerIdentities.has(`${row.type}\u0000${row.name}\u0000${row.tableName}`)&&row.sql!==null))db.exec(object.sql!);
}

function currentSchema(){
  return db.prepare("SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema WHERE type IN ('table','index','trigger','view') ORDER BY type,name,tbl_name").all().map(row=>({...row})).filter(row=>!providerIdentities.has(`${row.type}\u0000${row.name}\u0000${row.tableName}`));
}
const schemaCheckpoint=()=>{const definitions=currentSchema();return{objectCount:definitions.length,definitionsSha256:sha256(canonical(definitions))}};
if(canonical(currentSchema())!==canonical(sourceDefinitions))throw new Error("D1 Phase A predecessor reconstruction mismatch");

const migrations=migrationIds.map(id=>{
  const source=readFileSync(new URL(`drizzle/${id}.sql`,root),"utf8"),statements=splitD1Migration(source),sql=`${statements.join("\n--> statement-breakpoint\n")}\n`;
  return{id,sha256:sha256(sql),sql,statements};
});
const schemaCheckpoints=[{head:"0006",...schemaCheckpoint()}];
for(const statement of SITES_D1_PHASE_A_BOOTSTRAP)db.exec(statement);
schemaCheckpoints.push({head:"0006+operation",...schemaCheckpoint()});
for(const migration of migrations){for(const statement of migration.statements)db.exec(statement);schemaCheckpoints.push({head:migration.id.slice(0,4),...schemaCheckpoint()})}
const artifact={
  version:1,
  privateInputSha256:{ledger:sha256(ledgerEvidence.bytes),schema:sha256(schemaEvidence.bytes),shape:sha256(shapeEvidence.bytes)},
  providerMigrationRows,
  predecessorShapeSha256,
  migrations,
  schemaCheckpoints,
};
if(!Object.values(artifact.privateInputSha256).every(value=>HASH.test(value)))throw new Error("D1 Phase A evidence hash invalid");
const output=`// Generated by scripts/generate-sites-d1-phase-a-artifact.ts from private evidence hashes. Do not edit.\nexport const SITES_D1_PHASE_A_ARTIFACT=${canonical(artifact)} as const;\n`;
const target=new URL("lib/sites-d1-phase-a-artifact.generated.ts",root);
if(process.argv.includes("--check")){if(readFileSync(target,"utf8")!==output)throw new Error("Sites D1 Phase A artifact stale")}else writeFileSync(target,output);
