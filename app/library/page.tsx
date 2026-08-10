import type { Metadata } from "next";
import { Link } from "@/components/Link";
import { desc, eq } from "drizzle-orm";
import { AppShell } from "@/components/AppShell";
import { SleepPlayer } from "@/components/SleepPlayer";
import { sleepSessions, users } from "@/db/schema";
import { requirePageUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "My nights", robots: { index: false, follow: false } };

const themeIcons: Record<string, string> = { "moonlit-meadow": "☾", "sleepy-sea": "≈", "cloud-garden": "☁" };
const soundNames: Record<string, string> = { "soft-rain": "soft rain", "brown-noise": "brown noise", none: "voice only" };

export default async function LibraryPage() {
  const user = await requirePageUser("/library");
  const [{ getDb }, { ensureUser }] = await Promise.all([import("@/db"), import("@/lib/data")]);
  await ensureUser(user);
  const db = getDb();
  const [account, sessions] = await Promise.all([
    db.select({ credits: users.creditsRemaining }).from(users).where(eq(users.id, user.userId)).get(),
    db.select().from(sleepSessions).where(eq(sleepSessions.userId, user.userId)).orderBy(desc(sleepSessions.createdAt)).limit(50).all(),
  ]);

  return <AppShell active="library">
    <span className="eyebrow">Your private audio library</span><h1 className="app-title display">My nights</h1><p className="muted">Replays never use another generation credit.</p>
    <div className="panel" style={{ marginTop: 30, padding: sessions.length ? 0 : 32 }}>
      {sessions.length ? sessions.map((session) => <article className="session-card" style={{ gridTemplateColumns: "58px 1fr", alignItems: "start" }} key={session.id}>
        <span className="session-art" aria-hidden="true">{themeIcons[session.theme] || "✦"}</span>
        <div><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}><div><h3>{session.title}</h3><p>{soundNames[session.backgroundSound] || "voice only"} · {session.durationMinutes} min</p></div><span className="status-pill">{session.status}</span></div>
          {session.status === "ready" && session.audioKey && <div style={{ marginTop: 12 }}><SleepPlayer src={`/api/audio/${session.id}`} sound={session.backgroundSound} /></div>}
        </div>
      </article>) : <div style={{ textAlign: "center", padding: "18px 0" }}><span className="session-art" style={{ margin: "0 auto 16px" }} aria-hidden="true">☾</span><h2 style={{ marginBottom: 6 }}>Your first bedtime will appear here</h2><p className="muted">Create and save a session, then replay it without using another credit.</p><Link className="btn btn-primary" href="/studio" style={{ marginTop: 12 }}>Create your first bedtime</Link></div>}
    </div>
    {sessions.length > 0 && <div className="panel" style={{ marginTop: 20, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 20 }}><div><strong>Ready for a new bedtime?</strong><p className="muted" style={{ margin: 0 }}>{account?.credits ?? 0} generation {(account?.credits ?? 0) === 1 ? "credit" : "credits"} remaining.</p></div><Link className="btn btn-primary" href="/studio">Create one</Link></div>}
  </AppShell>;
}
