import type { Metadata } from "next";
import { Link } from "@/components/Link";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";
import { getAppUser, signInPath } from "@/lib/auth";

export const metadata: Metadata = { title: "Pricing", description: "Simple Nearnight plans with predictable generation limits and unlimited replays." };
export const dynamic = "force-dynamic";

export default async function PricingPage() {
  const user = await getAppUser();
  return <><SiteHeader /><main className="section" style={{ paddingTop: 65 }}><div className="container"><div className="section-head center"><span className="eyebrow">Predictable by design</span><h1 className="display" style={{ fontSize: "clamp(3.4rem,7vw,6rem)", margin: "12px 0" }}>More gentle nights.<br />No surprise bills.</h1><p className="muted">Generation credits control provider costs; saved sessions can be replayed as often as your family needs.</p></div><div className="pricing-card"><div className="pricing-main"><span className="eyebrow">Nearnight Plus</span><div className="price">$12 <small>/ month</small></div><p className="muted">One free personalized bedtime, then 12 new sessions per month.</p>{user ? <form action="/api/billing/checkout" method="post" style={{ marginTop: 20 }}><button className="btn btn-primary" type="submit">Start Nearnight Plus</button></form> : <Link className="btn btn-primary" href={signInPath("/pricing")} style={{ marginTop: 20 }}>Sign in to start Plus</Link>}<p className="pricing-note">Secure test checkout is handled by Stripe. Cancel anytime from Voice & account.</p><Link className="btn btn-secondary btn-small" href="/studio" style={{ marginTop: 12 }}>Create your free bedtime</Link></div><div className="pricing-details"><strong>Plus includes</strong><ul className="check-list"><li>One private parent voice profile</li><li>12 fresh 5–20 minute sessions/month</li><li>Unlimited library replays</li><li>Curated or personalized writing</li><li>Soft rain and noise layers</li><li>Cancel or delete anytime</li></ul><hr style={{ border: 0, borderTop: "1px solid var(--line)", margin: "25px 0" }} /><strong>Why credits?</strong><p className="muted" style={{ fontSize: ".85rem" }}>Audio generation has a real per-character cost. A generous monthly allowance keeps pricing sustainable without exposing parents to usage-based invoices.</p></div></div></div></main><SiteFooter /></>;
}
