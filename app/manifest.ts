import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Pizza 62",
    short_name: "Pizza 62",
    description: "Hamilton pizza ordering and restaurant operations.",
    start_url: "/",
    display: "standalone",
    background_color: "#fffaf0",
    theme_color: "#d33b27",
    orientation: "any",
    categories: ["food", "shopping", "business"],
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
