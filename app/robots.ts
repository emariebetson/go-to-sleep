import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: ["/", "/pricing", "/safety", "/privacy", "/terms"], disallow: ["/studio", "/library", "/account", "/admin", "/api/"] },
    sitemap: "https://nearnight.app/sitemap.xml",
  };
}
