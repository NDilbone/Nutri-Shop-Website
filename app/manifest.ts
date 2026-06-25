import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Nutri-Shop",
    short_name: "Nutri-Shop",
    description: "Private nutrition tracker & shopping list",
    start_url: "/today",
    scope: "/",
    display: "standalone",
    display_override: ["standalone"],
    background_color: "#0f1411",
    theme_color: "#0f1411",
    orientation: "portrait",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
