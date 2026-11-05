import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ConnectorCredentialStore } from "./connector-credentials.js";
import { iterateConnectorObjectPages, readConnectorObjectRange, type ConnectorRecord, type ConnectorRegistry } from "./connectors.js";
import type { LocalConnectorRootsPolicy } from "./local-connector-roots.js";
import type { WorkflowMcpClient } from "./workflow-mcp-client.js";
import type { WorkflowStore } from "./workflow-store.js";
import type { WorkflowRun } from "./workflow.js";
import { withRootSpan, withSpan } from "./telemetry.js";

const MAX_TARGETS = 100;
const MAX_CHILD_OUTPUT_BYTES = 1_048_576;
const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
const REMOTE_ARTIFACT_BATCH_BYTES = 3 * 1024 * 1024;
// Each returned FITS is capped at 5 MiB, so four-at-a-time bounds buffers near 20 MiB.
const REMOTE_ARTIFACT_WRITE_BATCH = 4;
const MAX_REMOTE_RANGE_BYTES = 8 * 1024 * 1024;
const REMOTE_RANGE_PATH = "/__internal/fits-range";
const CUTOUT_SCRIPT = fileURLToPath(new URL("./workflow-fits-cutout.py", import.meta.url));

export interface WorkspaceCutoutTarget {
  obj_id: string;
  row_index: number;
  ra_deg: number;
  dec_deg: number;
  tile_index?: string;
  brickname?: string;
}

export interface WorkspaceCutoutGroupInput {
  run_id: string;
  telescope: "euclid" | "desi";
  band: "vis" | "g" | "r" | "i" | "z";
  source_uri: string;
  targets: WorkspaceCutoutTarget[];
  size_deg: number;
  resolve_wildcard?: boolean;
}

interface PythonCutoutResult {
  status: "ok" | "error";
  row_index: number;
  obj_id: string;
  ra_deg: number;
  dec_deg: number;
  output_path?: string;
  error?: string;
  meta?: { has_overlap?: boolean; stamp_size_px?: number };
}

interface AuthorizedS3Source {
  connector: ConnectorRecord;
  key: string;
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
}

