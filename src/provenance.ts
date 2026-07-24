import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export interface ContentFingerprint {
  role: string;
  uri: string;
  fileName: string;
  mediaType: string;
  byteLength: number;
  modifiedAt: string;
  sha256: string;
}

export interface ScanRunOutput {
  role: string;
  artifactId: string;
  fileName: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
}

export interface ScanRun {
  schemaVersion: 1;
  id: string;
  kind: "redshift-volume" | "survey-atlas";
  status: "succeeded";
  startedAt: string;
  completedAt: string;
  producer: {
    name: string;
    version: string;
    gitCommit: string | null;
    codeSha256: string;
  };
  configSha256: string;
  parameters: Record<string, unknown>;
  inputs: ContentFingerprint[];
  outputs: ScanRunOutput[];
  lineage: Array<{
    from: string;
    to: string;
    relation: "derived_from";
  }>;
}

export interface LineageNode {
  id: string;
  kind: "source" | "artifact";
  sha256: string;
  fileName: string;
  mediaType: string;
  byteLength: number;
  artifactId?: string;
}

export interface LineageEdge {
  from: string;
  to: string;
  relation: "derived_from";
  scanRunId: string;
}

export interface LineageGraph {
  artifactId: string;
  nodes: LineageNode[];
  edges: LineageEdge[];
  scanRuns: ScanRun[];
}

function parseJson(text: string): unknown {
  return JSON.parse(text.replace(/^\uFEFF/, "")) as unknown;
}

function contentId(sha256: string): string {
  return `urn:sha256:${sha256}`;
}

function assertFingerprint(value: ContentFingerprint | ScanRunOutput, context: string): void {
  if (!SHA256_PATTERN.test(value.sha256) || !Number.isInteger(value.byteLength) || value.byteLength < 0) {
    throw new Error(`Invalid content fingerprint in scan run: ${context}`);
  }
  if (path.basename(value.fileName) !== value.fileName) {
    throw new Error(`Invalid provenance file name in scan run: ${context}`);
  }
}

function assertScanRun(value: unknown, directoryName: string): ScanRun {
  if (!value || typeof value !== "object") throw new Error(`Invalid scan run: ${directoryName}`);
  const run = value as Partial<ScanRun>;
  if (run.schemaVersion !== 1 || !run.id || !ID_PATTERN.test(run.id) || run.status !== "succeeded") {
    throw new Error(`Invalid scan run identity: ${directoryName}`);
  }
  if ((run.kind !== "redshift-volume" && run.kind !== "survey-atlas") || !Array.isArray(run.inputs) || !Array.isArray(run.outputs) || !Array.isArray(run.lineage)) {
    throw new Error(`Invalid scan run payload: ${run.id}`);
  }
  if (!run.producer || !SHA256_PATTERN.test(run.producer.codeSha256) || !run.configSha256 || !SHA256_PATTERN.test(run.configSha256)) {
    throw new Error(`Invalid scan run producer: ${run.id}`);
  }
  run.inputs.forEach((input) => assertFingerprint(input, run.id!));
  run.outputs.forEach((output) => assertFingerprint(output, run.id!));
  return run as ScanRun;
}

export class ScanRunCatalog {
  readonly #root: string;

  constructor(root: string) {
    this.#root = path.resolve(root);
  }

  async list(): Promise<ScanRun[]> {
    let entries;
    try {
      entries = await readdir(this.#root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const runs: ScanRun[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) continue;
      try {
        const raw = await readFile(path.join(this.#root, entry.name, "scan-run.json"), "utf8");
        runs.push(assertScanRun(parseJson(raw), entry.name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return runs.sort((left, right) => right.completedAt.localeCompare(left.completedAt));
  }

  async get(id: string): Promise<ScanRun> {
    if (!ID_PATTERN.test(id)) throw new RangeError("Invalid scan run id");
    const run = (await this.list()).find((candidate) => candidate.id === id);
    if (!run) throw new Error(`Scan run not found: ${id}`);
    return run;
  }

  async lineage(artifactId: string): Promise<LineageGraph> {
    if (!ID_PATTERN.test(artifactId)) throw new RangeError("Invalid artifact id");
    const runs = await this.list();
    const outputRunByHash = new Map<string, ScanRun>();
    for (const run of runs) {
      for (const output of run.outputs) outputRunByHash.set(output.sha256, run);
    }

    const selectedRuns = new Map<string, ScanRun>();
    const queue = runs.filter((run) => run.outputs.some((output) => output.artifactId === artifactId));
    while (queue.length > 0) {
      const run = queue.shift()!;
      if (selectedRuns.has(run.id)) continue;
      selectedRuns.set(run.id, run);
      for (const input of run.inputs) {
        const parent = outputRunByHash.get(input.sha256);
        if (parent && !selectedRuns.has(parent.id)) queue.push(parent);
      }
    }
    if (selectedRuns.size === 0) throw new Error(`Lineage not found: ${artifactId}`);

    const nodes = new Map<string, LineageNode>();
    const edges: LineageEdge[] = [];
    for (const run of selectedRuns.values()) {
      for (const input of run.inputs) {
        const id = contentId(input.sha256);
        nodes.set(id, { id, kind: outputRunByHash.has(input.sha256) ? "artifact" : "source", sha256: input.sha256, fileName: input.fileName, mediaType: input.mediaType, byteLength: input.byteLength });
      }
      for (const output of run.outputs) {
        const id = contentId(output.sha256);
        nodes.set(id, { id, kind: "artifact", sha256: output.sha256, fileName: output.fileName, mediaType: output.mediaType, byteLength: output.byteLength, artifactId: output.artifactId });
      }
      edges.push(...run.lineage.map((edge) => ({ ...edge, scanRunId: run.id })));
    }
    return { artifactId, nodes: [...nodes.values()], edges, scanRuns: [...selectedRuns.values()] };
  }
}
