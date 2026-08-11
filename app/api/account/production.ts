import { env } from "cloudflare:workers";
import { and, asc, eq, gt, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  accountDeletionOperations,
  accountDeletionItems,
  accountDeletionBillingTombstones,
  accountReauthChallenges,
  deletionReconciliations,
  generationOperations,
  householdBillingAccounts,
  householdBillingSubscriptions,
  householdExportMetadataPages,
  householdExportParts,
  householdExports,
  householdExportDownloadConfirmations,
  householdMembers,
  jobs,
  mediaAssets,
  sleepSessions,
  voiceReplacements,
  voices,
} from "@/db/schema";
import { requireApiAuthContext } from "@/lib/auth";
import { requireTask2cActivationReady, selectedHouseholdId } from "@/lib/api-v1-context";
import { ensureUser } from "@/lib/data";
import { assertTrustedMutationOrigin, fetchWithTimeout, jsonNoStore, readJsonObject } from "@/lib/http";
import { canonicalRequestHash, sha256Hex } from "@/lib/nearsleep-library";
import { stripeDelete, stripePost } from "@/lib/stripe";

type AudioBucket = { delete(keys: string | string[]): Promise<void>; head(key: string): Promise<unknown | null> };
const EXTERNAL_ACTIONS_PER_ATTEMPT = 2;
const QUIESCENCE_MS = 2 * 60 * 1000;
const STALE_WORK_MS = 15 * 60 * 1000;
const INVENTORY_ROWS_PER_PAGE = 20;
const INVENTORY_REFERENCES_PER_ATTEMPT = 50;
const INVENTORY_STAGES = ["billing_accounts", "billing_subscriptions", "voices", "voice_replacements", "media", "sessions", "exports", "export_parts", "export_metadata_pages", "generation", "reconciliations"] as const;
type InventoryStage = typeof INVENTORY_STAGES[number];
type InventoryKind = typeof accountDeletionItems.$inferInsert.kind;

function subjectAffectedExport(userId: string) {
  return or(
    eq(householdExports.requestedByUserId, userId),
    sql`EXISTS (SELECT 1 FROM ${mediaAssets} subject_media WHERE subject_media.household_id = ${householdExports.householdId} AND subject_media.owner_user_id = ${userId})`,
    sql`EXISTS (SELECT 1 FROM ${sleepSessions} subject_session WHERE subject_session.household_id = ${householdExports.householdId} AND subject_session.user_id = ${userId})`,
    sql`EXISTS (SELECT 1 FROM ${voices} subject_voice WHERE subject_voice.household_id = ${householdExports.householdId} AND subject_voice.user_id = ${userId})`,
    sql`EXISTS (SELECT 1 FROM voice_consents subject_consent WHERE subject_consent.household_id = ${householdExports.householdId} AND subject_consent.adult_user_id = ${userId})`,
  );
}

function errorDetail(error: unknown) {
  const details: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    if ("message" in current && typeof current.message === "string") details.push(current.message);
    current = "cause" in current ? current.cause : null;
  }
  return details.join(" ");
}

function bucket() { return (env as unknown as { AUDIO?: AudioBucket }).AUDIO; }

function statusPayload(record: typeof accountDeletionOperations.$inferSelect) {
  const retryMessages: Record<string, string> = {
    provider_unavailable: "Voice-provider cleanup is unavailable. Configure the provider and retry.",
    provider_cleanup_retry: "A private voice still needs provider cleanup. Retry safely.",
    billing_unavailable: "Billing cancellation is unavailable. Configure Stripe and retry.",
    billing_cleanup_retry: "Subscription cancellation needs another retry.",
    billing_cleanup_pending: "Billing cancellation is continuing in the background.",
    generation_in_progress: "Private generation or voice replacement is still winding down safely.",
    generation_quiescence: "Private generation is quiescent; cleanup will resume after the safety window.",
    export_in_progress: "A private export worker is finishing its bounded lease before cleanup continues.",
    storage_unavailable: "Private media storage is unavailable. Restore the binding and retry.",
    storage_cleanup_retry: "Private media deletion or verification needs another retry.",
    snapshot_retry: "Deletion inventory needs reconciliation before cleanup can continue.",
    inventory_pending: "Private-data inventory is continuing in bounded background pages.",
  };
  return {
    operationId: record.id,
    status: record.status,
    stage: record.stage,
    graceUntil: record.graceUntil,
    retryable: record.status === "retry_required",
    ...(record.errorCode ? { action: retryMessages[record.errorCode] || "Deletion needs another safe retry." } : {}),
    completedAt: record.completedAt,
  };
}

