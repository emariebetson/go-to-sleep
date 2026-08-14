import { Brand } from "@/components/Brand";
import { Link } from "@/components/Link";
import { getAppUser } from "@/lib/auth";
import { myNightsHref } from "@/lib/my-nights-navigation";

export default async function NotFound() {
  const user = await getAppUser();
  const nightsHref = myNightsHref(user);

  return (
    <div className="not-found-page">
      <header className="site-header">
        <div className="container">
          <Brand />
        </div>
      </header>
      <main className="container not-found-content">
        <section className="not-found-card" aria-labelledby="not-found-title">
          <div className="not-found-moon" aria-hidden="true" />
          <span className="eyebrow">404 · A quiet detour</span>
          <h1 className="display" id="not-found-title">This page wandered off to sleep.</h1>
          <p className="muted">The page you were looking for isn&apos;t here, but your family&apos;s saved nights are still safe and private.</p>
          <div className="not-found-actions">
            <Link className="btn btn-primary" href="/studio">Create a bedtime</Link>
            <Link className="btn btn-secondary" href="/">Return home</Link>
            <Link className="btn btn-secondary" href={nightsHref}>{user ? "Open My nights" : "Sign in to My nights"}</Link>
          </div>
          <p className="not-found-note">Nothing was changed or deleted.</p>
        </section>
      </main>
    </div>
  );
}