interface S3RangeBridge {
  url: string;
  size: number;
  token: string;
  close(): Promise<void>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function parseS3Uri(value: string, allowWildcard = false): { bucket: string; key: string } | undefined {
  if ((!allowWildcard && value.includes("*")) || /[?#\[\]]/.test(value)) return undefined;
  try {
    const uri = new URL(value);
    if (uri.protocol !== "s3:" || uri.username || uri.password || !uri.hostname) return undefined;
    const key = decodeURIComponent(uri.pathname.replace(/^\/+/, ""));
    if (!key || key.split("/").some((segment) => segment === "." || segment === "..")) return undefined;
    return { bucket: uri.hostname.toLowerCase(), key };
  } catch {
    return undefined;
  }
}

function s3GlobMatcher(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`);
}

function connectorPrefix(connector: ConnectorRecord): string {
  return (connector.config.prefix ?? "").replace(/^\/+|\/+$/g, "");
}

function coversObjectKey(connector: ConnectorRecord, key: string): boolean {
  const prefix = connectorPrefix(connector);
  return !prefix || key === prefix || key.startsWith(`${prefix}/`);
}

function parseContentRange(value: string | undefined): { start: number; end: number; size: number } | undefined {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value ?? "");
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const size = Number(match[3]);
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && Number.isSafeInteger(size) && size > end
    ? { start, end, size }
    : undefined;
}

async function createS3RangeBridge(source: AuthorizedS3Source): Promise<S3RangeBridge> {
  const firstByte = await readConnectorObjectRange(source.connector, source.credentials, source.key, 0, 0);
  const metadata = parseContentRange(firstByte.contentRange);
  if (!metadata || metadata.start !== 0 || metadata.end !== 0 || firstByte.bytes.byteLength !== 1) {
    throw new Error("S3 object store did not return valid FITS byte-range metadata");
  }
  const etag = firstByte.etag;
  const token = randomBytes(24).toString("hex");
  const server = createServer((request, response) => {
    void (async () => {
      const remoteAddress = request.socket.remoteAddress;
      if ((remoteAddress !== "127.0.0.1" && remoteAddress !== "::ffff:127.0.0.1") || request.url !== REMOTE_RANGE_PATH
        || request.headers["x-asa-fits-range-token"] !== token) {
        response.writeHead(404).end();
        return;
      }
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Accept-Ranges", "bytes");
      response.setHeader("Connection", "close");
      if (request.method === "HEAD") {
        response.writeHead(200, { "Content-Length": String(metadata.size) }).end();
        return;
      }
      if (request.method !== "GET") {
        response.writeHead(405).end();
        return;
      }
      const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? "");
      if (!match) {
        response.writeHead(416, { "Content-Range": `bytes */${metadata.size}` }).end();
        return;
      }
      const start = Number(match[1]);
      const end = Number(match[2]);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start
        || start >= metadata.size || end >= metadata.size || end - start + 1 > MAX_REMOTE_RANGE_BYTES) {
        response.writeHead(416, { "Content-Range": `bytes */${metadata.size}` }).end();
        return;
      }
      const range = await readConnectorObjectRange(source.connector, source.credentials, source.key, start, end, etag);
      const actual = parseContentRange(range.contentRange);
      if (!actual || actual.start !== start || actual.end !== end || actual.size !== metadata.size
        || range.bytes.byteLength !== end - start + 1 || (etag && range.etag && range.etag !== etag)) {
        throw new Error("S3 object changed or returned an invalid byte range");
      }
      response.writeHead(206, {
        "Content-Length": String(range.bytes.byteLength),
        "Content-Range": `bytes ${start}-${end}/${metadata.size}`,
      });
      response.end(Buffer.from(range.bytes));
    })().catch(() => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Unable to start the temporary FITS range reader");
  }
  return {
    url: `http://127.0.0.1:${address.port}${REMOTE_RANGE_PATH}`,
    size: metadata.size,
    token,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function parseInput(value: unknown): WorkspaceCutoutGroupInput {
  const input = asRecord(value);
  if (!input) throw new RangeError("cutout request must be an object");
  const runId = typeof input.run_id === "string" ? input.run_id.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(runId)) throw new RangeError("run_id is invalid");
  const telescope = input.telescope;
  if (telescope !== "euclid" && telescope !== "desi") throw new RangeError("telescope must be euclid or desi");
  const band = input.band;
  if (!(["vis", "g", "r", "i", "z"] as unknown[]).includes(band)) throw new RangeError("band is not supported");
  if ((telescope === "euclid" && band !== "vis") || (telescope === "desi" && band === "vis")) {
    throw new RangeError("band is not supported for this telescope");
  }
  const sourceUri = typeof input.source_uri === "string" ? input.source_uri.trim() : "";
  if (!sourceUri || sourceUri.length > 2048) throw new RangeError("source_uri is required and must be at most 2048 characters");
  const sizeDeg = Number(input.size_deg);
  if (!Number.isFinite(sizeDeg) || sizeDeg < 0.001 || sizeDeg > 1) throw new RangeError("size_deg must be between 0.001 and 1");
  if (!Array.isArray(input.targets) || input.targets.length < 1 || input.targets.length > MAX_TARGETS) {
    throw new RangeError(`targets must contain between 1 and ${MAX_TARGETS} rows`);
  }
  const targets = input.targets.map((targetValue): WorkspaceCutoutTarget => {
    const target = asRecord(targetValue);
    if (!target) throw new RangeError("each target must be an object");
    const objectId = typeof target.obj_id === "string" ? target.obj_id.trim() : "";
    const rowIndex = Number(target.row_index);
    const raDeg = Number(target.ra_deg);
    const decDeg = Number(target.dec_deg);
    if (!objectId || objectId.length > 256) throw new RangeError("target obj_id is required and must be at most 256 characters");
    if (!Number.isSafeInteger(rowIndex) || rowIndex < 0) throw new RangeError("target row_index must be a non-negative integer");
    if (!Number.isFinite(raDeg) || raDeg < 0 || raDeg >= 360) throw new RangeError("target ra_deg must be in [0, 360)");
    if (!Number.isFinite(decDeg) || decDeg < -90 || decDeg > 90) throw new RangeError("target dec_deg must be in [-90, 90]");
    const tileIndex = typeof target.tile_index === "string" ? target.tile_index.trim() : undefined;
    const brickname = typeof target.brickname === "string" ? target.brickname.trim() : undefined;
    return {
      obj_id: objectId,
      row_index: rowIndex,
      ra_deg: raDeg,
      dec_deg: decDeg,
      ...(tileIndex ? { tile_index: tileIndex } : {}),
      ...(brickname ? { brickname } : {}),
    };
  });
  if (new Set(targets.map((target) => target.row_index)).size !== targets.length) {
    throw new RangeError("target row_index values must be unique within a cutout group");
  }
  return {
    run_id: runId,
    telescope,
    band: band as WorkspaceCutoutGroupInput["band"],
    source_uri: sourceUri,
    targets,
    size_deg: sizeDeg,
    ...(typeof input.resolve_wildcard === "boolean" ? { resolve_wildcard: input.resolve_wildcard } : {}),
  };
}

export class WorkspaceFitsCutoutService {
  constructor(private readonly options: {
    store: WorkflowStore;
    connectors: ConnectorRegistry;
    credentials?: ConnectorCredentialStore;
    localRoots: LocalConnectorRootsPolicy;
    mcp: WorkflowMcpClient;
  }) {}

  async executeGroup(value: unknown, run?: WorkflowRun): Promise<unknown> {
    const execute = async (): Promise<unknown> => {
      const input = parseInput(value);
      return withSpan("fits.cutout", {
        "asa.component": "workflow",
        "asa.workflow.run_id": input.run_id,
        "gen_ai.tool.name": "execute_cutout_group",
      }, async () => {
        const sourcePath = await this.#authorizedLocalPath(input.source_uri);
        if (sourcePath) return this.#executeLocal(input, sourcePath, run);
        const s3Source = await this.#authorizedS3Source(input.source_uri);
        if (s3Source) return this.#executeS3(input, s3Source, run);
        if (input.resolve_wildcard && input.source_uri.includes("*")) {
          const resolved = await this.#resolveS3Wildcard(input.source_uri);
          if (resolved) return this.#executeS3({ ...input, source_uri: resolved.uri }, resolved.source, run);
        }
        if (await this.options.mcp.hasTool("cutout", "execute_cutout_group")) {
          if (!await this.options.mcp.hasTool("cutout", "read_cutout_artifacts")) {
            throw new Error("Configured FITS cutout MCP cannot return artifacts to Workspace");
          }
          return this.#executeRemote(input);
        }
        throw new Error("FITS source is outside Workspace Connector roots and no cutout MCP is configured");
      });
    };
    if (run) return execute();
    return withRootSpan("mcp.server.tool execute_cutout_group", {
      "asa.component": "workflow",
      "asa.step.id": "cutout",
      "gen_ai.tool.name": "execute_cutout_group",
      "mcp.method.name": "tools/call",
    }, execute);
  }

  async #authorizedS3Source(sourceUri: string, allowWildcard = false): Promise<AuthorizedS3Source | undefined> {
    const credentials = this.options.credentials;
    if (!credentials) return undefined;
    const location = parseS3Uri(sourceUri, allowWildcard);
    if (!location) return undefined;
    const candidates = (await this.options.connectors.list())
      .filter((connector) => connector.kind === "s3" && connector.status === "ready"
        && connector.config.bucket?.toLowerCase() === location.bucket && coversObjectKey(connector, location.key))
      .sort((left, right) => connectorPrefix(right).length - connectorPrefix(left).length);
    const connector = candidates[0];
    const credentialRef = connector?.credentialRef;
    if (!credentialRef) return undefined;
    const saved = await withSpan("connector.credentials.read", {
      "asa.component": "workflow",
      "asa.connector.kind": "s3",
    }, () => credentials.get(credentialRef));
    if (!saved?.accessKeyId || !saved.secretAccessKey) return undefined;
    const endpoint = connector.config.endpoint || saved.endpoint;
    if (!endpoint) return undefined;
    return {
      connector: { ...connector, config: { ...connector.config, endpoint } },
      key: location.key,
      credentials: {
        accessKeyId: saved.accessKeyId,
        secretAccessKey: saved.secretAccessKey,
        ...(saved.sessionToken ? { sessionToken: saved.sessionToken } : {}),
      },
    };
  }

  async #resolveS3Wildcard(sourceUri: string): Promise<{ source: AuthorizedS3Source; uri: string } | undefined> {
    const pattern = parseS3Uri(sourceUri, true);
    if (!pattern || pattern.key.split("*").length !== 2) return undefined;
    const wildcardIndex = pattern.key.indexOf("*");
    const directoryEnd = pattern.key.lastIndexOf("/", wildcardIndex);
    if (directoryEnd < 0 || pattern.key.indexOf("*", directoryEnd + 1) !== wildcardIndex) return undefined;
    const source = await this.#authorizedS3Source(sourceUri, true);
    if (!source) return undefined;

    const prefix = pattern.key.slice(0, directoryEnd + 1);
    const connectorRoot = connectorPrefix(source.connector);
    const scopedSegments = prefix.slice(connectorRoot.length).split("/").filter(Boolean);
    if (scopedSegments.length < 3) throw new RangeError("S3 cutout wildcard requires a tile-scoped Connector path");

    const matches: string[] = [];
    for await (const page of iterateConnectorObjectPages(source.connector, source.credentials, prefix)) {
      for (const object of page.objects) {
        if (s3GlobMatcher(pattern.key).test(object.key)) matches.push(object.key);
        if (matches.length > 1) throw new RangeError("S3 cutout wildcard matched more than one object");
      }
      if (page.continuationToken) throw new RangeError("S3 cutout wildcard prefix contains too many objects to resolve safely");
    }
    if (!matches.length) throw new RangeError("S3 cutout wildcard did not match an object in the authorized Connector");

    const key = matches[0]!;
    return {
      source: { ...source, key },
      uri: `s3://${pattern.bucket}/${key}`,
    };
  }

  async #executeRemote(input: WorkspaceCutoutGroupInput): Promise<Record<string, unknown>> {
    const report = asRecord(await this.options.mcp.callTool(
      "cutout",
      "execute_cutout_group",
      input as unknown as Record<string, unknown>,
    ));
    if (!report || !Array.isArray(report.results)) return report ?? {};

    const results = report.results.map(asRecord).filter((result): result is Record<string, unknown> => Boolean(result));
    const pending: Array<{ result: Record<string, unknown>; outputUri: string; name: string }> = [];
    for (const result of results) {
      if (result.status !== "ok") continue;
      const outputUri = typeof result.output_uri === "string" ? result.output_uri : "";
      const rowIndex = Number(result.row_index);
      const objectId = typeof result.obj_id === "string" ? result.obj_id : "";
      if (!outputUri || !Number.isSafeInteger(rowIndex) || rowIndex < 0 || !objectId) {
        result.status = "error";
        result.error = "Cutout MCP returned an invalid artifact reference";
        delete result.output_uri;
        continue;
      }
      const suffix = createHash("sha256")
        .update(`${input.telescope}\0${input.band}\0${rowIndex}\0${objectId}`)
        .digest("hex")
        .slice(0, 12);
      pending.push({
        result,
        outputUri,
        name: `cutout-${input.telescope}-${input.band}-${String(rowIndex).padStart(6, "0")}-${suffix}.fits`,
      });
    }

    for (let offset = 0; offset < pending.length; offset += REMOTE_ARTIFACT_WRITE_BATCH) {
      const batch = pending.slice(offset, offset + REMOTE_ARTIFACT_WRITE_BATCH);
      const contents = await this.#readRemoteArtifacts(batch.map((artifact) => artifact.outputUri));
      const artifacts = await this.options.store.writeArtifactsForRun(input.run_id, batch.map((artifact) => {
        const content = contents.get(artifact.outputUri);
        if (!content) throw new Error("FITS cutout artifact was not returned by the configured MCP");
        return { name: artifact.name, mediaType: "application/fits", rowCount: 1, content };
      }));
      const artifactsByName = new Map(artifacts.map((artifact) => [artifact.name, artifact]));
      for (const artifact of batch) {
        const saved = artifactsByName.get(artifact.name);
        if (!saved) throw new Error("FITS cutout artifact registration failed");
        artifact.result.artifact_name = saved.name;
        artifact.result.output_uri = `/api/workflow-runs/${encodeURIComponent(input.run_id)}/artifacts/${encodeURIComponent(saved.name)}`;
      }
    }
    return {
      ...(typeof report.resolved_source_uri === "string" ? { resolved_source_uri: report.resolved_source_uri } : {}),
      ...(typeof report.error === "string" ? { error: report.error } : {}),
      results,
    };
  }

