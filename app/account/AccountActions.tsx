"use client";

import { useState } from "react";

export function VoiceDeleteButton() {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function removeVoices() {
    if (!window.confirm("Permanently delete every voice clone? Existing audio will remain playable, but you cannot generate new sessions until you record again.")) return;
    setBusy(true); setMessage("");
    const response = await fetch("/api/voices?all=true", { method: "DELETE" });
    const payload = await response.json() as { error?: string };
    setBusy(false); setMessage(response.ok ? "Your voice clone has been deleted." : (payload.error || "Voice deletion failed."));
  }
  return <>{message && <div className="alert" role="status">{message}</div>}<button className="btn btn-secondary" style={{ marginTop: 20 }} onClick={removeVoices} disabled={busy}>{busy ? "Deleting…" : "Delete voice clone"}</button></>;
}

export function AccountDeleteButton() {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function removeAccount() {
    if (!window.confirm("Permanently delete your account, voice, scripts, and audio? This cannot be undone.")) return;
    setBusy(true); setMessage("");
    const response = await fetch("/api/account", { method: "DELETE" });
    const payload = await response.json() as { error?: string };
    setBusy(false);
    if (response.ok) window.location.assign("/");
    else setMessage(payload.error || "Account deletion failed.");
  }
  return <>{message && <div className="alert" role="status">{message}</div>}<button className="btn btn-secondary" onClick={removeAccount} disabled={busy}>{busy ? "Deleting…" : "Start account deletion"}</button></>;
}
