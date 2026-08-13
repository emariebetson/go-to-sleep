import { env } from "cloudflare:workers";
import { requireHouseholdContext } from "@/lib/api-v1-context";
import { jsonNoStore } from "@/lib/http";
import { createNearFamilySummaryService } from "@/lib/nearfamily-service";
import { createPostgresHouseholdProductAccess } from "@/lib/product-release-readiness-service";

// NearFamily is a bundle over existing identity/member/entitlement/invitation
// capabilities, not a separately deployed processor. Its public bundle route
// remains compile-time dark until the reviewed activation change lands.
const NEARFAMILY_ROUTE_ENABLED=false as const;
export async function GET(request:Request){
  if(!NEARFAMILY_ROUTE_ENABLED)return jsonNoStore({error:"NearFamily is not available."},{status:404});
  const{householdId}=await requireHouseholdContext(request,"entitlement:read");
  const pg=(env as unknown as{READINESS_PG?:{query<T>(sql:string,args:unknown[]):Promise<{rows:T[]}>}}).READINESS_PG;
  if(!pg||!await createPostgresHouseholdProductAccess(pg)("nearfamily",householdId))return jsonNoStore({error:"NearFamily is not available."},{status:404});
  try{return jsonNoStore(await createNearFamilySummaryService(env.DB)(householdId));}
  catch{return jsonNoStore({error:"NearFamily is not available."},{status:404});}
}
