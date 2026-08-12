import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ConnectorCredentialStore } from "../src/connector-credentials.js";
import { ConnectorIngestRunCatalog } from "../src/connector-history.js";
import type { ConnectorRegistry } from "../src/connectors.js";
import type { DataCatalogRegistry } from "../src/data-catalog.js";
import { DataWarehouseDisabledError, dataWarehouseEnabled, FlinkScanService, type FlinkResourceClient } from "../src/flink-ingest.js";
import { SqliteMetadataStore } from "../src/storage/index.js";

test("external Flink polling failures preserve the stored scan state", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-flink-poll-"));
  try {
    const store = new SqliteMetadataStore(path.join(directory, "workspace.sqlite"));
    await store.initialize();
    const runs = new ConnectorIngestRunCatalog(store);
    await runs.initialize();
    const run = await runs.add("s3://example/catalogs", { status: "running", jobId: "external-flink-task" });
    const resourceClient: FlinkResourceClient = {
      async request() {
        return { status: 503, ok: false, text: "warehouse unavailable" };
      },
    };
    const service = new FlinkScanService({
      enabled: true,
      connectors: {} as ConnectorRegistry,
      dataCatalog: {} as DataCatalogRegistry,
      credentials: {} as ConnectorCredentialStore,
      runs,
      namespace: "warehouse",
      secretNamespace: "warehouse",
      esUrl: "",
      esIndex: "astro_file_index_v1",
      pollMs: 1000,
      resourceClient,
    });

    await service.poll();

    const stored = (await runs.list()).find((candidate) => candidate.id === run.id);
    assert.equal(stored?.status, "running");
    assert.equal(stored?.completedAt, undefined);
    assert.equal(stored?.error, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("data warehouse configuration accepts only strict booleans and defaults off", () => {
  assert.equal(dataWarehouseEnabled(undefined), false);
  assert.equal(dataWarehouseEnabled("false"), false);
  assert.equal(dataWarehouseEnabled("true"), true);
  assert.throws(() => dataWarehouseEnabled("TRUE"), /must be true or false/);
  assert.throws(() => dataWarehouseEnabled("1"), /must be true or false/);
});

test("disabled warehouse neither polls nor submits scans", async () => {
  let requests = 0;
  const service = new FlinkScanService({
    enabled: false,
    connectors: {} as ConnectorRegistry,
    dataCatalog: {} as DataCatalogRegistry,
    credentials: {} as ConnectorCredentialStore,
    runs: { list: async () => { throw new Error("run catalog should not be read"); } } as unknown as ConnectorIngestRunCatalog,
    namespace: "warehouse",
    secretNamespace: "warehouse",
    esUrl: "http://warehouse-elasticsearch:9200",
    esIndex: "astro_file_index_v1",
    pollMs: 1000,
    resourceClient: { async request() { requests += 1; return { status: 200, ok: true, text: "" }; } },
  });

  service.start();
  await service.poll();
  await assert.rejects(service.submitScan("connector", { assetId: "asset" }), DataWarehouseDisabledError);
  await assert.rejects(service.submitPilot("connector"), DataWarehouseDisabledError);
  service.stop();
  assert.equal(requests, 0);
});