function parseDeletionRequest(body: Record<string, unknown>) {
  const requestId = String(body.requestId || "").trim().toLowerCase();
  const reauthChallengeId = String(body.reauthChallengeId || "").trim();
  const receiptToken = String(body.receiptToken || "").trim();
  const exportPolicy = body.exportPolicy;
  const exportId = body.exportId === undefined || body.exportId === null ? null : String(body.exportId).trim();
  const graceHours = Number(body.graceHours);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId)) throw new Error("A stable requestId is required.");
  if (!reauthChallengeId) throw new Error("Fresh reauthentication is required.");
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(receiptToken)) throw new Error("A high-entropy receiptToken is required.");
  if (body.confirmation !== "DELETE MY ACCOUNT") throw new Error("Type DELETE MY ACCOUNT to confirm.");
  if (exportPolicy !== "skip" && exportPolicy !== "require_completed_export") throw new Error("Choose an export policy.");
  if (exportPolicy === "require_completed_export" && !exportId) throw new Error("A completed export is required by this policy.");
  if (exportPolicy === "require_completed_export" && body.exportDownloaded !== true) throw new Error("Confirm that the completed export has been downloaded before deletion.");
  if (graceHours !== 0 && graceHours !== 24) throw new Error("graceHours must be 0 or 24.");
  return { requestId, reauthChallengeId, receiptToken, exportPolicy, exportId, graceHours } as const;
}

async function deleteProviderVoice(providerVoiceId: string) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("provider_unavailable");
  const response = await fetchWithTimeout(`https://api.elevenlabs.io/v1/voices/${encodeURIComponent(providerVoiceId)}`, { method: "DELETE", headers: { "xi-api-key": apiKey } }, 30_000);
  if (!response.ok && response.status !== 404) throw new Error("provider_cleanup_retry");
}

