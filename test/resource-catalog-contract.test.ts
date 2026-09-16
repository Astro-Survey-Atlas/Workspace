import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ResourcePackageManager } from "../src/resource-packages.js";

const liveCatalogUrl = process.env.ASTRO_RESOURCE_CATALOG_URL;

test("live Assets catalog parses and stays available (set ASTRO_RESOURCE_CATALOG_URL to enable)", { skip: !liveCatalogUrl }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-catalog-contract-"));
  try {
    const manager = new ResourcePackageManager({
      catalogUrl: liveCatalogUrl!,
      root: path.join(directory, "resource-packages"),
      statePath: path.join(directory, "state", "resource-package-state.json"),
    });
    await manager.initialize();
    const status = manager.catalogStatus();
    assert.equal(status.available, true, status.unavailableReason ?? "catalog unavailable");
    assert.ok(manager.list().length > 0, "live catalog must expose at least one package");
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 20 });
  }
});
