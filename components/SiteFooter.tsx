import { Link } from "./Link";
import { Brand } from "./Brand";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="container">
        <div className="footer-top">
          <div>
            <Brand light />
            <p style={{ maxWidth: 330, fontSize: ".85rem", marginTop: 14 }}>
              Familiar-voice bedtime audio, created by parents and played by parents.
            </p>
          </div>
          <nav className="footer-links" aria-label="Footer navigation">
            <Link href="/#how-it-works">How it works</Link>
            <Link href="/pricing">Pricing</Link>
            <Link href="/safety">Safety</Link>
            <Link href="/privacy">Privacy</Link>
            <Link href="/terms">Terms</Link>
          </nav>
        </div>
        <div className="footer-bottom">
          <span>© {new Date().getFullYear()} Nearnight, a NearSleep experience by NearYou. Made for the long nights.</span>
          <span>Not medical advice or a sleep-training program.</span>
        </div>
      </div>
    </footer>
  );
}
