import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ConnectorIngestRunCatalog, publicConnectorIngestRun } from "../src/connector-history.js";
import { SqliteMetadataStore } from "../src/storage/index.js";

test("connector ingest history is keyed by the normalized location", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-connector-runs-"));
  try {
    const statePath = path.join(directory, "runs.json");
    const store = new SqliteMetadataStore(`${statePath}.sqlite`);
    await store.initialize();
    const catalog = new ConnectorIngestRunCatalog(store);
    await catalog.initialize();
    const run = await catalog.add("s3://euclid/q1", { status: "succeeded", jobId: "flink-job-1", fileCount: 4 });
    assert.equal((await catalog.list("s3://euclid/q1"))[0]?.id, run.id);
    assert.equal((await catalog.list("s3://other/path")).length, 0);
    const reloaded = new ConnectorIngestRunCatalog(store);
    await reloaded.initialize();
    assert.equal((await reloaded.list("s3://euclid/q1"))[0]?.jobId, "flink-job-1");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("connector scan history snapshots identity and handles idempotent retries", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-connector-runs-"));
  const store = new SqliteMetadataStore(path.join(directory, "workspace.sqlite"));
  try {
    await store.initialize();
    const catalog = new ConnectorIngestRunCatalog(store);
    const input = {
      connectorId: "connector-one",
      connectorName: "Survey connector",
      connectorKind: "s3" as const,
      executor: "flink-ingest",
      target: { uri: "s3://survey/release", bucket: "survey", prefix: "release" },
      assetIds: ["asset-two", "asset-one", "asset-one"],
      status: "queued" as const,
      secretName: "private-task-secret",
    };
    const first = await catalog.create("s3://survey/release", input, "retry-key");
    const retry = await catalog.create("s3://survey/release", input, "retry-key");

    assert.equal(first.created, true);
    assert.equal(retry.created, false);
    assert.equal(retry.run.id, first.run.id);
    assert.deepEqual(first.run.assetIds, ["asset-one", "asset-two"]);
    assert.deepEqual((await catalog.list({ connectorId: "connector-one" })).map((run) => run.id), [first.run.id]);
    assert.equal(JSON.stringify(publicConnectorIngestRun(first.run)).includes("secretName"), false);
    assert.equal(JSON.stringify(publicConnectorIngestRun(first.run)).includes("idempotencyKeyHash"), false);
    await catalog.remove("s3://survey/edited-release", first.run.id, "connector-one");
    assert.deepEqual(await catalog.list({ connectorId: "connector-one" }), []);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
