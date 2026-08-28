import { defineConfig } from "@playwright/test";

const deployedBaseUrl = process.env.ASTRO_E2E_BASE_URL;
const e2eApiUrl = process.env.ASTRO_E2E_API ?? "http://astro.workspace.dev.72602.space:32080";

export default defineConfig({
  testDir: "./test/e2e",
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: deployedBaseUrl ?? "http://127.0.0.1:4173",
    trace: "retain-on-failure",
  },
  webServer: deployedBaseUrl ? undefined : {
    command: "npx vite preview --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    // Keep late browser requests on the same explicit API target used by the
    // test proxy. This avoids Vite's development default (localhost:3000)
    // when a page is torn down while an informational request is in flight.
    env: { ASTRO_API_URL: e2eApiUrl },
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
