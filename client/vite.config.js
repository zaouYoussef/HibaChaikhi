import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg"],
      manifest: {
        name: "Caravane médicale",
        short_name: "Caravane",
        description: "Gestion stock et délivrance — caravane médicale",
        theme_color: "#0f766e",
        background_color: "#f0fdfa",
        display: "standalone",
        start_url: "/",
        icons: [
          {
            src: "/favicon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,ico,svg,png}"],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      "/auth": "http://localhost:4000",
      "/medicaments": "http://localhost:4000",
      "/search": "http://localhost:4000",
      "/suggest": "http://localhost:4000",
      "/autocomplete": "http://localhost:4000",
      "/scan": "http://localhost:4000",
      "/alerts": "http://localhost:4000",
      "/equivalents": "http://localhost:4000",
      "/dashboard": "http://localhost:4000",
      "/history": "http://localhost:4000",
      "/health": "http://localhost:4000",
    },
  },
});
