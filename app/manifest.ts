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
    icons: [{ src: "/og.png", sizes: "1536x1024", type: "image/png", purpose: "any" }],
  };
}