async function advanceDeletionInventory(record: typeof accountDeletionOperations.$inferSelect, attemptToken: string) {
  const db = getDb();
  const householdId = record.householdId!;
  let stage = (INVENTORY_STAGES.includes(record.inventoryStage as InventoryStage) ? record.inventoryStage : INVENTORY_STAGES[0]) as InventoryStage;
  let cursor = record.inventoryCursor;
  let referenceBudget = INVENTORY_REFERENCES_PER_ATTEMPT;
  const refreshing = record.stage === "refresh_inventory";
  while (referenceBudget > 0) {
    const limit = Math.min(INVENTORY_ROWS_PER_PAGE, referenceBudget);
    let rows: Array<Record<string, unknown> & { cursor: string }> = [];
    let references: Array<{ kind: InventoryKind; reference: string }> = [];
    let forcedHasMore: boolean | undefined;
    let forcedNextCursor: string | null | undefined;
    if (stage === "billing_accounts" && cursor === null) {
      const row = await db.select({
        cursor: householdBillingAccounts.householdId,
        checkoutSessionId: householdBillingAccounts.checkoutSessionId,
        checkoutStatus: householdBillingAccounts.checkoutStatus,
        subscriptionId: householdBillingAccounts.subscriptionId,
        customerId: householdBillingAccounts.customerId,
      }).from(householdBillingAccounts).where(eq(householdBillingAccounts.householdId, householdId)).get();
      rows = row ? [row] : [];
      if (row?.checkoutSessionId && ["creating", "open"].includes(row.checkoutStatus || "")) references.push({ kind: "billing_checkout", reference: row.checkoutSessionId });
      if (row?.subscriptionId) references.push({ kind: "billing_subscription", reference: row.subscriptionId });
      if (row?.customerId) references.push({ kind: "billing_customer", reference: row.customerId });
    } else if (stage === "billing_subscriptions") {
      rows = await db.select({ cursor: householdBillingSubscriptions.subscriptionId, subscriptionId: householdBillingSubscriptions.subscriptionId }).from(householdBillingSubscriptions)
        .where(and(eq(householdBillingSubscriptions.householdId, householdId), ...(cursor ? [gt(householdBillingSubscriptions.subscriptionId, cursor)] : []))).orderBy(asc(householdBillingSubscriptions.subscriptionId)).limit(limit + 1).all();
      references = rows.slice(0, limit).map((row) => ({ kind: "billing_subscription", reference: String(row.subscriptionId) }));
    } else if (stage === "voices") {
      rows = await db.select({ cursor: voices.id, providerVoiceId: voices.providerVoiceId }).from(voices).where(and(
        eq(voices.userId, record.userId!), ...(cursor ? [gt(voices.id, cursor)] : []),
      )).orderBy(asc(voices.id)).limit(limit + 1).all();
      references = rows.slice(0, limit).flatMap((row) => typeof row.providerVoiceId === "string" && !row.providerVoiceId.startsWith("pending:") ? [{ kind: "provider_voice" as const, reference: row.providerVoiceId }] : []);
    } else if (stage === "voice_replacements") {
      rows = await db.select({ cursor: voiceReplacements.id, original: voiceReplacements.originalProviderVoiceId, replacement: voiceReplacements.replacementProviderVoiceId }).from(voiceReplacements).where(and(
        eq(voiceReplacements.adultUserId, record.userId!), ...(cursor ? [gt(voiceReplacements.id, cursor)] : []),
      )).orderBy(asc(voiceReplacements.id)).limit(limit + 1).all();
      references = rows.slice(0, limit).flatMap((row) => [row.original, row.replacement].flatMap((reference) => typeof reference === "string" && !reference.startsWith("pending:") ? [{ kind: "provider_voice" as const, reference }] : []));
    } else if (stage === "media") {
      rows = await db.select({ cursor: mediaAssets.id, storageKey: mediaAssets.storageKey }).from(mediaAssets).where(and(
        eq(mediaAssets.ownerUserId, record.userId!), ...(cursor ? [gt(mediaAssets.id, cursor)] : []),
      )).orderBy(asc(mediaAssets.id)).limit(limit + 1).all();
      references = rows.slice(0, limit).flatMap((row) => typeof row.storageKey === "string" ? [{ kind: "storage_key" as const, reference: row.storageKey }] : []);
    } else if (stage === "sessions") {
      rows = await db.select({ cursor: sleepSessions.id, id: sleepSessions.id, householdId: sleepSessions.householdId, audioKey: sleepSessions.audioKey }).from(sleepSessions).where(and(
        eq(sleepSessions.userId, record.userId!), ...(cursor ? [gt(sleepSessions.id, cursor)] : []),
      )).orderBy(asc(sleepSessions.id)).limit(limit + 1).all();
      references = rows.slice(0, limit).flatMap((row) => [
        ...(typeof row.audioKey === "string" ? [{ kind: "storage_key" as const, reference: row.audioKey }] : []),
        ...(typeof row.householdId === "string" ? [{ kind: "storage_key" as const, reference: `audio/${encodeURIComponent(row.householdId)}/${encodeURIComponent(String(row.id))}.mp3` }] : []),
      ]);
    } else if (stage === "exports") {
      rows = await db.select({ cursor: householdExports.id, manifestStorageKey: householdExports.manifestStorageKey }).from(householdExports).where(and(
        subjectAffectedExport(record.userId!), ...(cursor ? [gt(householdExports.id, cursor)] : []),
      )).orderBy(asc(householdExports.id)).limit(limit + 1).all();
      references = rows.slice(0, limit).flatMap((row) => typeof row.manifestStorageKey === "string" ? [{ kind: "storage_key" as const, reference: row.manifestStorageKey }] : []);
    } else if (stage === "export_parts") {
      rows = await db.select({ cursor: householdExportParts.id, exportStorageKey: householdExportParts.exportStorageKey }).from(householdExportParts).innerJoin(householdExports, and(
        eq(householdExportParts.exportId, householdExports.id),
      )).where(and(subjectAffectedExport(record.userId!), ...(cursor ? [gt(householdExportParts.id, cursor)] : []))).orderBy(asc(householdExportParts.id)).limit(limit + 1).all();
      references = rows.slice(0, limit).map((row) => ({ kind: "storage_key", reference: String(row.exportStorageKey) }));
    } else if (stage === "export_metadata_pages") {
      rows = await db.select({ cursor: householdExportMetadataPages.id, storageKey: householdExportMetadataPages.storageKey }).from(householdExportMetadataPages).innerJoin(householdExports, and(
        eq(householdExportMetadataPages.exportId, householdExports.id),
      )).where(and(subjectAffectedExport(record.userId!), ...(cursor ? [gt(householdExportMetadataPages.id, cursor)] : []))).orderBy(asc(householdExportMetadataPages.id)).limit(limit + 1).all();
      references = rows.slice(0, limit).map((row) => ({ kind: "storage_key", reference: String(row.storageKey) }));
    } else if (stage === "generation") {
      rows = await db.select({ cursor: generationOperations.id, id: generationOperations.id, householdId: generationOperations.householdId, operation: generationOperations.operation }).from(generationOperations).where(and(
        eq(generationOperations.userId, record.userId!), ...(cursor ? [gt(generationOperations.id, cursor)] : []),
      )).orderBy(asc(generationOperations.id)).limit(limit + 1).all();
      references = rows.slice(0, limit).flatMap((row) => {
        const requestId = String(row.id).split(":").at(-1);
        if (!requestId || (row.operation !== "script" && row.operation !== "audio")) return [];
        return [
          { kind: "storage_key" as const, reference: `generation-results/${encodeURIComponent(String(row.householdId))}/${encodeURIComponent(String(row.operation))}/${encodeURIComponent(requestId)}.json` },
          ...(row.operation === "audio" ? [{ kind: "storage_key" as const, reference: `audio-previews/${encodeURIComponent(String(row.householdId))}/${encodeURIComponent(requestId)}.mp3` }] : []),
        ];
      });
    } else if (stage === "reconciliations") {
      const partialMatch = cursor?.match(/^@reconciliation:(.*):(\d+)$/);
      const partialRowId = partialMatch ? decodeURIComponent(partialMatch[1]) : null;
      const partialOffset = partialMatch ? Number(partialMatch[2]) : 0;
      rows = await db.select({ cursor: deletionReconciliations.id, storageKeys: deletionReconciliations.storageKeys, providerReferences: deletionReconciliations.providerReferences }).from(deletionReconciliations)
        .where(and(or(
          and(eq(deletionReconciliations.scope, "account"), eq(deletionReconciliations.scopeId, householdId)),
          and(eq(deletionReconciliations.scope, "session"), sql`${deletionReconciliations.scopeId} IN (SELECT id FROM sleep_sessions WHERE user_id = ${record.userId!})`),
          and(eq(deletionReconciliations.scope, "voice"), or(
            sql`${deletionReconciliations.scopeId} IN (SELECT id FROM voices WHERE user_id = ${record.userId!})`,
            sql`${deletionReconciliations.scopeId} IN (SELECT id FROM voice_replacements WHERE adult_user_id = ${record.userId!})`,
          )),
        ), ...(partialRowId ? [eq(deletionReconciliations.id, partialRowId)] : cursor ? [gt(deletionReconciliations.id, cursor)] : [])))
        .orderBy(asc(deletionReconciliations.id)).limit(1).all();
      const allReferences = rows.flatMap((row) => {
        const storageKeys = Array.isArray(row.storageKeys) ? row.storageKeys.filter((value): value is string => typeof value === "string") : [];
        const providerReferences = Array.isArray(row.providerReferences) ? row.providerReferences.filter((value): value is string => typeof value === "string") : [];
        if (storageKeys.length + providerReferences.length > 100) throw new Error("inventory_reference_overflow");
        return [
          ...storageKeys.map((reference) => ({ kind: "storage_key" as const, reference })),
          ...providerReferences.filter((reference) => !reference.startsWith("pending:")).map((reference) => ({ kind: "provider_voice" as const, reference })),
        ];
      });
      references = allReferences.slice(partialOffset, partialOffset + referenceBudget);
      if (rows[0]) {
        const nextOffset = partialOffset + references.length;
        forcedHasMore = true;
        forcedNextCursor = nextOffset < allReferences.length
          ? `@reconciliation:${encodeURIComponent(rows[0].cursor)}:${nextOffset}`
          : rows[0].cursor;
      }
    }
    const pageRows = rows.slice(0, limit);
    const hasMore = forcedHasMore ?? rows.length > limit;
    const nextCursor = forcedNextCursor !== undefined ? forcedNextCursor : hasMore ? pageRows.at(-1)?.cursor || cursor : null;
    const stageIndex = INVENTORY_STAGES.indexOf(stage);
    const nextStage = hasMore ? stage : INVENTORY_STAGES[stageIndex + 1];
    const now = new Date();
    const statements = references.map((item) => db.insert(accountDeletionItems).values({
      id: `account-item:${crypto.randomUUID()}`,
      operationId: record.id,
      kind: item.kind,
      reference: item.reference,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing());
    if (!nextStage) {
      statements.push(db.update(accountDeletionOperations).set({
        inventoryStage: "completed", inventoryCursor: null, inventoryComplete: true,
        stage: refreshing ? "billing_refresh_cleanup" : "billing_cleanup", errorCode: null, updatedAt: now,
      }).where(and(eq(accountDeletionOperations.id, record.id), eq(accountDeletionOperations.attemptToken, attemptToken))) as never);
      await db.batch(statements as unknown as Parameters<typeof db.batch>[0]);
      return { complete: true, stage: refreshing ? "billing_refresh_cleanup" : "billing_cleanup" } as const;
    }
    statements.push(db.update(accountDeletionOperations).set({ inventoryStage: nextStage, inventoryCursor: nextCursor, stage: refreshing ? "refresh_inventory" : "inventory", updatedAt: now }).where(and(
      eq(accountDeletionOperations.id, record.id), eq(accountDeletionOperations.attemptToken, attemptToken),
    )) as never);
    await db.batch(statements as unknown as Parameters<typeof db.batch>[0]);
    referenceBudget -= Math.max(1, references.length);
    stage = nextStage;
    cursor = nextCursor;
  }
  return { complete: false, stage: refreshing ? "refresh_inventory" : "inventory" } as const;
}

async function deleteBillingReference(action: { kind: "checkout" | "subscription" | "customer"; id: string }, operationId: string) {
  if (action.kind === "checkout") {
    await stripePost(`/checkout/sessions/${encodeURIComponent(action.id)}/expire`, {}, { idempotencyKey: `account-delete:${operationId}:checkout:${action.id}`, notFoundIsSuccess: true });
    return;
  }
  await stripeDelete(`/${action.kind === "subscription" ? "subscriptions" : "customers"}/${encodeURIComponent(action.id)}`);
}

async function reconcileOperation(record: typeof accountDeletionOperations.$inferSelect) {
  const db = getDb();
  if (record.status === "completed" || record.status === "canceled") return record;
  const now = new Date();
  if (record.status === "processing" && record.attemptExpiresAt && record.attemptExpiresAt.getTime() > now.getTime()) return record;
  const attemptToken = crypto.randomUUID();
  const attemptExpiresAt = new Date(now.getTime() + 2 * 60 * 1000);
  const claimed = await db.update(accountDeletionOperations).set({ status: "processing", attemptToken, attemptExpiresAt, errorCode: null, updatedAt: now }).where(and(
    eq(accountDeletionOperations.id, record.id),
    or(ne(accountDeletionOperations.status, "processing"), isNull(accountDeletionOperations.attemptExpiresAt), lte(accountDeletionOperations.attemptExpiresAt, now)),
  )).returning({ id: accountDeletionOperations.id }).get();
  if (!claimed) return (await db.select().from(accountDeletionOperations).where(eq(accountDeletionOperations.id, record.id)).get())!;
  const pause = async (values: Partial<typeof accountDeletionOperations.$inferInsert>) => {
    await db.update(accountDeletionOperations).set({ status: "retry_required", attemptToken: null, attemptExpiresAt: null, updatedAt: new Date(), ...values }).where(and(
      eq(accountDeletionOperations.id, record.id), eq(accountDeletionOperations.attemptToken, attemptToken),
    ));
    return (await db.select().from(accountDeletionOperations).where(eq(accountDeletionOperations.id, record.id)).get())!;
  };
  try {
    if (record.graceUntil.getTime() > Date.now()) {
      await db.update(accountDeletionOperations).set({ status: "grace_period", stage: "grace_period", attemptToken: null, attemptExpiresAt: null, errorCode: null, updatedAt: new Date() }).where(and(
        eq(accountDeletionOperations.id, record.id), eq(accountDeletionOperations.attemptToken, attemptToken),
      ));
      return (await db.select().from(accountDeletionOperations).where(eq(accountDeletionOperations.id, record.id)).get())!;
    }
    let currentStage = record.stage;
    if (!record.inventoryComplete) {
      const inventory = await advanceDeletionInventory(record, attemptToken);
      currentStage = inventory.stage;
      if (!inventory.complete) return pause({ stage: currentStage, errorCode: "inventory_pending" });
    }
    if (currentStage === "billing_cleanup" || currentStage === "billing_refresh_cleanup" || currentStage === "inventory") {
      const afterRefresh = currentStage === "billing_refresh_cleanup";
      await db.update(accountDeletionOperations).set({ stage: "billing_cleanup", updatedAt: new Date() }).where(and(eq(accountDeletionOperations.id, record.id), eq(accountDeletionOperations.attemptToken, attemptToken)));
      const billingItems = await db.select().from(accountDeletionItems).where(and(
        eq(accountDeletionItems.operationId, record.id), eq(accountDeletionItems.status, "pending"), inArray(accountDeletionItems.kind, ["billing_checkout", "billing_subscription", "billing_customer"]),
      )).orderBy(asc(accountDeletionItems.id)).limit(EXTERNAL_ACTIONS_PER_ATTEMPT + 1).all();
      if (billingItems.length && !process.env.STRIPE_SECRET_KEY) throw new Error("billing_unavailable");
      for (const item of billingItems.slice(0, EXTERNAL_ACTIONS_PER_ATTEMPT)) {
        const kind = item.kind === "billing_checkout" ? "checkout" : item.kind === "billing_subscription" ? "subscription" : "customer";
        try { await deleteBillingReference({ kind, id: item.reference }, record.id); } catch { throw new Error("billing_cleanup_retry"); }
        const completedAt = new Date();
        const referenceHash = await sha256Hex(new TextEncoder().encode(item.reference));
        await db.batch([
          db.insert(accountDeletionBillingTombstones).values({ id: `billing-tombstone:${referenceHash}`, kind: item.kind, referenceHash, createdAt: completedAt, expiresAt: new Date(completedAt.getTime() + 2 * 365 * 24 * 60 * 60 * 1000) }).onConflictDoNothing(),
          db.update(accountDeletionItems).set({ status: "completed", completedAt, updatedAt: completedAt }).where(and(
            eq(accountDeletionItems.id, item.id), eq(accountDeletionItems.operationId, record.id), eq(accountDeletionItems.status, "pending"),
          )),
        ] as unknown as Parameters<typeof db.batch>[0]);
      }
      if (billingItems.length > EXTERNAL_ACTIONS_PER_ATTEMPT) return pause({ stage: "billing_cleanup", errorCode: "billing_cleanup_pending" });
      currentStage = afterRefresh ? "provider_cleanup" : "generation_quiescence";
    }
    if (!["provider_cleanup", "storage_cleanup", "finalizing"].includes(currentStage)) {
      const staleBefore = new Date(Date.now() - STALE_WORK_MS);
      await db.update(householdExports).set({ status: "canceled", attemptToken: null, attemptExpiresAt: null, errorCode: "account_deletion_fenced", updatedAt: new Date() }).where(and(
        subjectAffectedExport(record.userId!),
        or(inArray(householdExports.status, ["queued", "failed"]), and(eq(householdExports.status, "running"), or(isNull(householdExports.attemptExpiresAt), lte(householdExports.attemptExpiresAt, new Date())))),
      ));
      await Promise.all([
        db.update(generationOperations).set({ status: "failed", errorCode: "account_deletion_fenced", completedAt: new Date(), updatedAt: new Date() }).where(and(
          eq(generationOperations.userId, record.userId!), eq(generationOperations.status, "processing"), lte(generationOperations.updatedAt, staleBefore),
        )),
        db.update(voiceReplacements).set({ status: "failed", errorCode: "account_deletion_fenced", completedAt: new Date(), updatedAt: new Date() }).where(and(
          eq(voiceReplacements.adultUserId, record.userId!), inArray(voiceReplacements.status, ["processing", "provider_created", "activating"]), lte(voiceReplacements.updatedAt, staleBefore),
        )),
        db.update(jobs).set({ status: "canceled", errorCode: "account_deletion_fenced", completedAt: new Date(), updatedAt: new Date() }).where(and(
          eq(jobs.requestedByUserId, record.userId!), inArray(jobs.status, ["queued", "running"]), lte(jobs.updatedAt, staleBefore),
        )),
        db.update(sleepSessions).set({ status: "failed", errorCode: "account_deletion_fenced", completedAt: new Date() }).where(and(
          eq(sleepSessions.userId, record.userId!), inArray(sleepSessions.status, ["queued", "generating"]), lte(sleepSessions.createdAt, staleBefore),
        )),
      ]);
      const [liveExport, liveGeneration, liveReplacement, liveJob, liveSession] = await Promise.all([
        db.select({ id: householdExports.id }).from(householdExports).where(and(subjectAffectedExport(record.userId!), eq(householdExports.status, "running"), gt(householdExports.attemptExpiresAt, new Date()))).limit(1).get(),
        db.select({ id: generationOperations.id }).from(generationOperations).where(and(eq(generationOperations.userId, record.userId!), eq(generationOperations.status, "processing"))).limit(1).get(),
        db.select({ id: voiceReplacements.id }).from(voiceReplacements).where(and(
          eq(voiceReplacements.adultUserId, record.userId!), inArray(voiceReplacements.status, ["processing", "provider_created", "activating"]),
        )).limit(1).get(),
        db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.requestedByUserId, record.userId!), inArray(jobs.status, ["queued", "running"]))).limit(1).get(),
        db.select({ id: sleepSessions.id }).from(sleepSessions).where(and(eq(sleepSessions.userId, record.userId!), inArray(sleepSessions.status, ["queued", "generating"]))).limit(1).get(),
      ]);
      if (liveExport) return pause({ stage: "generation_quiescence", errorCode: "export_in_progress", quiescentAt: null });
      await db.update(householdExports).set({ status: "canceled", attemptToken: null, attemptExpiresAt: null, errorCode: "account_deletion_fenced", updatedAt: new Date() })
        .where(subjectAffectedExport(record.userId!));
      if (liveGeneration || liveReplacement || liveJob || liveSession) return pause({ stage: "generation_quiescence", errorCode: "generation_in_progress", quiescentAt: null });
      const quiescentAt = record.quiescentAt;
      if (!quiescentAt || quiescentAt.getTime() + QUIESCENCE_MS > Date.now()) {
        return pause({ stage: "generation_quiescence", errorCode: "generation_quiescence", quiescentAt: quiescentAt || new Date() });
      }
      return pause({ stage: "refresh_inventory", inventoryStage: INVENTORY_STAGES[0], inventoryCursor: null, inventoryComplete: false, errorCode: "inventory_pending" });
    }
    await db.update(accountDeletionOperations).set({ stage: "provider_cleanup", updatedAt: new Date() }).where(and(eq(accountDeletionOperations.id, record.id), eq(accountDeletionOperations.attemptToken, attemptToken)));
    const providerItems = await db.select().from(accountDeletionItems).where(and(
      eq(accountDeletionItems.operationId, record.id), eq(accountDeletionItems.kind, "provider_voice"), eq(accountDeletionItems.status, "pending"),
    )).orderBy(asc(accountDeletionItems.id)).limit(EXTERNAL_ACTIONS_PER_ATTEMPT + 1).all();
    for (const item of providerItems.slice(0, EXTERNAL_ACTIONS_PER_ATTEMPT)) {
      await deleteProviderVoice(item.reference);
      const completedAt = new Date();
      await db.update(accountDeletionItems).set({ status: "completed", completedAt, updatedAt: completedAt }).where(and(eq(accountDeletionItems.id, item.id), eq(accountDeletionItems.status, "pending")));
    }
    if (providerItems.length > EXTERNAL_ACTIONS_PER_ATTEMPT) return pause({ stage: "provider_cleanup", errorCode: "provider_cleanup_retry" });
    await db.update(accountDeletionOperations).set({ stage: "storage_cleanup", updatedAt: new Date() }).where(and(eq(accountDeletionOperations.id, record.id), eq(accountDeletionOperations.attemptToken, attemptToken)));
    const storageItems = await db.select().from(accountDeletionItems).where(and(
      eq(accountDeletionItems.operationId, record.id), eq(accountDeletionItems.kind, "storage_key"), eq(accountDeletionItems.status, "pending"),
    )).orderBy(asc(accountDeletionItems.id)).limit(EXTERNAL_ACTIONS_PER_ATTEMPT + 1).all();
    if (storageItems.length) {
      const storage = bucket();
      if (!storage) throw new Error("storage_unavailable");
      for (const item of storageItems.slice(0, EXTERNAL_ACTIONS_PER_ATTEMPT)) {
        try { await storage.delete(item.reference); if (await storage.head(item.reference)) throw new Error("present"); } catch { throw new Error("storage_cleanup_retry"); }
        const completedAt = new Date();
        await db.update(accountDeletionItems).set({ status: "completed", completedAt, updatedAt: completedAt }).where(and(eq(accountDeletionItems.id, item.id), eq(accountDeletionItems.status, "pending")));
      }
      if (storageItems.length > EXTERNAL_ACTIONS_PER_ATTEMPT) return pause({ stage: "storage_cleanup", errorCode: "storage_cleanup_retry" });
    }
    const completedAt = new Date();
    const finalized = await db.update(accountDeletionOperations).set({ status: "finalizing", stage: "finalizing", updatedAt: completedAt }).where(and(
      eq(accountDeletionOperations.id, record.id), eq(accountDeletionOperations.attemptToken, attemptToken), eq(accountDeletionOperations.status, "processing"),
    )).returning({ id: accountDeletionOperations.id }).get();
    if (!finalized) throw new Error("storage_cleanup_retry");
  } catch (error) {
    const code = (errorDetail(error) || "storage_cleanup_retry").slice(0, 500);
    await db.update(accountDeletionOperations).set({ status: "retry_required", attemptToken: null, attemptExpiresAt: null, errorCode: code, updatedAt: new Date() }).where(and(
      eq(accountDeletionOperations.id, record.id), eq(accountDeletionOperations.attemptToken, attemptToken),
    ));
  }
  return (await db.select().from(accountDeletionOperations).where(eq(accountDeletionOperations.id, record.id)).get())!;
}

