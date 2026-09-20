import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { calculateSkyOverlap } from "../src/sky-overlap.js";
import { ResourcePackageManager } from "../src/resource-packages.js";

const liveCatalogUrl = process.env.ASTRO_RESOURCE_CATALOG_URL;

test("live Assets catalog parses, installs current packages and exposes native MOCs (set ASTRO_RESOURCE_CATALOG_URL to enable)", { skip: !liveCatalogUrl }, async () => {
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
    for (const pkg of manager.list()) {
      const job = manager.install(pkg.id);
      const deadline = Date.now() + 60_000;
      while (!["completed", "failed"].includes(manager.job(job.id).status) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      const result = manager.job(job.id);
      assert.equal(result.status, "completed", `${pkg.id}@${pkg.version}: ${result.error ?? result.status}`);
      const layers = await manager.mocLayers(pkg.id);
      assert.ok(layers.length > 0);
      assert.deepEqual([...new Set(layers.map(layer => layer.releaseId))].sort(), [...pkg.releases].sort());
      for (const layer of layers) { assert.match(layer.sha256, /^[a-f0-9]{64}$/); assert.ok(layer.byteLength > 0); }
      await manager.activate(pkg.id);
    }
    const footprints = (await manager.activeFootprints()).footprints;
    assert.ok(footprints.length > 0);
    const selected = footprints.filter(f => ["euclid", "desi"].includes(f.surveyId));
    if (new Set(selected.map(f => f.surveyId)).size === 2) {
      const sources = await Promise.all(selected.map(async f => ({
        id: f.layerId!, label: f.label, kind: "public" as const, surveyId: f.surveyId,
        nside: 256, pixels: await manager.footprintPixels(f, 8),
      })));
      const actual = calculateSkyOverlap(sources, 256);
      const expectedResponse = await fetch(new URL("/api/v1/coverage/overlap", liveCatalogUrl), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ surveyIds: ["euclid", "desi"], requestedOrder: 8 }),
      });
      assert.equal(expectedResponse.status, 200);
      const expected = await expectedResponse.json() as { pixels: number[]; components: unknown[] };
      assert.deepEqual(actual.pixels, expected.pixels, "installed native MOC overlap must match Assets order 8");
      assert.equal(actual.components.length, expected.components.length);
    }
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 20 });
  }
});
