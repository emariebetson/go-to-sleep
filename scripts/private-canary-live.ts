import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { canonicalEvidence, verifyReleaseEvidence, type Claims, type Trust } from "../lib/asymmetric-release-evidence";
import { CloudKmsPublicKeyClient, PostgresNonceStore } from "../lib/release-evidence-adapters";
import { featureFlagsFromEnv, nearStoryParentBetaFlagsEnabled } from "../lib/nearyou-foundation";
import { createPostgresPrivateTesterInvitationEvaluator } from "../lib/product-release-readiness-service";
import { assessPrivateCanaryObservations } from "./private-canary-smoke";
import { verifyPrivateCanaryRuntimeSource } from "./verify-private-canary-runtime";

const HASH=/^[a-f0-9]{64}$/,RELEASE=/^rel_[A-Za-z0-9_-]{8,96}$/;
type Rollback={releaseId:string;invitedHouseholdHash:string;deniedHouseholdHash:string;startedAt:number;endedAt:number;nonce:string;killSwitchDenied:true;newStoryPaused:true;deletionAvailable:true;remediationAvailable:true;priorVersionRetained:true};
type Json=Record<string,unknown>;
const digest=(value:string)=>createHash("sha256").update(value).digest("hex");
const stable=(value:Rollback)=>JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0)));
export function validatePrivateCanaryEndpoint(raw:string,audience:string){const url=new URL(raw),aud=new URL(audience);if(url.protocol!=="https:"||url.username||url.password||url.search||url.hash||aud.protocol!=="https:"||aud.username||aud.password||aud.search||aud.hash||url.origin!==aud.origin)throw new Error("private canary D1 endpoint invalid");return url}
async function metadata(path:string){const response=await fetch(`http://metadata.google.internal${path}`,{headers:{"metadata-flavor":"Google"},signal:AbortSignal.timeout(5000)}),text=await response.text();if(!response.ok||text.length>16384)throw new Error("private canary identity unavailable");return text}
async function idToken(audience:string){const token=await metadata(`/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}&format=full`);if(token.split(".").length!==3)throw new Error("private canary identity unavailable");return token}
async function accessToken(){const value=JSON.parse(await metadata("/computeMetadata/v1/instance/service-accounts/default/token"))as{access_token?:unknown;expires_in?:unknown};if(typeof value.access_token!=="string"||!Number.isSafeInteger(value.expires_in)||Number(value.expires_in)<60)throw new Error("private canary identity unavailable");return value.access_token}
function cloudSqlConnection(){const raw=process.env.READINESS_CONTROL_DATABASE_URL??"",url=new URL(raw),marker=process.env.CLOUD_SQL_IAM_CONNECTOR,instance=process.env.CLOUD_SQL_INSTANCE_CONNECTION_NAME??"",artifact=readFileSync(new URL("../infra/production/cloud-sql-auth-proxy.args",import.meta.url),"utf8"),expected=digest(artifact);if(marker!=="cloud-sql-auth-proxy"||url.password||url.hostname!=="127.0.0.1"||url.port!=="5432"||url.searchParams.get("sslmode")!=="disable"||!/^[a-z][a-z0-9-]{4,62}:[a-z0-9-]{1,63}:[a-z][a-z0-9-]{1,62}$/.test(instance)||!artifact.includes("--auto-iam-authn")||process.env.CLOUD_SQL_PROXY_ARGS_CHECKSUM!==expected)throw new Error("private canary database connector invalid");return raw}
export function unwrapPrivateCanaryJsonb(row:Json|undefined,key:string){const value=row?.[key];if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("private canary PostgreSQL observation unavailable");return value as Json}

