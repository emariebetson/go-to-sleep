import type { Metadata } from "next";
import { Link } from "@/components/Link";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";

export const metadata: Metadata = {
  title: "Your voice, their gentlest bedtime",
  description: "Create personalized baby bedtime stories and calming audio in your own familiar voice.",
};
export const dynamic = "force-dynamic";

export default function Home() {
  return (
    <>
      <section className="hero">
        <SiteHeader />
        <div className="container hero-grid">
          <div>
            <span className="eyebrow">A familiar voice for sleepy moments</span>
            <h1 className="display">Your voice.<br />Their <em>gentlest</em> bedtime.</h1>
            <p className="hero-copy">
              Create a calming, personalized bedtime in the voice your baby knows best—yours. Made in minutes, ready whenever the night needs a little extra closeness.
            </p>
            <div className="hero-actions">
              <Link className="btn btn-primary" href="/studio">Create tonight’s story <span aria-hidden="true">→</span></Link>
              <Link className="btn btn-secondary" href="#how-it-works">See how it works</Link>
            </div>
            <div className="trust-row" aria-label="Product assurances">
              <span>Parent-operated</span><span>Voice deletion anytime</span><span>One free bedtime</span>
            </div>
          </div>
          <div className="phone-scene" aria-label="Nearnight audio player preview">
            <div className="orbit orbit-one" aria-hidden="true" /><div className="orbit orbit-two" aria-hidden="true" />
            <div className="star star-one" aria-hidden="true" /><div className="star star-two" aria-hidden="true" />
            <div className="phone">
              <div className="phone-top"><span>9:14</span><span>Tonight</span></div>
              <div className="phone-moon" aria-hidden="true" />
              <h3>Moonlit Meadow</h3>
              <p>For baby Junie · In Mama’s voice</p>
              <div className="wave" aria-hidden="true">{Array.from({ length: 9 }, (_, index) => <i key={index} />)}</div>
              <div className="phone-controls" aria-hidden="true"><span className="round">−15</span><span className="round play">▶</span><span className="round">+15</span></div>
              <p style={{ marginTop: 24 }}>8:12 remaining · soft rain</p>
            </div>
          </div>
        </div>
      </section>

      <section className="section" id="how-it-works">
        <div className="container">
          <div className="section-head center">
            <span className="eyebrow">From your voice to their dreams</span>
            <h2 className="display">Three small steps to a softer night</h2>
            <p className="muted">A simple ritual designed for exhausted parents, not audio engineers.</p>
          </div>
          <div className="steps">
            <article className="step"><span className="step-number">01</span><h3>Share your voice</h3><p>Record one to two quiet minutes in a room without background noise. You stay in control of the clone.</p><span className="step-art" aria-hidden="true" /></article>
            <article className="step"><span className="step-number">02</span><h3>Shape tonight’s story</h3><p>Choose your baby’s name, the bedtime challenge, story world, length, soundscape, and calming style.</p><span className="step-art" aria-hidden="true" /></article>
            <article className="step"><span className="step-number">03</span><h3>Press play nearby</h3><p>We create a familiar-voice track for you to play from a safe distance while you lead the bedtime routine.</p><span className="step-art" aria-hidden="true" /></article>
          </div>
        </div>
      </section>

      <section className="section night-section" id="safety">
        <div className="container feature-grid">
          <div className="sound-card" aria-hidden="true"><div className="sound-rings"><span /><span /><span /></div></div>
          <div>
            <span className="eyebrow">Built around trust</span>
            <h2 className="display">Their comfort.<br />Your control.</h2>
            <p className="muted">Nearnight is parent-operated and designed as a calming bedtime companion—not a monitor, medical device, or replacement for responsive care.</p>
            <div className="feature-list">
              <div className="feature-item"><span className="feature-icon">◐</span><div><h3>Your voice stays yours</h3><p>Explicit voice consent, private storage, and one-tap deletion from Nearnight and the voice provider.</p></div></div>
              <div className="feature-item"><span className="feature-icon">✦</span><div><h3>Guardrailed stories</h3><p>Reviewed templates and constrained personalization avoid fear, medical claims, unsafe sleep advice, and overstimulation.</p></div></div>
              <div className="feature-item"><span className="feature-icon">⌁</span><div><h3>Baby-conscious playback</h3><p>Low-volume reminders, timers, and placement guidance are shown each time a parent starts a session.</p></div></div>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container quote">
          <span className="eyebrow">For the nights that ask more of you</span>
          <blockquote>“It still sounds like me—even when I’m too tired to find one more lullaby.”</blockquote>
          <cite>Illustrative early-parent feedback · not a clinical claim</cite>
        </div>
      </section>

      <section className="section" id="pricing" style={{ background: "#f1eee6" }}>
        <div className="container">
          <div className="section-head center"><span className="eyebrow">Simple, sustainable pricing</span><h2 className="display">Start with tonight</h2><p className="muted">One free session. Upgrade only when Nearnight earns a place in your routine.</p></div>
          <div className="pricing-card">
            <div className="pricing-main"><span className="eyebrow">Nearnight Plus</span><div className="price">$12 <small>/ month</small></div><p className="muted">Includes 12 new personalized sessions each month, with unlimited replays of your library.</p><Link className="btn btn-primary" href="/studio" style={{ marginTop: 20 }}>Create your free bedtime</Link><p className="pricing-note">Cancel anytime. Additional session packs available; no surprise usage bills.</p></div>
            <div className="pricing-details"><strong>Everything parents need</strong><ul className="check-list"><li>Your private voice profile</li><li>Curated and personalized stories</li><li>5–20 minute sessions</li><li>On-device calming sound layers</li><li>Offline-ready mobile architecture</li><li>Voice and account deletion controls</li></ul></div>
          </div>
        </div>
      </section>

      <section className="cta-band"><div className="container"><h2 className="display">A little more of you, right when they need it.</h2><Link className="btn btn-primary" href="/studio">Create your first bedtime</Link></div></section>
      <SiteFooter />
    </>
  );
}
