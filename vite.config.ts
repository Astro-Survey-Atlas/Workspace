import { defineConfig } from "vite";

const apiTarget = process.env.ASTRO_API_URL ?? "http://127.0.0.1:3000";

export default defineConfig({
  root: "viewer",
  build: {
    outDir: "../dist/viewer",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": apiTarget,
    },
  },
});
