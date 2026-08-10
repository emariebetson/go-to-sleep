import type { Metadata } from "next";
import { count, eq, ne } from "drizzle-orm";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { sleepSessions, users, voices } from "@/db/schema";
import { isAdmin, requirePageUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Admin", robots: { index: false, follow: false } };

export default async function AdminPage() {
  const user = await requirePageUser("/admin");
  if (process.env.NODE_ENV === "production" && !isAdmin(user)) notFound();
  const { getDb } = await import("@/db");
  const db = getDb();
  const [families, activeFamilies, sessions, failedSessions, activeVoices] = await Promise.all([
    db.select({ value: count() }).from(users).get(),
    db.select({ value: count() }).from(users).where(eq(users.subscriptionStatus, "active")).get(),
    db.select({ value: count() }).from(sleepSessions).get(),
    db.select({ value: count() }).from(sleepSessions).where(eq(sleepSessions.status, "failed")).get(),
    db.select({ value: count() }).from(voices).where(ne(voices.status, "deleted")).get(),
  ]);
  const totalSessions = sessions?.value ?? 0;
  const failures = failedSessions?.value ?? 0;
  const successRate = totalSessions ? `${(((totalSessions - failures) / totalSessions) * 100).toFixed(1)}%` : "—";

  return <AppShell active="admin">
    <span className="eyebrow">Operator overview</span><h1 className="app-title display">A healthy product, at a glance</h1><p className="muted">Access is restricted server-side to emails in the admin allowlist. Metrics below come from live product records.</p>
    <div className="metric-grid"><div className="metric"><strong>{families?.value ?? 0}</strong><span>Registered families</span></div><div className="metric"><strong>{activeFamilies?.value ?? 0}</strong><span>Active subscriptions</span></div><div className="metric"><strong>{totalSessions}</strong><span>Sessions generated</span></div><div className="metric"><strong>{successRate}</strong><span>Generation success</span></div></div>
    <section className="panel"><h2>Operations queue</h2><div className="session-card"><span className="session-art">!</span><div><h3>{failures} failed generations</h3><p>Review provider logs and refund reconciliation before expanding the beta.</p></div><span className="status-pill">{failures ? "Review" : "Clear"}</span></div><div className="session-card"><span className="session-art">◐</span><div><h3>{activeVoices?.value ?? 0} active voice profiles</h3><p>Raw samples are not retained; provider deletion must be reconciled during the pilot.</p></div><span className="status-pill">Monitor</span></div><div className="session-card"><span className="session-art">$</span><div><h3>Revenue reporting</h3><p>Use Stripe as the source of truth until verified revenue events are stored locally.</p></div><span className="status-pill">Stripe</span></div></section>
  </AppShell>;
}
