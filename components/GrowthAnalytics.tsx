"use client";

import { ReactNode, useEffect } from "react";
import { Link } from "./Link";
import type { GrowthEvent } from "@/lib/growth-analytics";

function anonymousId() {
  const key = "nearyou_growth_session";
  const existing = sessionStorage.getItem(key);
  if (existing && /^[a-f0-9-]{36}$/.test(existing)) return existing;
  const created = crypto.randomUUID();
  sessionStorage.setItem(key, created);
  return created;
}

export function recordGrowthEvent(event: GrowthEvent) {
  try {
    void fetch("/api/v1/analytics", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...event, anonymousId: anonymousId() }),
      keepalive: true,
    }).catch(() => undefined);
  } catch { /* Measurement never blocks the product. */ }
}

export function GrowthView({ event }: { event: GrowthEvent }) {
  const serialized = JSON.stringify(event);
  useEffect(() => { recordGrowthEvent(JSON.parse(serialized) as GrowthEvent); }, [serialized]);
  return null;
}

export function GrowthLink({ event, href, className, children }: { event: GrowthEvent; href: string; className?: string; children: ReactNode }) {
  function click() { recordGrowthEvent(event); }
  return <Link href={href} className={className} onClick={click}>{children}</Link>;
}
