import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { createGunzip } from "node:zlib";
import { Tokenizer, TokenParser, TokenType } from "@streamparser/json";
import type { ConnectorIngestRunRecord } from "./connector-history.js";
import { streamWarehouseEvidence } from "./warehouse-evidence-stream.js";

export interface ScanInventoryFile {
  uri?: string;
  localPath?: string;
  objectKey?: string;
  size?: number;
}

/** Read a finite inventory with backpressure, retaining only the current chunk. */
export async function streamInventoryArray(filename: string, row: (value: Record<string, unknown>) => void, afterChunk?: () => Promise<void>): Promise<void> {
  const parser = new TokenParser({ paths: ["$.*"], keepStack: false });
  parser.onValue = ({ value, stack }) => {
    if (stack.length !== 1) return;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Inventory row must be an object");
    row(value as Record<string, unknown>);
  };
  let first = true;
  const tokenizer = new Tokenizer({ stringBufferSize: 65536, numberBufferSize: 64 });
  tokenizer.onToken = token => {
    if (first && token.token !== TokenType.LEFT_BRACKET) throw new Error("Inventory must be an array");
    first = false;
    parser.write(token);
  };
  const source = createReadStream(filename, { highWaterMark: 256 * 1024 });
  const input = filename.endsWith(".gz") ? source.pipe(createGunzip({ chunkSize: 1024 * 1024 })) : source;
  source.on("error", error => input.destroy(error));
  try {
    for await (const chunk of input) { tokenizer.write(chunk); await afterChunk?.(); }
    if (!tokenizer.isEnded) tokenizer.end();
    if (!parser.isEnded) parser.end();
    if (first) throw new Error("Empty inventory document");
  } finally { source.destroy(); input.destroy(); }
}

export async function readSuccessfulScanInventory(
  run: ConnectorIngestRunRecord,
  options: { workspaceScanRoot: string; evidenceRoot?: string },
  row: (file: ScanInventoryFile) => void,
  flush: () => Promise<void>,
): Promise<void> {
  if (run.executor === "workspace") {
    if (!/^[a-zA-Z0-9-]+$/.test(run.id)) throw new Error("Invalid Workspace scan identity");
    let count = 0;
    await streamWarehouseEvidence(path.join(options.workspaceScanRoot, `${run.id}.json`), (kind, value) => {
      if (kind !== "files") return;
      row(value as ScanInventoryFile); count++;
    }, flush);
    if (run.fileCount !== undefined && run.fileCount !== count) throw new Error("Workspace inventory count mismatch");
    return;
  }
  const root = options.evidenceRoot && path.resolve(options.evidenceRoot);
  const directory = run.evidencePath && path.resolve(run.evidencePath);
  if (!root || !directory?.startsWith(`${root}${path.sep}`)) throw new Error("Scan evidence is outside the evidence mount");
  const summary = JSON.parse(await readFile(path.join(directory, "summary.json"), "utf8")) as Record<string, unknown>;
  if (summary.phase !== "COMPLETED" || summary.scanRunId !== run.batchId || summary.layerId !== run.warehouseLayerId
    || !run.sourceSnapshotSha256 || summary.sourceSnapshotSha256 !== run.sourceSnapshotSha256
    || run.fileCount !== undefined && summary.fileCount !== run.fileCount) throw new Error("Completed scan evidence identity mismatch");
  let filename: string | undefined;
  for (const candidate of ["source-inventory.json.gz", "source-inventory.json"]) {
    const selected = path.join(directory, candidate);
    if (await access(selected).then(() => true, () => false)) { filename = selected; break; }
  }
  let count = 0;
  if (filename) {
    const hash = createHash("sha256");
    await streamInventoryArray(filename, value => {
      if (typeof value.sourceUri !== "string" || typeof value.fileId !== "string") throw new Error("Invalid source inventory row");
      hash.update(JSON.stringify(value)); hash.update("\n");
      row({ uri: value.sourceUri, size: typeof value.sizeBytes === "number" && value.sizeBytes >= 0 ? value.sizeBytes : undefined });
      count++;
    }, flush);
    if (hash.digest("hex") !== run.sourceSnapshotSha256) throw new Error("Source inventory checksum mismatch");
  } else {
    const metadata = await streamWarehouseEvidence(path.join(directory, "normalized-scan.json"), (kind, value) => {
      if (kind !== "files") return;
      if (value.layer_id !== undefined && value.layer_id !== run.warehouseLayerId
        || value.scan_run_id !== undefined && value.scan_run_id !== run.batchId) throw new Error("File evidence identity mismatch");
      if (typeof value.source_uri !== "string") throw new Error("Missing file source URI");
      row({ uri: value.source_uri, size: typeof value.size_bytes === "number" ? value.size_bytes : undefined }); count++;
    }, flush);
    if (metadata.phase !== "COMPLETED" || metadata.scanRunId !== run.batchId || metadata.layerId !== run.warehouseLayerId
      || (metadata.sourceSnapshot as { sha256?: string } | undefined)?.sha256 !== run.sourceSnapshotSha256) throw new Error("Normalized inventory identity mismatch");
  }
  if (count !== summary.fileCount || run.fileCount !== undefined && count !== run.fileCount) throw new Error("Historical inventory is incomplete");
}
