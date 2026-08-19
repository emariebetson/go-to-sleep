import { CompanyBrand } from "./CompanyBrand";
import { Link } from "./Link";
import { MobileMenu } from "./MobileMenu";

export function CompanyHeader() {
  return <header className="site-header company-header">
    <div className="container nav-wrap">
      <CompanyBrand />
      <nav className="nav-links company-nav" aria-label="Company navigation">
        <Link href="/#products">Products</Link>
        <Link href="/nearsleep">NearSleep</Link>
        <Link href="/#company-purpose">Our purpose</Link>
        <Link className="btn btn-secondary btn-small" href="/sign-in">Sign in</Link>
        <MobileMenu primary={{ href: "/nearsleep", label: "Explore NearSleep" }} account={{ href: "/sign-in", label: "Sign in" }} links={[{ href: "/#products", label: "Products" }, { href: "/#company-purpose", label: "Our purpose" }]} />
      </nav>
    </div>
  </header>;
}
