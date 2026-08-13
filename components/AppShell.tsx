import { Link } from "./Link";
import { getAppUser, isAdmin } from "@/lib/auth";
import { Brand } from "./Brand";
import { SignOutButton } from "./SignOutButton";
import { appNavigationLinks, resolveFamilyNavigationAvailability } from "./app-navigation";

type AppShellProps = {
  children: React.ReactNode;
  active: "studio" | "stories" | "family" | "legacy" | "library" | "account" | "admin";
  familyAvailable?: boolean;
};

export async function AppShell({ children, active, familyAvailable }: AppShellProps) {
  const user = await getAppUser();
  const showAdmin = Boolean(user && isAdmin(user));
  const { storyReady } = await import("@/app/api/v1/stories/production");
  const showStories = await storyReady().catch(() => false);
  const { nearLegacyReady } = await import("@/app/api/v1/legacy/production");
  const showLegacy = await nearLegacyReady().catch(() => false);
  const showFamily = await resolveFamilyNavigationAvailability(familyAvailable, async () => {
    const { nearFamilyPageAvailability } = await import("@/app/family/availability");
    return nearFamilyPageAvailability().catch(() => ({ available: false as const }));
  });
  const links = appNavigationLinks({ showStories, showLegacy, familyAvailable: showFamily });

  return (
    <div className="app-page">
      <header className="app-header">
        <div className="container nav-wrap" style={{ minHeight: 78 }}>
          <Brand />
          <div className="nav-links">
            <Link href="/pricing">Plan</Link>
            <Link className="btn btn-secondary btn-small" href="/">View site</Link>
          </div>
        </div>
      </header>
      <div className="app-layout">
        <aside className="sidebar">
          <nav className="side-nav" aria-label="Product navigation">
            {links.map(([key, href, label]) => (
              <Link className={active === key ? "active" : ""} href={href} key={key}>{label}</Link>
            ))}
            {showAdmin && <Link className={active === "admin" ? "active" : ""} href="/admin">Admin</Link>}
          </nav>
          <div className="sidebar-note">
            <strong style={{ display: "block", color: "var(--ink)", marginBottom: 4 }}>Tonight’s reminder</strong>
            Place the speaker across the room, keep the volume low, and always follow safe-sleep guidance.
          </div>
          {user && <div className="sidebar-account"><span>{user.displayName}</span><small>{user.email}</small><SignOutButton /></div>}
        </aside>
        <main className="app-main">{children}</main>
      </div>
    </div>
  );
}
