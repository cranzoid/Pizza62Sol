import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = "https://pizza62.ca";
  return [
    { url: base, changeFrequency: "daily", priority: 1 },
    { url: `${base}/privacy`, changeFrequency: "monthly", priority: 0.3 },
    { url: `${base}/terms`, changeFrequency: "monthly", priority: 0.3 },
    { url: `${base}/accessibility`, changeFrequency: "monthly", priority: 0.3 },
    { url: `${base}/cancellation`, changeFrequency: "monthly", priority: 0.3 },
  ];
}
