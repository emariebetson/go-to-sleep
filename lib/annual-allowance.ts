import { env } from "cloudflare:workers";
import { annualAllowanceBoundary } from "./annual-allowance-core";

export async function advanceAnnualAllowanceRefill(nowSeconds = Math.floor(Date.now() / 1000)) {
  const annualPriceIds = [
    process.env.STRIPE_PRICE_NEARYOU_PLUS_ANNUAL,
    process.env.STRIPE_PRICE_NEARYOU_FAMILY_ANNUAL,
    process.env.STRIPE_PRICE_NEARLEGACY_ANNUAL,
  ].map((value) => value?.trim()).filter((value): value is string => Boolean(value));
  if (!annualPriceIds.length) return { status: "idle" as const };
  const placeholders = annualPriceIds.map(() => "?").join(",");
  const selected = await env.DB.prepare(`SELECT e.id,e.household_id,e.allowance_milliunits,e.remaining_milliunits,e.valid_until,r.anchor_seconds,r.refilled_through_seconds,h.owner_user_id FROM annual_allowance_refills r JOIN entitlements e ON e.id=r.entitlement_id AND e.household_id=r.household_id JOIN household_billing_accounts b ON b.household_id=e.household_id JOIN households h ON h.id=e.household_id WHERE e.source='stripe' AND e.status='active' AND e.valid_until>? AND b.price_id IN (${placeholders}) ORDER BY r.refilled_through_seconds,e.id LIMIT 20`).bind(nowSeconds * 1000, ...annualPriceIds).all();
  for (const raw of selected.results || []) {
    const row = raw as Record<string, unknown>;
    const prior = Number(row.refilled_through_seconds);
    const boundary = annualAllowanceBoundary(prior, Number(row.anchor_seconds));
    if (boundary > nowSeconds || boundary * 1000 >= Number(row.valid_until)) continue;
    const allowance = Number(row.allowance_milliunits);
    const ledgerId = `annual-refill:${row.id}:${boundary}`;
    try { await env.DB.batch([
      // The unique ledger claim is deliberately first and not OR IGNORE. D1
      // batches are atomic, so a competing worker's duplicate claim aborts the
      // entire batch before it can credit the entitlement a second time.
      env.DB.prepare("INSERT INTO usage_ledger (id,household_id,user_id,entitlement_id,product,operation,quantity,weight_milliunits,direction,idempotency_key,metadata,created_at) VALUES (?,?,?,?,?,'annual_monthly_refill',1,?,'credit',?,?,?)").bind(ledgerId, row.household_id, row.owner_user_id, row.id, "nearyou", allowance, ledgerId, JSON.stringify({ billingBoundary: boundary }), nowSeconds * 1000),
      env.DB.prepare("UPDATE entitlements SET remaining_milliunits=MIN(allowance_milliunits*2,remaining_milliunits+allowance_milliunits),updated_at=? WHERE id=? AND household_id=? AND status='active' AND EXISTS (SELECT 1 FROM annual_allowance_refills WHERE entitlement_id=? AND household_id=? AND refilled_through_seconds=?)").bind(nowSeconds * 1000, row.id, row.household_id,row.id,row.household_id,prior),
      env.DB.prepare("UPDATE annual_allowance_refills SET refilled_through_seconds=?,updated_at=? WHERE entitlement_id=? AND household_id=? AND refilled_through_seconds=?").bind(boundary,nowSeconds*1000,row.id,row.household_id,prior),
    ]); } catch (error) {
      if (error instanceof Error && /UNIQUE|constraint/i.test(error.message)) continue;
      throw error;
    }
    return { status: "credited" as const, entitlementId: String(row.id), boundary };
  }
  return { status: "idle" as const };
}
