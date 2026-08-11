import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { jobs } from "@/db/schema";
import { apiV1Failure, requireHouseholdContext } from "@/lib/api-v1-context";
import { jsonNoStore } from "@/lib/http";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { householdId } = await requireHouseholdContext(request, "job:read");
    const { id } = await context.params;
    const job = await getDb().select({
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
    }).from(jobs).where(and(eq(jobs.id, id), eq(jobs.householdId, householdId))).get();
    if (!job) return jsonNoStore({ error: "Job not found." }, { status: 404 });
    return jsonNoStore({ apiVersion: "v1", job });
  } catch (error) {
    return apiV1Failure(error, "Job could not be loaded.");
  }
}
