import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ConnectorCredentialStore } from "../src/connector-credentials.js";
import { ConnectorIngestRunCatalog } from "../src/connector-history.js";
import type { ConnectorRegistry } from "../src/connectors.js";
import type { DataCatalogRegistry } from "../src/data-catalog.js";
import { FlinkScanService, type FlinkResourceClient } from "../src/flink-ingest.js";

test("external Flink polling failures preserve the stored scan state", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-flink-poll-"));
  try {
    const runs = new ConnectorIngestRunCatalog(path.join(directory, "runs.json"));
    await runs.initialize();
    const run = await runs.add("s3://example/catalogs", { status: "running", jobId: "external-flink-task" });
    const resourceClient: FlinkResourceClient = {
      async request() {
        return { status: 503, ok: false, text: "warehouse unavailable" };
      },
    };
    const service = new FlinkScanService({
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

    const stored = runs.list().find((candidate) => candidate.id === run.id);
    assert.equal(stored?.status, "running");
    assert.equal(stored?.completedAt, undefined);
    assert.equal(stored?.error, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