async function main(){
 const [releaseId,invitedHouseholdHash,deniedHouseholdHash,rollbackPath,output]=process.argv.slice(2);
 if(!releaseId||!RELEASE.test(releaseId)||!HASH.test(invitedHouseholdHash??"")||!HASH.test(deniedHouseholdHash??"")||!rollbackPath||!output)throw new Error("private canary input invalid");
 const required=["D1_CANARY_SMOKE_URL","D1_CANARY_SMOKE_AUDIENCE","KMS_PROJECT","KMS_LOCATION","KMS_KEY_RING","KMS_KEY","EVIDENCE_PRINCIPAL","EVIDENCE_KEY_ID","EVIDENCE_TRUST_JSON"] as const;
 if(required.some(key=>!process.env[key]))throw new Error("private canary live binding unavailable");
 const source=verifyPrivateCanaryRuntimeSource();if(source.productActivation||source.internalRouteActivation||nearStoryParentBetaFlagsEnabled(featureFlagsFromEnv({})))throw new Error("private canary source gate enabled");
 const rollbackRaw=await readFile(rollbackPath,"utf8");if(Buffer.byteLength(rollbackRaw)>262144)throw new Error("rollback evidence invalid");
 const envelope=JSON.parse(rollbackRaw)as{claims:Claims;signature:string;rollback:Rollback},rollback=envelope.rollback,rollbackArtifactDigest=digest(stable(rollback));
 if(rollback.releaseId!==releaseId||rollback.invitedHouseholdHash!==invitedHouseholdHash||rollback.deniedHouseholdHash!==deniedHouseholdHash||!Number.isSafeInteger(rollback.startedAt)||!Number.isSafeInteger(rollback.endedAt)||rollback.endedAt<=rollback.startedAt||rollback.endedAt-rollback.startedAt>900000||!/^[A-Za-z0-9_-]{22,128}$/.test(rollback.nonce)||rollback.startedAt<envelope.claims.notBefore||rollback.endedAt>envelope.claims.issuedAt||envelope.claims.releaseId!==releaseId||envelope.claims.nonce!==rollback.nonce||!envelope.claims.productReadiness.some(item=>item.product==="nearfamily"&&item.artifact===rollbackArtifactDigest))throw new Error("rollback evidence binding invalid");
 const d1Url=validatePrivateCanaryEndpoint(process.env.D1_CANARY_SMOKE_URL!,process.env.D1_CANARY_SMOKE_AUDIENCE!),name="pg",{Pool}=await import(name)as typeof import("pg"),pool=new Pool({connectionString:cloudSqlConnection(),ssl:{rejectUnauthorized:false}});
 try{
  const publicKeys=new CloudKmsPublicKeyClient({project:process.env.KMS_PROJECT!,location:process.env.KMS_LOCATION!,keyRing:process.env.KMS_KEY_RING!,key:process.env.KMS_KEY!,principal:process.env.EVIDENCE_PRINCIPAL!,keyId:process.env.EVIDENCE_KEY_ID!,accessToken});
  const facts=(await pool.query<{observed_at:string;rollout:Json;provider:Json}>("SELECT floor(extract(epoch from statement_timestamp())*1000)::bigint::text AS observed_at,nearyou.load_private_canary_rollout($1,$2,$3) AS rollout,nearyou.load_private_story_readiness($1) AS provider",[releaseId,invitedHouseholdHash,deniedHouseholdHash])).rows[0],observedAt=Number(facts?.observed_at);
  if(!Number.isSafeInteger(observedAt)||rollback.endedAt>observedAt||observedAt-rollback.endedAt>300000)throw new Error("rollback evidence stale");
  await verifyReleaseEvidence({claims:envelope.claims,signature:envelope.signature},{now:observedAt,trust:JSON.parse(process.env.EVIDENCE_TRUST_JSON!)as Trust[],lookupKey:(p,k,v)=>publicKeys.lookup(p,k,v),consumeNonce:value=>new PostgresNonceStore(pool).consume(value)});
  const token=await idToken(process.env.D1_CANARY_SMOKE_AUDIENCE!),response=await fetch(new URL(`?releaseId=${encodeURIComponent(releaseId)}&phase=revoked`,d1Url),{headers:{authorization:`Bearer ${token}`,accept:"application/json"},redirect:"error",signal:AbortSignal.timeout(10000)});
  if(!response.ok||response.headers.get("content-type")?.split(";")[0]!=="application/json")throw new Error("D1 canary observation unavailable");
  const observed=await response.json()as{observedAt:number;d1:never;story:{activationStatus:string;migrationVersion:string;heartbeatAt:number}},rollout=unwrapPrivateCanaryJsonb(facts as unknown as Json,"rollout"),provider=unwrapPrivateCanaryJsonb(facts as unknown as Json,"provider");
  if(Number(rollout.observedAt)!==observedAt||Number(provider.observedAt)!==observedAt||!Number.isSafeInteger(observed.observedAt)||observed.observedAt>observedAt||observedAt-observed.observedAt>30000)throw new Error("private canary observation clock mismatch");
  const task5Authorization=createPostgresPrivateTesterInvitationEvaluator(pool),[nearStoryInvited,nearStoryDenied,nearFamilyInvited,nearFamilyDenied]=await Promise.all([task5Authorization.authorize({product:"nearstory",householdHash:invitedHouseholdHash}),task5Authorization.authorize({product:"nearstory",householdHash:deniedHouseholdHash}),task5Authorization.authorize({product:"nearfamily",householdHash:invitedHouseholdHash}),task5Authorization.authorize({product:"nearfamily",householdHash:deniedHouseholdHash})]);
  const result=await assessPrivateCanaryObservations({mode:"post-issue",releaseId,invitedHouseholdHash,deniedHouseholdHash,maxHeartbeatAgeMs:300000},{now:async()=>observedAt,sourceGates:async()=>({family:source.productActivation,canaryRoute:source.internalRouteActivation,story:false}),d1:async()=>observed.d1,pg:async()=>({...rollout,invitedAllowed:nearStoryInvited&&nearFamilyInvited,deniedAllowed:nearStoryDenied||nearFamilyDenied}) as never,story:async()=>({...observed.story,providerPrerequisites:provider.providerPrerequisites===true}),rollback:async()=>({...rollback,artifact:rollbackArtifactDigest})});
  await writeFile(output,JSON.stringify({version:1,authenticated:true,rollbackArtifactDigest,releaseEvidenceDigest:digest(canonicalEvidence(envelope.claims)),result})+"\n",{flag:"wx"});
 }finally{await pool.end()}
}
main().catch(()=>{process.stderr.write("private canary live verification failed\n");process.exitCode=1});
