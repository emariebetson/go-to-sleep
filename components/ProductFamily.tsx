import { Link } from "./Link";
import { WaitlistForm } from "./WaitlistForm";

export function ProductFamily({ source }: { source: "home" | "pricing" }) {
  return <section className="section product-family" id="products">
    <div className="container">
      <div className="section-head center"><span className="eyebrow">The NearYou family</span><h2 className="display">Support for every chapter.</h2><p className="muted">NearSleep is available now. Join the waitlist for what comes next.</p></div>
      <div className="product-grid">
        <article className="product-card"><span className="status-badge available">Available now</span><h3>NearSleep</h3><p>Personalized sleep and calming audio in a familiar adult voice.</p><Link className="btn btn-primary" href="/studio">Create a bedtime</Link></article>
        <article className="product-card"><span className="status-badge">Coming soon</span><h3>NearStory</h3><p>Parent-controlled personalized stories that make your child the protagonist.</p><details><summary className="btn btn-secondary">Join waitlist</summary><WaitlistForm initialProduct="nearstory" source={source} /></details></article>
        <article className="product-card"><span className="status-badge">Coming soon</span><h3>NearFamily</h3><p>More children, loved-one voices, household members, and shared family capacity.</p><details><summary className="btn btn-secondary">Join waitlist</summary><WaitlistForm initialProduct="nearfamily" source={source} /></details></article>
        <article className="product-card"><span className="status-badge">Coming soon</span><h3>NearLegacy</h3><p>A consent-based archive for original family recordings, memories, and grounded search.</p><details><summary className="btn btn-secondary">Join waitlist</summary><WaitlistForm initialProduct="nearlegacy" source={source} /></details></article>
      </div>
    </div>
  </section>;
}
