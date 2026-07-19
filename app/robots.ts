import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: "/", disallow: ["/admin", "/kitchen", "/employee", "/track", "/feedback", "/api/"] },
    ],
    sitemap: "https://pizza62.ca/sitemap.xml",
  };
}
