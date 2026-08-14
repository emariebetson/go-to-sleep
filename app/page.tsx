import type { Metadata } from "next";
import { CompanyHeader } from "@/components/CompanyHeader";
import { Link } from "@/components/Link";
import { ProductFamily } from "@/components/ProductFamily";
import { SiteFooter } from "@/components/SiteFooter";
import { GrowthView } from "@/components/GrowthAnalytics";

export const metadata: Metadata = {
  title: { absolute: "NearYou Still — Near you, still." },
  description: "Thoughtful tools that help families keep comfort, stories, connection, and memories near.",
  alternates: { canonical: "/" },
};

const organizationSchema = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "NearYou",
  url: "https://nearyoustill.com",
  slogan: "Near you, still.",
  brand: ["NearSleep", "NearStory", "NearFamily", "NearLegacy"].map((name) => ({ "@type": "Brand", name })),
};

export default function CompanyHome() {
  return <>
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationSchema).replace(/</g, "\\u003c") }} />
    <GrowthView event={{ event: "landing_view", properties: { product: "company", landingVariant: "company-home" } }} />
    <CompanyHeader />
    <main>
      <section className="company-hero">
        <div className="container company-hero-inner">
          <span className="eyebrow">NearYou Still</span>
          <h1 className="company-display">Near you, <em>still.</em></h1>
          <p className="company-lede">Thoughtful tools for the comfort, stories, connection, and memories families choose to keep close.</p>
          <div className="hero-actions">
            <Link className="btn btn-primary" href="/nearsleep">Explore NearSleep <span aria-hidden="true">→</span></Link>
            <Link className="btn btn-secondary" href="#products">Meet the family</Link>
          </div>
        </div>
      </section>
      <section className="company-intro section" aria-labelledby="company-purpose">
        <div className="container company-purpose-grid">
          <span className="eyebrow">Made for meaningful closeness</span>
          <div>
            <h2 className="display" id="company-purpose">Technology should feel more human when family matters most.</h2>
            <p className="muted">NearYou creates calm, private experiences that support families across nights, stories, everyday connection, and the memories they decide to carry forward.</p>
          </div>
        </div>
      </section>
      <ProductFamily source="home" />
      <section className="company-promise section">
        <div className="container center">
          <span className="eyebrow">Our promise</span>
          <h2 className="display">Designed with care. Kept in your control.</h2>
          <p className="muted">Every NearYou experience is built around clear consent, family choice, and the belief that technology belongs in the background—not between people.</p>
        </div>
      </section>
    </main>
    <SiteFooter />
  </>;
}
