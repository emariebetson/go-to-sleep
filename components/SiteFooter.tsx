import { Link } from "./Link";
import { CompanyBrand } from "./CompanyBrand";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="container">
        <div className="footer-top">
          <div>
            <CompanyBrand light />
            <p style={{ maxWidth: 330, fontSize: ".85rem", marginTop: 14 }}>
              Thoughtful tools that help families keep what matters near.
            </p>
          </div>
          <nav className="footer-links" aria-label="Footer navigation">
            <Link href="/#products">Products</Link>
            <Link href="/nearsleep">NearSleep</Link>
            <Link href="/pricing">Pricing</Link>
            <Link href="/safety">Safety</Link>
            <Link href="/privacy">Privacy</Link>
            <Link href="/terms">Terms</Link>
          </nav>
        </div>
        <div className="footer-bottom">
          <span>© {new Date().getFullYear()} NearYou. Near you, still.</span>
          <span>NearYouStill is our public home—not a separate company or plan.</span>
        </div>
      </div>
    </footer>
  );
}
