"use client";

import { useEffect, useState } from "react";
import { Link } from "@/components/Link";
import type { NearFamilySummary } from "@/lib/nearfamily-service";

type Props = { initialSummary?: NearFamilySummary | null };
type Dimension = keyof NearFamilySummary["capacity"]["usage"];

const labels: Record<Dimension, string> = { members: "Household members", children: "Child profiles", voices: "Verified adult voices", storageBytes: "Private storage" };

function amount(dimension: Dimension, value: number) {
  return dimension === "storageBytes" ? `${Number((value / 1_000_000_000).toFixed(1))} GB` : String(value);
}

export function FamilyDashboard({ initialSummary = null }: Props) {
  const [summary, setSummary] = useState(initialSummary);
  const [message, setMessage] = useState(initialSummary ? "" : "Loading family capacity…");
  useEffect(() => {
    if (initialSummary) return;
    void fetch("/api/v1/family", { headers: { accept: "application/json" } }).then(async response => {
      if (!response.ok) throw new Error("NearFamily is not available for this household.");
      setSummary(await response.json() as NearFamilySummary); setMessage("");
    }).catch(error => setMessage(error instanceof Error ? error.message : "NearFamily is not available for this household."));
  }, [initialSummary]);

  if (!summary) return <section className="panel"><p className="muted" role="status" aria-live="polite">{message}</p></section>;
  const dimensions = Object.keys(summary.capacity.usage) as Dimension[];
  return <>
    <span className="eyebrow">NearFamily</span>
    <h1 className="app-title display">Your family capacity, in one place.</h1>
    <p className="muted">NearFamily is an adult-managed bundle over your existing household, child profiles, verified voices, and private storage.</p>
    {summary.capacity.state === "restricted" && <section className="panel" style={{ marginTop: 24 }} aria-labelledby="family-remediation-heading">
      <h2 id="family-remediation-heading">Capacity needs attention</h2>
      <p className="panel-intro">Nothing has been deleted. New capacity stays paused until you reduce the highlighted usage or choose a suitable plan.</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}><Link className="btn btn-secondary btn-small" href="/studio">Review child profiles</Link><Link className="btn btn-secondary btn-small" href="/account">Manage voices &amp; account</Link><Link className="btn btn-secondary btn-small" href="/pricing">Review plan options</Link></div>
    </section>}
    <section className="metric-grid" aria-label="Family capacity">
      {dimensions.map(dimension => <article className="metric" key={dimension}><strong>{amount(dimension, summary.capacity.usage[dimension])} of {amount(dimension, summary.capacity.limits[dimension])}</strong><span>{labels[dimension]}{summary.capacity.exceeded.includes(dimension) ? " · over current limit" : ""}</span></article>)}
    </section>
    <section className="panel" aria-labelledby="family-safety-heading"><h2 id="family-safety-heading">Adult-managed by design</h2><ul className="check-list"><li>Children remain non-login profiles managed by an authenticated adult.</li><li>Child microphones are disabled.</li><li>Every narrator voice requires verified adult consent.</li><li>Posthumous voice synthesis is disabled.</li></ul></section>
  </>;
}
