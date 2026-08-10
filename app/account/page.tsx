import type { Metadata } from "next";
import Link from "next/link";
import { and, desc, eq, ne } from "drizzle-orm";
import { AppShell } from "@/components/AppShell";
import { users, voices } from "@/db/schema";
import { requirePageUser } from "@/lib/auth";
import { AccountDeleteButton, VoiceDeleteButton } from "./AccountActions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Voice & account", robots: { index: false, follow: false } };

export default async function AccountPage() {
  const user = await requirePageUser("/account");
  const [{ getDb }, { ensureUser }] = await Promise.all([import("@/db"), import("@/lib/data")]);
  await ensureUser(user);
  const db = getDb();
  const [account, activeVoice] = await Promise.all([
    db.select().from(users).where(eq(users.id, user.userId)).get(),
    db.select().from(voices).where(and(eq(voices.userId, user.userId), ne(voices.status, "deleted"))).orderBy(desc(voices.createdAt)).get(),
  ]);
  const paid = Boolean(account?.stripeCustomerId);

  return <AppShell active="account">
    <span className="eyebrow">Privacy controls</span><h1 className="app-title display">Voice & account</h1><p className="muted">Your voice may be sensitive data. The controls should be as clear as the promise.</p>
    <section className="panel" style={{ marginTop: 30 }}><h2>Your voice</h2>{activeVoice ? <><p className="panel-intro">“{activeVoice.name}” · {activeVoice.status} · Added {activeVoice.createdAt.toLocaleDateString()}</p><div className="consent-box"><span aria-hidden="true">✓</span><span>Your consent was recorded when this voice was created. You may revoke it and permanently delete the associated clone at any time.</span></div><VoiceDeleteButton /></> : <><p className="panel-intro">No active voice clone is attached to this account.</p><Link className="btn btn-primary" href="/studio">Create your voice</Link></>}</section>
    <section className="panel" style={{ marginTop: 20 }}><h2>Subscription</h2><p className="panel-intro">{paid ? `Nearnight Plus · ${account?.subscriptionStatus || "active"}` : "Free plan"} · {account?.creditsRemaining ?? 0} generation {(account?.creditsRemaining ?? 0) === 1 ? "credit" : "credits"} remaining</p>{paid ? <form action="/api/billing/portal" method="post"><button className="btn btn-secondary" type="submit">Manage billing with Stripe</button></form> : <Link className="btn btn-secondary" href="/pricing">View Plus plan</Link>}</section>
    <section className="panel" style={{ marginTop: 20 }}><h2>Delete account</h2><p className="panel-intro">Permanently removes your profile, child nicknames, scripts, audio library, and voice clones, and cancels the active subscription.</p><AccountDeleteButton /></section>
  </AppShell>;
}
