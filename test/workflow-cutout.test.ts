import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MemoryConnectorCredentialStore } from "../src/connector-credentials.js";
import type { CatalogQueryClient } from "../src/catalog-mcp-client.js";
import type { ConnectorRecord, ConnectorRegistry } from "../src/connectors.js";
import { LocalConnectorRootsPolicy } from "../src/local-connector-roots.js";
import { WorkflowEngine, EUCLID_DESI_WORKFLOW } from "../src/workflow-engine.js";
import { WorkspaceFitsCutoutService } from "../src/workflow-fits-cutout.js";
import type { WorkflowMcpClient, WorkflowMcpRole } from "../src/workflow-mcp-client.js";
import { WorkflowStore } from "../src/workflow-store.js";
import type { WorkflowRun } from "../src/workflow.js";

function fitsPrimaryHdu(objectId: string): Buffer {
  const cards = [
    "SIMPLE  =                    T",
    "BITPIX  =                    8",
    "NAXIS   =                    0",
    "EXTEND  =                    T",
    `OBJECT  = '${objectId}'`,
    "END",
  ].map((card) => card.padEnd(80, " ")).join("");
  return Buffer.from(cards.padEnd(2880, " "));
}

class CutoutCatalogClient implements CatalogQueryClient {
  async query(request: Record<string, unknown>): Promise<unknown> {
    const euclid = String(request.catalog).toLowerCase().includes("euclid");
    const source = euclid
      ? { OBJECT_ID: "e1", RIGHT_ASCENSION: 0, DECLINATION: 0, TILE_INDEX: "123456" }
      : { TARGETID: "d1", RA: 0, DEC: 0, BRICKNAME: "1234p567" };
    return { data: { result: { hits: { hits: [{ _source: source }] } } } };
  }
}

class CutoutMcpFixture {
  readonly artifacts = new Map<string, Buffer>();
  readonly executions: Array<Record<string, unknown>> = [];
  readonly reads: Array<Record<string, unknown>> = [];

  async hasTool(role: WorkflowMcpRole, toolName: string): Promise<boolean> {
    return role === "cutout" && ["execute_cutout_group", "read_cutout_artifacts"].includes(toolName);
  }

  async getTool(): Promise<undefined> {
    return undefined;
  }

  async callTool(role: WorkflowMcpRole, toolName: string, input: Record<string, unknown>): Promise<unknown> {
    assert.equal(role, "cutout");
    if (toolName === "execute_cutout_group") {
      this.executions.push(input);
      const results = (input.targets as Array<Record<string, unknown>>).map((target) => {
        const uri = `s3://cutout-output/${input.telescope}/${input.band}/${target.obj_id}.fits`;
        this.artifacts.set(uri, fitsPrimaryHdu(String(target.obj_id)));
        return {
          ...target,
          status: "ok",
          output_uri: uri,
          meta: { has_overlap: true, stamp_size_px: 32 },
        };
      });
      return { resolved_source_uri: input.source_uri, results };
    }
    if (toolName === "read_cutout_artifacts") {
      this.reads.push(input);
      const cursors = input.artifacts as Array<{ output_uri: string; offset: number }>;
      return {
        chunks: cursors.map(({ output_uri, offset }) => {
          const content = this.artifacts.get(output_uri);
          assert.ok(content, `fixture has artifact bytes for ${output_uri}`);
          return {
            output_uri,
            offset,
            size: content.byteLength,
            next_offset: content.byteLength,
            content_base64: content.toString("base64"),
          };
        }),
      };
    }
    throw new Error(`Unexpected MCP tool: ${toolName}`);
  }
}