export async function reconcilePendingAccountDeletions(limit = 10) {
  const db = getDb();
  const now = new Date();
  const records = await db.select().from(accountDeletionOperations).where(or(
    eq(accountDeletionOperations.status, "retry_required"),
    and(eq(accountDeletionOperations.status, "grace_period"), lte(accountDeletionOperations.graceUntil, now)),
    and(eq(accountDeletionOperations.status, "processing"), or(isNull(accountDeletionOperations.attemptExpiresAt), lte(accountDeletionOperations.attemptExpiresAt, now))),
  )).orderBy(accountDeletionOperations.updatedAt).limit(Math.min(20, Math.max(1, limit))).all();
  for (const record of records) await reconcileOperation(record);
  return records.length;
}

export async function deleteProductionAccount(request: Request) {
  try {
    assertTrustedMutationOrigin(request);
    const auth = await requireApiAuthContext(request);
    const { householdId: personalHouseholdId } = await ensureUser(auth.user);
    let input;
    try { input = parseDeletionRequest(await readJsonObject(request, 4_000)); } catch (error) {
      return error instanceof Response ? error : jsonNoStore({ error: error instanceof Error ? error.message : "Deletion request is invalid." }, { status: 400 });
    }
    const receiptHash = await sha256Hex(new TextEncoder().encode(input.receiptToken));
    const requestHash = await canonicalRequestHash({ exportPolicy: input.exportPolicy, exportId: input.exportId, graceHours: input.graceHours });
    const db = getDb();
    let record = await db.select().from(accountDeletionOperations).where(and(
      eq(accountDeletionOperations.userId, auth.user.userId), eq(accountDeletionOperations.idempotencyKey, input.requestId),
    )).get();
    if (record) {
      if (record.userId !== auth.user.userId || record.requestHash !== requestHash || record.subjectReceiptHash !== receiptHash) return jsonNoStore({ error: "That request ID conflicts with another deletion request." }, { status: 409 });
    } else {
      await requireTask2cActivationReady();
      const householdId = selectedHouseholdId(request, personalHouseholdId);
      const memberships = await db.select({ householdId: householdMembers.householdId, role: householdMembers.role }).from(householdMembers).where(and(
        eq(householdMembers.userId, auth.user.userId), eq(householdMembers.status, "active"),
      )).all();
      if (memberships.length !== 1 || memberships[0].householdId !== householdId || memberships[0].role !== "owner") {
        return jsonNoStore({ error: "Transfer or leave every other household, then select the sole household you own before deleting this account." }, { status: 409 });
      }
      const others = await db.select({ id: householdMembers.id }).from(householdMembers).where(and(
        eq(householdMembers.householdId, householdId), eq(householdMembers.status, "active"), ne(householdMembers.userId, auth.user.userId),
      )).all();
      if (others.length) return jsonNoStore({ error: "Transfer this household or remove its other active members before deleting it." }, { status: 409 });
      const challenge = await db.select().from(accountReauthChallenges).where(and(
        eq(accountReauthChallenges.id, input.reauthChallengeId), eq(accountReauthChallenges.userId, auth.user.userId), eq(accountReauthChallenges.status, "verified"), eq(accountReauthChallenges.verifiedSessionId, auth.sessionId),
      )).get();
      if (!challenge || challenge.expiresAt.getTime() <= Date.now()) return jsonNoStore({ error: "A new, one-use Google sign-in is required before deletion." }, { status: 403 });
      if (input.exportPolicy === "require_completed_export") {
        const completedExport = await db.select({ id: householdExports.id }).from(householdExports).innerJoin(householdExportDownloadConfirmations, and(
          eq(householdExportDownloadConfirmations.exportId, householdExports.id),
          eq(householdExportDownloadConfirmations.userId, auth.user.userId),
          eq(householdExportDownloadConfirmations.manifestChecksum, householdExports.manifestChecksum),
        )).where(and(
          eq(householdExports.id, input.exportId!), eq(householdExports.householdId, householdId), eq(householdExports.requestedByUserId, auth.user.userId), eq(householdExports.status, "succeeded"),
        )).get();
        if (!completedExport) return jsonNoStore({ error: "Download and verify every file in the selected household export before deletion." }, { status: 409 });
      }
      const now = new Date();
      const operationId = `account-delete:${crypto.randomUUID()}`;
      try {
        await db.insert(accountDeletionOperations).values({
          id: operationId,
          userId: auth.user.userId,
          householdId,
          subjectReceiptHash: receiptHash,
          idempotencyKey: input.requestId,
          requestHash,
          reauthChallengeId: input.reauthChallengeId,
          reauthSessionId: auth.sessionId,
          status: "grace_period",
          stage: "fenced",
          exportPolicy: input.exportPolicy,
          graceUntil: new Date(now.getTime() + input.graceHours * 60 * 60 * 1000),
          snapshot: { exportId: input.exportId },
          createdAt: now,
          updatedAt: now,
        });
      } catch (error) {
        const concurrent = await db.select().from(accountDeletionOperations).where(and(
          eq(accountDeletionOperations.userId, auth.user.userId), eq(accountDeletionOperations.idempotencyKey, input.requestId),
        )).get();
        if (concurrent) {
          if (concurrent.requestHash !== requestHash || concurrent.subjectReceiptHash !== receiptHash) return jsonNoStore({ error: "That request ID conflicts with another deletion request." }, { status: 409 });
          record = concurrent;
        } else {
        const detail = errorDetail(error);
        if (detail.includes("fresh_reauthentication_required")) return jsonNoStore({ error: "A new, one-use Google sign-in is required before deletion." }, { status: 403 });
        if (detail.includes("account_deletion_checkout_in_progress")) return jsonNoStore({ error: "A billing checkout is still being created. Finish or expire it before deleting the account." }, { status: 409 });
        if (detail.includes("account_deletion_membership_conflict")) return jsonNoStore({ error: "Household membership changed. Transfer, leave, or remove members before retrying deletion." }, { status: 409 });
        throw error;
        }
      }
      record ||= (await db.select().from(accountDeletionOperations).where(eq(accountDeletionOperations.id, operationId)).get())!;
    }
    record = await reconcileOperation(record);
    return jsonNoStore({ deletion: statusPayload(record) }, { status: record.status === "completed" ? 200 : 202 });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("Production account deletion failed", error);
    return jsonNoStore({ error: "Account deletion is safely paused and can be retried." }, { status: 500 });
  }
}

