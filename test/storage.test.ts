import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";


import type { ConnectorIngestRunRecord } from "../src/connector-history.js";
import type { ConnectorRecord } from "../src/connectors.js";
import type { DataAssetRecord } from "../src/data-catalog.js";
import { createMetadataStore, SqliteMetadataStore, type MetadataStore } from "../src/storage/index.js";

const timestamp = "2026-08-12T12:00:00.000Z";

function connector(overrides: Partial<ConnectorRecord> = {}): ConnectorRecord {
  return {
    id: "connector-one",
    locationKey: "s3://survey/release",
    displayPath: "s3://survey/release",
    name: "Survey connector",
    description: "Contract fixture",
    kind: "s3",
    config: { bucket: "survey", prefix: "release" },
    surveyId: "survey",
    releaseId: "release",
    status: "ready",
    createdAt: timestamp,
    updatedAt: timestamp,
    origin: "user",
    ...overrides,
  };
}

function asset(overrides: Partial<DataAssetRecord> = {}): DataAssetRecord {
  return {
    id: "asset-one",
    name: "Catalog",
    description: "Contract fixture",
    surveyId: "survey",
    product: "Sources",
    kind: "catalog",
    modalities: ["photometry"],
    access: { connector: "s3", uri: "s3://survey/release/catalog.fits", format: "fits", connectorId: "connector-one" },
    status: "ready",
    projectState: "acquired",
    footprintIds: [],
    origin: "user",
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function ingestRun(overrides: Partial<ConnectorIngestRunRecord> = {}): ConnectorIngestRunRecord {
  return {
    id: "ingest-one",
    locationKey: "s3://survey/release",
    status: "succeeded",
    startedAt: timestamp,
    completedAt: timestamp,
    fileCount: 3,
    createdAt: timestamp,
    ...overrides,
  };
}

async function metadataStoreContract(store: MetadataStore): Promise<void> {
  await store.initialize();

  const originalConnector = connector();
  await store.putConnector(originalConnector);
  assert.deepEqual(await store.getConnector(originalConnector.id), originalConnector);
  assert.deepEqual(await store.getConnectorByLocationKey(originalConnector.locationKey), originalConnector);
  await store.putConnector(connector({ name: "Updated connector" }));
  assert.equal((await store.listConnectors())[0]?.name, "Updated connector");

  const userAsset = asset();
  const overrideAsset = asset({ id: "builtin-override", origin: "override", name: "Overridden catalog" });
  await store.putDataAsset(userAsset);
  await store.putDataAsset(overrideAsset);
  assert.deepEqual(await store.getDataAsset(userAsset.id), userAsset);
  assert.deepEqual((await store.listDataAssets()).map((record) => record.origin).sort(), ["override", "user"]);
  await assert.rejects(() => store.putDataAsset(asset({ id: "builtin", origin: "builtin" })), /Only user and override/);

  const olderRun = ingestRun({ id: "ingest-old", createdAt: "2026-08-11T12:00:00.000Z" });
  const latestRun = ingestRun();
  await store.putConnectorIngestRun(olderRun);
  await store.putConnectorIngestRun(latestRun);
  assert.deepEqual(await store.getConnectorIngestRun(latestRun.id), latestRun);
  assert.deepEqual((await store.listConnectorIngestRuns(latestRun.locationKey)).map((record) => record.id), [latestRun.id, olderRun.id]);
  assert.deepEqual(await store.listConnectorIngestRuns("s3://unrelated"), []);

  const scopedRuns = [
    ingestRun({ id: "quality-parent", assetId: "w2", fitsQualityProfile: "csst-wcs-v1" }),
    ingestRun({ id: "quality-child", assetId: "w2", parentRunId: "quality-parent", fitsQualityProfile: "csst-wcs-v1" }),
    ingestRun({ id: "quality-multi", assetIds: ["w2", "w3"], fitsQualityProfile: "csst-wcs-v1" }),
    ingestRun({ id: "unrelated-quality", assetId: "w1", fitsQualityProfile: "csst-wcs-v1" }),
  ];
  for (const run of scopedRuns) await store.putConnectorIngestRun(run);
  assert.deepEqual((await store.listConnectorIngestRuns({ assetIds: ["w2"], qualityOnly: true })).map(run => run.id).sort(), ["quality-multi", "quality-parent"]);
  assert.deepEqual((await store.listConnectorIngestRuns({ assetIds: ["w3"] })).map(run => run.id), ["quality-multi"]);
  assert.deepEqual(await store.listConnectorIngestRuns({ assetIds: [] }), []);
  for (const run of scopedRuns) await store.deleteConnectorIngestRun(run.id);

  await store.transaction(async (transaction) => {
    await transaction.setImportMarker("legacy-json-v1", "complete");
    await transaction.putConnector(connector({ id: "connector-two", locationKey: "local:///data", kind: "local", config: { rootPath: "/data" } }));
  });
  assert.equal(await store.getImportMarker("legacy-json-v1"), "complete");
  assert.equal((await store.listConnectors()).length, 2);

  await assert.rejects(() => store.transaction(async (transaction) => {
    await transaction.putConnector(connector({ id: "rolled-back", locationKey: "local:///rollback", kind: "local", config: { rootPath: "/rollback" } }));
    throw new Error("rollback requested");
  }), /rollback requested/);
  assert.equal(await store.getConnector("rolled-back"), undefined);

  assert.equal(await store.deleteConnectorIngestRun(olderRun.id), true);
  assert.equal(await store.deleteConnectorIngestRun(olderRun.id), false);
  assert.equal(await store.deleteDataAsset(overrideAsset.id), true);
  assert.equal(await store.deleteConnector("connector-two"), true);
}

test("SQLite metadata store satisfies the storage contract and persists one DELETE-journal file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-metadata-sqlite-"));
  const filename = path.join(directory, "workspace.sqlite");
  const store = new SqliteMetadataStore(filename);
  try {
    await metadataStoreContract(store);
    await store.close();

    const database = new DatabaseSync(filename);
    assert.equal(database.prepare("PRAGMA journal_mode").get()?.journal_mode, "delete");
    assert.deepEqual(database.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((row) => row.version), [1, 2, 3, 4]);
    database.close();

    const reopened = new SqliteMetadataStore(filename);
    await reopened.initialize();
    assert.equal((await reopened.getConnector("connector-one"))?.name, "Updated connector");
    assert.equal(await reopened.getImportMarker("legacy-json-v1"), "complete");
    await reopened.close();
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("SQLite yields while waiting for another writer and invokes the transaction only once", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-sqlite-contention-"));
  const filename = path.join(directory, "workspace.sqlite");
  const store = new SqliteMetadataStore(filename);
  await store.initialize();
  const writer = new DatabaseSync(filename);
  let release: ReturnType<typeof setTimeout> | undefined;
  try {
    writer.exec("BEGIN IMMEDIATE");
    release = setTimeout(() => { writer.exec("ROLLBACK"); release = undefined; }, 150);
    let calls = 0;
    await store.transaction(async tx => { calls++; await tx.putConnector(connector()); });
    assert.equal(calls, 1, "lock recovery must not replay callbacks with side effects");
    assert.equal((await store.getConnector("connector-one"))?.name, "Survey connector");
    writer.exec("BEGIN EXCLUSIVE");
    release = setTimeout(() => { writer.exec("ROLLBACK"); release = undefined; }, 150);
    assert.equal((await store.listConnectors()).length, 1, "metadata reads must also wait for a short commit lock");
  } finally {
    if (release) { clearTimeout(release); writer.exec("ROLLBACK"); }
    writer.close(); await store.close(); await rm(directory, { recursive: true, force: true });
  }
});

test("SQLite v2 migration retains legacy connector ingest runs", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-metadata-sqlite-v1-"));
  const filename = path.join(directory, "workspace.sqlite");
  const legacy = ingestRun({ id: "legacy-ingest", locationKey: "local:///legacy", sourcePath: "/legacy" });
  try {
    const database = new DatabaseSync(filename);
    database.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT;
      CREATE TABLE import_markers (name TEXT PRIMARY KEY, value TEXT NOT NULL, imported_at TEXT NOT NULL) STRICT;
      CREATE TABLE connectors (
        id TEXT PRIMARY KEY, location_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL CHECK (kind IN ('s3', 'local', 'jdbc')),
        status TEXT NOT NULL CHECK (status IN ('draft', 'ready', 'disabled')), updated_at TEXT NOT NULL,
        record TEXT NOT NULL CHECK (json_valid(record)), CHECK (json_extract(record, '$.id') = id),
        CHECK (json_extract(record, '$.locationKey') = location_key)
      ) STRICT;
      CREATE TABLE data_assets (
        id TEXT PRIMARY KEY, origin TEXT NOT NULL CHECK (origin IN ('user', 'override')), survey_id TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('catalog', 'image', 'spectra', 'cube', 'timeseries', 'other')),
        status TEXT NOT NULL CHECK (status IN ('ready', 'metadata_only', 'unavailable')), updated_at TEXT NOT NULL,
        record TEXT NOT NULL CHECK (json_valid(record)), CHECK (json_extract(record, '$.id') = id),
        CHECK (json_extract(record, '$.origin') = origin)
      ) STRICT;
      CREATE TABLE connector_ingest_runs (
        id TEXT PRIMARY KEY, location_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')), created_at TEXT NOT NULL,
        record TEXT NOT NULL CHECK (json_valid(record)), CHECK (json_extract(record, '$.id') = id),
        CHECK (json_extract(record, '$.locationKey') = location_key)
      ) STRICT;`);
    database.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)").run(timestamp);
    database.prepare("INSERT INTO connector_ingest_runs (id, location_key, status, created_at, record) VALUES (?, ?, ?, ?, ?)")
      .run(legacy.id, legacy.locationKey, legacy.status, legacy.createdAt, JSON.stringify(legacy));
    database.close();

    const store = new SqliteMetadataStore(filename);
    await store.initialize();
    assert.deepEqual(await store.getConnectorIngestRun(legacy.id), legacy);
    const migrated = new DatabaseSync(filename);
    assert.deepEqual(migrated.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((row) => row.version), [1, 2, 3, 4]);
    migrated.close();
    await store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("metadata store uses the configured local SQLite path", () => {
  assert.equal(createMetadataStore({ ASTRO_STATE_ROOT: "/tmp/workspace" }).filename, "/tmp/workspace/workspace.sqlite");
  assert.equal(createMetadataStore({ ASTRO_SQLITE_PATH: "/tmp/custom.sqlite" }).filename, "/tmp/custom.sqlite");
});
