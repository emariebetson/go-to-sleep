import { env } from "cloudflare:workers";
import { apiV1Failure } from "@/lib/api-v1-context";
import { requireApiAuthContext } from "@/lib/auth";
import { jsonNoStore } from "@/lib/http";

// Rights discovery intentionally does not require current household membership,
// a paid entitlement, or worker health. It exposes only the authenticated
// contributor's own identity and consent controls, never archive content.
export async function GET(request: Request) {
  try {
    const { user } = await requireApiAuthContext(request);
    const rows = await env.DB.prepare(`SELECT n.household_id AS householdId,h.name AS householdName,n.id AS contributorId,n.display_name AS displayName,n.relationship,n.status,c.id AS consentId,c.kind AS consentKind,c.status AS consentStatus,c.expires_at AS consentExpiresAt
      FROM contributors n JOIN households h ON h.id=n.household_id
      LEFT JOIN legacy_consents c ON c.household_id=n.household_id AND c.contributor_id=n.id
      WHERE n.adult_user_id=? ORDER BY h.created_at,n.created_at,c.attested_at`).bind(user.userId).all();
    const contributions = new Map<string, { householdId:string; householdName:string; contributorId:string; displayName:string; relationship:string|null; status:string; consents:Array<{id:string;kind:string;status:string;expiresAt:number|null}> }>();
    for (const raw of rows.results || []) {
      const row=raw as Record<string,unknown>,key=String(row.contributorId);
      const item=contributions.get(key)||{householdId:String(row.householdId),householdName:String(row.householdName),contributorId:key,displayName:String(row.displayName),relationship:row.relationship?String(row.relationship):null,status:String(row.status),consents:[]};
      if(row.consentId)item.consents.push({id:String(row.consentId),kind:String(row.consentKind),status:String(row.consentStatus),expiresAt:typeof row.consentExpiresAt==='number'?row.consentExpiresAt:null});
      contributions.set(key,item);
    }
    return jsonNoStore({ contributions:[...contributions.values()] });
  } catch (error) { return apiV1Failure(error, "Archive contribution rights could not be loaded."); }
}
