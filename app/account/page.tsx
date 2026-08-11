import type { Metadata } from "next";
import { Link } from "@/components/Link";
import { and, desc, eq, ne } from "drizzle-orm";
import { headers } from "next/headers";
import { AppShell } from "@/components/AppShell";
import { householdBillingAccounts, users, voices } from "@/db/schema";
import { requirePageUser } from "@/lib/auth";
import { AccountDeleteButton, VoiceDeleteButton } from "./AccountActions";
import { isEntitledSubscriptionStatus } from "@/lib/stripe-events";
import { featureFlagsFromEnv, nearSleepLibraryPrivacyEnabled, nearSleepProductionEnabled } from "@/lib/nearyou-foundation";
import { ProductionPrivacyControls } from "./ProductionPrivacyControls";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Voice & account", robots: { index: false, follow: false } };

export default async function AccountPage() {
  const user = await requirePageUser("/account");
  const [{ getDb }, { ensureUser }] = await Promise.all([import("@/db"), import("@/lib/data")]);
  await ensureUser(user);
  const db = getDb();
  if (nearSleepProductionEnabled(featureFlagsFromEnv(process.env))) {
    const [{ requireHouseholdContext }, { loadEffectiveHouseholdEntitlement }] = await Promise.all([
      import("@/lib/api-v1-context"),
      import("@/lib/household-entitlements"),
    ]);
    const requestHeaders = await headers();
    const context = await requireHouseholdContext(new Request("https://nearyou.invalid/account", { headers: requestHeaders }), "household:read");
    const [billing, activeVoice, entitlement] = await Promise.all([
      db.select().from(householdBillingAccounts).where(eq(householdBillingAccounts.householdId, context.householdId)).get(),
      db.select().from(voices).where(and(eq(voices.householdId, context.householdId), eq(voices.userId, user.userId), ne(voices.status, "deleted"))).orderBy(desc(voices.createdAt)).get(),
      loadEffectiveHouseholdEntitlement(context.householdId).catch(() => null),
    ]);
    const planName = entitlement?.planId === "nearyou_family" ? "NearYou Family"
      : entitlement?.planId === "nearyou_plus" ? "NearYou Plus"
        : entitlement?.planId === "nearsleep_plus_legacy" ? "Grandfathered NearSleep Plus"
          : entitlement?.planId === "nearsleep_free" ? "NearSleep Free" : "No current plan";
    const canManageBilling = context.role === "owner" && Boolean(billing?.customerId);
    const remaining = Math.max(0, entitlement?.remainingMilliunits || 0) / 1_000;
    const allowanceLabel = entitlement?.planId === "nearsleep_plus_legacy"
      ? `${remaining.toLocaleString()} session ${remaining === 1 ? "credit" : "credits"} remaining`
      : entitlement?.planId === "nearsleep_free"
        ? entitlement.remainingMilliunits >= 1_000 ? "one five-minute creation remaining" : "five-minute creation used"
        : `${remaining.toLocaleString()} narration ${remaining === 1 ? "minute" : "minutes"} remaining`;
    return <AppShell active="account">
      <span className="eyebrow">Selected household controls</span><h1 className="app-title display">Voice & account</h1><p className="muted">Billing, consent, and generation limits below apply to the household currently selected in NearYou.</p>
      <section className="panel" style={{ marginTop: 30 }}><h2>Your voice</h2>{activeVoice ? <><p className="panel-intro">“{activeVoice.name}” · {activeVoice.status} · Added {activeVoice.createdAt.toLocaleDateString()}</p><div className="consent-box"><span aria-hidden="true">✓</span><span>Only you can re-verify or revoke this adult-owned voice. Other authorized household adults may select a currently verified voice for narration.</span></div><VoiceDeleteButton /></> : <><p className="panel-intro">You do not have an active voice slot in this household.</p><Link className="btn btn-primary" href="/studio">Set up your voice</Link></>}</section>
      <section className="panel" style={{ marginTop: 20 }}><h2>Household subscription</h2><p className="panel-intro">{planName} · {billing?.status || entitlement?.status || "free"} · {allowanceLabel}</p>{canManageBilling ? <form action="/api/billing/portal" method="post"><button className="btn btn-secondary" type="submit">Manage billing with Stripe</button></form> : context.role === "owner" ? <Link className="btn btn-secondary" href="/pricing">View household plans</Link> : <p className="muted">Only the household owner can manage billing.</p>}</section>
      {nearSleepLibraryPrivacyEnabled(featureFlagsFromEnv(process.env)) ? <ProductionPrivacyControls role={context.role} /> : <section className="panel" style={{ marginTop: 20 }}><h2>Delete account</h2><p className="panel-intro">Account deletion is temporarily unavailable during the protected media-cleanup migration. Billing management remains available above.</p><button className="btn btn-secondary" type="button" disabled>Deletion temporarily unavailable</button></section>}
    </AppShell>;
  }
  const [account, activeVoice] = await Promise.all([
    db.select().from(users).where(eq(users.id, user.userId)).get(),
    db.select().from(voices).where(and(eq(voices.userId, user.userId), ne(voices.status, "deleted"))).orderBy(desc(voices.createdAt)).get(),
  ]);
  const paid = isEntitledSubscriptionStatus(account?.subscriptionStatus || "");
  const canManageBilling = Boolean(account?.stripeCustomerId);

  return <AppShell active="account">
    <span className="eyebrow">Privacy controls</span><h1 className="app-title display">Voice & account</h1><p className="muted">Your voice may be sensitive data. The controls should be as clear as the promise.</p>
    <section className="panel" style={{ marginTop: 30 }}><h2>Your voice</h2>{activeVoice ? <><p className="panel-intro">“{activeVoice.name}” · {activeVoice.status} · Added {activeVoice.createdAt.toLocaleDateString()}</p><div className="consent-box"><span aria-hidden="true">✓</span><span>Your consent was recorded when this voice was created. You may revoke it and permanently delete the associated clone at any time.</span></div><VoiceDeleteButton /></> : <><p className="panel-intro">No active voice clone is attached to this account.</p><Link className="btn btn-primary" href="/studio">Create your voice</Link></>}</section>
    <section className="panel" style={{ marginTop: 20 }}><h2>Subscription</h2><p className="panel-intro">{paid ? `Nearnight Plus · ${account?.subscriptionStatus}` : account?.subscriptionStatus === "past_due" ? "Plus · payment needs attention" : "Free plan"} · {account?.creditsRemaining ?? 0} generation {(account?.creditsRemaining ?? 0) === 1 ? "credit" : "credits"} remaining</p>{canManageBilling ? <form action="/api/billing/portal" method="post"><button className="btn btn-secondary" type="submit">Manage billing with Stripe</button></form> : <Link className="btn btn-secondary" href="/pricing">View Plus plan</Link>}</section>
    <section className="panel" style={{ marginTop: 20 }}><h2>Delete account</h2><p className="panel-intro">Permanently removes your profile, child nicknames, scripts, audio library, and voice clones, and cancels the active subscription.</p><AccountDeleteButton /></section>
  </AppShell>;
}
