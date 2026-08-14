import { CompanyBrand } from "@/components/CompanyBrand";
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
          <CompanyBrand />
        </div>
      </header>
      <main className="container not-found-content">
        <section className="not-found-card" aria-labelledby="not-found-title">
          <div className="not-found-moon" aria-hidden="true" />
          <span className="eyebrow">404 · A little farther than near</span>
          <h1 className="display" id="not-found-title">This page isn&apos;t here. We still are.</h1>
          <p className="muted">The page you were looking for may have moved. Your account and anything your family chose to save remain private and unchanged.</p>
          <div className="not-found-actions">
            <Link className="btn btn-primary" href="/">Return to NearYou Still</Link>
            <Link className="btn btn-secondary" href="/nearsleep">Explore NearSleep</Link>
            <Link className="btn btn-secondary" href={nightsHref}>{user ? "Open My nights" : "Sign in to My nights"}</Link>
          </div>
          <p className="not-found-note">Nothing was changed or deleted.</p>
        </section>
      </main>
    </div>
  );
}
