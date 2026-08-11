import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { nearStoryActivationState } from "@/db/schema";
import { jsonNoStore, readJsonObject } from "@/lib/http";
import { featureFlagsFromEnv, nearStoryParentBetaFlagsEnabled } from "@/lib/nearyou-foundation";
import { assertNearStoryWorkerReady } from "@/lib/nearstory-production-worker";
import { advanceNextNearStoryStage, reconcileExhaustedNearStoryJobs, reconcileStoryCheckpointCleanup } from "@/lib/nearstory-stage-worker";

async function secretMatches(actual: string, expected: string) {
  const [leftBuffer, rightBuffer] = await Promise.all([crypto.subtle.digest("SHA-256", new TextEncoder().encode(actual)), crypto.subtle.digest("SHA-256", new TextEncoder().encode(expected))]);
  const left = new Uint8Array(leftBuffer); const right = new Uint8Array(rightBuffer); let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

export async function POST(request: Request) {
  if (!nearStoryParentBetaFlagsEnabled(featureFlagsFromEnv(process.env))) return jsonNoStore({ error: "Not found." }, { status: 404 });
  const expected = process.env.NEARYOU_STORY_WORKER_SECRET || "";
  const authorization = request.headers.get("authorization") || ""; const actual = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(expected) || !await secretMatches(actual, expected)) return jsonNoStore({ error: "Unauthorized." }, { status: 401 });
  let body: Record<string, unknown>; try { body = await readJsonObject(request, 1_000); } catch { return jsonNoStore({ error: "A small JSON worker request is required." }, { status: 400 }); }
  if ((body.jobId !== undefined && (typeof body.jobId !== "string" || !body.jobId || body.jobId.length > 200)) || Object.keys(body).some((key) => key !== "jobId")) return jsonNoStore({ error: "jobId must be bounded when supplied." }, { status: 400 });
  try { await assertNearStoryWorkerReady(); } catch { return jsonNoStore({ error: "NearStory worker is not ready." }, { status: 503 }); }
  const heartbeat = new Date(); await getDb().update(nearStoryActivationState).set({ workerHeartbeatAt: heartbeat, checkedAt: heartbeat }).where(eq(nearStoryActivationState.id, "parent-beta"));
  await reconcileExhaustedNearStoryJobs(2);
  await reconcileStoryCheckpointCleanup(10);
  const result = await advanceNextNearStoryStage(typeof body.jobId === "string" ? body.jobId : undefined);
  return jsonNoStore({ result, heartbeatAt: heartbeat }, { status: result.status === "retryable" ? 503 : result.status === "busy" ? 409 : 200 });
}
