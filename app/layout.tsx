import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import MarketingConsent from "./MarketingConsent";
import WebAppRegistration from "./WebAppRegistration";
import "./globals.css";

/**
 * Title, description and social image come from the owner's website editor when
 * they have been set. The database is not guaranteed to be reachable while
 * metadata renders, so a failure falls back to the built-in wording rather than
 * failing the page.
 */
async function siteContent(): Promise<Record<string, unknown>> {
  try {
    const { getSetting } = await import("@/db/runtime");
    return await getSetting<Record<string, unknown>>("content");
  } catch {
    return {};
  }
}

export async function generateMetadata(): Promise<Metadata> {
  const content = await siteContent();
  const requestHeaders = await headers();
  const candidateHost = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "pizza62.ca";
  const host = /^[a-z0-9.-]+(?::\d+)?$/i.test(candidateHost) ? candidateHost : "pizza62.ca";
  const protocol = requestHeaders.get("x-forwarded-proto") === "http" || host.startsWith("localhost:") ? "http" : "https";
  let origin = `${protocol}://${host}`;
  try {
    if (process.env.PUBLIC_BASE_URL) origin = new URL(process.env.PUBLIC_BASE_URL).origin;
  } catch {
    // A malformed deployment value must not make every page fail to render.
  }
  const socialImage = `${origin}/og.png`;
  const title = String(content.seoTitle ?? "").trim() || "Pizza 62 | Pizza Delivery & Pickup in Hamilton";
  const description = String(content.seoDescription ?? "").trim()
    || "Order fresh pizza, wings and local deals for pickup or delivery directly from Pizza 62 in Hamilton, Ontario.";
  const indexable = process.env.SEO_INDEXABLE === "true";
  return {
    metadataBase: new URL(origin),
    title: { default: title, template: "%s | Pizza 62" },
    description,
    keywords: ["Pizza 62", "pizza Hamilton", "pizza delivery Hamilton", "pizza pickup Hamilton", "wings Hamilton"],
    category: "restaurant",
    applicationName: "Pizza 62",
    manifest: "/manifest.webmanifest",
    icons: {
      icon: [
        { url: "/favicon.ico", sizes: "16x16 32x32 48x48" },
        { url: "/icon-192.png", type: "image/png", sizes: "192x192" },
        { url: "/icon-512.png", type: "image/png", sizes: "512x512" },
      ],
      shortcut: "/favicon.ico",
      apple: "/apple-touch-icon.png",
    },
    openGraph: {
      type: "website",
      locale: "en_CA",
      siteName: "Pizza 62",
      title,
      description,
      images: [{ url: socialImage, width: 1731, height: 909, alt: "Pizza 62 — Hamilton pickup and delivery" }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [socialImage],
    },
    robots: indexable
      ? {
          index: true,
          follow: true,
          googleBot: { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1, "max-video-preview": -1 },
        }
      : { index: false, follow: false, noarchive: true, nosnippet: true },
    verification: process.env.GOOGLE_SITE_VERIFICATION
      ? { google: process.env.GOOGLE_SITE_VERIFICATION }
      : undefined,
    appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Pizza 62" },
    formatDetection: { telephone: false },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#d33b27" },
    { media: "(prefers-color-scheme: dark)", color: "#173b2c" },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html
    lang="en-CA"
    data-meta-pixel-id={process.env.META_PIXEL_ID || undefined}
    data-ga4-id={process.env.GA4_MEASUREMENT_ID || undefined}
    data-google-ads-id={process.env.GOOGLE_ADS_ID || undefined}
    data-google-ads-label={process.env.GOOGLE_ADS_CONVERSION_LABEL || undefined}
  ><body>{children}<MarketingConsent /><WebAppRegistration /></body></html>;
}