  async #readRemoteArtifacts(outputUris: string[]): Promise<Map<string, Buffer>> {
    const states = new Map(outputUris.map((outputUri) => [outputUri, {
      offset: 0,
      size: undefined as number | undefined,
      chunks: [] as Buffer[],
    }]));
    while ([...states.values()].some((state) => state.size === undefined || state.offset < state.size)) {
      const cursors = [...states.entries()]
        .filter(([, state]) => state.size === undefined || state.offset < state.size)
        .map(([output_uri, state]) => ({ output_uri, offset: state.offset }));
      const response = asRecord(await this.options.mcp.callTool("cutout", "read_cutout_artifacts", {
        artifacts: cursors,
        max_bytes: REMOTE_ARTIFACT_BATCH_BYTES,
      }));
      const chunks = Array.isArray(response?.chunks)
        ? response.chunks.map(asRecord).filter((chunk): chunk is Record<string, unknown> => Boolean(chunk))
        : [];
      if (!chunks.length) throw new Error("FITS cutout MCP returned no artifact data");

      let bytesReceived = 0;
      for (const chunk of chunks) {
        const outputUri = typeof chunk.output_uri === "string" ? chunk.output_uri : "";
        const state = states.get(outputUri);
        const offset = Number(chunk.offset);
        const size = Number(chunk.size);
        const nextOffset = Number(chunk.next_offset);
        const encoded = typeof chunk.content_base64 === "string" ? chunk.content_base64 : "";
        if (!state || offset !== state.offset || !Number.isSafeInteger(size) || size < 1 || size > MAX_ARTIFACT_BYTES
          || !Number.isSafeInteger(nextOffset) || nextOffset <= offset || nextOffset > size
          || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
          throw new Error("FITS cutout MCP returned an invalid artifact range");
        }
        const content = Buffer.from(encoded, "base64");
        if (content.byteLength !== nextOffset - offset) throw new Error("FITS cutout MCP artifact range length mismatch");
        if (state.size !== undefined && state.size !== size) throw new Error("FITS cutout MCP artifact size changed during retrieval");
        state.size = size;
        state.offset = nextOffset;
        state.chunks.push(content);
        bytesReceived += content.byteLength;
      }
      if (bytesReceived > REMOTE_ARTIFACT_BATCH_BYTES) throw new Error("FITS cutout MCP exceeded the artifact transfer limit");
    }

