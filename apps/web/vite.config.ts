import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  // Resellers' API lives under /<code>/api, next to the platform's /api.
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3187",
      "^/[a-z0-9][a-z0-9-]{1,18}[a-z0-9]/api(/|$)": "http://localhost:3187",
    },
  },
});
