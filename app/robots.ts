import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: ["/", "/nearsleep", "/nearstory", "/nearfamily", "/nearlegacy", "/pricing", "/safety", "/privacy", "/terms"], disallow: ["/studio", "/library", "/stories", "/family", "/legacy", "/account", "/admin", "/api/"] },
    sitemap: "https://nearyoustill.com/sitemap.xml",
  };
}
