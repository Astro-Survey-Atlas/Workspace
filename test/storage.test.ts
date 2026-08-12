import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { Pool } from "pg";

import type { ConnectorIngestRun } from "../src/connector-history.js";
import type { ConnectorRecord } from "../src/connectors.js";
import type { DataAssetRecord } from "../src/data-catalog.js";
import { createMetadataStore, PostgresMetadataStore, SqliteMetadataStore, type MetadataStore } from "../src/storage/index.js";

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

function ingestRun(overrides: Partial<ConnectorIngestRun> = {}): ConnectorIngestRun {
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
    assert.deepEqual(database.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((row) => row.version), [1]);
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

test("metadata store factory defaults to SQLite and validates backend configuration", () => {
  const defaultStore = createMetadataStore({});
  assert.ok(defaultStore instanceof SqliteMetadataStore);
  assert.equal(defaultStore.filename, "/state/workspace.sqlite");
  assert.throws(() => createMetadataStore({ ASTRO_METADATA_STORE: "postgres" }), /ASTRO_DATABASE_URL is required/);
  assert.throws(() => createMetadataStore({ ASTRO_METADATA_STORE: "unknown" }), /Unsupported ASTRO_METADATA_STORE/);
  assert.throws(() => new PostgresMetadataStore("postgresql://example.invalid/db", "invalid-schema"), /valid unqualified identifier/);
});

const postgresUrl = process.env.ASTRO_TEST_DATABASE_URL;
test("PostgreSQL metadata store satisfies the storage contract", { skip: postgresUrl ? false : "ASTRO_TEST_DATABASE_URL is not set" }, async () => {
  const schema = `astro_workspace_test_${process.pid}_${Date.now()}`;
  const store = new PostgresMetadataStore(postgresUrl!, schema);
  try {
    await metadataStoreContract(store);
  } finally {
    await store.close();
    const cleanup = new Pool({ connectionString: postgresUrl });
    try {
      await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await cleanup.end();
    }
  }
});
