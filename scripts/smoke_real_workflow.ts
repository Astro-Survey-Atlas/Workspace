import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { McpCatalogQueryClient } from "../src/catalog-mcp-client.js";
import { extractCatalogHits } from "../src/scientific-tools.js";
import { WorkflowEngine } from "../src/workflow-engine.js";
import { WorkflowStore } from "../src/workflow-store.js";
import type { WorkflowRun } from "../src/workflow.js";

async function waitForRun(store: WorkflowStore, runId: string): Promise<WorkflowRun> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const run = await store.get(runId);
    if (!["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for the real workflow run");
}

const root = await mkdtemp(path.join(os.tmpdir(), "astro-real-workflow-"));
try {
  const store = new WorkflowStore(root);
  await store.initialize();
  const client = new McpCatalogQueryClient(
    process.env.ASTRO_CATALOG_MCP_URL ?? "http://eva24002-entrance.lab.zverse.space:30082/mcp",
    Number(process.env.ASTRO_CATALOG_MCP_TIMEOUT_MS ?? "20000"),
    1,
  );
  const engine = new WorkflowEngine(store, client);
  const configuredRa = process.env.ASTRO_SMOKE_RA;
  const configuredDec = process.env.ASTRO_SMOKE_DEC;
  const candidates: Array<{ raDeg: number; decDeg: number }> = [];
  let discoveryPayload: unknown;
  if (configuredRa !== undefined && configuredDec !== undefined) {
    candidates.push({ raDeg: Number(configuredRa), decDeg: Number(configuredDec) });
  } else {
    discoveryPayload = await client.query({
      catalog: "euclid-q1-mer-final",
      mode: "search",
      body: { query: { match_all: {} }, from: 0, size: 20 },
    });
    const sample = extractCatalogHits(discoveryPayload);
    for (const hit of sample) {
      const source = hit._source && typeof hit._source === "object" ? hit._source as Record<string, unknown> : hit;
      const raDeg = Number(source.RIGHT_ASCENSION ?? source.right_ascension ?? source.ra ?? source.RA);
      const decDeg = Number(source.DECLINATION ?? source.declination ?? source.dec ?? source.DEC);
      if (Number.isFinite(raDeg) && Number.isFinite(decDeg)) candidates.push({ raDeg, decDeg });
    }
  }
  if (candidates.length === 0) throw new Error(`Real Euclid query returned no candidate coordinates: ${JSON.stringify(discoveryPayload).slice(0, 2000)}`);

  let run: WorkflowRun | undefined;
  let selected: { raDeg: number; decDeg: number } | undefined;
  for (const candidate of candidates) {
    const created = await engine.createRun("euclid-desi-crossmatch@1", {
      ...candidate,
      queryRadiusArcsec: Number(process.env.ASTRO_SMOKE_QUERY_RADIUS_ARCSEC ?? "600"),
      matchRadiusArcsec: Number(process.env.ASTRO_SMOKE_MATCH_RADIUS_ARCSEC ?? "1.5"),
      limit: Number(process.env.ASTRO_SMOKE_LIMIT ?? "1000"),
    });
    const candidateRun = await waitForRun(store, created.id);
    if (candidateRun.status === "failed") throw new Error(candidateRun.error ?? "Real workflow failed");
    if (candidateRun.waiting?.reason === "filter") {
      run = candidateRun;
      selected = candidate;
      break;
    }
  }
  if (!run || !selected) throw new Error(`No 1.5 arcsec Euclid × DESI match found across ${candidates.length} real Euclid candidates`);
  run = await engine.decide(run.id, { action: "accept_all" });
  if (run.status !== "succeeded") throw new Error(`Real workflow did not complete: ${run.status}`);
  console.log(JSON.stringify({
    runId: run.id,
    coordinate: selected,
    status: run.status,
    summary: run.summary,
    previewRows: run.preview.length,
    artifacts: run.artifacts.map(({ name, rowCount, sha256 }) => ({ name, rowCount, sha256 })),
    sources: run.lineage.sources,
  }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
