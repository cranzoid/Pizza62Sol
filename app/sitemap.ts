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
    // Public and worth finding — "pizza gift card hamilton" is a real search,
    // and it peaks in the three weeks nobody can think what to buy anyone.
    // `/gift-cards/balance` and `/gift-cards/return` are deliberately absent:
    // both are `noindex`, and neither has anything for a crawler to do.
    { url: `${base}/gift-cards`, changeFrequency: "monthly", priority: 0.6 },
    { url: `${base}/privacy`, changeFrequency: "monthly", priority: 0.3 },
    { url: `${base}/terms`, changeFrequency: "monthly", priority: 0.3 },
    { url: `${base}/accessibility`, changeFrequency: "monthly", priority: 0.3 },
    { url: `${base}/cancellation`, changeFrequency: "monthly", priority: 0.3 },
  ];
}
