import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  const indexable = process.env.SEO_INDEXABLE === "true";
  if (!indexable) {
    return { rules: [{ userAgent: "*", disallow: "/" }] };
  }
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        // `/gift-cards` itself is public and in the sitemap; these two are the
        // private half of it — a balance form has nothing to index, and a
        // payment return page carries a session id.
        disallow: [
          "/admin",
          "/kitchen",
          "/employee",
          "/kiosk",
          "/track",
          "/feedback",
          "/order/",
          "/gift-cards/balance",
          "/gift-cards/return",
          "/api/",
        ],
      },
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
