import type { Metadata } from "next";
import { Link } from "@/components/Link";
import { Brand } from "@/components/Brand";
import { configuredOAuthProviders, safeRelativeReturnPath } from "@/lib/auth";
import { SignInOptions } from "./SignInOptions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sign in", robots: { index: false, follow: false } };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ returnTo?: string }> }) {
  const params = await searchParams;
  const returnTo = safeRelativeReturnPath(params.returnTo || "/studio");
  const providers = configuredOAuthProviders();

  return <main className="auth-page">
    <div className="auth-card">
      <Brand />
      <span className="eyebrow">Welcome to Nearnight</span>
      <h1 className="display">A private place for gentler nights</h1>
      <p className="muted">Sign in with Google. Nearnight never receives your Google password.</p>
      <SignInOptions googleEnabled={providers.google} returnTo={returnTo} />
      <p className="auth-fine-print">For parents and caregivers 18+. By continuing, you agree to the <Link href="/terms">terms</Link> and acknowledge the <Link href="/privacy">privacy notice</Link>.</p>
      <Link className="auth-back" href="/">← Back to Nearnight</Link>
    </div>
  </main>;
}
