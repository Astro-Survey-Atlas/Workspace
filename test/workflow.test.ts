import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { CatalogQueryClient } from "../src/catalog-mcp-client.js";
import { WorkflowEngine, EUCLID_DESI_WORKFLOW } from "../src/workflow-engine.js";
import { WorkflowStore } from "../src/workflow-store.js";
import { ToolRegistry, validateWorkflowDefinition, type WorkflowRun } from "../src/workflow.js";

class FixtureCatalogClient implements CatalogQueryClient {
  constructor(private readonly mode: "success" | "zero" | "error" | "invalid" = "success") {}

  async query(request: Record<string, unknown>): Promise<unknown> {
    if (this.mode === "error") throw new Error("fixture MCP timeout");
    if (this.mode === "zero") return { data: { result: { hits: { hits: [] } } } };
    const euclid = request.catalog === "euclid-q1-mer-final";
    const source = this.mode === "invalid"
      ? { OBJECT_ID: euclid ? "e-invalid" : "d-invalid" }
      : euclid
        ? { OBJECT_ID: "e1", RIGHT_ASCENSION: 359.9999, DECLINATION: 0, MAG_VIS: 21.1, EXTENDED_FLAG: "galaxy" }
        : { OBJECT_ID: "d1", ra: 0.0001, dec: 0, mag_r: 20.2, type: "REX" };
    return { data: { result: { hits: { hits: [{ _source: source }] } } } };
  }
}

class ErrorPayloadCatalogClient implements CatalogQueryClient {
  async query(): Promise<unknown> {
    throw new Error("Catalog MCP remote error: [INTERNAL] Elasticsearch unavailable");
  }
}

async function temporaryStore(t: test.TestContext): Promise<WorkflowStore> {
  const root = await mkdtemp(path.join(os.tmpdir(), "astro-workflows-"));
  const store = new WorkflowStore(root);
  t.after(async () => {
    await store.flush();
    await rm(root, { recursive: true, force: true });
  });
  await store.initialize();
  return store;
}

async function waitFor(store: WorkflowStore, runId: string, statuses: WorkflowRun["status"][]): Promise<WorkflowRun> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const run = await store.get(runId);
    if (statuses.includes(run.status)) return run;
    if (run.status === "failed" && !statuses.includes("failed")) throw new Error(`Workflow failed while waiting: ${run.error}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${statuses.join(", ")}`);
}

test("rejects cyclic workflow DAGs", () => {
  const tools = new ToolRegistry();
  tools.register({ id: "a", title: "a", description: "a", kind: "local", version: "1", inputSchema: {}, health: { status: "healthy", detail: "ok" } }, async () => null);
  assert.throws(() => validateWorkflowDefinition({
    id: "cycle", version: 1, key: "cycle@1", title: "cycle", description: "cycle", inputSchema: {}, outputs: [],
    steps: [
      { id: "first", title: "first", kind: "tool", toolId: "a", dependsOn: ["second"] },
      { id: "second", title: "second", kind: "tool", toolId: "a", dependsOn: ["first"] },
    ],
  }, tools), /cycle/);
});

test("pauses a real-shaped catalog run and resumes after a human decision", async (t) => {
  const store = await temporaryStore(t);
  const engine = new WorkflowEngine(store, new FixtureCatalogClient());
  const created = await engine.createRun("euclid-desi-crossmatch@1", {
    raDeg: 0, decDeg: 0, queryRadiusArcsec: 10, matchRadiusArcsec: 1.5, limit: 50,
  });
  const waiting = await waitFor(store, created.id, ["waiting_for_input"]);
  assert.equal(waiting.waiting?.reason, "filter");
  assert.equal(waiting.summary.matchRows, 1);
  assert.equal(waiting.preview.length, 1);
  const completed = await engine.decide(created.id, {
    action: "apply_filter",
    filter: { logic: "and", conditions: [{ field: "separationArcsec", op: "<=", value: 1 }] },
  });
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.summary.filteredRows, 1);
  assert.ok(completed.artifacts.some((artifact) => artifact.name === "filtered.csv" && artifact.sha256.length === 64));
  const csv = await readFile((await store.artifactPath(created.id, "filtered.csv")).filePath, "utf8");
  assert.match(csv, /e1,d1/);
});

test("waits for region adjustment when a real catalog returns zero rows", async (t) => {
  const store = await temporaryStore(t);
  const engine = new WorkflowEngine(store, new FixtureCatalogClient("zero"));
  const created = await engine.createRun(EUCLID_DESI_WORKFLOW.key, { raDeg: 10, decDeg: 0 });
  const waiting = await waitFor(store, created.id, ["waiting_for_input"]);
  assert.equal(waiting.waiting?.reason, "region_adjust");
  assert.equal(waiting.artifacts.length, 0);
});

test("fails explicitly on MCP errors and incomplete catalog fields", async (t) => {
  const store = await temporaryStore(t);
  const failedClient = new WorkflowEngine(store, new FixtureCatalogClient("error"));
  const first = await failedClient.createRun(EUCLID_DESI_WORKFLOW.key, { raDeg: 10, decDeg: 0 });
  assert.match((await waitFor(store, first.id, ["failed"])).error ?? "", /fixture MCP timeout/);

  const invalidClient = new WorkflowEngine(store, new FixtureCatalogClient("invalid"));
  const second = await invalidClient.createRun(EUCLID_DESI_WORKFLOW.key, { raDeg: 10, decDeg: 0 });
  assert.match((await waitFor(store, second.id, ["failed"])).error ?? "", /有效对象标识或坐标字段/);

  const errorPayloadClient = new WorkflowEngine(store, new ErrorPayloadCatalogClient());
  const third = await errorPayloadClient.createRun(EUCLID_DESI_WORKFLOW.key, { raDeg: 10, decDeg: 0 });
  assert.match((await waitFor(store, third.id, ["failed"])).error ?? "", /Elasticsearch unavailable/);
});

test("marks queued or running runs failed during service restart recovery", async (t) => {
  const store = await temporaryStore(t);
  const run = await store.create(EUCLID_DESI_WORKFLOW, { raDeg: 10, decDeg: 0 });
  run.status = "running";
  run.steps[0]!.status = "running";
  await store.save(run);
  const restarted = new WorkflowStore(store.root);
  await restarted.initialize();
  const recovered = await restarted.get(run.id);
  assert.equal(recovered.status, "failed");
  assert.match(recovered.error ?? "", /restarted/);
});
