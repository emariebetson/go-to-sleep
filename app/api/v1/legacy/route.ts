import { env } from "cloudflare:workers";
import { apiV1Failure, requireHouseholdContext } from "@/lib/api-v1-context";
import { jsonNoStore } from "@/lib/http";
import { nearLegacyReady, requireLegacyEntitlement } from "./production";

export async function GET(request: Request) {
  try {
    if (!await nearLegacyReady("read")) return jsonNoStore({ error: "NearLegacy is not available." }, { status: 404 });
    const { householdId, role, user } = await requireHouseholdContext(request, "archive:read");
    if (!await requireLegacyEntitlement(householdId, "read")) return jsonNoStore({ error: "NearLegacy is not included in this household plan." }, { status: 403 });
    const [contributors, interviews, collections, custodian] = await Promise.all([
      env.DB.prepare("SELECT id,display_name,relationship,status FROM contributors WHERE household_id=? AND status NOT IN ('revoked','invited') ORDER BY created_at").bind(householdId).all(),
      env.DB.prepare("SELECT id,contributor_id,title,status,created_at,updated_at FROM legacy_interviews WHERE household_id=? AND status<>'deleted' ORDER BY updated_at DESC LIMIT 100").bind(householdId).all(),
      env.DB.prepare("SELECT id,name,description,created_at,updated_at FROM legacy_collections WHERE household_id=? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 100").bind(householdId).all(),
      env.DB.prepare("SELECT user_id,role,status,accepted_at FROM legacy_custodians WHERE household_id=? AND status='active' ORDER BY role LIMIT 8").bind(householdId).all(),
    ]);
    const linked = role === "contributor" ? await env.DB.prepare("SELECT id FROM contributors WHERE household_id=? AND adult_user_id=? AND status='active' LIMIT 1").bind(householdId, user.userId).all() : null;
    const isLegacyCustodian = (custodian.results || []).some((item) => (item as Record<string, unknown>).user_id === user.userId && (item as Record<string, unknown>).role === "primary");
    return jsonNoStore({ apiVersion: "v1", householdId, contributors: contributors.results || [], interviews: interviews.results || [], collections: collections.results || [], custodians: isLegacyCustodian ? custodian.results || [] : { activeCount: custodian.results?.length || 0 }, permissions: { manage: role === "owner" || role === "adult_manager", contributeSelf: role === "contributor" && Boolean(linked?.results?.length), read: true, custody: isLegacyCustodian, bootstrapCustody: role === "owner" && !(custodian.results?.length) }, linkedContributorId: linked?.results?.[0]?.id || null, syntheticNarrationEnabled: false, posthumousSynthesisEnabled: false });
  } catch (error) { return apiV1Failure(error, "NearLegacy could not be loaded."); }
}
