"use client";

import { FormEvent, useRef, useState } from "react";
import { Link } from "./Link";
import { recordGrowthEvent } from "./GrowthAnalytics";

type Product = "nearstory" | "nearfamily" | "nearlegacy";
type Props = { initialProduct: Product; source: "home" | "pricing" | "nearstory" | "nearfamily" | "nearlegacy" };
const labels: Record<Product, string> = { nearstory: "NearStory", nearfamily: "NearFamily", nearlegacy: "NearLegacy" };

export function WaitlistForm({ initialProduct, source }: Props) {
  const requestId = useRef(crypto.randomUUID());
  const [products, setProducts] = useState<Product[]>([initialProduct]);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  function toggle(product: Product) {
    setProducts((current) => current.includes(product) ? current.filter((value) => value !== product) : [...current, product]);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    if (!products.length) return setStatus("Choose at least one product.");
    setBusy(true);
    setStatus("");
    try {
      const response = await fetch("/api/v1/marketing/waitlist", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": requestId.current },
        body: JSON.stringify({ email: data.get("email"), products, source, consent: data.get("consent") === "on", consentVersion: "marketing-consent-v1" }),
      });
      const result = await response.json() as { products?: Product[]; error?: string };
      if (!response.ok) throw new Error(result.error || "We could not save your signup right now.");
      setStatus(`You're on the ${result.products?.map((product) => labels[product]).join(", ")} waitlist.`);
      for (const product of result.products || []) recordGrowthEvent({ event: "expansion_interest_confirmed", properties: { product, source } });
      form.reset();
      requestId.current = crypto.randomUUID();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "We could not save your signup right now.");
    } finally {
      setBusy(false);
    }
  }

  return <form className="waitlist-form" onSubmit={submit}>
    <label>Email address<input name="email" type="email" autoComplete="email" required maxLength={254} /></label>
    <fieldset><legend>What are you interested in?</legend>{(Object.keys(labels) as Product[]).map((product) => <label className="waitlist-check" key={product}><input type="checkbox" checked={products.includes(product)} onChange={() => toggle(product)} />{labels[product]}</label>)}</fieldset>
    <label className="waitlist-consent"><input name="consent" type="checkbox" required />I agree to receive product-launch and marketing email from NearYou. I can unsubscribe at any time.</label>
    <p className="pricing-note">See our <Link href="/privacy">Privacy</Link> and <Link href="/terms">Terms</Link>.</p>
    <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? "Joining…" : "Join waitlist"}</button>
    <p className="waitlist-status" aria-live="polite">{status}</p>
  </form>;
}
