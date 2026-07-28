import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ConnectorIngestRunCatalog } from "../src/connector-history.js";

test("connector ingest history is keyed by the normalized location", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-connector-runs-"));
  try {
    const statePath = path.join(directory, "runs.json");
    const catalog = new ConnectorIngestRunCatalog(statePath);
    await catalog.initialize();
    const run = await catalog.add("s3://euclid/q1", { status: "succeeded", jobId: "flink-job-1", fileCount: 4 });
    assert.equal(catalog.list("s3://euclid/q1")[0]?.id, run.id);
    assert.equal(catalog.list("s3://other/path").length, 0);
    const reloaded = new ConnectorIngestRunCatalog(statePath);
    await reloaded.initialize();
    assert.equal(reloaded.list("s3://euclid/q1")[0]?.jobId, "flink-job-1");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
