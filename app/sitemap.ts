import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = process.env.PUBLIC_APP_URL || "https://nearnight.app";
  return [
    ["", 1, "weekly"],
    ["/pricing", 0.8, "monthly"],
    ["/safety", 0.8, "monthly"],
    ["/privacy", 0.3, "yearly"],
    ["/terms", 0.3, "yearly"],
  ].map(([path, priority, changeFrequency]) => ({ url: `${base}${path}`, lastModified: new Date(), changeFrequency, priority })) as MetadataRoute.Sitemap;
}
