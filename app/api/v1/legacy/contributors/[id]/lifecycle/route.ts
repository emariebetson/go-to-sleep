import { env } from "cloudflare:workers";
import { apiV1Failure, badRequest } from "@/lib/api-v1-context";
import { requireApiAuthContext } from "@/lib/auth";
import { assertTrustedMutationOrigin, jsonNoStore, readJsonObject } from "@/lib/http";
import { legacyHash, legacyInternalId, legacyUuid } from "@/lib/nearlegacy-route";
import { isLegacyCustodian, requireLegacyFreshAuth } from "../../../production";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertTrustedMutationOrigin(request);
    const { user } = await requireApiAuthContext(request);
    const householdId = request.headers.get("x-nearyou-household-id")?.trim() || "";
    if (!/^[A-Za-z0-9:_-]{1,200}$/.test(householdId)) return badRequest(new Error("A household is required."));
    const { id: rawId } = await context.params;
    const id = legacyUuid(rawId, "contributorId");
    let body: Record<string, unknown>;
    try { body = await readJsonObject(request, 1000); } catch (error) { return error instanceof Response ? error : badRequest(error); }
    const action = String(body.action || "");
    if (!["report_death", "review_death", "revoke"].includes(action)) return badRequest(new Error("Lifecycle action is invalid."));
    const contributorResult = await env.DB.prepare("SELECT id,adult_user_id,status FROM contributors WHERE id=? AND household_id=?").bind(id, householdId).all();
    const contributor = contributorResult.results?.[0] as Record<string, unknown> | undefined;
    if (!contributor) return jsonNoStore({ error: "Contributor not found." }, { status: 404 });
    const member = await env.DB.prepare("SELECT role FROM household_members WHERE household_id=? AND user_id=? AND status='active'").bind(householdId, user.userId).all();
    const role = String((member.results?.[0] as Record<string, unknown> | undefined)?.role || "");
    const primary = await isLegacyCustodian(householdId, user.userId);
    const self = contributor.adult_user_id === user.userId;
    if ((action === "report_death" && role !== "owner" && !primary) || (action === "review_death" && !primary) || (action === "revoke" && !self)) return jsonNoStore({ error: "You cannot perform this contributor lifecycle action." }, { status: 403 });
    const key = request.headers.get("idempotency-key") || "";
    const operationId = await legacyInternalId(`contributor-${action}`, householdId, key);
    const hash = await legacyHash(JSON.stringify({ id, action }));
    const existing = await env.DB.prepare("SELECT request_hash,event_type FROM legacy_audit_events WHERE id=? AND household_id=?").bind(operationId, householdId).all();
    if (existing.results?.length) {
      const prior = existing.results[0] as Record<string, unknown>;
      if (prior.request_hash !== hash) return jsonNoStore({ error: "That idempotency key belongs to another lifecycle action." }, { status: 409 });
      return jsonNoStore({ contributor: { id, status: contributor.status }, duplicate: true });
    }
    const fresh = await requireLegacyFreshAuth(request, user.userId);
    if (!fresh) return jsonNoStore({ error: "A fresh sign-in is required." }, { status: 403 });
    const now = Date.now();
    const securityAction = (kind: "death_report" | "death_review") => env.DB.prepare("INSERT INTO legacy_security_actions (id,household_id,actor_user_id,action,target_kind,target_id,request_hash,reauth_challenge_id,reauth_session_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(`${operationId}:security`, householdId, user.userId, kind, "contributor", id, hash, fresh.challengeId, fresh.sessionId, now);
    if (action === "report_death") {
      if (contributor.status !== "active") return jsonNoStore({ error: "Only an active contributor can enter death review." }, { status: 409 });
      await env.DB.batch([
        securityAction("death_report"),
        env.DB.prepare("UPDATE contributors SET status='deceased_pending_review',death_reviewed_at=NULL,death_reviewed_by_user_id=NULL,updated_at=? WHERE id=? AND household_id=? AND status='active'").bind(now, id, householdId),
        env.DB.prepare("INSERT INTO legacy_audit_events (id,household_id,actor_user_id,event_type,target_kind,target_id,request_hash,created_at) VALUES (?,?,?,'death_reported','contributor',?,?,?)").bind(operationId, householdId, user.userId, id, hash, now),
      ]);
    } else if (action === "review_death") {
      if (contributor.status !== "deceased_pending_review") return jsonNoStore({ error: "This contributor is not awaiting death review." }, { status: 409 });
      await env.DB.batch([
        securityAction("death_review"),
        env.DB.prepare("UPDATE contributors SET death_reviewed_at=?,death_reviewed_by_user_id=?,updated_at=? WHERE id=? AND household_id=? AND status='deceased_pending_review'").bind(now, user.userId, now, id, householdId),
        env.DB.prepare("INSERT INTO legacy_audit_events (id,household_id,actor_user_id,event_type,target_kind,target_id,request_hash,created_at) VALUES (?,?,?,'death_review_completed','contributor',?,?,?)").bind(operationId, householdId, user.userId, id, hash, now),
      ]);
    } else {
      const deletionId = await legacyInternalId("deletion", householdId, key);
      await env.DB.batch([
        env.DB.prepare("UPDATE contributors SET status='revoked',updated_at=? WHERE id=? AND household_id=? AND status IN ('active','deceased_pending_review')").bind(now, id, householdId),
        env.DB.prepare("INSERT INTO legacy_audit_events (id,household_id,actor_user_id,event_type,target_kind,target_id,request_hash,created_at) VALUES (?,?,?,'contributor_revoked','contributor',?,?,?)").bind(operationId, householdId, user.userId, id, hash, now),
        env.DB.prepare("INSERT INTO legacy_deletion_operations (id,household_id,requested_by_user_id,target_kind,target_id,request_hash,reauth_challenge_id,reauth_session_id,status,created_at,updated_at) VALUES (?,?,?,'contributor',?,?,?,?,'queued',?,?)").bind(deletionId, householdId, user.userId, id, hash, fresh.challengeId, fresh.sessionId, now, now),
      ]);
    }
    const updated = await env.DB.prepare("SELECT id,status,death_reviewed_at FROM contributors WHERE id=? AND household_id=?").bind(id, householdId).all();
    return jsonNoStore({ contributor: updated.results?.[0] });
  } catch (error) { return apiV1Failure(error, "Contributor lifecycle could not be updated."); }
}
