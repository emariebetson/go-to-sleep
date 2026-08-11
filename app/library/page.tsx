import type { Metadata } from "next";
import { Link } from "@/components/Link";
import { and, desc, eq, isNull } from "drizzle-orm";
import { headers } from "next/headers";
import { AppShell } from "@/components/AppShell";
import { SleepPlayer } from "@/components/SleepPlayer";
import { mediaAssets, sleepSessions, users } from "@/db/schema";
import { requirePageUser } from "@/lib/auth";
import { formatFrequencyLabel, parseStoredFrequencyLayers } from "@/lib/frequency-layers";
import { featureFlagsFromEnv, nearSleepLibraryPrivacyEnabled } from "@/lib/nearyou-foundation";
import { encodeLibraryCursor } from "@/lib/nearsleep-library";
import { ProductionLibraryControls } from "./LibraryControls";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "My nights", robots: { index: false, follow: false } };

const themeIcons: Record<string, string> = { "moonlit-meadow": "☾", "sleepy-sea": "≈", "cloud-garden": "☁" };
const soundNames: Record<string, string> = { "soft-rain": "soft rain", "brown-noise": "brown noise", none: "voice only" };

export default async function LibraryPage() {
  const user = await requirePageUser("/library");
  const [{ getDb }, { ensureUser }] = await Promise.all([import("@/db"), import("@/lib/data")]);
  await ensureUser(user);
  const db = getDb();
  if (nearSleepLibraryPrivacyEnabled(featureFlagsFromEnv(process.env))) {
    const { requireHouseholdContext } = await import("@/lib/api-v1-context");
    const context = await requireHouseholdContext(new Request("https://nearyou.invalid/library", { headers: await headers() }), "playlist:read");
    const sessions = await db.select({
      id: sleepSessions.id,
      mediaAssetId: mediaAssets.id,
      title: sleepSessions.title,
      narrationKind: sleepSessions.narrationKind,
      backgroundSound: sleepSessions.backgroundSound,
      frequencyLayers: sleepSessions.frequencyLayers,
      durationMinutes: sleepSessions.durationMinutes,
      favorite: sleepSessions.favorite,
      repeatMinutes: sleepSessions.repeatMinutes,
      childProfileId: mediaAssets.childProfileId,
      voiceId: sleepSessions.voiceId,
      createdAt: sleepSessions.createdAt,
    }).from(sleepSessions).innerJoin(mediaAssets, and(
      eq(sleepSessions.mediaAssetId, mediaAssets.id), eq(mediaAssets.householdId, context.householdId), eq(mediaAssets.status, "ready"), eq(mediaAssets.private, true), isNull(mediaAssets.deletedAt),
    )).where(and(eq(sleepSessions.householdId, context.householdId), eq(sleepSessions.status, "ready"), eq(sleepSessions.deletionStatus, "active"))).orderBy(desc(sleepSessions.createdAt), desc(sleepSessions.id)).limit(100).all();
    return <AppShell active="library">
      <span className="eyebrow">Selected household private library</span><h1 className="app-title display">My nights</h1><p className="muted">Favorites, repeat timers, playlists, downloads, and the bedtime queue stay private to this household.</p>
      <ProductionLibraryControls initialSessions={sessions.map((session) => ({ ...session, createdAt: session.createdAt.getTime() }))} initialNextCursor={sessions.length === 100 ? encodeLibraryCursor({ createdAt: sessions.at(-1)!.createdAt.getTime(), id: sessions.at(-1)!.id }) : null} canManage={context.role === "owner" || context.role === "adult_manager"} />
      <div className="panel" style={{ marginTop: 20 }}><Link className="btn btn-primary" href="/studio">Create a new bedtime</Link></div>
    </AppShell>;
  }
  const [account, sessions] = await Promise.all([
    db.select({ credits: users.creditsRemaining }).from(users).where(eq(users.id, user.userId)).get(),
    db.select().from(sleepSessions).where(eq(sleepSessions.userId, user.userId)).orderBy(desc(sleepSessions.createdAt)).limit(50).all(),
  ]);

  return <AppShell active="library">
    <span className="eyebrow">Your private audio library</span><h1 className="app-title display">My nights</h1><p className="muted">Replays never use another generation credit.</p>
    <div className="panel" style={{ marginTop: 30, padding: sessions.length ? 0 : 32 }}>
      {sessions.length ? sessions.map((session) => {
        const frequencies = parseStoredFrequencyLayers(session.frequencyLayers);
        const frequencyLabel = formatFrequencyLabel(frequencies);
        return <article className="session-card" style={{ gridTemplateColumns: "58px 1fr", alignItems: "start" }} key={session.id}>
        <span className="session-art" aria-hidden="true">{themeIcons[session.theme] || "✦"}</span>
        <div><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}><div><h3>{session.title}</h3><p>{session.narrationKind === "demo_narrator" ? "Demo narrator (not your voice)" : "Parent voice"} · {soundNames[session.backgroundSound] || "voice only"}{frequencyLabel ? ` · ${frequencyLabel}` : ""} · {session.durationMinutes} min</p></div><span className="status-pill">{session.status}</span></div>
          {session.status === "ready" && session.audioKey && <div style={{ marginTop: 12 }}><SleepPlayer src={`/api/audio/${session.id}`} sound={session.backgroundSound} frequencies={frequencies} /></div>}
        </div>
      </article>;
      }) : <div style={{ textAlign: "center", padding: "18px 0" }}><span className="session-art" style={{ margin: "0 auto 16px" }} aria-hidden="true">☾</span><h2 style={{ marginBottom: 6 }}>Your first bedtime will appear here</h2><p className="muted">Create and save a session, then replay it without using another credit.</p><Link className="btn btn-primary" href="/studio" style={{ marginTop: 12 }}>Create your first bedtime</Link></div>}
    </div>
    {sessions.length > 0 && <div className="panel" style={{ marginTop: 20, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 20 }}><div><strong>Ready for a new bedtime?</strong><p className="muted" style={{ margin: 0 }}>{account?.credits ?? 0} generation {(account?.credits ?? 0) === 1 ? "credit" : "credits"} remaining.</p></div><Link className="btn btn-primary" href="/studio">Create one</Link></div>}
  </AppShell>;
}