    return new Map([...states.entries()].map(([uri, state]) => [uri, Buffer.concat(state.chunks)]));
  }

  async #authorizedLocalPath(sourceUri: string): Promise<string | undefined> {
    if (sourceUri.includes("*") || sourceUri.startsWith("s3://")) return undefined;
    try {
      const filePath = sourceUri.startsWith("file:")
        ? fileURLToPath(sourceUri)
        : sourceUri.startsWith("local://")
          ? decodeURIComponent(sourceUri.slice("local://".length))
          : sourceUri;
      if (!path.isAbsolute(filePath)) return undefined;
      const resolved = await this.options.localRoots.resolveReadableFile(filePath);
      const details = await stat(resolved.fileSystemPath);
      if (!details.isFile()) return undefined;
      const connectors = await this.options.connectors.list();
      const registered = connectors.some((connector) => connector.kind === "local" && connector.status === "ready"
        && typeof connector.config.rootPath === "string"
        && isWithinRoot(resolved.containerPath, connector.config.rootPath));
      return registered ? resolved.fileSystemPath : undefined;
    } catch {
      return undefined;
    }
  }

  async #executeLocal(input: WorkspaceCutoutGroupInput, sourcePath: string, activeRun?: WorkflowRun): Promise<unknown> {
    return this.#executeWithPython(input, activeRun, { source_path: sourcePath });
  }

  async #executeS3(input: WorkspaceCutoutGroupInput, source: AuthorizedS3Source, activeRun?: WorkflowRun): Promise<unknown> {
    const bridge = await createS3RangeBridge(source);
    try {
      return await this.#executeWithPython(input, activeRun, {
        source_url: bridge.url,
        source_size: bridge.size,
        source_token: bridge.token,
      });
    } finally {
      await bridge.close();
    }
  }

  async #executeWithPython(
    input: WorkspaceCutoutGroupInput,
    activeRun: WorkflowRun | undefined,
    source: Record<string, unknown>,
  ): Promise<unknown> {
    const run = activeRun ?? await this.options.store.get(input.run_id);
    if (run.id !== input.run_id) throw new Error("Workflow run identity mismatch");
    const stagingRoot = await mkdtemp(path.join(os.tmpdir(), "asa-fits-cutout-"));
    try {
      const report = await runPython({
        run_id: input.run_id,
        telescope: input.telescope,
        band: input.band,
        size_deg: input.size_deg,
        ...source,
        output_root: stagingRoot,
        targets: input.targets,
      });
      const results: PythonCutoutResult[] = Array.isArray(report.results)
        ? report.results.map((item) => asRecord(item)).filter((item): item is Record<string, unknown> => Boolean(item)).map((item) => ({
          status: item.status === "ok" ? "ok" : "error",
          row_index: Number(item.row_index),
          obj_id: String(item.obj_id ?? ""),
          ra_deg: Number(item.ra_deg),
          dec_deg: Number(item.dec_deg),
          ...(typeof item.output_path === "string" ? { output_path: item.output_path } : {}),
          ...(typeof item.error === "string" ? { error: item.error } : {}),
          ...(asRecord(item.meta) ? { meta: asRecord(item.meta) as PythonCutoutResult["meta"] } : {}),
        }))
        : [];
      const returnedRows = new Set(results.map((result) => result.row_index));
      for (const target of input.targets) {
        if (!returnedRows.has(target.row_index)) results.push({
          status: "error",
          row_index: target.row_index,
          obj_id: target.obj_id,
          ra_deg: target.ra_deg,
          dec_deg: target.dec_deg,
          error: "MissingResult",
        });
      }

      const pendingArtifacts: Array<{ result: PythonCutoutResult; name: string; content: Buffer }> = [];
      for (const result of results) {
        if (result.status !== "ok" || !result.output_path) continue;
        const outputPath = path.resolve(result.output_path);
        if (!outputPath.startsWith(`${path.resolve(stagingRoot)}${path.sep}`)) throw new Error("FITS cutout output escaped its staging directory");
        const filename = path.basename(outputPath);
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.fits$/.test(filename)) throw new Error("FITS cutout generated an invalid artifact name");
        const details = await stat(outputPath);
        if (details.size > MAX_ARTIFACT_BYTES) {
          result.status = "error";
          result.error = "ArtifactTooLarge";
          delete result.output_path;
          continue;
        }
        pendingArtifacts.push({ result, name: filename, content: await readFile(outputPath) });
      }
      const artifacts = await this.options.store.writeArtifactsForRun(input.run_id,
        pendingArtifacts.map(({ name, content }) => ({ name, mediaType: "application/fits", rowCount: 1, content })));
      const artifactsByName = new Map(artifacts.map((artifact) => [artifact.name, artifact]));
      for (const { result, name } of pendingArtifacts) {
        const artifact = artifactsByName.get(name);
        if (!artifact) throw new Error("FITS cutout artifact registration failed");
        (result as PythonCutoutResult & { output_uri?: string; artifact_name?: string }).output_uri = `/api/workflow-runs/${encodeURIComponent(input.run_id)}/artifacts/${encodeURIComponent(artifact.name)}`;
        (result as PythonCutoutResult & { artifact_name?: string }).artifact_name = artifact.name;
        delete result.output_path;
      }
      return { resolved_source_uri: input.source_uri, results };
    } finally {
      await rm(stagingRoot, { recursive: true, force: true });
    }
  }
}

