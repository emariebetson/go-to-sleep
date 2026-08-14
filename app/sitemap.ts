import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = "https://nearyoustill.com";
  return [
    ["", 1, "weekly"],
    ["/nearsleep", 1, "weekly"],
    ["/nearstory", 0.7, "monthly"],
    ["/nearfamily", 0.7, "monthly"],
    ["/nearlegacy", 0.7, "monthly"],
    ["/pricing", 0.8, "monthly"],
    ["/safety", 0.8, "monthly"],
    ["/privacy", 0.3, "yearly"],
    ["/terms", 0.3, "yearly"],
  ].map(([path, priority, changeFrequency]) => ({ url: `${base}${path}`, lastModified: new Date(), changeFrequency, priority })) as MetadataRoute.Sitemap;
}
