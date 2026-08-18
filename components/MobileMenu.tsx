"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Link } from "./Link";

export type MobileMenuLink = { href: string; label: string };

export function MobileMenu({ links, primary, account }: {
  links: MobileMenuLink[];
  primary: MobileMenuLink;
  account: MobileMenuLink;
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (!open) {
      if (wasOpen.current) toggleRef.current?.focus();
      wasOpen.current = false;
      return;
    }
    wasOpen.current = true;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", close);
    document.body.style.overflow = "hidden";
    requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>("a, button")?.focus());
    return () => { document.removeEventListener("keydown", close); document.body.style.overflow = ""; };
  }, [open]);

  return <div className="mobile-menu">
    <button ref={toggleRef} className="mobile-menu-toggle" type="button" aria-expanded={open} aria-controls={menuId} aria-label={open ? "Close menu" : "Open menu"} onClick={() => setOpen((value) => !value)}>
      <span aria-hidden="true">{open ? "×" : "☰"}</span>
    </button>
    {open && <div ref={panelRef} className="mobile-menu-panel" id={menuId} role="dialog" aria-label="Mobile navigation">
      <Link className="btn btn-primary mobile-menu-primary" href={primary.href} onClick={() => setOpen(false)}>{primary.label}</Link>
      <nav className="mobile-menu-links" aria-label="Mobile navigation links">
        {links.map((link) => <Link href={link.href} key={link.href} onClick={() => setOpen(false)}>{link.label}</Link>)}
        <Link href={account.href} onClick={() => setOpen(false)}>{account.label}</Link>
      </nav>
    </div>}
  </div>;
}
