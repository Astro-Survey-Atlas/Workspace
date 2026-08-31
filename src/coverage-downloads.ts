import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ConnectorRecord, ConnectorRegistrationInput } from "./connectors.js";
import { assertPublicHttpUrl, type RemoteHostnameResolver } from "./remote-url-policy.js";

export interface CoverageDownloadFile {
  url: string;
  name: string;
  sizeBytes?: number;
  sha256?: string;
  sourceId?: string;
}

export type CoverageDownloadStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type CoverageDownloadPhase = "queued" | "downloading" | "verifying" | "registering" | "completed" | "failed" | "cancelled";

export interface CoverageDownloadJob {
  id: string;
  status: CoverageDownloadStatus;
  phase: CoverageDownloadPhase;
  files: CoverageDownloadFile[];
  downloadedFiles: number;
  totalFiles: number;
  downloadedBytes: number;
  totalBytes: number;
  /** Maximum number of files downloaded concurrently. */
  concurrency?: number;
  outputConnectorId?: string;
  outputPath?: string;
  componentId?: string;
  sourceIds?: string[];
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CoverageDownloadServiceOptions {
  root: string;
  statePath?: string;
  connectorPath?: string;
  registerConnector?: (input: ConnectorRegistrationInput) => Promise<ConnectorRecord>;
  fetchImpl?: typeof fetch;
  resolveHostname?: RemoteHostnameResolver;
  skipDnsLookup?: boolean;
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

export interface CoverageDownloadSubmitInput {
  files: readonly CoverageDownloadFile[];
  componentId?: string;
  sourceIds?: readonly string[];
  concurrency?: number;
  /** Internal server-owned output root. Browser callers cannot set this. */
  outputRoot?: string;
  /** Internal safe directory name used below outputRoot. */
  outputPrefix?: string;
}

interface PersistedState {
  schemaVersion: 1;
  jobs: CoverageDownloadJob[];
}

const DEFAULT_MAX_FILES = 128;
const DEFAULT_MAX_FILE_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2000) || "Coverage download failed";
}

function normalizedFile(value: unknown, index: number): CoverageDownloadFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RangeError(`files[${index}] must be an object`);
  const entry = value as Partial<CoverageDownloadFile>;
  if (typeof entry.url !== "string" || !entry.url.trim()) throw new RangeError(`files[${index}].url is required`);
  let url: URL;
  try { url = new URL(entry.url.trim()); } catch { throw new RangeError(`files[${index}].url is invalid`); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new RangeError(`files[${index}].url must use HTTP or HTTPS`);
  if (typeof entry.name !== "string" || !entry.name.trim()) throw new RangeError(`files[${index}].name is required`);
  const name = path.basename(entry.name.trim());
  if (!name || name === "." || name === ".." || name !== entry.name.trim() || name.length > 180) throw new RangeError(`files[${index}].name must be a simple file name`);
  const sizeBytes = entry.sizeBytes === undefined ? undefined : Number(entry.sizeBytes);
  if (sizeBytes !== undefined && (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0)) throw new RangeError(`files[${index}].sizeBytes is invalid`);
  const sha256 = entry.sha256 === undefined ? undefined : String(entry.sha256).trim().toLowerCase();
  if (sha256 !== undefined && !/^[a-f0-9]{64}$/.test(sha256)) throw new RangeError(`files[${index}].sha256 is invalid`);
  const sourceId = entry.sourceId === undefined ? undefined : String(entry.sourceId).trim() || undefined;
  return { url: url.href, name, ...(sizeBytes === undefined ? {} : { sizeBytes }), ...(sha256 === undefined ? {} : { sha256 }), ...(sourceId ? { sourceId } : {}) };
}

function validJob(value: unknown): value is CoverageDownloadJob {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const job = value as Partial<CoverageDownloadJob>;
  return typeof job.id === "string" && typeof job.status === "string" && typeof job.phase === "string" && Array.isArray(job.files)
    && Number.isSafeInteger(job.downloadedFiles) && Number.isSafeInteger(job.totalFiles)
    && Number.isSafeInteger(job.downloadedBytes) && Number.isSafeInteger(job.totalBytes)
    && typeof job.createdAt === "string" && typeof job.updatedAt === "string";
}

/**
 * File-oriented download workflow. The browser only submits URL metadata; the
 * server owns the filesystem, checksums, cancellation, and Connector handoff.
 */
export class CoverageDownloadService {
  readonly #root: string;
  readonly #statePath: string;
  readonly #connectorPath?: string;
  readonly #registerConnector?: CoverageDownloadServiceOptions["registerConnector"];
  readonly #fetch: typeof fetch;
  readonly #resolveHostname?: RemoteHostnameResolver;
  readonly #skipDnsLookup: boolean;
  readonly #maxFiles: number;
  readonly #maxFileBytes: number;
  readonly #maxTotalBytes: number;
  readonly #jobs = new Map<string, CoverageDownloadJob>();
  readonly #abortControllers = new Map<string, AbortController>();
  #initialized = false;
  #persisting: Promise<void> = Promise.resolve();

