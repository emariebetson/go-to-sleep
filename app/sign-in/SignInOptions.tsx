"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";

type Provider = "google" | "apple";

export function SignInOptions({ appleEnabled, googleEnabled, returnTo }: {
  appleEnabled: boolean;
  googleEnabled: boolean;
  returnTo: string;
}) {
  const [busy, setBusy] = useState<Provider | null>(null);
  const [message, setMessage] = useState("");

  async function signIn(provider: Provider) {
    setBusy(provider);
    setMessage("");
    try {
      const result = await authClient.signIn.social({ provider, callbackURL: returnTo });
      if (result.error) setMessage(result.error.message || `Could not continue with ${provider === "google" ? "Google" : "Apple"}.`);
    } catch {
      setMessage("Sign-in could not start. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  const unavailable = !googleEnabled && !appleEnabled;
  return <div className="auth-options">
    <button className="auth-provider" type="button" disabled={!googleEnabled || busy !== null} onClick={() => signIn("google")}>
      <span className="provider-mark google-mark" aria-hidden="true">G</span>
      <span>{busy === "google" ? "Opening Google…" : "Continue with Google"}</span>
    </button>
    <button className="auth-provider apple-provider" type="button" disabled={!appleEnabled || busy !== null} onClick={() => signIn("apple")}>
      <span className="provider-mark" aria-hidden="true">●</span>
      <span>{busy === "apple" ? "Opening Apple…" : "Continue with Apple"}</span>
    </button>
    {unavailable && <p className="auth-notice">Provider credentials still need to be added before sign-in can open.</p>}
    {message && <p className="alert" role="alert">{message}</p>}
  </div>;
}
