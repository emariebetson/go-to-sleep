"use client";

import { useEffect, useRef, useState } from "react";

type Child = { id: string; nickname: string; pronunciation: string; ageMonths: number };
type Voice = { id: string; name: string; status: string; consentStatus: string | null; consentVersion?: string | null };
const modes = ["bedtime", "adventure", "learning", "calm-down", "potty-training", "new-sibling", "first-day-of-school"];
const soundscapes = ["none", "rainforest", "construction", "dinosaurs", "ocean", "space"];
type Story = { id: string; mode: string; durationMinutes: number; status: string; errorCode?: string | null; createdAt: string | number };

export function StoryStudio() {
  const [children, setChildren] = useState<Child[]>([]);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [childProfileId, setChild] = useState("");
  const [voiceId, setVoice] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [stories, setStories] = useState<Story[]>([]);
  const requestId = useRef("");
  useEffect(() => {
    Promise.all([fetch("/api/v1/children"), fetch("/api/voices")]).then(async ([childrenResponse, voicesResponse]) => {
      if (!childrenResponse.ok || !voicesResponse.ok) throw new Error("Household profiles could not be loaded.");
      const childPayload = await childrenResponse.json() as { children?: Child[] };
      const voicePayload = await voicesResponse.json() as { voices?: Voice[] };
      const nextChildren = (childPayload.children || []).filter((child) => Number.isInteger(child.ageMonths) && child.ageMonths >= 0 && child.ageMonths <= 107);
      const nextVoices = (voicePayload.voices || []).filter((voice) => voice.status === "ready" && voice.consentStatus === "active_verified" && voice.consentVersion === "voice-v2-live-phrase");
      setChildren(nextChildren); setVoices(nextVoices); setChild(nextChildren[0]?.id || ""); setVoice(nextVoices[0]?.id || "");
    }).catch((error) => setMessage(error instanceof Error ? error.message : "Household profiles could not be loaded."));
  }, []);
  useEffect(() => {
    let active = true;
    const load = () => fetch("/api/v1/stories", { headers: { accept: "application/json" } }).then(async (response) => {
      if (!response.ok) return;
      const payload = await response.json() as { stories?: Story[] };
      if (active) setStories(payload.stories || []);
    }).catch(() => undefined);
    void load(); const timer = window.setInterval(load, 10_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage("");
    const data = new FormData(event.currentTarget);
    requestId.current ||= crypto.randomUUID();
    const sourceUrl = String(data.get("sourceUrl") || "").trim();
    const body = {
      requestId: requestId.current, childProfileId, voiceId, mode: data.get("mode"), durationMinutes: Number(data.get("durationMinutes")),
      setting: data.get("setting"), characters: data.get("characters"),
      lesson: data.get("lesson"), interests: data.get("interests"),
      sensitivities: String(data.get("sensitivities") || "").split(",").map((value) => value.trim()).filter(Boolean), soundscape: data.get("soundscape"),
      ...(sourceUrl ? { sourceUrl, sourceRightsAttested: data.get("sourceRightsAttested") === "on" } : {}),
    };
    let receivedResponse = false;
    try {
      const response = await fetch("/api/v1/stories", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": requestId.current }, body: JSON.stringify(body) });
      receivedResponse = true;
      const payload = await response.json() as { error?: string; story?: { id: string }; job?: { status: string } };
      if (!response.ok) throw new Error(payload.error || "Story could not be queued.");
      setMessage("Your story is safely queued. It will appear below when narration is ready."); requestId.current = "";
      const refreshed = await fetch("/api/v1/stories"); if (refreshed.ok) setStories(((await refreshed.json()) as { stories?: Story[] }).stories || []);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Story could not be queued."); }
    finally { if (receivedResponse) requestId.current = ""; setBusy(false); }
  }
  return <>
    <span className="eyebrow">NearStory parent beta</span><h1 className="app-title display">Make your child the hero.</h1>
    <p className="muted">You choose and submit every story direction. Child microphone interaction is not enabled.</p>
    <form className="panel form-grid" style={{ marginTop: 28 }} onSubmit={submit}>
      <label className="field"><span>Child profile</span><select required value={childProfileId} onChange={(event) => setChild(event.target.value)}>{children.map((child) => <option value={child.id} key={child.id}>{child.nickname}</option>)}</select></label>
      <label className="field"><span>Verified adult narrator</span><select required value={voiceId} onChange={(event) => setVoice(event.target.value)}>{voices.map((voice) => <option value={voice.id} key={voice.id}>{voice.name}</option>)}</select></label>
      <label className="field"><span>Mode</span><select name="mode">{modes.map((mode) => <option key={mode} value={mode}>{mode.replaceAll("-", " ")}</option>)}</select></label>
      <label className="field"><span>Length</span><select name="durationMinutes"><option value="5">5 minutes</option><option value="10">10 minutes</option><option value="15">15 minutes</option></select></label>
      <label className="field"><span>Setting</span><input name="setting" required maxLength={160} placeholder="Kansas City" /></label>
      <label className="field"><span>Characters, comma-separated</span><input name="characters" required maxLength={240} placeholder="excavator, dinosaurs" /></label>
      <label className="field full"><span>Gentle lesson</span><input name="lesson" required maxLength={240} placeholder="Sharing can make play more fun" /></label>
      <label className="field"><span>Interests</span><input name="interests" required maxLength={240} placeholder="bulldozers, fossils" /></label>
      <label className="field"><span>Content sensitivities</span><input name="sensitivities" maxLength={240} placeholder="No loud storms" /></label>
      <label className="field"><span>Soundscape</span><select name="soundscape">{soundscapes.map((sound) => <option key={sound} value={sound}>{sound}</option>)}</select></label>
      <label className="field"><span>Optional YouTube inspiration</span><input name="sourceUrl" type="url" placeholder="https://www.youtube.com/watch?v=…" /></label>
      <label className="field full"><input name="sourceRightsAttested" type="checkbox" /> I have permission to use the linked page only as high-level inspiration. NearYou stores its canonical YouTube URL and does not copy the source audio or captions.</label>
      <div className="full"><button className="btn btn-primary" disabled={busy || !childProfileId || !voiceId}>{busy ? "Queuing safely…" : "Create story"}</button></div>
      <p className="muted full" role="status" aria-live="polite">{message}</p>
    </form>
    <section style={{ marginTop: 32 }} aria-labelledby="story-library-heading"><h2 id="story-library-heading">Your private stories</h2>
      <div className="panel" style={{ marginTop: 14 }}>{stories.length ? stories.map((story) => <StoryCard key={story.id} story={story} onChanged={(next) => setStories((current) => current.map((item) => item.id === next.id ? next : item).filter((item) => item.status !== "deleted"))} />) : <p className="muted">Your first queued story will appear here.</p>}</div>
    </section>
  </>;
}

function StoryCard({ story, onChanged }: { story: Story; onChanged: (story: Story) => void }) {
  const [status, setStatus] = useState(""); const [deleting, setDeleting] = useState(false); const deleteRequestId = useRef("");
  const [transcript, setTranscript] = useState<Array<{ ordinal: number; narration: string }>>([]);
  useEffect(() => {
    if (story.status !== "completed") return;
    let active = true;
    void fetch(`/api/v1/stories/${encodeURIComponent(story.id)}`).then(async (response) => {
      if (!response.ok) return;
      const payload = await response.json() as { story?: { segments?: Array<{ ordinal: number; narration?: string | null }> } };
      if (active) setTranscript((payload.story?.segments || []).filter((segment): segment is { ordinal: number; narration: string } => typeof segment.narration === "string" && Boolean(segment.narration)));
    }).catch(() => undefined);
    return () => { active = false; };
  }, [story.id, story.status]);
  async function remove() {
    if (deleting || !window.confirm("Delete this private story and all of its audio? This cannot be undone.")) return;
    setDeleting(true); deleteRequestId.current ||= crypto.randomUUID();
    try { const response = await fetch(`/api/v1/stories/${encodeURIComponent(story.id)}`, { method: "DELETE", headers: { "idempotency-key": deleteRequestId.current } });
      const payload = await response.json() as { error?: string; status?: string };
      if (!response.ok) setStatus(payload.error || "Deletion will retry."); else onChanged({ ...story, status: payload.status || "delete_pending" });
    } catch { setStatus("Deletion status is unknown. Retry safely with the same request."); }
    finally { setDeleting(false); }
  }
  return <article className="session-card" style={{ display: "block" }}>
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}><div><strong>{story.mode.replaceAll("-", " ")} story</strong><p className="muted" style={{ margin: 0 }}>{story.durationMinutes} minutes · {story.status}</p></div><button className="btn btn-secondary btn-small" type="button" disabled={deleting} onClick={remove}>{deleting ? "Deleting…" : "Delete"}</button></div>
    {story.status === "completed" && <audio style={{ width: "100%", marginTop: 14 }} controls preload="metadata" src={`/api/v1/stories/${encodeURIComponent(story.id)}/audio`}><track default kind="captions" srcLang="en" label="English story narration" src={`/api/v1/stories/${encodeURIComponent(story.id)}/captions`} />Your browser does not support private audio playback.</audio>}
    {transcript.length > 0 && <details style={{ marginTop: 12 }}><summary>Read the story transcript</summary><ol>{transcript.map((segment) => <li key={segment.ordinal}><p>{segment.narration}</p></li>)}</ol></details>}
    {story.status === "failed" && <p role="alert">This story could not be completed. No unused narration allowance is kept reserved.</p>}
    <p className="muted" role="status" aria-live="polite">{status}</p>
  </article>;
}
