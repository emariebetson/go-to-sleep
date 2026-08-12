export type StripeObject = Record<string, unknown>;

export type CheckoutBinding = {
  sessionId: string;
  operationId: string;
  userId: string;
  householdId?: string;
  customerId: string;
  subscriptionId: string;
  priceId: string;
};

export type PaymentCheckoutBinding = Omit<CheckoutBinding, "subscriptionId"> & { paymentIntentId: string };

export type SubscriptionUpdate = {
  userId: string;
  householdId?: string;
  customerId: string;
  subscriptionId: string;
  operationId?: string;
  priceId: string;
  status: string;
  periodEnd?: number;
};

export type PaidInvoice = {
  customerId: string;
  subscriptionId: string;
  invoiceId: string;
  priceId: string;
  periodStart: number;
  periodEnd?: number;
};

type ExpectedPrices = string | readonly string[] | ReadonlySet<string>;

function expectedPriceSet(expected: ExpectedPrices) {
  return typeof expected === "string" ? new Set([expected]) : expected instanceof Set ? expected : new Set(expected);
}

function objectValue(value: unknown): StripeObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as StripeObject : null;
}

export function stripeId(value: unknown) {
  if (typeof value === "string") return value;
  return String(objectValue(value)?.id || "");
}

function metadataValue(object: StripeObject, key: string) {
  const metadata = objectValue(object.metadata);
  return typeof metadata?.[key] === "string" ? String(metadata[key]) : "";
}

function listData(value: unknown) {
  const object = objectValue(value);
  return Array.isArray(object?.data) ? object.data.map(objectValue).filter((item): item is StripeObject => Boolean(item)) : [];
}

export function checkoutBinding(object: StripeObject, expectedPriceIds: ExpectedPrices): CheckoutBinding | null {
  if (object.mode !== "subscription" || !["paid", "no_payment_required"].includes(String(object.payment_status || ""))) return null;
  const sessionId = stripeId(object.id);
  const operationId = metadataValue(object, "checkout_operation_id");
  const priceId = metadataValue(object, "price_id");
  if (!expectedPriceSet(expectedPriceIds).has(priceId)) return null;
  const userId = String(object.client_reference_id || metadataValue(object, "user_id"));
  const householdId = metadataValue(object, "household_id") || undefined;
  const customerId = stripeId(object.customer);
  const subscriptionId = stripeId(object.subscription);
  return sessionId && operationId && userId && customerId && subscriptionId
    ? { sessionId, operationId, userId, ...(householdId ? { householdId } : {}), customerId, subscriptionId, priceId }
    : null;
}

export function paymentCheckoutBinding(object: StripeObject, expectedPriceIds: ExpectedPrices): PaymentCheckoutBinding | null {
  if (object.mode !== "payment" || object.payment_status !== "paid") return null;
  const sessionId = stripeId(object.id), operationId = metadataValue(object, "checkout_operation_id"), priceId = metadataValue(object, "price_id");
  if (!expectedPriceSet(expectedPriceIds).has(priceId)) return null;
  const userId = String(object.client_reference_id || metadataValue(object, "user_id"));
  const householdId = metadataValue(object, "household_id") || undefined;
  const customerId = stripeId(object.customer), paymentIntentId = stripeId(object.payment_intent);
  return sessionId && operationId && userId && customerId && paymentIntentId
    ? { sessionId, operationId, userId, ...(householdId ? { householdId } : {}), customerId, paymentIntentId, priceId }
    : null;
}

export function expiredCheckoutBinding(object: StripeObject) {
  const sessionId = stripeId(object.id);
  const operationId = metadataValue(object, "checkout_operation_id");
  const householdId = metadataValue(object, "household_id");
  return sessionId && operationId && householdId ? { sessionId, operationId, householdId } : null;
}

export function subscriptionUpdate(object: StripeObject, expectedPriceIds: ExpectedPrices): SubscriptionUpdate | null {
  const userId = metadataValue(object, "user_id");
  const customerId = stripeId(object.customer);
  const subscriptionId = stripeId(object.id);
  const status = String(object.status || "");
  const priceIds = listData(object.items).map((item) => stripeId(objectValue(item.price) || item.price)).filter(Boolean);
  const allowed = expectedPriceSet(expectedPriceIds);
  const matched = [...new Set(priceIds.filter((priceId) => allowed.has(priceId)))];
  if (!userId || !customerId || !subscriptionId || !status || matched.length !== 1) return null;
  const householdId = metadataValue(object, "household_id") || undefined;
  const operationId = metadataValue(object, "checkout_operation_id") || undefined;
  const periodEnd = Math.max(Number(object.current_period_end || 0), ...listData(object.items).map((item) => Number(item.current_period_end || 0)).filter(Number.isFinite), 0);
  return { userId, ...(householdId ? { householdId } : {}), ...(operationId ? { operationId } : {}), customerId, subscriptionId, status, priceId: matched[0], ...(periodEnd ? { periodEnd } : {}) };
}

function invoiceSubscriptionId(object: StripeObject) {
  const direct = stripeId(object.subscription);
  if (direct) return direct;
  const parent = objectValue(object.parent);
  const subscriptionDetails = objectValue(parent?.subscription_details);
  return stripeId(subscriptionDetails?.subscription);
}

function invoicePriceIds(object: StripeObject) {
  return listData(object.lines).flatMap((line) => {
    const legacy = stripeId(line.price);
    const pricing = objectValue(line.pricing);
    const priceDetails = objectValue(pricing?.price_details);
    const current = stripeId(priceDetails?.price);
    return [legacy, current].filter(Boolean);
  });
}

function invoicePeriodStart(object: StripeObject) {
  const direct = Number(object.period_start || 0);
  const lineStarts = listData(object.lines).map((line) => Number(objectValue(line.period)?.start || 0)).filter(Number.isFinite);
  return Math.max(direct, ...lineStarts, 0);
}

function invoicePeriodEnd(object: StripeObject) {
  const direct = Number(object.period_end || 0);
  const lineEnds = listData(object.lines).map((line) => Number(objectValue(line.period)?.end || 0)).filter(Number.isFinite);
  return Math.max(direct, ...lineEnds, 0);
}

export function subscriptionInvoice(object: StripeObject, expectedPriceIds: ExpectedPrices): PaidInvoice | null {
  const invoiceId = stripeId(object.id);
  const customerId = stripeId(object.customer);
  const subscriptionId = invoiceSubscriptionId(object);
  const periodStart = invoicePeriodStart(object);
  const periodEnd = invoicePeriodEnd(object);
  const allowed = expectedPriceSet(expectedPriceIds);
  const matched = [...new Set(invoicePriceIds(object).filter((priceId) => allowed.has(priceId)))];
  if (!invoiceId || !customerId || !subscriptionId || !periodStart || matched.length !== 1) return null;
  return { invoiceId, customerId, subscriptionId, priceId: matched[0], periodStart, ...(periodEnd ? { periodEnd } : {}) };
}

export function paidInvoice(object: StripeObject, expectedPriceIds: ExpectedPrices): PaidInvoice | null {
  if (object.status !== "paid" && object.paid !== true) return null;
  return subscriptionInvoice(object, expectedPriceIds);
}

export function isEntitledSubscriptionStatus(status: string) {
  return status === "active" || status === "trialing";
}

export function isExistingSubscriptionStatus(status: string) {
  return !["", "free", "canceled", "incomplete_expired"].includes(status);
}
