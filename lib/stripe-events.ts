export type StripeObject = Record<string, unknown>;

export type CheckoutBinding = {
  userId: string;
  customerId: string;
  subscriptionId: string;
};

export type SubscriptionUpdate = CheckoutBinding & {
  priceId: string;
  status: string;
};

export type PaidInvoice = {
  customerId: string;
  subscriptionId: string;
  invoiceId: string;
  periodStart: number;
};

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

export function checkoutBinding(object: StripeObject, expectedPriceId: string): CheckoutBinding | null {
  if (object.mode !== "subscription" || !["paid", "no_payment_required"].includes(String(object.payment_status || ""))) return null;
  if (metadataValue(object, "price_id") !== expectedPriceId) return null;
  const userId = String(object.client_reference_id || metadataValue(object, "user_id"));
  const customerId = stripeId(object.customer);
  const subscriptionId = stripeId(object.subscription);
  return userId && customerId && subscriptionId ? { userId, customerId, subscriptionId } : null;
}

export function subscriptionUpdate(object: StripeObject, expectedPriceId: string): SubscriptionUpdate | null {
  const userId = metadataValue(object, "user_id");
  const customerId = stripeId(object.customer);
  const subscriptionId = stripeId(object.id);
  const status = String(object.status || "");
  const priceIds = listData(object.items).map((item) => stripeId(objectValue(item.price) || item.price)).filter(Boolean);
  if (!userId || !customerId || !subscriptionId || !status || !priceIds.includes(expectedPriceId)) return null;
  return { userId, customerId, subscriptionId, status, priceId: expectedPriceId };
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

export function subscriptionInvoice(object: StripeObject, expectedPriceId: string): PaidInvoice | null {
  const invoiceId = stripeId(object.id);
  const customerId = stripeId(object.customer);
  const subscriptionId = invoiceSubscriptionId(object);
  const periodStart = invoicePeriodStart(object);
  if (!invoiceId || !customerId || !subscriptionId || !periodStart || !invoicePriceIds(object).includes(expectedPriceId)) return null;
  return { invoiceId, customerId, subscriptionId, periodStart };
}

export function paidInvoice(object: StripeObject, expectedPriceId: string): PaidInvoice | null {
  if (object.status !== "paid" && object.paid !== true) return null;
  return subscriptionInvoice(object, expectedPriceId);
}

export function isEntitledSubscriptionStatus(status: string) {
  return status === "active" || status === "trialing";
}

export function isExistingSubscriptionStatus(status: string) {
  return !["", "free", "canceled", "incomplete_expired"].includes(status);
}
