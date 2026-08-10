"use client";

import { useState } from "react";

async function responseError(response: Response, fallback: string) {
  try {
    const payload = await response.json() as { error?: string };
    return payload.error || fallback;
  } catch {
    return fallback;
  }
}

export function VoiceDeleteButton() {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function removeVoices() {
    if (!window.confirm("Permanently delete every voice clone? Existing audio will remain playable, but you cannot generate new sessions until you record again.")) return;
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/voices?all=true", { method: "DELETE" });
      if (response.ok) window.location.reload();
      else setMessage(await responseError(response, "Voice deletion failed."));
    } catch {
      setMessage("Voice deletion failed. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }
  return <>{message && <div className="alert" role="status">{message}</div>}<button className="btn btn-secondary" style={{ marginTop: 20 }} onClick={removeVoices} disabled={busy}>{busy ? "Deleting…" : "Delete voice clone"}</button></>;
}

export function AccountDeleteButton() {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function removeAccount() {
    if (!window.confirm("Permanently delete your account, voice, scripts, and audio? This cannot be undone.")) return;
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/account", { method: "DELETE" });
      if (response.ok) window.location.assign("/");
      else setMessage(await responseError(response, "Account deletion failed."));
    } catch {
      setMessage("Account deletion failed. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }
  return <>{message && <div className="alert" role="status">{message}</div>}<button className="btn btn-secondary" onClick={removeAccount} disabled={busy}>{busy ? "Deleting…" : "Start account deletion"}</button></>;
}
