import type { Metadata, Viewport } from "next";
import WebAppRegistration from "./WebAppRegistration";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://pizza62.ca"),
  title: { default: "Pizza 62 | Hamilton, Ontario", template: "%s | Pizza 62" },
  description: "Order fresh pizza, wings and local deals directly from Pizza 62 in Hamilton, Ontario.",
  applicationName: "Pizza 62",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/og.png", shortcut: "/og.png", apple: "/og.png" },
  openGraph: {
    type: "website",
    locale: "en_CA",
    siteName: "Pizza 62",
    title: "Pizza 62 | Big flavour. Zero fuss.",
    description: "Fresh pizza, wings and local deals in Hamilton, Ontario.",
    images: [{ url: "/og.png", width: 1536, height: 1024, alt: "Pizza 62 — Big flavour. Zero fuss." }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Pizza 62 | Big flavour. Zero fuss.",
    description: "Fresh pizza, wings and local deals in Hamilton, Ontario.",
    images: ["/og.png"],
  },
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Pizza 62" },
  formatDetection: { telephone: false },
};

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
