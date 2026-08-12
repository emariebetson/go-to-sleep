import { PLAN_CATALOG, type PlanId } from "./nearyou-foundation";

export type StripeBillingInterval = "month" | "year" | "one_time";
export type StripePriceBinding = {
  priceId: string;
  planId: PlanId;
  interval: StripeBillingInterval;
  allowanceMilliunits: number;
  grandfathered: boolean;
};

const bindings = [
  ["STRIPE_PRICE_PLUS_MONTHLY", "nearsleep_plus_legacy", "month", true],
  ["STRIPE_PRICE_NEARYOU_PLUS_MONTHLY", "nearyou_plus", "month", false],
  ["STRIPE_PRICE_NEARYOU_PLUS_ANNUAL", "nearyou_plus", "year", false],
  ["STRIPE_PRICE_NEARYOU_FAMILY_MONTHLY", "nearyou_family", "month", false],
  ["STRIPE_PRICE_NEARYOU_FAMILY_ANNUAL", "nearyou_family", "year", false],
  ["STRIPE_PRICE_NEARLEGACY_MONTHLY", "nearlegacy", "month", false],
  ["STRIPE_PRICE_NEARLEGACY_ANNUAL", "nearlegacy", "year", false],
  ["STRIPE_PRICE_ARCHIVE_CARE_ANNUAL", "archive_care", "year", false],
  ["STRIPE_PRICE_ARCHIVE_BUILDER", "archive_builder", "one_time", false],
] as const;

export function configuredStripePrices(environment: Record<string, string | undefined>) {
  const prices = new Map<string, StripePriceBinding>();
  for (const [variable, planId, interval, grandfathered] of bindings) {
    const priceId = environment[variable]?.trim();
    if (!priceId) continue;
    if (!/^price_[A-Za-z0-9_]+$/.test(priceId)) throw new Error(`Invalid Stripe price configured in ${variable}.`);
    if (prices.has(priceId)) throw new Error("A Stripe price cannot map to multiple plans.");
    prices.set(priceId, {
      priceId,
      planId,
      interval,
      allowanceMilliunits: PLAN_CATALOG[planId].monthlyAllowanceMilliunits,
      grandfathered,
    });
  }
  return prices;
}

export function stripeCheckoutPrice(
  environment: Record<string, string | undefined>,
  planId: string,
  interval: string,
) {
  if (planId === "nearsleep_plus_legacy") throw new Error("The grandfathered plan is not available for new checkout.");
  const allowed = (planId === "archive_builder" && interval === "one_time")
    || (planId === "archive_care" && interval === "year")
    || (["nearyou_plus", "nearyou_family", "nearlegacy"].includes(planId) && ["month", "year"].includes(interval));
  if (!allowed) {
    throw new Error("That billing plan is not available.");
  }
  const match = [...configuredStripePrices(environment).values()].find((price) => price.planId === planId && price.interval === interval);
  if (!match) throw new Error("That billing plan is not configured.");
  return match;
}

export function parseStripeCheckoutSelection(contentType: string | null, body: string) {
  if (new TextEncoder().encode(body).byteLength > 2_048) throw new Error("Checkout selection is too large.");
  let planId: unknown;
  let interval: unknown;
  if (contentType?.split(";", 1)[0].trim().toLowerCase() === "application/x-www-form-urlencoded") {
    const values = new URLSearchParams(body);
    planId = values.get("plan");
    interval = values.get("interval");
  } else if (contentType?.split(";", 1)[0].trim().toLowerCase() === "application/json") {
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { throw new Error("Checkout selection is invalid."); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Checkout selection is invalid.");
    planId = (parsed as Record<string, unknown>).plan;
    interval = (parsed as Record<string, unknown>).interval;
  } else {
    throw new Error("Checkout selection content type is unsupported.");
  }
  if (typeof planId !== "string" || typeof interval !== "string") throw new Error("Checkout plan and interval are required.");
  return { planId, interval };
}

export function stripeEntitlementStatus(status: string, deleted: boolean): "active" | "grace" | "inactive" | "revoked" {
  if (deleted) return "revoked";
  if (status === "active" || status === "trialing") return "active";
  if (status === "past_due") return "grace";
  if (["unpaid", "canceled", "incomplete", "incomplete_expired", "paused"].includes(status)) return "inactive";
  throw new Error("Unsupported Stripe subscription status.");
}

export function stripeEntitlementValidUntil(
  status: "active" | "grace" | "inactive" | "revoked",
  eventCreatedAt: Date,
  periodEndSeconds?: number,
  existingGraceUntil?: Date | null,
) {
  if (status === "grace") {
    const proposed = new Date(eventCreatedAt.getTime() + 7 * 24 * 60 * 60 * 1000);
    return existingGraceUntil && existingGraceUntil < proposed ? existingGraceUntil : proposed;
  }
  if (status !== "active") return eventCreatedAt;
  return periodEndSeconds && Number.isFinite(periodEndSeconds) && periodEndSeconds * 1000 > eventCreatedAt.getTime()
    ? new Date(periodEndSeconds * 1000)
    : null;
}

export function stripeInvoiceOrderingDecision(
  subscriptionEventCreatedAt: number | null,
  subscriptionStatus: string,
  invoiceEventCreatedAt: number,
  expectedStatuses: readonly string[],
): "apply" | "ignore" | "retry" | "reconcile" {
  if (expectedStatuses.includes(subscriptionStatus)) return "apply";
  if (subscriptionEventCreatedAt !== null && subscriptionEventCreatedAt > invoiceEventCreatedAt) return "ignore";
  if (subscriptionEventCreatedAt === invoiceEventCreatedAt) return "reconcile";
  return "retry";
}