async function temporaryStore(t: test.TestContext): Promise<WorkflowStore> {
  const root = await mkdtemp(path.join(os.tmpdir(), "astro-workflow-cutout-"));
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

test("runs catalog match through HITL, grouped cutouts, Workspace artifacts, and export", async (t) => {
  const store = await temporaryStore(t);
  const mcpFixture = new CutoutMcpFixture();
  const mcp = mcpFixture as unknown as WorkflowMcpClient;
  const cutoutService = new WorkspaceFitsCutoutService({
    store,
    connectors: {} as ConnectorRegistry,
    localRoots: {} as LocalConnectorRootsPolicy,
    mcp,
  });
  const engine = new WorkflowEngine(store, new CutoutCatalogClient(), mcp, undefined, cutoutService);
  const created = await engine.createRun(EUCLID_DESI_WORKFLOW.key, {
    raDeg: 0,
    decDeg: 0,
    queryRadiusArcsec: 10,
    matchRadiusArcsec: 1.5,
    limit: 50,
    desiBands: ["g"],
  });

  const waiting = await waitFor(store, created.id, ["waiting_for_input"]);
  assert.equal(waiting.waiting?.reason, "filter");
  assert.equal(waiting.summary.matchRows, 1);
  assert.equal(waiting.steps.find((step) => step.id === "cutout")?.status, "pending");

  const completed = await engine.decide(created.id, { action: "accept_all" });
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.steps.find((step) => step.id === "human_filter")?.status, "succeeded");
  assert.equal(completed.steps.find((step) => step.id === "cutout")?.status, "succeeded");
  assert.equal(completed.steps.find((step) => step.id === "export")?.status, "succeeded");
  assert.equal(mcpFixture.executions.length, 2);
  assert.equal(mcpFixture.reads.length, 2);
  assert.equal(completed.cutoutGroups?.length, 2);
  assert.equal(completed.summary.cutoutTargetsSucceeded, 2);

  const cutouts = JSON.parse(await store.readArtifact(completed.id, "cutouts.json")) as {
    records: Array<{ telescope: string; status: string; outputUri?: string }>;
  };
  assert.deepEqual(cutouts.records.map((record) => [record.telescope, record.status]).sort(), [
    ["desi", "ok"],
    ["euclid", "ok"],
  ]);
  for (const record of cutouts.records) {
    assert.ok(record.outputUri?.startsWith(`/api/workflow-runs/${completed.id}/artifacts/`));
    const artifactName = record.outputUri!.split("/").at(-1)!;
    const saved = await store.artifactPath(completed.id, artifactName);
    assert.equal(saved.artifact.mediaType, "application/fits");
    assert.equal(saved.artifact.byteLength, 2880);
    assert.equal((await readFile(saved.filePath)).subarray(0, 8).toString("ascii"), "SIMPLE  ");
  }

  const csv = await store.readArtifact(completed.id, "filtered.csv");
  assert.match(csv, /e1,d1/);
  assert.ok(completed.artifacts.some((artifact) => artifact.name === "result.json"));
  assert.ok(completed.lineage.artifacts.some((artifact) => artifact.name === "filtered.csv"));
  assert.ok(completed.lineage.artifacts.some((artifact) => artifact.name.startsWith("cutout-euclid-vis-")));
});

