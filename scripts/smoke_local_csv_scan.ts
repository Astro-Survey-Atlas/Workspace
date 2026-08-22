import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AstroObjectIndexService } from "../src/astro-object-index.js";
import { ConnectorIngestRunCatalog } from "../src/connector-history.js";
import { ConnectorRegistry } from "../src/connectors.js";
import { DataCatalogRegistry } from "../src/data-catalog.js";
import { LocalConnectorRootsPolicy } from "../src/local-connector-roots.js";
import { LocalCsvScanExecutor } from "../src/local-scan-executor.js";
import { SqliteMetadataStore } from "../src/storage/index.js";

interface Arguments {
  file: string;
  objectIdColumn: string;
  raColumn: string;
  decColumn: string;
}

function argumentsFrom(argv: string[]): Arguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) throw new RangeError("Arguments must use --name value pairs");
    values.set(key.slice(2), value);
  }
  const required = (name: string): string => {
    const value = values.get(name)?.trim();
    if (!value) throw new RangeError(`--${name} is required`);
    return value;
  };
  return {
    file: path.resolve(required("file")),
    objectIdColumn: values.get("object-id")?.trim() || "object_id",
    raColumn: values.get("ra")?.trim() || "ra",
    decColumn: values.get("dec")?.trim() || "dec",
  };
}

async function requestBody(request: import("node:http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const input = argumentsFrom(process.argv.slice(2));
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "astro-local-scan-smoke-"));
  let objectDocuments = 0;
  let coverageDocuments = 0;
  let bulkRequests = 0;
  let nextProgress = 100_000;
  const mockElasticsearch = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.method === "HEAD" && (request.url === "/astro_object_index_v1" || request.url === "/astro_coverage_index_v1")) {
      response.statusCode = 200;
      response.end();
      return;
    }
    if (request.method !== "POST" || request.url !== "/_bulk") {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
      return;
    }
    const lines = (await requestBody(request)).trimEnd().split("\n");
    const items: unknown[] = [];
    for (let index = 0; index < lines.length; index += 2) {
      const action = JSON.parse(lines[index]!) as { index: { _index: string; _id: string } };
      if (action.index._index === "astro_object_index_v1") objectDocuments += 1;
      else if (action.index._index === "astro_coverage_index_v1") coverageDocuments += 1;
      items.push({ index: { _index: action.index._index, _id: action.index._id, status: 201 } });
    }
    bulkRequests += 1;
    if (objectDocuments >= nextProgress) {
      process.stderr.write(`indexed ${objectDocuments.toLocaleString("en-US")} object documents\n`);
      nextProgress += 100_000;
    }
    response.end(JSON.stringify({ errors: false, items }));
  });
  await new Promise<void>((resolve) => mockElasticsearch.listen(0, "127.0.0.1", resolve));
  const address = mockElasticsearch.address();
  if (!address || typeof address === "string") throw new Error("Mock Elasticsearch did not bind a port");

  const store = new SqliteMetadataStore(path.join(temporaryRoot, "workspace.sqlite"));
  try {
    await store.initialize();
    const sourceRoot = path.dirname(input.file);
    const roots = new LocalConnectorRootsPolicy([{ containerPath: sourceRoot, hostPath: sourceRoot }]);
    const connectors = new ConnectorRegistry(store, roots);
    await connectors.initialize();
    const dataCatalog = new DataCatalogRegistry(store);
    await dataCatalog.initialize();
    const runs = new ConnectorIngestRunCatalog(store);
    const registered = await connectors.register({
      name: "Local CSV smoke connector",
      kind: "local",
      config: { rootPath: sourceRoot },
      status: "ready",
    });
    const connector = await connectors.check(registered.id);
    const asset = await dataCatalog.register({
      name: path.basename(input.file),
      surveyId: "local-smoke",
      releaseId: "local-smoke-v1",
      product: "local CSV smoke catalog",
      kind: "catalog",
      modalities: ["photometry"],
      connectorIds: [connector.id],
      connectorLocationKeys: [connector.locationKey],
      status: "ready",
      projectStates: ["deliverable"],
      scanSpec: {
        format: "csv",
        objectIdColumn: input.objectIdColumn,
        raColumn: input.raColumn,
        decColumn: input.decColumn,
        coordinateFrame: "ICRS",
        coordinateUnits: "deg",
        modality: "photometry",
        product: "local CSV smoke catalog",
      },
    });
    const indexService = new AstroObjectIndexService({ baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 30_000 });
    const executor = new LocalCsvScanExecutor({ enabled: true, connectors, dataCatalog, runs, roots, indexService });

    const startedAt = Date.now();
    const queued = await executor.submit(connector.id, { relativePath: path.basename(input.file) }, "full-local-smoke");
    const completed = await executor.awaitCompletion(queued.id);
    const elapsedMs = Date.now() - startedAt;
    if (completed.status !== "succeeded") throw new Error(completed.error || "Local scan smoke failed");
    if (completed.documentCount !== objectDocuments) {
      throw new Error(`Run count ${completed.documentCount} does not match bulk count ${objectDocuments}`);
    }
    process.stdout.write(`${JSON.stringify({
      status: completed.status,
      assetId: asset.id,
      file: input.file,
      objectDocuments,
      coverageDocuments,
      bulkRequests,
      elapsedMs,
    }, null, 2)}\n`);
  } finally {
    await store.close().catch(() => undefined);
    await new Promise<void>((resolve) => mockElasticsearch.close(() => resolve()));
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

await main();
