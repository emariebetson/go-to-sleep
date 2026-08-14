import { Link } from "./Link";
import { Brand } from "./Brand";
import { getAppUser } from "@/lib/auth";
import { myNightsHref } from "@/lib/my-nights-navigation";

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
          <Link className="btn btn-primary btn-small" href="/studio">Create a bedtime</Link>
        </nav>
      </div>
    </header>
  );
}
