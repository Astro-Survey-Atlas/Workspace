import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { ASTRO_FILE_INDEX } from "../src/astro-index.js";

async function waitForHealth(baseUrl: string, process: ChildProcess, logs: () => string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`workspace exited before health check:\n${logs()}`);
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`workspace did not become healthy:\n${logs()}`);
}

test("runtime data services are read-only, sanitized, and the catalog config route is gone", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "asa-runtime-config-"));
  const stateRoot = path.join(directory, "state");
  const catalogPath = path.join(directory, "missing-assets-catalog.json");
  let logs = "";
  let apiProcess: ChildProcess | null = null;
  t.after(async () => {
    apiProcess?.kill("SIGTERM");
    if (apiProcess) await new Promise((resolve) => apiProcess!.once("exit", resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const apiPort = 3_2000 + Math.floor(Math.random() * 10_000);
  const baseUrl = `http://127.0.0.1:${apiPort}`;
  const environment = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(apiPort),
    ASTRO_ALLOWED_HOSTS: "127.0.0.1,localhost",
    ASTRO_DATA_WAREHOUSE_ENABLED: "false",
    ASTRO_LOCAL_SCAN_ENABLED: "false",
    ASTRO_ES_URL: "http://esa:secret-pass@127.0.0.1:9200/ignored?token=hush#frag",
    ASTRO_WAREHOUSE_ES_URL: "http://wh:secret@127.0.0.1:9201",
    ASTRO_METADATA_STORE: "sqlite",
    ASTRO_SQLITE_PATH: path.join(stateRoot, "workspace.sqlite"),
    ASTRO_STATE_ROOT: stateRoot,
    ASTRO_RESOURCE_PACKAGE_ROOT: path.join(stateRoot, "resource-packages"),
    ASTRO_RESOURCE_PACKAGE_STATE: path.join(stateRoot, "resource-package-state.json"),
    ASTRO_RESOURCE_CATALOG_URL: pathToFileURL(catalogPath).href,
    ASTRO_MOC_CORE_CLI: `${path.resolve("node_modules/.bin/tsx")} ${path.resolve("test/helpers/mock-moc-core-cli.ts")}`,
    ASTRO_BUILD_COMMIT: "",
    NODE_NO_WARNINGS: "1",
  };
  apiProcess = spawn(path.resolve("node_modules/.bin/tsx"), ["src/http-server.ts"], {
    cwd: process.cwd(),
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  apiProcess.stdout?.on("data", (chunk) => { logs += String(chunk); });
  apiProcess.stderr?.on("data", (chunk) => { logs += String(chunk); });
  await waitForHealth(baseUrl, apiProcess, () => logs);

  const runtimeResponse = await fetch(`${baseUrl}/api/system-config/runtime`);
  assert.equal(runtimeResponse.status, 200);
  assert.equal(runtimeResponse.headers.get("cache-control"), "no-store");
  const runtime = await runtimeResponse.json() as {
    readOnly: boolean;
    catalog: { endpoint: string; configured: boolean; available: boolean; source: string };
    workspaceSearch: { endpoint: string; configured: boolean; indices: { file: string; object: string; coverage: string }; source: string };
    warehouseSearch: { enabled: boolean; endpoint: string; configured: boolean; indices: { layer: string; file: string; coverage: string } };
    capabilities?: Array<{ kind: string; key: string; version: number; availability: string; responsibility: string; sourcePath: string }>;
    build?: { commit: string | null; sourceUrl: string; permalinkBase: string | null };
    assetsApi?: { endpoint: string; apiKeyConfigured: boolean };
  };
  assert.equal(runtime.readOnly, true);
  assert.equal(runtime.catalog.endpoint, pathToFileURL(catalogPath).href);
  assert.equal(runtime.catalog.configured, true);
  assert.equal(runtime.catalog.source, "environment");
  assert.ok(!("adminConfigured" in runtime.catalog), "admin token state must no longer be surfaced");
  // Credentials, query, and fragment must never leak to the browser.
  assert.equal(runtime.workspaceSearch.endpoint, "http://127.0.0.1:9200/ignored");
  assert.equal(runtime.workspaceSearch.configured, true);
  assert.equal(runtime.workspaceSearch.indices.file, ASTRO_FILE_INDEX);
  assert.equal(runtime.workspaceSearch.indices.object, "astro_object_index_v1");
  assert.equal(runtime.workspaceSearch.indices.coverage, "astro_coverage_index_v1");
  // A stale warehouse endpoint stays hidden while the integration is disabled.
  assert.equal(runtime.warehouseSearch.enabled, false);
  assert.equal(runtime.warehouseSearch.endpoint, "");
  assert.equal(runtime.warehouseSearch.configured, false);
  assert.equal(runtime.warehouseSearch.indices.layer, "ast_layer_index_v1");

  const putResponse = await fetch(`${baseUrl}/api/resource-packages/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ catalogUrl: "https://attacker.example/catalog.json" }),
  });
  assert.ok(putResponse.status === 404 || putResponse.status === 405, `expected the mutable config route to be gone, got ${putResponse.status}`);

  const configResponse = await fetch(`${baseUrl}/api/resource-packages/config`);
  assert.equal(configResponse.status, 200);
  const config = await configResponse.json() as { config: { catalogUrl: string } };
  assert.equal(config.config.catalogUrl, pathToFileURL(catalogPath).href);

  // Sync is a single-user operation: no admin token gate. The unreachable
  // file:// catalog still makes the attempt fail downstream (502/503), never 401.
  const syncResponse = await fetch(`${baseUrl}/api/resource-packages/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.notEqual(syncResponse.status, 401);
  assert.ok(syncResponse.status === 502 || syncResponse.status === 503, `expected sync to attempt the catalog read, got ${syncResponse.status}`);

  // Capability registry: read-only descriptors with warehouse availability reflecting this deployment.
  const overlap = runtime.capabilities?.find((capability) => capability.key === "overlap-download" && capability.kind === "pipeline");
  assert.ok(overlap);
  assert.equal(overlap.availability, "available");
  const warehouseScan = runtime.capabilities?.find((capability) => capability.key === "warehouse-scan");
  assert.ok(warehouseScan);
  assert.equal(warehouseScan.availability, "unavailable");
  const desiTile = runtime.capabilities?.find((capability) => capability.key === "desi-tile");
  assert.ok(desiTile);
  assert.equal(desiTile.kind, "resolver");
  assert.equal(desiTile.availability, "available");
  assert.ok(runtime.capabilities?.every((capability) => capability.responsibility && capability.sourcePath));

  // Build provenance: this test server has no baked commit, so permalinks stay null.
  assert.equal(runtime.build?.commit, null);
  assert.equal(runtime.build?.sourceUrl, "https://github.com/Astro-Survey-Atlas/Workspace");
  assert.equal(runtime.build?.permalinkBase, null);

  // Assets API key round-trip: stored server-side, never echoed into runtime output.
  assert.equal(runtime.assetsApi?.endpoint, pathToFileURL(catalogPath).href);
  assert.equal(runtime.assetsApi?.apiKeyConfigured, false);
  const keyResponse = await fetch(`${baseUrl}/api/system-config/assets`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: "assets-secret-1" }),
  });
  assert.equal(keyResponse.status, 200);
  assert.deepEqual(await keyResponse.json(), { assets: { apiKeyConfigured: true } });
  const runtimeAfterSet = await fetch(`${baseUrl}/api/system-config/runtime`);
  const runtimeAfterText = await runtimeAfterSet.text();
  assert.doesNotMatch(runtimeAfterText, /assets-secret-1/);
  assert.equal((JSON.parse(runtimeAfterText) as { assetsApi: { apiKeyConfigured: boolean } }).assetsApi.apiKeyConfigured, true);
  const clearResponse = await fetch(`${baseUrl}/api/system-config/assets`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: null }),
  });
  assert.equal(clearResponse.status, 200);
  assert.deepEqual(await clearResponse.json(), { assets: { apiKeyConfigured: false } });
});
