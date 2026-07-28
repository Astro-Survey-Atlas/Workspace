import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DataCatalogRegistry, type DataAssetRecord } from "../src/data-catalog.js";

async function fixture(): Promise<{ directory: string; bootstrapPath: string; statePath: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-data-catalog-"));
  const bootstrapPath = path.join(directory, "bootstrap.json");
  const statePath = path.join(directory, "state", "catalog.json");
  const now = "2026-07-24T00:00:00.000Z";
  const builtin: DataAssetRecord[] = [{
    id: "builtin-catalog",
    name: "Built-in catalog",
    description: "Fixture",
    product: "Sources",
    kind: "catalog",
    modalities: ["catalog"],
    access: { connector: "metadata", uri: "catalog://fixture", format: "table" },
    status: "metadata_only",
    projectState: "public_reference",
    footprintIds: [],
    origin: "builtin",
    createdAt: now,
    updatedAt: now,
  }];
  await writeFile(bootstrapPath, JSON.stringify(builtin), "utf8");
  return { directory, bootstrapPath, statePath };
}

test("data catalog merges read-only bootstrap records with persisted user records", async () => {
  const paths = await fixture();
  try {
    const registry = new DataCatalogRegistry(paths.bootstrapPath, paths.statePath);
    await registry.initialize();
    const created = await registry.register({
      name: "My FITS table",
      description: "A user-maintained source",
      surveyId: "euclid",
      releaseId: "euclid-q1",
      kind: "catalog",
      modalities: ["catalog", "photometry"],
      connector: "local",
      sourceUri: "/mnt/data/euclid/q1.fits",
      format: "fits",
      status: "ready",
      projectState: "acquired",
    });
    assert.equal(registry.list().length, 2);
    assert.equal(created.origin, "user");
    assert.equal(created.projectState, "acquired");

    const reloaded = new DataCatalogRegistry(paths.bootstrapPath, paths.statePath);
    await reloaded.initialize();
    assert.equal(reloaded.get(created.id).access.uri, "/mnt/data/euclid/q1.fits");
    assert.equal((JSON.parse(await readFile(paths.statePath, "utf8")) as DataAssetRecord[]).length, 1);
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("only user records can be updated or removed", async () => {
  const paths = await fixture();
  try {
    const registry = new DataCatalogRegistry(paths.bootstrapPath, paths.statePath);
    await registry.initialize();
    await assert.rejects(() => registry.remove("builtin-catalog"), /read-only/);
    const created = await registry.register({
      name: "Initial",
      kind: "image",
      connector: "http",
      sourceUri: "https://example.test/image.fits",
      format: "fits",
    });
    const updated = await registry.update(created.id, {
      name: "Updated",
      kind: "image",
      connector: "http",
      sourceUri: "https://example.test/image-v2.fits",
      format: "fits",
      status: "ready",
      projectState: "processed",
    });
    assert.equal(updated.name, "Updated");
    assert.equal(updated.access.uri, "https://example.test/image-v2.fits");
    await registry.remove(created.id);
    assert.deepEqual(registry.list().map((entry) => entry.id), ["builtin-catalog"]);
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("data catalog rejects incomplete connector metadata", async () => {
  const paths = await fixture();
  try {
    const registry = new DataCatalogRegistry(paths.bootstrapPath, paths.statePath);
    await registry.initialize();
    await assert.rejects(() => registry.register({
      name: "Broken",
      kind: "catalog",
      connector: "http",
      sourceUri: "",
      format: "csv",
    }), /sourceUri is required/);
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("ready remote metadata is not inferred to be a processed project asset", async () => {
  const paths = await fixture();
  try {
    const registry = new DataCatalogRegistry(paths.bootstrapPath, paths.statePath);
    await registry.initialize();
    const created = await registry.register({
      name: "Public query metadata",
      kind: "catalog",
      connector: "mcp",
      sourceUri: "catalog+mcp://public-query",
      format: "table",
      status: "ready",
    });
    assert.deepEqual(created.projectStates, ["planned"]);
    assert.equal(created.projectState, "planned");
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("one logical asset can retain public reference and acquired locations", async () => {
  const paths = await fixture();
  try {
    const registry = new DataCatalogRegistry(paths.bootstrapPath, paths.statePath);
    await registry.initialize();
    const created = await registry.register({
      name: "Euclid Q1 local mirror",
      surveyId: "euclid",
      releaseId: "euclid-q1",
      kind: "catalog",
      connector: "mcp",
      sourceUri: "catalog+mcp://euclid-q1",
      format: "table",
      accesses: [
        { connector: "mcp", uri: "catalog+mcp://euclid-q1", format: "table" },
        { connector: "local", uri: "/mnt/data/euclid/q1", format: "fits" },
      ],
      sources: [{ label: "Official Q1", url: "https://example.test/euclid-q1" }],
      status: "ready",
      projectStates: ["public_reference", "acquired"],
    });
    assert.deepEqual(created.projectStates, ["public_reference", "acquired"]);
    assert.equal(created.accesses?.length, 2);
    assert.equal(created.sources?.[0]?.label, "Official Q1");

    const updated = await registry.update("builtin-catalog", {
      name: "Built-in catalog",
      kind: "catalog",
      connector: "metadata",
      sourceUri: "catalog://fixture",
      format: "table",
      accesses: [
        { connector: "metadata", uri: "catalog://fixture", format: "table" },
        { connector: "s3", uri: "s3://bucket/catalog", format: "fits" },
      ],
      projectStates: ["public_reference", "acquired"],
    });
    assert.equal(updated.origin, "builtin");
    assert.deepEqual(registry.get("builtin-catalog").projectStates, ["public_reference", "acquired"]);
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});
