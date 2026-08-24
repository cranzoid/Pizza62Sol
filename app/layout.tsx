import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
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
  const origin = `${protocol}://${host}`;
  const socialImage = `${origin}/og.png`;
  const title = String(content.seoTitle ?? "").trim() || "Pizza 62 | Hamilton, Ontario";
  const description = String(content.seoDescription ?? "").trim()
    || "Order fresh pizza, wings and local deals directly from Pizza 62 in Hamilton, Ontario.";
  const indexable = process.env.SEO_INDEXABLE === "true";
  return {
    metadataBase: new URL(origin),
    title: { default: title, template: "%s | Pizza 62" },
    description,
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
      ? { index: true, follow: true }
      : { index: false, follow: false, noarchive: true, nosnippet: true },
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
  return <html lang="en-CA"><body>{children}<WebAppRegistration /></body></html>;
}
