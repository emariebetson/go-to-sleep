import Link from "next/link";
import { Brand } from "./Brand";

export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="container nav-wrap">
        <Brand />
        <nav className="nav-links" aria-label="Primary navigation">
          <Link href="/#how-it-works">How it works</Link>
          <Link href="/#safety">Safety</Link>
          <Link href="/pricing">Pricing</Link>
          <Link href="/sign-in">Sign in</Link>
          <Link className="btn btn-secondary btn-small" href="/library">My nights</Link>
          <Link className="btn btn-primary btn-small" href="/studio">Create a bedtime</Link>
        </nav>
      </div>
    </header>
  );
}
