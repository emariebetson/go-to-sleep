import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { childProfiles } from "@/db/schema";
import { apiV1Failure, badRequest, requireHouseholdContext } from "@/lib/api-v1-context";
import { parseChildProfileInput } from "@/lib/api-v1-input";
import { assertTrustedMutationOrigin, jsonNoStore, readJsonObject } from "@/lib/http";
import { loadEffectiveHouseholdEntitlement } from "@/lib/household-entitlements";
import { loadSelectableChildProfiles } from "@/lib/nearsleep-selectors";

const publicChild = {
  id: childProfiles.id,
  nickname: childProfiles.nickname,
  pronunciation: childProfiles.pronunciation,
  ageMonths: childProfiles.ageMonths,
  bedtimeChallenge: childProfiles.bedtimeChallenge,
  createdAt: childProfiles.createdAt,
  updatedAt: childProfiles.updatedAt,
};

export async function GET(request: Request) {
  try {
    const { householdId } = await requireHouseholdContext(request, "child:read");
    const records = await loadSelectableChildProfiles(householdId);
    return jsonNoStore({ apiVersion: "v1", children: records.map((record) => ({
      id: record.id,
      nickname: record.nickname,
      pronunciation: record.pronunciation,
      ageMonths: record.ageMonths,
      bedtimeChallenge: record.bedtimeChallenge,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    })) });
  } catch (error) {
    return apiV1Failure(error, "Child profiles could not be loaded.");
  }
}

export async function POST(request: Request) {
  try {
    assertTrustedMutationOrigin(request);
    const { householdId } = await requireHouseholdContext(request, "child:write");
    let input;
    try { input = parseChildProfileInput(await readJsonObject(request, 4_000)); } catch (error) { return error instanceof Response ? error : badRequest(error); }
    const db = getDb();
    const existing = await db.select({ ...publicChild, normalizedNickname: childProfiles.normalizedNickname })
      .from(childProfiles).where(and(eq(childProfiles.id, input.requestId), eq(childProfiles.householdId, householdId))).get();
    if (existing) {
      if (existing.normalizedNickname !== input.normalizedNickname || existing.pronunciation !== input.pronunciation || existing.ageMonths !== input.ageMonths || existing.bedtimeChallenge !== input.bedtimeChallenge) {
        return jsonNoStore({ error: "That request ID is already associated with different child-profile data." }, { status: 409 });
      }
      const child = {
        id: existing.id,
        nickname: existing.nickname,
        pronunciation: existing.pronunciation,
        ageMonths: existing.ageMonths,
        bedtimeChallenge: existing.bedtimeChallenge,
        createdAt: existing.createdAt,
        updatedAt: existing.updatedAt,
      };
      return jsonNoStore({ apiVersion: "v1", child, duplicate: true });
    }
    const [entitlement, childCount] = await Promise.all([
      loadEffectiveHouseholdEntitlement(householdId),
      db.select({ value: sql<number>`count(*)` }).from(childProfiles)
        .where(and(eq(childProfiles.householdId, householdId), isNull(childProfiles.archivedAt))).get(),
    ]);
    if ((childCount?.value || 0) >= entitlement.limits.children) {
      return jsonNoStore({ error: "This household has reached its child-profile limit." }, { status: 409 });
    }
    const now = new Date();
    const inserted = await db.insert(childProfiles).values({
      id: input.requestId,
      householdId,
      nickname: input.nickname,
      normalizedNickname: input.normalizedNickname,
      pronunciation: input.pronunciation,
      ageMonths: input.ageMonths,
      bedtimeChallenge: input.bedtimeChallenge,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing().returning(publicChild).get();
    if (inserted) return jsonNoStore({ apiVersion: "v1", child: inserted }, { status: 201 });
    const conflicted = await db.select({ ...publicChild, normalizedNickname: childProfiles.normalizedNickname })
      .from(childProfiles).where(and(eq(childProfiles.id, input.requestId), eq(childProfiles.householdId, householdId))).get();
    if (!conflicted || conflicted.normalizedNickname !== input.normalizedNickname || conflicted.pronunciation !== input.pronunciation || conflicted.ageMonths !== input.ageMonths || conflicted.bedtimeChallenge !== input.bedtimeChallenge) {
      return jsonNoStore({ error: "That request ID is already associated with different child-profile data." }, { status: 409 });
    }
    const child = {
      id: conflicted.id,
      nickname: conflicted.nickname,
      pronunciation: conflicted.pronunciation,
      ageMonths: conflicted.ageMonths,
      bedtimeChallenge: conflicted.bedtimeChallenge,
      createdAt: conflicted.createdAt,
      updatedAt: conflicted.updatedAt,
    };
    return jsonNoStore({ apiVersion: "v1", child, duplicate: true });
  } catch (error) {
    return apiV1Failure(error, "Child profile could not be created.");
  }
}