test("cuts an authorized S3 FITS section with temporary Connector credentials and bounded Range reads", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-s3-fits-cutout-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const sourcePath = path.join(directory, "image.fits");
  const python = process.env.PYTHON_EXECUTABLE ?? "python3";
  const fixtureScript = [
    "import sys",
    "import numpy as np",
    "from astropy.io import fits",
    "header = fits.Header()",
    "header['CTYPE1'] = 'RA---TAN'",
    "header['CTYPE2'] = 'DEC--TAN'",
    "header['CRPIX1'] = 1025.0",
    "header['CRPIX2'] = 1025.0",
    "header['CRVAL1'] = 10.0",
    "header['CRVAL2'] = 0.0",
    "header['CDELT1'] = -1.0 / 3600.0",
    "header['CDELT2'] = 1.0 / 3600.0",
    "fits.PrimaryHDU(np.zeros((2048, 2048), dtype=np.float32), header=header).writeto(sys.argv[1])",
  ].join("\n");
  execFileSync(python, ["-c", fixtureScript, sourcePath]);
  const sourceBytes = await readFile(sourcePath);
  const ranges: Array<[number, number]> = [];
  const securityTokens: string[] = [];
  const badRequests: string[] = [];
  const server = createServer((request, response) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? "");
    if (request.method !== "GET" || !match) {
      badRequests.push(`${request.method ?? ""} ${request.url ?? ""}`);
      response.writeHead(400).end();
      return;
    }
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (end < start || end >= sourceBytes.byteLength) {
      response.writeHead(416).end();
      return;
    }
    ranges.push([start, end]);
    securityTokens.push(String(request.headers["x-amz-security-token"] ?? ""));
    const bytes = sourceBytes.subarray(start, end + 1);
    response.writeHead(206, {
      "Content-Length": String(bytes.byteLength),
      "Content-Range": `bytes ${start}-${end}/${sourceBytes.byteLength}`,
      "Accept-Ranges": "bytes",
      ETag: '"cutout-fixture-etag"',
    });
    response.end(bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const now = new Date().toISOString();
  const credentialRef = "asa-workspace/astro-connector-cutout-test";
  const connector: ConnectorRecord = {
    id: "connector-cutout-test",
    locationKey: "s3://cutout-bucket/data",
    displayPath: `http://127.0.0.1:${address.port}/cutout-bucket/data`,
    name: "cutout source",
    description: "",
    kind: "s3",
    config: {
      bucket: "cutout-bucket",
      prefix: "data",
      endpoint: `http://127.0.0.1:${address.port}`,
      region: "us-east-1",
    },
    credentialRef,
    status: "ready",
    createdAt: now,
    updatedAt: now,
    origin: "user",
  };
  const credentials = new MemoryConnectorCredentialStore();
  await credentials.put(credentialRef, {
    accessKeyId: "fixture-access",
    secretAccessKey: "fixture-secret",
    endpoint: `http://127.0.0.1:${address.port}`,
    sessionToken: "fixture-session-token",
  });
  const store = await temporaryStore(t);
  const mcpFixture = new CutoutMcpFixture();
  const mcp = mcpFixture as unknown as WorkflowMcpClient;
  const engine = new WorkflowEngine(store, new CutoutCatalogClient(), mcp);
  const created = await engine.createRun(EUCLID_DESI_WORKFLOW.key, {
    raDeg: 0,
    decDeg: 0,
    queryRadiusArcsec: 10,
    matchRadiusArcsec: 1.5,
    limit: 50,
    desiBands: ["g"],
  });
  const waiting = await waitFor(store, created.id, ["waiting_for_input"]);
  assert.equal(waiting.waiting?.reason, "filter");

  const service = new WorkspaceFitsCutoutService({
    store,
    connectors: { list: async () => [connector] } as unknown as ConnectorRegistry,
    credentials,
    localRoots: new LocalConnectorRootsPolicy(),
    mcp,
  });
  const result = await service.executeGroup({
    run_id: waiting.id,
    telescope: "euclid",
    band: "vis",
    source_uri: "s3://cutout-bucket/data/image.fits",
    targets: [{ obj_id: "target-1", row_index: 0, ra_deg: 10, dec_deg: 0 }],
    size_deg: 0.003,
  }, waiting) as { results: Array<{ status: string; output_uri?: string; artifact_name?: string }> };

  assert.equal(result.results[0]?.status, "ok");
  assert.ok(result.results[0]?.output_uri?.startsWith(`/api/workflow-runs/${waiting.id}/artifacts/`));
  assert.equal(mcpFixture.executions.length, 0);
  assert.equal(mcpFixture.reads.length, 0);
  assert.deepEqual(badRequests, []);
  assert.ok(ranges.length > 1);
  assert.ok(ranges.every(([start, end]) => end - start + 1 <= 1024 * 1024));
  assert.ok(ranges.reduce((total, [start, end]) => total + end - start + 1, 0) < sourceBytes.byteLength / 2);
  assert.ok(securityTokens.length > 0);
  assert.ok(securityTokens.every((token) => token === "fixture-session-token"));

  const artifactName = result.results[0]?.artifact_name;
  assert.ok(artifactName);
  const artifact = await store.artifactPath(waiting.id, artifactName);
  assert.equal(artifact.artifact.mediaType, "application/fits");
  const inspection = execFileSync(python, ["-c", [
    "import sys",
    "from astropy.io import fits",
    "with fits.open(sys.argv[1]) as hdus:",
    "    print(hdus[0].data.shape, float(hdus[0].data.max()))",
  ].join("\n"), artifact.filePath]).toString("utf8").trim();
  assert.equal(inspection, "(10, 10) 0.0");
});
