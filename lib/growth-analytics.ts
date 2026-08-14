const PRODUCTS = new Set(["company", "nearsleep", "nearstory", "nearfamily", "nearlegacy"]);
const FUTURE_PRODUCTS = new Set(["nearstory", "nearfamily", "nearlegacy"]);
const IDENTIFIER = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ATTRIBUTION_SOURCES = new Set(["direct", "organic", "google", "facebook", "instagram", "linkedin", "email", "referral"]);
const CAMPAIGNS = new Set(["launch", "nearyoustill_launch"]);

export type GrowthEvent = {
  event: "landing_view" | "creation_started" | "expansion_interest_confirmed";
  properties: Partial<Record<"product" | "landingVariant" | "source" | "campaign", string>>;
};

export function normalizeGrowthEvent(value: unknown): GrowthEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_growth_event");
  const input = value as Record<string, unknown>;
  if (!(["landing_view", "creation_started", "expansion_interest_confirmed"] as unknown[]).includes(input.event)) throw new Error("invalid_growth_event");
  if (!input.properties || typeof input.properties !== "object" || Array.isArray(input.properties)) throw new Error("invalid_growth_event");
  const source = input.properties as Record<string, unknown>;
  const entries = Object.entries(source);
  if (!entries.length || entries.length > 4 || entries.some(([, property]) => typeof property !== "string" || !IDENTIFIER.test(property))) throw new Error("invalid_growth_event");
  if (typeof source.product !== "string" || !PRODUCTS.has(source.product)) throw new Error("invalid_growth_event");
  const keys = new Set(entries.map(([key]) => key));
  if (input.event === "landing_view") {
    if ([...keys].some((key) => !["product", "landingVariant", "source", "campaign"].includes(key))) throw new Error("invalid_growth_event");
    const expectedVariant = source.product === "company" ? "company-home" : source.product === "nearsleep" ? "nearsleep-hub" : "product-hub";
    if (source.landingVariant !== expectedVariant) throw new Error("invalid_growth_event");
    if (source.source !== undefined && !ATTRIBUTION_SOURCES.has(source.source as string)) throw new Error("invalid_growth_event");
    if (source.campaign !== undefined && !CAMPAIGNS.has(source.campaign as string)) throw new Error("invalid_growth_event");
  } else if (input.event === "creation_started") {
    if (keys.size !== 2 || !keys.has("product") || !keys.has("landingVariant") || source.product !== "nearsleep" || source.landingVariant !== "nearsleep-hub") throw new Error("invalid_growth_event");
  } else {
    if (keys.size !== 2 || !keys.has("product") || !keys.has("source") || !FUTURE_PRODUCTS.has(source.product as string) || source.source !== source.product) throw new Error("invalid_growth_event");
  }
  return { event: input.event as GrowthEvent["event"], properties: Object.fromEntries(entries) as GrowthEvent["properties"] };
}
