import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  let base = "https://pizza62.ca";
  try {
    if (process.env.PUBLIC_BASE_URL) base = new URL(process.env.PUBLIC_BASE_URL).origin;
  } catch {
    // Keep the production default when local configuration is malformed.
  }
  return [
    { url: base, changeFrequency: "daily", priority: 1 },
    { url: `${base}/privacy`, changeFrequency: "monthly", priority: 0.3 },
    { url: `${base}/terms`, changeFrequency: "monthly", priority: 0.3 },
    { url: `${base}/accessibility`, changeFrequency: "monthly", priority: 0.3 },
    { url: `${base}/cancellation`, changeFrequency: "monthly", priority: 0.3 },
  ];
}
