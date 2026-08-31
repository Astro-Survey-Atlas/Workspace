import { defineConfig } from "vite";

const apiTarget = process.env.ASTRO_API_URL ?? "http://127.0.0.1:3000";

export default defineConfig({
  root: "viewer",
  build: {
    outDir: "../dist/viewer",
    emptyOutDir: true,
  },
  // Keep API proxying explicit for both `vite` and `vite preview`. Preview
  // is commonly used on port 4173 while the API runs in k3s on another host.
  server: {
    host: "0.0.0.0",
    proxy: {
      "/api": apiTarget,
    },
  },
  preview: {
    host: "0.0.0.0",
    proxy: {
      "/api": apiTarget,
    },
  },
});