  constructor(options: CoverageDownloadServiceOptions) {
    if (!options.root || !path.isAbsolute(options.root)) throw new RangeError("coverage download root must be absolute");
    this.#root = path.resolve(options.root);
    this.#statePath = options.statePath ?? path.join(this.#root, "jobs.json");
    this.#connectorPath = options.connectorPath;
    this.#registerConnector = options.registerConnector;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#resolveHostname = options.resolveHostname;
    this.#skipDnsLookup = options.skipDnsLookup ?? Boolean(options.fetchImpl && !options.resolveHostname);
    this.#maxFiles = Math.max(1, Math.min(DEFAULT_MAX_FILES, options.maxFiles ?? DEFAULT_MAX_FILES));
    this.#maxFileBytes = Math.max(1, options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES);
    this.#maxTotalBytes = Math.max(this.#maxFileBytes, options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES);
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    this.#initialized = true;
    let recoveredAny = false;
    try {
      const parsed = JSON.parse(await readFile(this.#statePath, "utf8")) as Partial<PersistedState>;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.jobs)) throw new Error("coverage download state has an unsupported schema");
      parsed.jobs.filter(validJob).forEach((job) => {
        const restored = job.status === "queued" || job.status === "running"
          ? { ...job, status: "failed" as const, phase: "failed" as const, error: "Download process interrupted before completion", updatedAt: new Date().toISOString() }
          : job;
        if (restored !== job) recoveredAny = true;
        this.#jobs.set(restored.id, clone(restored));
      });
      if (recoveredAny) await this.#persist();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("Ignoring invalid coverage download state", error);
    }
  }

  async list(): Promise<CoverageDownloadJob[]> {
    await this.initialize();
    return [...this.#jobs.values()].map(clone).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async get(id: string): Promise<CoverageDownloadJob> {
    await this.initialize();
    const job = this.#jobs.get(id);
    if (!job) throw new Error(`Coverage download job not found: ${id}`);
    return clone(job);
  }

  async submit(input: CoverageDownloadSubmitInput): Promise<CoverageDownloadJob> {
    await this.initialize();
    // Downloads are deliberately isolated into a new directory and handed off
    // to a newly registered Connector. A target Connector would need an
    // explicit append/overwrite contract; rejecting the legacy no-op field is
    // safer than silently writing somewhere else than the caller expects.
    const legacyTarget = (input as { targetConnectorId?: unknown }).targetConnectorId;
    if (legacyTarget !== undefined) throw new RangeError("targetConnectorId is not supported; coverage downloads create a new Connector");
    if (!Array.isArray(input.files) || input.files.length < 1 || input.files.length > this.#maxFiles) throw new RangeError(`files must contain between 1 and ${this.#maxFiles} entries`);
    const files = input.files.map((file, index) => normalizedFile(file, index));
    await Promise.all(files.map((file) => assertPublicHttpUrl(file.url, { resolveHostname: this.#resolveHostname, skipDnsLookup: this.#skipDnsLookup })));
    if (new Set(files.map((file) => file.name)).size !== files.length) throw new RangeError("files must not contain duplicate names");
    const totalBytes = files.reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0);
    if (totalBytes > this.#maxTotalBytes) throw new RangeError("declared download size exceeds the Workspace limit");
    const concurrency = input.concurrency === undefined ? 4 : input.concurrency;
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new RangeError("concurrency must be an integer between 1 and 16");
    if (input.outputRoot !== undefined && (!input.outputRoot || !path.isAbsolute(input.outputRoot))) throw new RangeError("outputRoot must be an absolute path");
    const outputRoot = input.outputRoot === undefined ? undefined : path.normalize(input.outputRoot);
    const outputPrefix = input.outputPrefix === undefined ? undefined : input.outputPrefix.trim();
    if (outputPrefix !== undefined && (!outputPrefix || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(outputPrefix))) throw new RangeError("outputPrefix must be a safe directory name");
    const now = new Date().toISOString();
    const id = `coverage-download-${randomUUID()}`;
    const job: CoverageDownloadJob = {
      id,
      status: "queued",
      phase: "queued",
      files,
      downloadedFiles: 0,
      totalFiles: files.length,
      downloadedBytes: 0,
      totalBytes,
      concurrency,
      ...(input.componentId ? { componentId: input.componentId } : {}),
      ...(input.sourceIds?.length ? { sourceIds: [...new Set(input.sourceIds)] } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.#jobs.set(id, job);
    await this.#persist();
    void this.#run(id, outputRoot, outputPrefix);
    return clone(job);
  }

  async cancel(id: string): Promise<CoverageDownloadJob> {
    await this.initialize();
    const job = this.#jobs.get(id);
    if (!job) throw new Error(`Coverage download job not found: ${id}`);
    if (job.status === "queued") {
      this.#update(job, { status: "cancelled", phase: "cancelled", error: "Cancelled by user" });
      await this.#persist();
    } else if (job.status === "running") {
      this.#abortControllers.get(id)?.abort();
    }
    return clone(job);
  }

  async #run(id: string, outputRoot?: string, outputPrefix?: string): Promise<void> {
    const job = this.#jobs.get(id);
    if (!job || job.status !== "queued") return;
    const controller = new AbortController();
    this.#abortControllers.set(id, controller);
    const directory = outputRoot
      ? path.join(outputRoot, outputPrefix ?? id)
      : path.join(this.#root, "files", outputPrefix ?? id);
    try {
      this.#update(job, { status: "running", phase: "downloading" });
      await this.#persist();
      await mkdir(directory, { recursive: true });
      let nextFile = 0;
      const downloadOne = async (): Promise<void> => {
        while (true) {
          const file = job.files[nextFile++];
          if (!file) return;
        if (controller.signal.aborted) throw new DOMException("Download cancelled", "AbortError");
        await assertPublicHttpUrl(file.url, { resolveHostname: this.#resolveHostname, skipDnsLookup: this.#skipDnsLookup });
        const response = await this.#fetch(file.url, { method: "GET", redirect: "error", signal: controller.signal });
        if (!response.ok) throw new Error(`Download returned HTTP ${response.status}: ${file.url}`);
        const declaredLength = Number(response.headers.get("content-length") ?? "");
        if (Number.isSafeInteger(declaredLength) && declaredLength > this.#maxFileBytes) throw new Error(`Download exceeds the per-file limit: ${file.name}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > this.#maxFileBytes) throw new Error(`Download exceeds the per-file limit: ${file.name}`);
        this.#update(job, { phase: "verifying" });
        if (file.sizeBytes !== undefined && bytes.byteLength !== file.sizeBytes) throw new Error(`Size mismatch for ${file.name}`);
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        if (file.sha256 && sha256 !== file.sha256) throw new Error(`SHA-256 mismatch for ${file.name}`);
        const downloadedBytes = job.downloadedBytes + bytes.byteLength;
        if (downloadedBytes > this.#maxTotalBytes) throw new Error("Downloaded files exceed the Workspace total size limit");
        await writeFile(path.join(directory, file.name), bytes, { flag: "wx" });
        const totalBytes = Math.max(job.totalBytes, downloadedBytes);
        this.#update(job, { phase: "downloading", downloadedFiles: job.downloadedFiles + 1, downloadedBytes, totalBytes });
        await this.#persist();
        }
      };
      const workers = Array.from({ length: Math.min(job.concurrency ?? 1, job.files.length) }, () => downloadOne());
      const workerResults = await Promise.allSettled(workers);
      const failedWorker = workerResults.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failedWorker) throw failedWorker.reason;
      this.#update(job, { phase: "registering" });
      await this.#persist();
      if (!this.#registerConnector) throw new Error("No Connector registrar is configured for coverage downloads");
      const connectorPath = this.#connectorPath ?? directory;
      const connector = await this.#registerConnector({
        name: `Coverage download ${id.slice(-12)}`,
        description: `Workspace coverage download ${id}`,
        kind: "local",
        config: { rootPath: connectorPath },
        status: "ready",
      });
      this.#update(job, { status: "completed", phase: "completed", outputConnectorId: connector.id, outputPath: connectorPath });
      await this.#persist();
    } catch (error) {
      const cancelled = controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError");
      this.#update(job, {
        status: cancelled ? "cancelled" : "failed",
        phase: cancelled ? "cancelled" : "failed",
        error: cancelled ? "Cancelled by user" : errorText(error),
      });
      await this.#persist();
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    } finally {
      this.#abortControllers.delete(id);
    }
  }

  #update(job: CoverageDownloadJob, update: Partial<CoverageDownloadJob>): void {
    Object.assign(job, update, { updatedAt: new Date().toISOString() });
  }

  async #persist(): Promise<void> {
    const state: PersistedState = { schemaVersion: 1, jobs: [...this.#jobs.values()].map(clone) };
    this.#persisting = this.#persisting.then(async () => {
      await mkdir(path.dirname(this.#statePath), { recursive: true });
      const temporary = `${this.#statePath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
        await rename(temporary, this.#statePath);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    });
    return this.#persisting;
  }
}
