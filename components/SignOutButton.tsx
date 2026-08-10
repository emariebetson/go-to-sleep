"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";

export function SignOutButton() {
  const [busy, setBusy] = useState(false);
  async function signOut() {
    setBusy(true);
    await authClient.signOut();
    window.location.assign("/");
  }
  return <button className="text-button" type="button" disabled={busy} onClick={signOut}>{busy ? "Signing out…" : "Sign out"}</button>;
}
