"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";

export function SignInOptions({ googleEnabled, returnTo }: {
  googleEnabled: boolean;
  returnTo: string;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function signIn() {
    setBusy(true);
    setMessage("");
    try {
      const result = await authClient.signIn.social({ provider: "google", callbackURL: returnTo });
      if (result.error) setMessage(result.error.message || "Could not continue with Google.");
    } catch {
      setMessage("Sign-in could not start. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return <div className="auth-options">
    <button className="auth-provider" type="button" disabled={!googleEnabled || busy} onClick={signIn}>
      <span className="provider-mark google-mark" aria-hidden="true">G</span>
      <span>{busy ? "Opening Google…" : "Continue with Google"}</span>
    </button>
    {!googleEnabled && <p className="auth-notice">Google sign-in is being connected. Please try again shortly.</p>}
    {message && <p className="alert" role="alert">{message}</p>}
  </div>;
}
