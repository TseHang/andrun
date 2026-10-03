import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The SPA lives in web/ and is built to dist/, which the Worker serves as static assets.
// In `pnpm dev:web` the API calls are proxied to `wrangler dev`.
export default defineConfig({
  root: "web",
  plugins: [react(), tailwindcss()],
  build: { outDir: "../dist", emptyOutDir: true },
  server: {
    proxy: {
      "/sessions": { target: "http://localhost:8787", ws: true },
      "/config": "http://localhost:8787",
    },
  },
});