export async function getProductionAccountDeletion(request: Request) {
  try {
    const authorization = request.headers.get("authorization") || "";
    const receiptToken = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
    if (receiptToken) {
      const receiptHash = await sha256Hex(new TextEncoder().encode(receiptToken));
      const receipt = await getDb().select().from(accountDeletionOperations).where(eq(accountDeletionOperations.subjectReceiptHash, receiptHash)).get();
      if (!receipt) return jsonNoStore({ error: "Deletion receipt not found." }, { status: 404 });
      return jsonNoStore({ deletion: statusPayload(receipt) });
    }
    const auth = await requireApiAuthContext(request);
    const record = await getDb().select().from(accountDeletionOperations).where(eq(accountDeletionOperations.userId, auth.user.userId)).get();
    return jsonNoStore({ deletion: record ? statusPayload(record) : null });
  } catch (error) {
    if (error instanceof Response) return error;
    return jsonNoStore({ error: "Deletion status is unavailable." }, { status: 500 });
  }
}

export async function cancelProductionAccountDeletion(request: Request) {
  try {
    assertTrustedMutationOrigin(request);
    const auth = await requireApiAuthContext(request);
    const body = await readJsonObject(request, 1_000);
    const receiptToken = String(body.receiptToken || "").trim();
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(receiptToken)) return jsonNoStore({ error: "The saved receipt token is required to cancel deletion." }, { status: 400 });
    const receiptHash = await sha256Hex(new TextEncoder().encode(receiptToken));
    const db = getDb();
    const record = await db.select().from(accountDeletionOperations).where(and(
      eq(accountDeletionOperations.userId, auth.user.userId),
      eq(accountDeletionOperations.subjectReceiptHash, receiptHash),
      eq(accountDeletionOperations.reauthSessionId, auth.sessionId),
      eq(accountDeletionOperations.status, "grace_period"),
      gt(accountDeletionOperations.graceUntil, new Date()),
    )).get();
    if (!record?.householdId) return jsonNoStore({ error: "Cancelable deletion grace period not found." }, { status: 404 });
    const owner = await db.select({ id: householdMembers.id }).from(householdMembers).where(and(
      eq(householdMembers.householdId, record.householdId), eq(householdMembers.userId, auth.user.userId), eq(householdMembers.role, "owner"), eq(householdMembers.status, "active"),
    )).get();
    if (!owner) return jsonNoStore({ error: "Only the current household owner can cancel this deletion." }, { status: 403 });
    const canceledAt = new Date();
    const canceled = await db.update(accountDeletionOperations).set({
      status: "canceled", stage: "canceled", userId: null, householdId: null,
      idempotencyKey: "redacted", requestHash: "redacted", reauthChallengeId: "redacted", reauthSessionId: "redacted",
      snapshot: {}, errorCode: null, attemptToken: null, attemptExpiresAt: null, completedAt: canceledAt, updatedAt: canceledAt,
    }).where(and(eq(accountDeletionOperations.id, record.id), eq(accountDeletionOperations.status, "grace_period"), isNull(accountDeletionOperations.attemptToken))).returning().get();
    if (!canceled) return jsonNoStore({ error: "Deletion grace state changed. Refresh status." }, { status: 409 });
    return jsonNoStore({ deletion: statusPayload(canceled), canceled: true });
  } catch (error) {
    if (error instanceof Response) return error;
    return jsonNoStore({ error: "Deletion cancellation could not be verified." }, { status: 500 });
  }
}
