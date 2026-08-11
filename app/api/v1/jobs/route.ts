import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { jobs, voiceConsents, voices } from "@/db/schema";
import { apiV1Failure, badRequest, requireHouseholdContext } from "@/lib/api-v1-context";
import { parseJobInput } from "@/lib/api-v1-input";
import { assertSameOrigin, jsonNoStore, readJsonObject } from "@/lib/http";
import { canonicalJobRequestHash, featureFlagsFromEnv, jobTypeEnabled } from "@/lib/nearyou-foundation";

const publicJob = {
  id: jobs.id,
  type: jobs.type,
  status: jobs.status,
  result: jobs.result,
  attempts: jobs.attempts,
  errorCode: jobs.errorCode,
  createdAt: jobs.createdAt,
  updatedAt: jobs.updatedAt,
  startedAt: jobs.startedAt,
  completedAt: jobs.completedAt,
};

export async function GET(request: Request) {
  try {
    const { householdId } = await requireHouseholdContext(request, "job:read");
    const records = await getDb().select(publicJob).from(jobs)
      .where(eq(jobs.householdId, householdId)).orderBy(desc(jobs.createdAt)).limit(100).all();
    return jsonNoStore({ apiVersion: "v1", jobs: records });
  } catch (error) {
    return apiV1Failure(error, "Jobs could not be loaded.");
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const { householdId, user } = await requireHouseholdContext(request, "job:write");
    let input;
    try { input = parseJobInput(await readJsonObject(request, 20_000)); } catch (error) { return error instanceof Response ? error : badRequest(error); }
    if (!jobTypeEnabled(input.type, featureFlagsFromEnv(process.env))) {
      return jsonNoStore({ error: "That job type is not enabled with a worker and usage reservations." }, { status: 503 });
    }
    if (input.type === "nearsleep_audio" || input.type === "story_audio") {
      const voiceId = input.input.voiceId;
      if (typeof voiceId !== "string") return jsonNoStore({ error: "An adult voice ID is required for audio jobs." }, { status: 400 });
      const verifiedVoice = await getDb().select({ id: voices.id }).from(voices)
        .innerJoin(voiceConsents, eq(voices.currentConsentId, voiceConsents.id))
        .where(and(
          eq(voices.id, voiceId),
          eq(voices.householdId, householdId),
          eq(voices.status, "ready"),
          eq(voiceConsents.householdId, householdId),
          eq(voiceConsents.status, "active_verified"),
        )).get();
      if (!verifiedVoice) return jsonNoStore({ error: "An active verified adult voice consent is required." }, { status: 403 });
    }
    const requestHash = await canonicalJobRequestHash(input.type, input.input);
    const now = new Date();
    const inserted = await getDb().insert(jobs).values({
      id: input.requestId,
      householdId,
      requestedByUserId: user.userId,
      type: input.type,
      status: "queued",
      idempotencyKey: input.requestId,
      requestHash,
      input: input.input,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing().returning(publicJob).get();
    if (inserted) return jsonNoStore({ apiVersion: "v1", job: inserted }, { status: 202 });
    const existing = await getDb().select({ ...publicJob, requestHash: jobs.requestHash }).from(jobs)
      .where(and(eq(jobs.id, input.requestId), eq(jobs.householdId, householdId))).get();
    if (!existing || existing.type !== input.type || existing.requestHash !== requestHash) {
      return jsonNoStore({ error: "That request ID is already associated with different job data." }, { status: 409 });
    }
    const job = {
      id: existing.id,
      type: existing.type,
      status: existing.status,
      result: existing.result,
      attempts: existing.attempts,
      errorCode: existing.errorCode,
      createdAt: existing.createdAt,
      updatedAt: existing.updatedAt,
      startedAt: existing.startedAt,
      completedAt: existing.completedAt,
    };
    return jsonNoStore({ apiVersion: "v1", job, duplicate: true });
  } catch (error) {
    return apiV1Failure(error, "Job could not be created.");
  }
}