async function runPython(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const python = process.env.ASTRO_PYTHON_BIN?.trim() || "python3";
  const env: NodeJS.ProcessEnv = { PYTHONUNBUFFERED: "1" };
  for (const name of ["PATH", "PYTHONPATH", "PYTHONHOME", "LD_LIBRARY_PATH", "SSL_CERT_FILE", "SSL_CERT_DIR", "TMPDIR", "TEMP", "TMP"]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(python, [CUTOUT_SCRIPT], { stdio: ["pipe", "pipe", "pipe"], env });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let spawnError: Error | undefined;
    child.once("error", (error) => { spawnError = error; });
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_CHILD_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        return;
      }
      stdout.push(Buffer.from(chunk));
    });
    child.stdin.on("error", () => undefined);
    child.once("close", (code) => {
      if (spawnError) return reject(new Error(`Unable to start FITS cutout helper: ${spawnError.name}`));
      if (stdoutBytes > MAX_CHILD_OUTPUT_BYTES) return reject(new RangeError("FITS cutout helper response exceeded 1 MiB"));
      if (code !== 0) return reject(new Error("FITS cutout helper failed"));
      try {
        const value: unknown = JSON.parse(Buffer.concat(stdout).toString("utf8"));
        const record = asRecord(value);
        if (!record) throw new Error("FITS cutout helper returned an invalid response");
        resolve(record);
      } catch {
        reject(new Error("FITS cutout helper returned invalid JSON"));
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}
