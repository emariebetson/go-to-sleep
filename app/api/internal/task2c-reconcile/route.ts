import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { task2cActivationState } from "@/db/schema";
import { reconcilePendingAccountDeletions } from "@/app/api/account/production";
import { reconcilePendingDeletionReconciliations, reconcilePendingSessionDeletions } from "@/lib/nearsleep-deletion-reconciliation";
import { reconcileHouseholdExports } from "@/lib/nearsleep-export";
import { jsonNoStore } from "@/lib/http";
import { featureFlagsFromEnv, nearSleepLibraryPrivacyEnabled } from "@/lib/nearyou-foundation";
import { reconcileLegacyReadyMedia } from "@/lib/nearsleep-storage-reconciliation";
import { reconcilePendingStoryDeletions } from "@/lib/nearstory-deletion";

type AudioBucket = Parameters<typeof reconcilePendingSessionDeletions>[0]["bucket"] & Parameters<typeof reconcileHouseholdExports>[0]["bucket"];

async function secretMatches(actual: string, expected: string) {
  const [actualDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(actual)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(expected)),
  ]);
  const left = new Uint8Array(actualDigest);
  const right = new Uint8Array(expectedDigest);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

export async function POST(request: Request) {
  const libraryEnabled = nearSleepLibraryPrivacyEnabled(featureFlagsFromEnv(process.env));
  const migrationReconciliationEnabled = process.env.NEARYOU_ENABLE_NEARSLEEP_LIBRARY_RECONCILIATION === "true";
  if (!libraryEnabled && !migrationReconciliationEnabled) return jsonNoStore({ error: "Not found." }, { status: 404 });
  const expected = process.env.NEARYOU_RECONCILIATION_SECRET || "";
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(expected)) return jsonNoStore({ error: "Reconciliation scheduling is not configured." }, { status: 503 });
  const authorization = request.headers.get("authorization") || "";
  const actual = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
  if (!await secretMatches(actual, expected)) return jsonNoStore({ error: "Unauthorized." }, { status: 401 });
  const bucket = (env as unknown as { AUDIO?: AudioBucket }).AUDIO;
  if (!bucket) return jsonNoStore({ error: "Private storage is unavailable." }, { status: 503 });
  const storageReconciliation = await reconcileLegacyReadyMedia({ bucket: bucket as never, limit: 2 });
  const heartbeatAt = new Date();
  const schedulerRunId = crypto.randomUUID();
  await getDb().update(task2cActivationState).set({ schedulerHeartbeatAt: heartbeatAt, schedulerRunId }).where(eq(task2cActivationState.id, "storage"));
  if (!libraryEnabled) return jsonNoStore({ storageReconciliation, productRoutesEnabled: false, heartbeatAt, schedulerRunId });
  const exportsAdvanced = await reconcileHouseholdExports({ bucket, limit: 10 });
  const sessionsAdvanced = await reconcilePendingSessionDeletions({ bucket, limit: 10 });
  const cleanupAdvanced = await reconcilePendingDeletionReconciliations({ bucket, limit: 10, actionLimit: 2 });
  const accountsAdvanced = await reconcilePendingAccountDeletions(10);
  const storiesDeleted = process.env.NEARYOU_ENABLE_STORY === "true" ? await reconcilePendingStoryDeletions({ bucket, limit: 10 }) : 0;
  return jsonNoStore({ storageReconciliation, exportsAdvanced, sessionsAdvanced, cleanupAdvanced, accountsAdvanced, storiesDeleted, heartbeatAt, schedulerRunId });
}
