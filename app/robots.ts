import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  const indexable = process.env.SEO_INDEXABLE === "true";
  if (!indexable) {
    return { rules: [{ userAgent: "*", disallow: "/" }] };
  }
  return {
    rules: [
      { userAgent: "*", allow: "/", disallow: ["/admin", "/kitchen", "/employee", "/track", "/feedback", "/api/"] },
    ],
    sitemap: "https://pizza62.ca/sitemap.xml",
  };
}
