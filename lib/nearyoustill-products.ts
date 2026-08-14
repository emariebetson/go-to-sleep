export type ProductSlug = "nearsleep" | "nearstory" | "nearfamily" | "nearlegacy";
export type ProductAvailability = "live" | "coming_soon";
export type ProductAccent = "dusk" | "story" | "family" | "legacy";
export type ProductWaitlistSource = Exclude<ProductSlug, "nearsleep">;

export type NearYouProduct = Readonly<{
  slug: ProductSlug;
  name: "NearSleep" | "NearStory" | "NearFamily" | "NearLegacy";
  path: `/${ProductSlug}`;
  availability: ProductAvailability;
  description: string;
  eyebrow: string;
  accent: ProductAccent;
  primaryCta: string;
  metadataTitle: string;
  metadataDescription: string;
  waitlistSource: ProductWaitlistSource | null;
  applicationDestination: "/studio" | null;
}>;

export const PRODUCTS = Object.freeze([
  {
    slug: "nearsleep",
    name: "NearSleep",
    path: "/nearsleep",
    availability: "live",
    description: "Personalized bedtime stories and calming audio in a familiar adult voice.",
    eyebrow: "For gentler nights",
    accent: "dusk",
    primaryCta: "Create a bedtime",
    metadataTitle: "NearSleep — A familiar voice for gentler nights",
    metadataDescription: "Create personalized bedtime stories and calming audio in a familiar adult voice.",
    waitlistSource: null,
    applicationDestination: "/studio",
  },
  {
    slug: "nearstory",
    name: "NearStory",
    path: "/nearstory",
    availability: "coming_soon",
    description: "Thoughtful family stories shaped for the people and moments you care about.",
    eyebrow: "For stories held close",
    accent: "story",
    primaryCta: "Join the NearStory waitlist",
    metadataTitle: "NearStory — Coming soon from NearYou",
    metadataDescription: "NearStory is a new way for families to keep meaningful stories close. Join the waitlist.",
    waitlistSource: "nearstory",
    applicationDestination: null,
  },
  {
    slug: "nearfamily",
    name: "NearFamily",
    path: "/nearfamily",
    availability: "coming_soon",
    description: "A shared place for families to stay connected across everyday life and changing chapters.",
    eyebrow: "For family, together",
    accent: "family",
    primaryCta: "Join the NearFamily waitlist",
    metadataTitle: "NearFamily — Coming soon from NearYou",
    metadataDescription: "NearFamily is a shared place for families to stay connected. Join the waitlist.",
    waitlistSource: "nearfamily",
    applicationDestination: null,
  },
  {
    slug: "nearlegacy",
    name: "NearLegacy",
    path: "/nearlegacy",
    availability: "coming_soon",
    description: "A private home for the memories and original recordings a family chooses to preserve.",
    eyebrow: "For what you carry forward",
    accent: "legacy",
    primaryCta: "Join the NearLegacy waitlist",
    metadataTitle: "NearLegacy — Coming soon from NearYou",
    metadataDescription: "NearLegacy is a private home for family memories and original recordings. Join the waitlist.",
    waitlistSource: "nearlegacy",
    applicationDestination: null,
  },
] as const satisfies readonly NearYouProduct[]);

export function getProduct(slug: ProductSlug): NearYouProduct {
  const product = PRODUCTS.find((candidate) => candidate.slug === slug);
  if (!product) throw new Error("unknown_product");
  return product;
}
