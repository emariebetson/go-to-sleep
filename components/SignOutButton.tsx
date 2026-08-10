"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";

export function SignOutButton() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function signOut() {
    setBusy(true); setMessage("");
    try {
      const result = await authClient.signOut();
      if (result.error) throw new Error(result.error.message || "Sign out failed.");
      window.location.assign("/");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Sign out failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return <>{message && <span className="alert" role="alert">{message}</span>}<button className="text-button" type="button" disabled={busy} onClick={signOut}>{busy ? "Signing out…" : "Sign out"}</button></>;
}
