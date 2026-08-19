import { Link } from "./Link";
import { Brand } from "./Brand";
import { getAppUser } from "@/lib/auth";
import { myNightsHref } from "@/lib/my-nights-navigation";
import { MobileMenu } from "./MobileMenu";

export async function SiteHeader() {
  const user = await getAppUser();
  const nightsHref = myNightsHref(user);

  return (
    <header className="site-header">
      <div className="container nav-wrap">
        <Brand />
        <nav className="nav-links" aria-label="Primary navigation">
          <Link href="/nearsleep#how-it-works">How it works</Link>
          <Link href="/nearsleep#safety">Safety</Link>
          <Link href="/#products">NearYou products</Link>
          <Link href="/pricing">Pricing</Link>
          <Link href="/sign-in">Sign in</Link>
          <Link className="btn btn-secondary btn-small" href={nightsHref}>My nights</Link>
          <MobileMenu primary={{ href: "/studio", label: "Create a bedtime" }} account={{ href: user ? nightsHref : "/sign-in", label: user ? "My nights" : "Sign in" }} links={[{ href: "/nearsleep#how-it-works", label: "How it works" }, { href: "/nearsleep#safety", label: "Safety & privacy" }, { href: "/#products", label: "NearYou products" }, { href: "/pricing", label: "Pricing" }]} />
        </nav>
      </div>
    </header>
  );
}
