import { Link } from "./Link";
import { PRODUCTS } from "@/lib/nearyoustill-products";

export function ProductFamily({ source }: { source: "home" | "pricing" }) {
  void source;
  return <section className="section product-family" id="products">
    <div className="container">
      <div className="section-head center"><span className="eyebrow">The NearYou family</span><h2 className="display">For the moments you keep near.</h2><p className="muted">NearSleep is available now. The next NearYou experiences are taking shape with care.</p></div>
      <div className="product-grid">
        {PRODUCTS.map((product) => <article className={`product-card product-card-${product.accent}`} key={product.slug}>
          <span className={`status-badge ${product.availability === "live" ? "available" : ""}`}>{product.availability === "live" ? "Available now" : "Coming soon"}</span>
          <h3>{product.name}</h3><p>{product.description}</p>
          <Link className={product.availability === "live" ? "btn btn-primary" : "btn btn-secondary"} href={product.path}>{product.availability === "live" ? "Explore NearSleep" : `Meet ${product.name}`}</Link>
        </article>)}
      </div>
    </div>
  </section>;
}
