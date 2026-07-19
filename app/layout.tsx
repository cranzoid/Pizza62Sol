import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import WebAppRegistration from "./WebAppRegistration";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const candidateHost = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "pizza62.ca";
  const host = /^[a-z0-9.-]+(?::\d+)?$/i.test(candidateHost) ? candidateHost : "pizza62.ca";
  const protocol = requestHeaders.get("x-forwarded-proto") === "http" || host.startsWith("localhost:") ? "http" : "https";
  const origin = `${protocol}://${host}`;
  const socialImage = `${origin}/og.png`;
  return {
    metadataBase: new URL(origin),
    title: { default: "Pizza 62 | Hamilton, Ontario", template: "%s | Pizza 62" },
    description: "Order fresh pizza, wings and local deals directly from Pizza 62 in Hamilton, Ontario.",
    applicationName: "Pizza 62",
    manifest: "/manifest.webmanifest",
    icons: { icon: "/og.png", shortcut: "/og.png", apple: "/og.png" },
    openGraph: {
      type: "website",
      locale: "en_CA",
      siteName: "Pizza 62",
      title: "Pizza 62 | Hamilton pickup & delivery",
      description: "Fresh pizza, wings and local deals in Hamilton, Ontario.",
      images: [{ url: socialImage, width: 1731, height: 909, alt: "Pizza 62 — Hamilton pickup and delivery" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Pizza 62 | Hamilton pickup & delivery",
      description: "Fresh pizza, wings and local deals in Hamilton, Ontario.",
      images: [socialImage],
    },
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
