import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  const indexable = process.env.SEO_INDEXABLE === "true";
  if (!indexable) {
    return { rules: [{ userAgent: "*", disallow: "/" }] };
  }
  return {
    rules: [
      { userAgent: "*", allow: "/", disallow: ["/admin", "/kitchen", "/employee", "/kiosk", "/track", "/feedback", "/order/", "/api/"] },
    ],
    sitemap: `${safeBaseUrl()}/sitemap.xml`,
    host: safeBaseUrl(),
  };
}

function safeBaseUrl(): string {
  try {
    return new URL(process.env.PUBLIC_BASE_URL || "https://pizza62.ca").origin;
  } catch {
    return "https://pizza62.ca";
  }
}
