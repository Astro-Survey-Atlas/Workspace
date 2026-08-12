import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ConnectorRegistry } from "../src/connectors.js";
import { SqliteMetadataStore, importJsonState, JSON_STATE_IMPORT_MARKER } from "../src/storage/index.js";

const timestamp = "2026-08-12T12:00:00.000Z";

async function paths(directory: string) {
  const value = {
    connectorStatePath: path.join(directory, "connectors.json"),
    dataCatalogStatePath: path.join(directory, "data-catalog.json"),
    connectorRunStatePath: path.join(directory, "connector-runs.json"),
  };
  await writeFile(value.connectorStatePath, JSON.stringify([{
    id: "connector-imported", name: "Imported", kind: "local", config: { rootPath: "/catalogs" },
    status: "ready", createdAt: timestamp, updatedAt: timestamp,
  }]), "utf8");
  await writeFile(value.dataCatalogStatePath, JSON.stringify([{
    id: "user-imported", name: "Imported asset", description: "Legacy state", product: "Catalog", kind: "catalog",
    modalities: ["photometry"], access: { connector: "local", uri: "/catalogs/data.fits", format: "fits" },
    status: "ready", projectState: "acquired", footprintIds: [], origin: "user", createdAt: timestamp, updatedAt: timestamp,
  }, {
    id: "builtin-ignored", name: "Old builtin", description: "Must not persist", product: "Catalog", kind: "catalog",
    modalities: [], access: { connector: "metadata", uri: "asset://builtin", format: "metadata" },
    status: "metadata_only", projectState: "public_reference", footprintIds: [], origin: "builtin", createdAt: timestamp, updatedAt: timestamp,
  }]), "utf8");
  await writeFile(value.connectorRunStatePath, JSON.stringify([{
    id: "run-imported", locationKey: "local:///catalogs", status: "succeeded", startedAt: timestamp, createdAt: timestamp,
  }]), "utf8");
  return value;
}

test("JSON state imports all domains transactionally and is idempotent", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-json-import-"));
  const store = new SqliteMetadataStore(path.join(directory, "workspace.sqlite"));
  try {
    const statePaths = await paths(directory);
    await store.initialize();
    await importJsonState(store, statePaths);
    assert.equal((await store.listConnectors())[0]?.id, "connector-imported");
    assert.deepEqual((await store.listDataAssets()).map((record) => record.id), ["user-imported"]);
    assert.equal((await store.listConnectorIngestRuns())[0]?.id, "run-imported");
    assert.ok(await store.getImportMarker(JSON_STATE_IMPORT_MARKER));

    await writeFile(statePaths.connectorStatePath, "[]", "utf8");
    await importJsonState(store, statePaths);
    assert.equal((await store.listConnectors())[0]?.id, "connector-imported");

    await store.close();
    const reopened = new SqliteMetadataStore(path.join(directory, "workspace.sqlite"));
    await reopened.initialize();
    await importJsonState(reopened, statePaths);
    assert.equal((await reopened.listConnectors())[0]?.id, "connector-imported");
    await reopened.close();
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an imported empty connector file suppresses connector bootstrap", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-json-empty-"));
  const store = new SqliteMetadataStore(path.join(directory, "workspace.sqlite"));
  try {
    const statePaths = await paths(directory);
    await writeFile(statePaths.connectorStatePath, "[]", "utf8");
    const bootstrapPath = path.join(directory, "bootstrap.json");
    await writeFile(bootstrapPath, JSON.stringify([{
      id: "connector-bootstrap", name: "Bootstrap", kind: "local", config: { rootPath: "/bootstrap" },
      status: "ready", createdAt: timestamp, updatedAt: timestamp,
    }]), "utf8");
    await store.initialize();
    await importJsonState(store, statePaths);
    const registry = new ConnectorRegistry(store, bootstrapPath);
    await registry.initialize();
    assert.deepEqual(await registry.list(), []);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("JSON migration refuses mixed database state without a marker", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-json-mixed-"));
  const store = new SqliteMetadataStore(path.join(directory, "workspace.sqlite"));
  try {
    const statePaths = await paths(directory);
    await store.initialize();
    await store.putConnector({
      id: "connector-existing", locationKey: "local:///existing", displayPath: "/existing", name: "Existing",
      description: "Existing database row", kind: "local", config: { rootPath: "/existing" }, status: "ready",
      createdAt: timestamp, updatedAt: timestamp, origin: "user",
    });
    await assert.rejects(() => importJsonState(store, statePaths), /refusing mixed state/);
    assert.equal(await store.getImportMarker(JSON_STATE_IMPORT_MARKER), undefined);
    assert.equal((await store.listConnectors()).length, 1);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("malformed or invalid JSON fails without partially importing any domain", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-json-invalid-"));
  const store = new SqliteMetadataStore(path.join(directory, "workspace.sqlite"));
  try {
    const statePaths = await paths(directory);
    await writeFile(statePaths.connectorRunStatePath, "{broken", "utf8");
    await store.initialize();
    await assert.rejects(() => importJsonState(store, statePaths), /malformed JSON/);
    assert.deepEqual(await store.listConnectors(), []);
    assert.deepEqual(await store.listDataAssets(), []);
    assert.equal(await store.getImportMarker(JSON_STATE_IMPORT_MARKER), undefined);

    await writeFile(statePaths.connectorRunStatePath, JSON.stringify([{ id: "bad-run", locationKey: "x", status: "unknown", startedAt: timestamp, createdAt: timestamp }]), "utf8");
    await assert.rejects(() => importJsonState(store, statePaths), /invalid record/);
    assert.deepEqual(await store.listConnectors(), []);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
