import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DataCatalogRegistry, normalizeDataAssetRecord, normalizePersistedDataAsset, type DataAssetRecord, type DataAssetRegistrationInput, type DataAssetScanSpec } from "../src/data-catalog.js";
import { SqliteMetadataStore } from "../src/storage/index.js";

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

async function catalogRegistry(bootstrapPath: string, statePath: string): Promise<DataCatalogRegistry> {
  const store = new SqliteMetadataStore(`${statePath}.sqlite`);
  await store.initialize();
  const registry = new DataCatalogRegistry(bootstrapPath, store);
  await registry.initialize();
  return registry;
}

const normalizedScanSpec: DataAssetScanSpec = {
  format: "csv",
  objectIdColumn: "object_id",
  raColumn: "ra_deg",
  decColumn: "dec_deg",
  coordinateFrame: "ICRS",
  coordinateUnits: "deg",
  modality: "photometry",
  product: "source catalog",
};

function registrationWithScanSpec(scanSpec: unknown): DataAssetRegistrationInput {
  return { name: "CSV catalog", kind: "catalog", scanSpec: scanSpec as DataAssetScanSpec };
}

test("data catalog merges read-only bootstrap records with persisted user records", async () => {
  const paths = await fixture();
  try {
    const registry = await catalogRegistry(paths.bootstrapPath, paths.statePath);
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
    assert.equal((await registry.list()).length, 2);
    assert.equal(created.origin, "user");
    assert.equal(created.projectState, "acquired");

    const reloaded = await catalogRegistry(paths.bootstrapPath, paths.statePath);
    assert.equal((await reloaded.get(created.id)).access.uri, "/mnt/data/euclid/q1.fits");
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("only user records can be updated or removed", async () => {
  const paths = await fixture();
  try {
    const registry = await catalogRegistry(paths.bootstrapPath, paths.statePath);
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
    assert.deepEqual((await registry.list()).map((entry) => entry.id), ["builtin-catalog"]);
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("data catalog rejects incomplete connector metadata", async () => {
  const paths = await fixture();
  try {
    const registry = await catalogRegistry(paths.bootstrapPath, paths.statePath);
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

test("CSV scan specs are normalized, retained by updates, and survive restart", async () => {
  const paths = await fixture();
  try {
    const registry = await catalogRegistry(paths.bootstrapPath, paths.statePath);
    const created = await registry.register({
      ...registrationWithScanSpec({
        format: " csv ",
        objectIdColumn: " object_id ",
        raColumn: " ra_deg ",
        decColumn: " dec_deg ",
        coordinateFrame: " ICRS ",
        coordinateUnits: " deg ",
        modality: " photometry ",
        product: " source catalog ",
      }),
    });
    assert.deepEqual(created.scanSpec, normalizedScanSpec);
    assert.deepEqual(normalizeDataAssetRecord(created, "user").scanSpec, normalizedScanSpec);

    const updated = await registry.update(created.id, { name: "Updated CSV catalog", kind: "catalog" });
    assert.deepEqual(updated.scanSpec, normalizedScanSpec);

    const restarted = await catalogRegistry(paths.bootstrapPath, paths.statePath);
    assert.deepEqual((await restarted.get(created.id)).scanSpec, normalizedScanSpec);
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("CSV scan specs reject unknown fields, invalid formats, columns, coordinates, and long text", async () => {
  const paths = await fixture();
  try {
    const registry = await catalogRegistry(paths.bootstrapPath, paths.statePath);
    const valid = { ...normalizedScanSpec };
    await assert.rejects(() => registry.register(registrationWithScanSpec({ ...valid, extra: true })), /unknown field/);
    await assert.rejects(() => registry.register(registrationWithScanSpec({ ...valid, format: "fits" })), /format must be csv/);
    await assert.rejects(() => registry.register(registrationWithScanSpec({ ...valid, objectIdColumn: "" })), /objectIdColumn is required/);
    await assert.rejects(() => registry.register(registrationWithScanSpec({ ...valid, decColumn: "ra_deg" })), /column names must be distinct/);
    await assert.rejects(() => registry.register(registrationWithScanSpec({ ...valid, coordinateFrame: "FK5" })), /coordinateFrame must be ICRS/);
    await assert.rejects(() => registry.register(registrationWithScanSpec({ ...valid, coordinateUnits: "rad" })), /coordinateUnits must be deg/);
    await assert.rejects(() => registry.register(registrationWithScanSpec({ ...valid, raColumn: "r".repeat(513) })), /at most 512/);
    await assert.rejects(() => registry.register(registrationWithScanSpec({ ...valid, product: "p".repeat(161) })), /at most 160/);

    const created = await registry.register({ ...registrationWithScanSpec(valid) });
    await assert.rejects(async () => normalizePersistedDataAsset({ ...created, scanSpec: { ...valid, modality: 42 } }), /modality must be a string/);
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("ready remote metadata is not inferred to be a processed project asset", async () => {
  const paths = await fixture();
  try {
    const registry = await catalogRegistry(paths.bootstrapPath, paths.statePath);
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
    const registry = await catalogRegistry(paths.bootstrapPath, paths.statePath);
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
    assert.deepEqual((await registry.get("builtin-catalog")).projectStates, ["public_reference", "acquired"]);
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});
