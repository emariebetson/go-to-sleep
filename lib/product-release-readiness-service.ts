import { stickyProductCohort, type Product } from "./product-release-readiness";
import {validateProductReadinessExact,type ProductReadiness}from"./asymmetric-release-evidence";

type Pg = { query<T>(sql: string, args: unknown[]): Promise<{ rows: T[] }>;transaction?<T>(run:(tx:Pg)=>Promise<T>):Promise<T> };

function signedProductReady(product:Product,releaseId:string,p:Record<string,unknown>,claims:Record<string,unknown>){try{if(p.product!==product)return false;return validateProductReadinessExact(p as ProductReadiness,{releaseId,notBefore:Number(claims.notBefore),issuedAt:Number(claims.issuedAt),expiresAt:Number(claims.expiresAt)})}catch{return false}}

export function createPostgresProductDecision(pg: Pg) {
  return async (product: Product) => {
    const row = (await pg.query<{ mode: "off" | "canary" | "percent"; percent: number; kill_switch: boolean; evidence_digest: string | null; release_id: string | null;canonical_product:Record<string,unknown>|null;claims_projection:Record<string,unknown>|null }>(
      "SELECT s.mode,s.percent,s.kill_switch,s.evidence_digest,s.release_id,e.canonical_product,a.claims_projection FROM nearyou.product_rollout_state s LEFT JOIN nearyou.product_readiness_evidence e ON e.product=s.product AND e.release_id=s.release_id AND e.evidence_digest=s.evidence_digest AND e.expires_at>statement_timestamp() LEFT JOIN nearyou.release_evidence_audit a ON a.claims_digest=e.evidence_digest WHERE s.product=$1",
      [product],
    )).rows[0];
    if (!row || row.mode === "off" || row.kill_switch || !row.evidence_digest || !row.release_id||!row.canonical_product||!row.claims_projection||!signedProductReady(product,row.release_id,row.canonical_product,row.claims_projection)) return { mode: "off" as const, percent: 0, reason: row?.kill_switch ? "kill_switch" as const : "evidence_required" as const };
    return{mode:row.mode,percent:row.percent,productKind:product==="nearfamily"?"bundle"as const:"service"as const};
  };
}

export function createPostgresHouseholdProductAccess(pg: Pg) {
  return async (product: Product, householdId: string) => {
    const state=(await pg.query<{release_id:string}>("SELECT release_id FROM nearyou.product_rollout_state WHERE product=$1 AND NOT kill_switch AND mode<>'off'",[product])).rows[0];
    if(!state?.release_id)return false;
    const releaseId=state.release_id;
    const cohort = await stickyProductCohort(householdId, releaseId);
    const householdHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(householdId))), byte => byte.toString(16).padStart(2, "0")).join("");
    const row = (await pg.query<{ allowed: boolean }>("SELECT nearyou.authorize_product_household($1,$2,$3,$4) AS allowed", [product, releaseId, householdHash, cohort])).rows[0];
    return row?.allowed === true;
  };
}
export function createPostgresRolloutFence(pg:Pg){return async(product:Product,householdId:string)=>{const state=(await pg.query<{release_id:string;version:number}>("SELECT release_id,version FROM nearyou.product_rollout_state WHERE product=$1 AND NOT kill_switch AND mode<>'off'",[product])).rows[0];if(!state?.release_id)return null;const cohort=await stickyProductCohort(householdId,state.release_id),hash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(householdId))),b=>b.toString(16).padStart(2,"0")).join(""),allowed=(await pg.query<{allowed:boolean}>("SELECT nearyou.authorize_product_household($1,$2,$3,$4) AS allowed",[product,state.release_id,hash,cohort])).rows[0]?.allowed===true;return allowed?{releaseId:state.release_id,version:Number(state.version)}:null}}

export function createPostgresRolloutController(pg:Pg){return async(input:{action:"transition"|"kill"|"invite";product:Product;principal:string;expectedVersion?:number;mode?:"canary"|"percent";percent?:number;releaseId?:string;evidenceDigest?:string;householdHash?:string;expiresAt?:string})=>{if(!/^service:[A-Za-z0-9_-]{3,100}$/.test(input.principal)||!pg.transaction)throw new Error("rollout control invalid");return pg.transaction(async tx=>{await tx.query("SELECT set_config('nearyou.principal',$1,true)",[input.principal]);const identity=(await tx.query<{ok:boolean}>("SELECT EXISTS(SELECT 1 FROM nearyou.rollout_controller_identities WHERE database_user=session_user AND principal=current_setting('nearyou.principal',true)) AS ok",[])).rows[0];if(!identity?.ok)throw new Error("rollout control invalid");if(input.action==="invite"){if(!/^[a-f0-9]{64}$/.test(input.householdHash??"")||!input.releaseId||!input.expiresAt)throw new Error("rollout control invalid");await tx.query("SELECT nearyou.upsert_product_canary_invite($1,$2,$3,$4)",[input.product,input.householdHash,input.releaseId,input.expiresAt]);return{ok:true as const}}const mode=input.action==="kill"?"off":input.mode,percent=input.action==="kill"?0:input.percent;if(!Number.isSafeInteger(input.expectedVersion)||!mode||!Number.isSafeInteger(percent))throw new Error("rollout control invalid");const row=(await tx.query<{version:number}>("SELECT nearyou.transition_product_rollout($1,$2,$3,$4,$5,$6) AS version",[input.product,input.expectedVersion,mode,percent,input.action==="kill"?null:input.releaseId,input.action==="kill"?null:input.evidenceDigest])).rows[0];if(!row)throw new Error("rollout control unavailable");return{ok:true as const,version:Number(row.version)}})}}
