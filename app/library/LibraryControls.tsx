"use client";

import { useEffect, useRef, useState } from "react";
import { SleepPlayer } from "@/components/SleepPlayer";
import { formatFrequencyLabel, parseStoredFrequencyLayers } from "@/lib/frequency-layers";
import { settleStoredRequestId, stableStoredRequestId } from "@/lib/task2c-client-state";

type LibrarySession = {
  id: string; mediaAssetId: string; title: string; narrationKind: string; backgroundSound: string; frequencyLayers: string;
  durationMinutes: number; favorite: boolean; repeatMinutes: number | null; childProfileId: string | null; voiceId: string | null; createdAt: number;
};
type Playlist = { id: string; name: string };
type PlaylistItem = { id: string; sessionId: string; mediaAssetId: string; title: string; position: number };
type QueueItem = { id: string; sessionId: string; title: string; position: number; status: string };
type FilterOption = { id: string; label: string };

async function payloadError(response: Response) {
  try { return ((await response.json()) as { error?: string }).error || "The request could not be completed."; }
  catch { return "The request could not be completed."; }
}

export function ProductionLibraryControls({ initialSessions, initialNextCursor, canManage }: { initialSessions: LibrarySession[]; initialNextCursor: string | null; canManage: boolean }) {
  const [sessions, setSessions] = useState(initialSessions);
  const [nextCursor, setNextCursor] = useState(initialNextCursor);
  const [childFilter, setChildFilter] = useState("");
  const [voiceFilter, setVoiceFilter] = useState("");
  const [childOptions, setChildOptions] = useState<FilterOption[]>([]);
  const [voiceOptions, setVoiceOptions] = useState<FilterOption[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState("");
  const [playlistItems, setPlaylistItems] = useState<PlaylistItem[]>([]);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [playlistName, setPlaylistName] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const pendingRequestIds = useRef(new Map<string, string>());

  function stableRequestId(key: string) {
    try { return stableStoredRequestId(window.sessionStorage, `nearyou:task2c:${key}`); }
    catch {
      const existing = pendingRequestIds.current.get(key);
      if (existing) return existing;
      const created = crypto.randomUUID(); pendingRequestIds.current.set(key, created); return created;
    }
  }
  function settleRequestId(key: string, response: Response) {
    try { settleStoredRequestId(window.sessionStorage, `nearyou:task2c:${key}`, response.status); } catch { /* in-memory fallback below */ }
    if (response.status < 500 && response.status !== 408 && response.status !== 429) pendingRequestIds.current.delete(key);
  }

  async function loadPlaylists() {
    const response = await fetch("/api/v1/playlists", { cache: "no-store" });
    if (!response.ok) return;
    const records = (await response.json() as { playlists?: Playlist[] }).playlists || [];
    setPlaylists(records);
    setSelectedPlaylistId((current) => records.some(({ id }) => id === current) ? current : records[0]?.id || "");
  }
  async function loadPlaylistItems(id = selectedPlaylistId) {
    if (!id) return setPlaylistItems([]);
    const response = await fetch(`/api/v1/playlists/${encodeURIComponent(id)}/items`, { cache: "no-store" });
    if (response.ok) setPlaylistItems((await response.json() as { items: PlaylistItem[] }).items);
  }
  async function loadQueue() {
    const response = await fetch("/api/v1/bedtime-queue", { cache: "no-store" });
    if (response.ok) setQueue((await response.json() as { items: QueueItem[] }).items);
  }
  async function loadFilters() {
    const response = await fetch("/api/v1/library/filters", { cache: "no-store" });
    if (!response.ok) return;
    const payload = await response.json() as { children: FilterOption[]; voices: FilterOption[] };
    setChildOptions(payload.children); setVoiceOptions(payload.voices);
  }

  useEffect(() => { queueMicrotask(() => { void loadPlaylists(); void loadQueue(); void loadFilters(); }); }, []);
  // The selected ID is the trigger; the loader intentionally reads the latest component closure.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { queueMicrotask(() => { void loadPlaylistItems(); }); }, [selectedPlaylistId]);

  async function loadLibrary(reset: boolean) {
    setBusy("library-load"); setMessage("");
    try {
      const query = new URLSearchParams({ limit: "100" });
      if (childFilter) query.set("childProfileId", childFilter);
      if (voiceFilter) query.set("voiceId", voiceFilter);
      if (!reset && nextCursor) query.set("cursor", nextCursor);
      const response = await fetch(`/api/v1/library?${query}`, { cache: "no-store" });
      if (!response.ok) return setMessage(await payloadError(response));
      const payload = await response.json() as { sessions: LibrarySession[]; nextCursor: string | null };
      setSessions((current) => reset ? payload.sessions : [...current, ...payload.sessions]);
      setNextCursor(payload.nextCursor);
    } catch { setMessage("The private library could not be loaded. Try again."); }
    finally { setBusy(""); }
  }

  async function setLibraryState(session: LibrarySession, update: { favorite: boolean; repeatMinutes: number | null }) {
    setBusy(session.id); setMessage("");
    try {
      const response = await fetch(`/api/v1/library/${encodeURIComponent(session.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(update) });
      if (!response.ok) return setMessage(await payloadError(response));
      setSessions((current) => current.map((entry) => entry.id === session.id ? { ...entry, ...update } : entry));
    } catch { setMessage("The private library could not be updated. Try again."); }
    finally { setBusy(""); }
  }

  async function createPlaylist() {
    const name = playlistName.trim(); if (!name) return;
    const key = `playlist-create:${name}`; setBusy("playlist-create"); setMessage("");
    try {
      const response = await fetch("/api/v1/playlists", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: stableRequestId(key), name }) });
      settleRequestId(key, response);
      if (!response.ok) return setMessage(await payloadError(response));
      const created = (await response.json() as { playlist: Playlist }).playlist;
      await loadPlaylists(); setSelectedPlaylistId(created.id); setPlaylistName("");
    } catch { setMessage("The playlist could not be created. Retry uses the same protected request ID."); }
    finally { setBusy(""); }
  }

  async function deletePlaylist() {
    if (!selectedPlaylistId || !window.confirm("Delete this private playlist? Saved audio remains in your library.")) return;
    setBusy("playlist-delete"); setMessage("");
    try {
      const response = await fetch(`/api/v1/playlists/${encodeURIComponent(selectedPlaylistId)}`, { method: "DELETE" });
      if (!response.ok) return setMessage(await payloadError(response));
      setSelectedPlaylistId(""); setPlaylistItems([]); await loadPlaylists();
    } catch { setMessage("Playlist deletion can be retried safely."); }
    finally { setBusy(""); }
  }

  async function addToPlaylist(session: LibrarySession) {
    if (!selectedPlaylistId) return setMessage("Create or select a playlist first.");
    const key = `playlist-item:${selectedPlaylistId}:${session.mediaAssetId}`; setBusy(`playlist:${session.id}`); setMessage("");
    try {
      const position = playlistItems.reduce((max, item) => Math.max(max, item.position + 1), 0);
      const response = await fetch(`/api/v1/playlists/${encodeURIComponent(selectedPlaylistId)}/items`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: stableRequestId(key), mediaAssetId: session.mediaAssetId, position }) });
      settleRequestId(key, response);
      if (!response.ok) return setMessage(await payloadError(response));
      await loadPlaylistItems(); setMessage(`Added “${session.title}” to the playlist.`);
    } catch { setMessage("Playlist update was ambiguous. Retry preserves the same request ID."); }
    finally { setBusy(""); }
  }

  async function removePlaylistItem(item: PlaylistItem) {
    const response = await fetch(`/api/v1/playlists/${encodeURIComponent(selectedPlaylistId)}/items?itemId=${encodeURIComponent(item.id)}`, { method: "DELETE" });
    if (response.ok) await loadPlaylistItems(); else setMessage(await payloadError(response));
  }
  async function reorderPlaylist(from: number, to: number) {
    if (to < 0 || to >= playlistItems.length) return;
    const order = [...playlistItems]; const [item] = order.splice(from, 1); order.splice(to, 0, item);
    const response = await fetch(`/api/v1/playlists/${encodeURIComponent(selectedPlaylistId)}/items`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ itemIds: order.map(({ id }) => id) }) });
    if (response.ok) setPlaylistItems(order.map((entry, position) => ({ ...entry, position }))); else setMessage(await payloadError(response));
  }

  async function addToQueue(session: LibrarySession) {
    const key = `queue-item:${session.id}`; setBusy(`queue:${session.id}`); setMessage("");
    try {
      const position = queue.reduce((max, item) => Math.max(max, item.position + 1), 0);
      const response = await fetch("/api/v1/bedtime-queue", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: stableRequestId(key), sessionId: session.id, position }) });
      settleRequestId(key, response);
      if (!response.ok) return setMessage(await payloadError(response));
      await loadQueue(); setMessage(`Queued “${session.title}” for bedtime.`);
    } catch { setMessage("Queue update was ambiguous. Retry preserves the same request ID."); }
    finally { setBusy(""); }
  }
  async function updateQueue(order: QueueItem[], playingItemId: string | null) {
    const response = await fetch("/api/v1/bedtime-queue", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ itemIds: order.map(({ id }) => id), playingItemId }) });
    if (response.ok) setQueue(order.map((entry, position) => ({ ...entry, position, status: entry.id === playingItemId ? "playing" : "queued" }))); else setMessage(await payloadError(response));
  }
  async function removeQueueItem(item: QueueItem) {
    const response = await fetch(`/api/v1/bedtime-queue?itemId=${encodeURIComponent(item.id)}`, { method: "DELETE" });
    if (response.ok) await loadQueue(); else setMessage(await payloadError(response));
  }
  async function reorderQueue(from: number, to: number) {
    if (to < 0 || to >= queue.length) return;
    const order = [...queue]; const [item] = order.splice(from, 1); order.splice(to, 0, item);
    await updateQueue(order, order.find(({ status }) => status === "playing")?.id || null);
  }

  async function deleteSession(session: LibrarySession) {
    if (!window.confirm(`Permanently delete “${session.title}” and its private audio?`)) return;
    setBusy(`delete:${session.id}`); setMessage("");
    try {
      const response = await fetch(`/api/v1/library/${encodeURIComponent(session.id)}`, { method: "DELETE" });
      if (!response.ok && response.status !== 202) return setMessage(await payloadError(response));
      setSessions((current) => current.filter((entry) => entry.id !== session.id));
      if (response.status === 202) setMessage("Playback is disabled. Private storage cleanup will retry in the background.");
    } catch { setMessage("Playback remains protected; deletion can be retried when the connection returns."); }
    finally { setBusy(""); }
  }

  return <>
    <section className="panel" style={{ marginTop: 24 }}>
      <h2>Filter library</h2><div className="form-grid">
        <div className="field"><label htmlFor="library-child">Child profile</label><select id="library-child" value={childFilter} onChange={(event) => setChildFilter(event.target.value)}><option value="">All children</option>{childOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></div>
        <div className="field"><label htmlFor="library-voice">Voice</label><select id="library-voice" value={voiceFilter} onChange={(event) => setVoiceFilter(event.target.value)}><option value="">All voices</option>{voiceOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></div>
      </div><button className="btn btn-secondary" type="button" disabled={busy === "library-load"} onClick={() => void loadLibrary(true)}>Apply filters</button>
    </section>
    <section className="panel" style={{ marginTop: 20 }}>
      <h2>Playlists</h2><div className="form-grid">
        <div className="field"><label htmlFor="library-playlist">Active playlist</label><select id="library-playlist" value={selectedPlaylistId} onChange={(event) => setSelectedPlaylistId(event.target.value)}><option value="">Select a playlist</option>{playlists.map((playlist) => <option key={playlist.id} value={playlist.id}>{playlist.name}</option>)}</select></div>
        {canManage && <div className="field"><label htmlFor="new-playlist">New private playlist</label><div style={{ display: "flex", gap: 8 }}><input id="new-playlist" maxLength={100} value={playlistName} onChange={(event) => setPlaylistName(event.target.value)} /><button className="btn btn-secondary" type="button" disabled={busy === "playlist-create"} onClick={() => void createPlaylist()}>Create</button></div></div>}
      </div>{selectedPlaylistId && <>{canManage && <button className="btn btn-secondary" type="button" onClick={() => void deletePlaylist()}>Delete playlist</button>}<ol>{playlistItems.map((item, index) => <li key={item.id}>{item.title}{canManage && <> <button type="button" onClick={() => void reorderPlaylist(index, index - 1)} disabled={index === 0}>↑</button> <button type="button" onClick={() => void reorderPlaylist(index, index + 1)} disabled={index === playlistItems.length - 1}>↓</button> <button type="button" onClick={() => void removePlaylistItem(item)}>Remove</button></>}</li>)}</ol></>}
      {message && <div className="alert" role="status" style={{ marginTop: 12 }}>{message}</div>}
    </section>
    <section className="panel" style={{ marginTop: 20 }}><h2>Bedtime queue</h2>{queue.length ? <ol>{queue.map((item, index) => <li key={item.id}><strong>{item.title}</strong> · {item.status}{canManage && <> <button type="button" onClick={() => void updateQueue(queue, item.id)}>{item.status === "playing" ? "Playing" : "Play"}</button> <button type="button" onClick={() => void reorderQueue(index, index - 1)} disabled={index === 0}>↑</button> <button type="button" onClick={() => void reorderQueue(index, index + 1)} disabled={index === queue.length - 1}>↓</button> <button type="button" onClick={() => void removeQueueItem(item)}>Remove</button></>}{item.status === "playing" && <SleepPlayer src={`/api/audio/${item.sessionId}`} sound="none" />}</li>)}</ol> : <p className="muted">{canManage ? "Queue a saved session below." : "No saved sessions are queued."}</p>}</section>
    <div className="panel" style={{ marginTop: 20, padding: sessions.length ? 0 : 32 }}>
      {sessions.length ? sessions.map((session) => {
        const frequencies = parseStoredFrequencyLayers(session.frequencyLayers); const frequencyLabel = formatFrequencyLabel(frequencies);
        return <article className="session-card" style={{ gridTemplateColumns: "58px 1fr", alignItems: "start" }} key={session.id}><span className="session-art" aria-hidden="true">☾</span><div><h3>{session.title}</h3><p>{session.narrationKind === "demo_narrator" ? "Standard narrator" : "Parent voice"} · {session.backgroundSound === "none" ? "voice only" : session.backgroundSound}{frequencyLabel ? ` · ${frequencyLabel}` : ""} · {session.durationMinutes} min</p>
          <SleepPlayer src={`/api/audio/${session.id}`} sound={session.backgroundSound} frequencies={frequencies} repeatMinutes={session.repeatMinutes} /><div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12, alignItems: "center" }}>
            {canManage && <><button className="btn btn-secondary" type="button" disabled={busy === session.id} aria-pressed={session.favorite} onClick={() => void setLibraryState(session, { favorite: !session.favorite, repeatMinutes: session.repeatMinutes })}>{session.favorite ? "★ Favorite" : "☆ Favorite"}</button>
            <label>Repeat <select value={session.repeatMinutes ?? ""} disabled={busy === session.id} onChange={(event) => void setLibraryState(session, { favorite: session.favorite, repeatMinutes: event.target.value ? Number(event.target.value) : null })}><option value="">Off</option>{[15,30,45,60].map((minutes) => <option value={minutes} key={minutes}>{minutes} min</option>)}</select></label>
            <button className="btn btn-secondary" type="button" disabled={Boolean(busy)} onClick={() => void addToPlaylist(session)}>Add to playlist</button><button className="btn btn-secondary" type="button" disabled={Boolean(busy)} onClick={() => void addToQueue(session)}>Queue</button></>}<a className="btn btn-secondary" href={`/api/audio/${session.id}?download=true`}>Download</a>{canManage && <button className="btn btn-secondary" type="button" disabled={Boolean(busy)} onClick={() => void deleteSession(session)}>Delete</button>}
          </div></div></article>;
      }) : <div style={{ textAlign: "center" }}><h2>No saved nights match</h2><p className="muted">Adjust filters or create and save a session.</p></div>}
      {nextCursor && <div style={{ padding: 20, textAlign: "center" }}><button className="btn btn-secondary" type="button" disabled={busy === "library-load"} onClick={() => void loadLibrary(false)}>Load more</button></div>}
    </div>
  </>;
}
