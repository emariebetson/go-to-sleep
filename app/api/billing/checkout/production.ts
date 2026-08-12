import { and, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import { getDb } from "@/db";
import { accountDeletionBillingTombstones, accountDeletionItems, accountDeletionOperations, entitlements, householdBillingAccounts } from "@/db/schema";
import { requireHouseholdContext } from "@/lib/api-v1-context";
import { assertTrustedMutationOrigin, jsonNoStore, publicAppOrigin, readLimitedBytes } from "@/lib/http";
import { requireCurrentAdultOnboarding } from "@/lib/nearsleep-live";
import { parseStripeCheckoutSelection, stripeCheckoutPrice } from "@/lib/stripe-entitlements";
import { stripePost, validateStripeCheckoutResponse } from "@/lib/stripe";
import { featureFlagsFromEnv, nearSleepLibraryPrivacyEnabled } from "@/lib/nearyou-foundation";
import { sha256Hex } from "@/lib/nearsleep-library";

async function persistCheckoutCleanup(householdId: string, checkoutSessionId: string) {
  if (!nearSleepLibraryPrivacyEnabled(featureFlagsFromEnv(process.env))) return null;
  const db = getDb();
  const operation = await db.select({ id: accountDeletionOperations.id }).from(accountDeletionOperations).where(and(
    eq(accountDeletionOperations.householdId, householdId),
    inArray(accountDeletionOperations.status, ["grace_period", "processing", "retry_required", "finalizing"]),
  )).get();
  if (!operation) return null;
  const now = new Date();
  await db.insert(accountDeletionItems).values({
    id: `account-item:${crypto.randomUUID()}`,
    operationId: operation.id,
    kind: "billing_checkout",
    reference: checkoutSessionId,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing();
  return db.select({ id: accountDeletionItems.id }).from(accountDeletionItems).where(and(
    eq(accountDeletionItems.operationId, operation.id),
    eq(accountDeletionItems.kind, "billing_checkout"),
    eq(accountDeletionItems.reference, checkoutSessionId),
  )).get();
}

export async function expireFencedCheckout(householdId: string, operationId: string, checkoutSessionId: string, reason: string) {
  let cleanup: { id: string } | null | undefined;
  try { cleanup = await persistCheckoutCleanup(householdId, checkoutSessionId); } catch { cleanup = null; }
  try {
    await stripePost(`/checkout/sessions/${encodeURIComponent(checkoutSessionId)}/expire`, {}, {
      idempotencyKey: `${reason}-${householdId}-${operationId}`,
      notFoundIsSuccess: true,
    });
    if (!nearSleepLibraryPrivacyEnabled(featureFlagsFromEnv(process.env))) return;
    const completedAt = new Date();
    const referenceHash = await sha256Hex(new TextEncoder().encode(checkoutSessionId));
    const tombstone = getDb().insert(accountDeletionBillingTombstones).values({
      id: `billing-tombstone:${referenceHash}`,
      kind: "billing_checkout",
      referenceHash,
      createdAt: completedAt,
      expiresAt: new Date(completedAt.getTime() + 2 * 365 * 24 * 60 * 60 * 1000),
    }).onConflictDoNothing();
    if (cleanup) {
      await getDb().batch([
        tombstone,
        getDb().update(accountDeletionItems).set({ status: "completed", completedAt, updatedAt: completedAt }).where(and(
          eq(accountDeletionItems.id, cleanup.id), eq(accountDeletionItems.status, "pending"),
        )),
      ] as unknown as Parameters<ReturnType<typeof getDb>["batch"]>[0]);
    } else await tombstone;
  } catch {
    // The pending account-deletion item is the durable retry record. The
    // deletion finalizer aborts while it remains pending.
  }
}

export async function postProductionCheckout(request: Request) {
  try {
    assertTrustedMutationOrigin(request);
    const { householdId, user } = await requireHouseholdContext(request, "household:write");
    await requireCurrentAdultOnboarding({ householdId, userId: user.userId });
    let plan;
    try {
      const contentLength = Number(request.headers.get("content-length") || 0);
      if (contentLength > 2_048) throw new Error("Checkout selection is too large.");
      const selection = parseStripeCheckoutSelection(
        request.headers.get("content-type"),
        new TextDecoder().decode(await readLimitedBytes(request, 2_048)),
      );
      plan = stripeCheckoutPrice(process.env, selection.planId, selection.interval);
    } catch (error) {
      return jsonNoStore({ error: error instanceof Error ? error.message : "Checkout selection is invalid." }, { status: 400 });
    }
    const db = getDb();
    const now = new Date();
    await db.insert(householdBillingAccounts).values({ householdId, status: "free", createdAt: now, updatedAt: now }).onConflictDoNothing();
    const [account, paidEntitlement] = await Promise.all([
      db.select({
        customerId: householdBillingAccounts.customerId,
        subscriptionId: householdBillingAccounts.subscriptionId,
        status: householdBillingAccounts.status,
        checkoutPendingAt: householdBillingAccounts.checkoutPendingAt,
        checkoutOperationId: householdBillingAccounts.checkoutOperationId,
        checkoutSessionId: householdBillingAccounts.checkoutSessionId,
        checkoutSessionUrl: householdBillingAccounts.checkoutSessionUrl,
        checkoutPriceId: householdBillingAccounts.checkoutPriceId,
        checkoutStatus: householdBillingAccounts.checkoutStatus,
        checkoutExpiresAt: householdBillingAccounts.checkoutExpiresAt,
      })
        .from(householdBillingAccounts).where(eq(householdBillingAccounts.householdId, householdId)).get(),
      db.select({ id: entitlements.id }).from(entitlements).where(and(
        eq(entitlements.householdId, householdId),
        inArray(entitlements.status, ["active", "grace"]),
        inArray(entitlements.planId, ["nearsleep_plus_legacy", "nearyou_plus", "nearyou_family", "nearlegacy", "archive_builder", "archive_care"]),
        lte(entitlements.validFrom, now),
        or(isNull(entitlements.validUntil), gt(entitlements.validUntil, now)),
      )).get(),
    ]);
    const terminalSubscription = account?.subscriptionId && ["canceled", "incomplete_expired", "unpaid"].includes(account.status);
    if (paidEntitlement || (account?.subscriptionId && !terminalSubscription)) return jsonNoStore({ error: "This household already has a subscription. Manage it from Voice & account." }, { status: 409 });
    if (account?.checkoutPendingAt && !account.checkoutOperationId) {
      return jsonNoStore({ error: "A checkout opened before the protected billing upgrade is still pending. Contact support before opening another." }, { status: 409 });
    }
    let checkoutStatus = account?.checkoutStatus || null;
    if (checkoutStatus === "open" && account?.checkoutExpiresAt && account.checkoutExpiresAt <= now) {
      const expired = await db.update(householdBillingAccounts).set({ checkoutStatus: "expired", checkoutPendingAt: null, updatedAt: now }).where(and(
        eq(householdBillingAccounts.householdId, householdId),
        eq(householdBillingAccounts.checkoutStatus, "open"),
        eq(householdBillingAccounts.checkoutOperationId, account.checkoutOperationId!),
        eq(householdBillingAccounts.checkoutExpiresAt, account.checkoutExpiresAt),
      )).returning({ id: householdBillingAccounts.householdId }).get();
      if (!expired) return jsonNoStore({ error: "Checkout state changed. Try again." }, { status: 409 });
      checkoutStatus = "expired";
    }
    let operationId = account?.checkoutOperationId || "";
    let expiresAt = account?.checkoutExpiresAt || null;
    if (checkoutStatus === "creating" || checkoutStatus === "open") {
      if (account!.checkoutPriceId !== plan.priceId) return jsonNoStore({ error: "A checkout for another plan is already open for this household." }, { status: 409 });
      if (checkoutStatus === "open" && account!.checkoutSessionId && account!.checkoutSessionUrl && account!.checkoutExpiresAt) {
        const replay = validateStripeCheckoutResponse({
          id: account!.checkoutSessionId,
          url: account!.checkoutSessionUrl,
          expires_at: Math.floor(account!.checkoutExpiresAt.getTime() / 1000),
        });
        return Response.redirect(replay.url, 303);
      }
    } else {
      operationId = crypto.randomUUID();
      expiresAt = new Date(now.getTime() + 35 * 60 * 1000);
      const claimed = await db.update(householdBillingAccounts).set({
        checkoutPendingAt: now,
        checkoutOperationId: operationId,
        checkoutSessionId: null,
        checkoutSessionUrl: null,
        checkoutPriceId: plan.priceId,
        checkoutStatus: "creating",
        checkoutExpiresAt: expiresAt,
        updatedAt: now,
      }).where(and(
        eq(householdBillingAccounts.householdId, householdId),
        or(isNull(householdBillingAccounts.subscriptionId), inArray(householdBillingAccounts.status, ["canceled", "incomplete_expired", "unpaid"])),
        or(isNull(householdBillingAccounts.checkoutStatus), inArray(householdBillingAccounts.checkoutStatus, ["expired", "completed"])),
      )).returning({ id: householdBillingAccounts.householdId }).get();
      if (!claimed) return jsonNoStore({ error: "A checkout is already open for this household." }, { status: 409 });
    }
    if (!operationId || !expiresAt) throw new Error("checkout_operation_state_invalid");
    const origin = publicAppOrigin(request);
    const subscriptionCheckout = plan.interval !== "one_time";
    const rawSession = await stripePost("/checkout/sessions", {
        mode: subscriptionCheckout ? "subscription" : "payment",
        integration_identifier: "nearyou_checkout_mxqjvtpa",
        "line_items[0][price]": plan.priceId,
        "line_items[0][quantity]": "1",
        customer: account?.customerId || undefined,
        customer_email: account?.customerId ? undefined : user.email,
        client_reference_id: user.userId,
        "metadata[user_id]": user.userId,
        "metadata[household_id]": householdId,
        "metadata[price_id]": plan.priceId,
        "metadata[plan_id]": plan.planId,
        "metadata[checkout_operation_id]": operationId,
        success_url: `${origin}/library?checkout=success`,
        cancel_url: `${origin}/pricing?checkout=canceled`,
        expires_at: String(Math.floor(expiresAt.getTime() / 1000)),
        allow_promotion_codes: "true",
        ...(subscriptionCheckout ? {
          "subscription_data[metadata][user_id]": user.userId,
          "subscription_data[metadata][household_id]": householdId,
          "subscription_data[metadata][price_id]": plan.priceId,
          "subscription_data[metadata][plan_id]": plan.planId,
          "subscription_data[metadata][checkout_operation_id]": operationId,
        } : {}),
    }, { idempotencyKey: `checkout-${householdId}-${operationId}` });
    const session = validateStripeCheckoutResponse(rawSession);
    let persisted;
    try { persisted = await db.update(householdBillingAccounts).set({
        checkoutSessionId: session.id,
        checkoutSessionUrl: session.url,
        checkoutStatus: "open",
        checkoutExpiresAt: new Date(session.expiresAt * 1000),
        updatedAt: new Date(),
    }).where(and(
        eq(householdBillingAccounts.householdId, householdId),
        eq(householdBillingAccounts.checkoutOperationId, operationId),
        eq(householdBillingAccounts.checkoutPriceId, plan.priceId),
        inArray(householdBillingAccounts.checkoutStatus, ["creating", "open"]),
        or(isNull(householdBillingAccounts.checkoutSessionId), eq(householdBillingAccounts.checkoutSessionId, session.id)),
    )).returning({ id: householdBillingAccounts.householdId }).get(); }
    catch (error) {
      await expireFencedCheckout(householdId, operationId, session.id, "checkout-fence-expire");
      throw error;
    }
    // Keep the stable operation claim when Stripe or this write fails. A retry
    // uses the same provider idempotency key and cannot open a second Checkout.
    if (!persisted) {
      await expireFencedCheckout(householdId, operationId, session.id, "checkout-conflict-expire");
      throw new Error("checkout_session_state_conflict");
    }
    return Response.redirect(session.url, 303);
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("NearYou Stripe checkout failed", error);
    return jsonNoStore({ error: "Checkout is unavailable right now. Please try again later." }, { status: 502 });
  }
}
