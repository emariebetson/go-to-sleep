import type { NearYouProduct } from "@/lib/nearyoustill-products";
import { CompanyHeader } from "./CompanyHeader";
import { Link } from "./Link";
import { SiteFooter } from "./SiteFooter";
import { WaitlistForm } from "./WaitlistForm";
import { GrowthView } from "./GrowthAnalytics";

export function ProductHub({ product }: { product: NearYouProduct }) {
  return <div className={`product-hub product-accent-${product.accent}`}>
    <GrowthView event={{ event: "landing_view", properties: { product: product.slug, landingVariant: "product-hub" } }} />
    <CompanyHeader />
    <main>
      <section className="product-hub-hero">
        <div className="container product-hub-grid">
          <div>
            <span className="eyebrow">{product.eyebrow}</span>
            <h1 className="company-display">{product.name}</h1>
            <p className="company-lede">{product.description}</p>
            <span className="status-badge">Coming soon</span>
          </div>
          <div className="product-hub-panel">
            <h2>Be among the first to know.</h2>
            <p>Join the waitlist for thoughtful launch notes and product updates from NearYou.</p>
            {product.waitlistSource && <WaitlistForm initialProduct={product.waitlistSource} source={product.waitlistSource} />}
          </div>
        </div>
      </section>
      <section className="section">
        <div className="container product-values">
          <article><span aria-hidden="true">01</span><h2>Family-led</h2><p>The adults a family trusts stay in control of what is shared and preserved.</p></article>
          <article><span aria-hidden="true">02</span><h2>Private by design</h2><p>Clear choices and careful boundaries shape every experience.</p></article>
          <article><span aria-hidden="true">03</span><h2>Quietly useful</h2><p>Technology stays in the background so the human moment can stay in focus.</p></article>
        </div>
      </section>
      <section className="company-promise section"><div className="container center"><span className="eyebrow">Part of NearYou Still</span><h2 className="display">Near you, still.</h2><Link href="/#products" className="btn btn-secondary">Explore all NearYou products</Link></div></section>
    </main>
    <SiteFooter />
  </div>;
}
