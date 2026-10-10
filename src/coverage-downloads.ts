import { randomUUID, createHash } from "node:crypto";
import type { Hash } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { assertPublicHttpUrl, type RemoteHostnameResolver } from "./remote-url-policy.js";
import { fetchPublicHttp } from "./public-http.js";
import type { ConnectorRegistrationInput, ConnectorRecord } from "./connectors.js";
import { validateRelativePath } from "./source-crawler.js";

export interface CoverageDownloadFile {
  url: string;
  name: string;
  /** Hierarchical destination path. Defaults to the flat `name`. */
  relativePath?: string;
  sizeBytes?: number;
  sha256?: string;
  etag?: string;
  lastModified?: string;
  sourceId?: string;
  unitId?: string;
  nativeUnitId?: string;
  nativeUnitKind?: string;
  layerId?: string;
}

export type CoverageDownloadStatus = "queued" | "running" | "completed" | "partial" | "failed" | "cancelled";
export type CoverageDownloadPhase = "queued" | "resuming" | "downloading" | "verifying" | "registering" | "completed" | "partial" | "failed" | "cancelled";
export type CoverageFileTransferStatus = "pending" | "partial" | "verified" | "failed";

export interface CoverageDownloadFileState {
  url: string;
  name: string;
  relativePath: string;
  status: CoverageFileTransferStatus;
  bytesPresent: number;
  expectedSizeBytes?: number;
  actualSizeBytes?: number;
  expectedSha256?: string;
  actualSha256?: string;
  etag?: string;
  lastModified?: string;
  error?: string;
  sourceId?: string;
  unitId?: string;
  nativeUnitId?: string;
  nativeUnitKind?: string;
  layerId?: string;
}

export interface CoverageDownloadJob {
  id: string;
  status: CoverageDownloadStatus;
  phase: CoverageDownloadPhase;
  files: CoverageDownloadFile[];
  transfer: CoverageDownloadFileState[];
  downloadedFiles: number;
  totalFiles: number;
  downloadedBytes: number;
  totalBytes: number;
  concurrency?: number;
  outputRoot?: string;
  outputConnectorId?: string;
  outputPath?: string;
  outputPrefix?: string;
  requestKey?: string;
  inventorySha256?: string;
  componentId?: string;
  sourceIds?: string[];
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CoverageDownloadOptions {
  root: string;
  statePath?: string;
  connectorPath?: string;
  registerConnector?: (input: ConnectorRegistrationInput) => Promise<ConnectorRecord>;
  fetchImpl?: typeof fetch;
  resolveHostname?: RemoteHostnameResolver;
  skipDnsLookup?: boolean;
  maxFiles?: number;
}

export interface CoverageDownloadSubmitInput {
  files: CoverageDownloadFile[];
  componentId?: string;
  sourceIds?: string[];
  concurrency?: number;
  outputRoot?: string;
  outputPrefix?: string;
  /** Deterministic idempotency key; duplicates reuse the existing job/staging. */
  requestKey?: string;
  inventorySha256?: string;
  /** @deprecated Legacy field rejected explicitly. */
  targetConnectorId?: string;
}

interface PersistedState {
  schemaVersion: number;
  jobs: CoverageDownloadJob[];
}

const DEFAULT_MAX_FILES = 128;
const COPY_CHUNK_BYTES = 1024 * 1024;
const MAX_TRANSFER_RETRIES = 3;

function now(): string { return new Date().toISOString(); }

function clone<T>(value: T): T { return structuredClone(value); }

function safeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Strong validator for If-Range: a quoted non-weak ETag, or Last-Modified. */
function strongValidator(etag: string | undefined, lastModified: string | undefined): string | undefined {
  if (etag && !etag.startsWith("W/") && etag.startsWith('"')) return etag;
  return lastModified;
}

class RetryableDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableDownloadError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "name" in error && (error as { name?: unknown }).name === "AbortError");
}

function waitForRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

function basenameOf(relativePath: string): string {
  return relativePath.split("/").pop() ?? relativePath;
}

/** Stream file bytes into an incremental hash without buffering the file. */
async function hashInto(filePath: string, hash: Hash): Promise<number> {
  const handle = await open(filePath, "r");
  try {
    const stats = await handle.stat();
    const buffer = Buffer.allocUnsafe(Math.min(COPY_CHUNK_BYTES, Math.max(stats.size, 1)));
    let position = 0;
    while (position < stats.size) {
      const { bytesRead } = await handle.read({ buffer, position });
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return stats.size;
  } finally {
    await handle.close();
  }
}

async function hashFile(filePath: string): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = createHash("sha256");
  const sizeBytes = await hashInto(filePath, hash);
  return { sha256: hash.digest("hex"), sizeBytes };
}

interface NormalizedFilePlan {
  url: string;
  name: string;
  relativePath: string;
  sizeBytes?: number;
  sha256?: string;
  etag?: string;
  lastModified?: string;
  sourceId?: string;
  unitId?: string;
  nativeUnitId?: string;
  nativeUnitKind?: string;
  layerId?: string;
}

function normalizedFile(input: CoverageDownloadFile): NormalizedFilePlan {
  if (!input || typeof input !== "object") throw new RangeError("each file must be an object");
  if (typeof input.url !== "string" || !input.url.trim()) throw new RangeError("file url is required");
  let relativePath: string;
  if (input.relativePath !== undefined) {
    relativePath = validateRelativePath(input.relativePath);
  } else {
    if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 180) throw new RangeError("file name must contain 1..180 characters");
    if (path.basename(input.name) !== input.name) throw new RangeError("file name must be a simple basename; use relativePath for hierarchy");
    relativePath = input.name;
  }
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : basenameOf(relativePath);
  const sizeBytes = safeInteger(input.sizeBytes);
  const sha256 = typeof input.sha256 === "string" && /^[a-f0-9]{64}$/i.test(input.sha256) ? input.sha256.toLowerCase() : undefined;
  return {
    url: input.url.trim(),
    name,
    relativePath,
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
    ...(sha256 ? { sha256 } : {}),
    ...(typeof input.etag === "string" && input.etag ? { etag: input.etag } : {}),
    ...(typeof input.lastModified === "string" && input.lastModified ? { lastModified: input.lastModified } : {}),
    ...(typeof input.sourceId === "string" && input.sourceId.trim() ? { sourceId: input.sourceId.trim() } : {}),
    ...(typeof input.unitId === "string" && input.unitId.trim() ? { unitId: input.unitId.trim() } : {}),
    ...(typeof input.nativeUnitId === "string" && input.nativeUnitId.trim() ? { nativeUnitId: input.nativeUnitId.trim() } : {}),
    ...(typeof input.nativeUnitKind === "string" && input.nativeUnitKind.trim() ? { nativeUnitKind: input.nativeUnitKind.trim() } : {}),
    ...(typeof input.layerId === "string" && input.layerId.trim() ? { layerId: input.layerId.trim() } : {}),
  };
}

function transferState(plan: NormalizedFilePlan): CoverageDownloadFileState {
  return {
    url: plan.url,
    name: plan.name,
    relativePath: plan.relativePath,
    status: "pending",
    bytesPresent: 0,
    ...(plan.sizeBytes === undefined ? {} : { expectedSizeBytes: plan.sizeBytes }),
    ...(plan.sha256 ? { expectedSha256: plan.sha256 } : {}),
    ...(plan.etag ? { etag: plan.etag } : {}),
    ...(plan.lastModified ? { lastModified: plan.lastModified } : {}),
    ...(plan.sourceId ? { sourceId: plan.sourceId } : {}),
    ...(plan.unitId ? { unitId: plan.unitId } : {}),
    ...(plan.nativeUnitId ? { nativeUnitId: plan.nativeUnitId } : {}),
    ...(plan.nativeUnitKind ? { nativeUnitKind: plan.nativeUnitKind } : {}),
    ...(plan.layerId ? { layerId: plan.layerId } : {}),
  };
}

function publicFile(entry: CoverageDownloadFileState): CoverageDownloadFile {
  return {
    url: entry.url,
    name: entry.name,
    relativePath: entry.relativePath,
    ...(entry.expectedSizeBytes === undefined ? {} : { sizeBytes: entry.expectedSizeBytes }),
    ...(entry.expectedSha256 ? { sha256: entry.expectedSha256 } : {}),
    ...(entry.etag ? { etag: entry.etag } : {}),
    ...(entry.lastModified ? { lastModified: entry.lastModified } : {}),
    ...(entry.sourceId ? { sourceId: entry.sourceId } : {}),
    ...(entry.unitId ? { unitId: entry.unitId } : {}),
    ...(entry.nativeUnitId ? { nativeUnitId: entry.nativeUnitId } : {}),
    ...(entry.nativeUnitKind ? { nativeUnitKind: entry.nativeUnitKind } : {}),
    ...(entry.layerId ? { layerId: entry.layerId } : {}),
  };
}

function refreshProgress(job: CoverageDownloadJob): void {
  let bytes = 0;
  let files = 0;
  let declaredBytes = 0;
  job.transfer.forEach((entry) => {
    if (entry.status === "verified") {
      files += 1;
      bytes += entry.actualSizeBytes ?? entry.bytesPresent;
    } else if (entry.status === "partial") {
      bytes += entry.bytesPresent;
    }
    declaredBytes += entry.expectedSizeBytes ?? 0;
  });
  job.downloadedFiles = files;
  job.downloadedBytes = bytes;
  job.totalBytes = declaredBytes;
}

export class CoverageDownloadService {
  readonly #root: string;
  readonly #statePath: string;
  readonly #connectorPath?: string;
  readonly #registerConnector?: CoverageDownloadOptions["registerConnector"];
  readonly #fetchImpl: typeof fetch;
  readonly #resolveHostname?: RemoteHostnameResolver;
  readonly #skipDnsLookup: boolean;
  readonly #maxFiles: number;
  readonly #jobs = new Map<string, CoverageDownloadJob>();
  readonly #controllers = new Map<string, AbortController>();
  #persisting: Promise<void> = Promise.resolve();
  #initialized = false;

  constructor(options: CoverageDownloadOptions) {
    if (!options || !path.isAbsolute(options.root)) throw new RangeError("coverage download root must be absolute");
    this.#root = options.root;
    this.#statePath = options.statePath ?? path.join(this.#root, "jobs.json");
    this.#connectorPath = options.connectorPath;
    this.#registerConnector = options.registerConnector;
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.#resolveHostname = options.resolveHostname;
    this.#skipDnsLookup = options.skipDnsLookup ?? Boolean(options.fetchImpl && !options.resolveHostname);
    this.#maxFiles = Math.max(1, Math.min(4096, options.maxFiles ?? DEFAULT_MAX_FILES));
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    this.#initialized = true;
    let state: PersistedState | undefined;
    try {
      state = JSON.parse(await readFile(this.#statePath, "utf8")) as PersistedState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("Ignoring invalid coverage download state", error);
      return;
    }
    const jobs = Array.isArray(state?.jobs) ? state.jobs : [];
    for (const raw of jobs) {
      if (!raw || typeof raw !== "object" || typeof raw.id !== "string") continue;
      const job = raw as CoverageDownloadJob;
      if (!Array.isArray(job.transfer)) {
        job.transfer = Array.isArray(job.files) ? job.files.map((file) => transferState(normalizedFile(file))) : [];
      }
      job.files = job.transfer.map(publicFile);
      if (job.status === "queued" || job.status === "running") {
        // Active jobs cannot be reattached after a process restart. Staging
        // files and the per-file ledger are intentionally preserved so an
        // idempotent resubmission (requestKey) can resume instead of
        // restarting from zero.
        job.status = "failed";
        job.phase = "failed";
        job.error = "Download process interrupted before completion";
        job.transfer.forEach((entry) => {
          if (entry.status === "pending" || entry.status === "partial") {
            entry.status = entry.bytesPresent > 0 ? "partial" : "pending";
          }
        });
      }
      refreshProgress(job);
      this.#jobs.set(job.id, job);
    }
    await this.#persist();
  }

  async list(): Promise<CoverageDownloadJob[]> {
    await this.initialize();
    return [...this.#jobs.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(job => { refreshProgress(job); return clone(job); });
  }

  async get(id: string): Promise<CoverageDownloadJob> {
    await this.initialize();
    const job = this.#jobs.get(id);
    if (!job) throw new Error(`Coverage download not found: ${id}`);
    refreshProgress(job);
    return clone(job);
  }

  async submit(input: CoverageDownloadSubmitInput): Promise<CoverageDownloadJob> {
    await this.initialize();
    if (!input || typeof input !== "object") throw new RangeError("request body must be an object");
    if ("targetConnectorId" in input && input.targetConnectorId !== undefined) {
      throw new RangeError("targetConnectorId is not supported; downloads always create a new local Connector");
    }
    if (!Array.isArray(input.files) || input.files.length < 1 || input.files.length > this.#maxFiles) {
      throw new RangeError(`files must contain between 1 and ${this.#maxFiles} entries`);
    }
    const plans = input.files.map(normalizedFile);
    const seen = new Set<string>();
    plans.forEach((plan) => {
      if (seen.has(plan.relativePath)) throw new RangeError(`duplicate names are not allowed: ${plan.relativePath}`);
      seen.add(plan.relativePath);
    });
    for (const plan of plans) {
      await assertPublicHttpUrl(plan.url, { resolveHostname: this.#resolveHostname, skipDnsLookup: this.#skipDnsLookup });
    }
    const concurrency = input.concurrency === undefined ? 4 : input.concurrency;
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new RangeError("concurrency must be an integer between 1 and 16");
    const outputRoot = input.outputRoot === undefined ? undefined : path.resolve(input.outputRoot);
    if (outputRoot !== undefined && !path.isAbsolute(outputRoot)) throw new RangeError("outputRoot must be absolute");
    const outputPrefix = input.outputPrefix === undefined ? undefined : String(input.outputPrefix);
    if (outputPrefix !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(outputPrefix)) {
      throw new RangeError("outputPrefix must match [a-zA-Z0-9][a-zA-Z0-9._-]{0,127}");
    }
    const requestKey = input.requestKey === undefined ? undefined : String(input.requestKey).trim();
    if (requestKey !== undefined && (!requestKey || requestKey.length > 180)) throw new RangeError("requestKey must contain 1..180 characters");

    if (requestKey) {
      const existing = [...this.#jobs.values()]
        .filter((job) => job.requestKey === requestKey)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
      if (existing && (existing.status === "queued" || existing.status === "running" || existing.status === "completed")) {
        if (existing.inventorySha256 !== input.inventorySha256) throw new RangeError("requestKey belongs to a different download inventory");
        return clone(existing);
      }
      if (existing && existing.inventorySha256 && input.inventorySha256 && existing.inventorySha256 !== input.inventorySha256) {
        throw new RangeError(`下载清单与暂存目录不一致，无法复用 requestKey: ${requestKey}`);
      }
      const job = this.#createJob(plans, {
        concurrency,
        outputRoot: outputRoot ?? (existing?.outputRoot),
        outputPrefix: existing?.outputPrefix ?? outputPrefix,
        requestKey,
        inventorySha256: input.inventorySha256,
        componentId: input.componentId,
        sourceIds: input.sourceIds,
        resumeFrom: existing,
      });
      void this.#run(job.id);
      return clone(job);
    }

    const job = this.#createJob(plans, {
      concurrency,
      outputRoot,
      outputPrefix,
      requestKey,
      inventorySha256: input.inventorySha256,
      componentId: input.componentId,
      sourceIds: input.sourceIds,
    });
    void this.#run(job.id);
    return clone(job);
  }

  async cancel(id: string): Promise<CoverageDownloadJob> {
    await this.initialize();
    const job = this.#jobs.get(id);
    if (!job) throw new Error(`Coverage download not found: ${id}`);
    if (job.status === "queued") {
      job.status = "cancelled";
      job.phase = "cancelled";
      job.updatedAt = now();
      await this.#persist();
      return clone(job);
    }
    if (job.status === "running") {
      this.#controllers.get(id)?.abort();
      // The running worker finalizes the cancelled state; report the snapshot.
      return clone(job);
    }
    return clone(job);
  }

  #createJob(
    plans: NormalizedFilePlan[],
    context: {
      concurrency: number;
      outputRoot?: string;
      outputPrefix?: string;
      requestKey?: string;
      inventorySha256?: string;
      componentId?: string;
      sourceIds?: string[];
      resumeFrom?: CoverageDownloadJob;
    },
  ): CoverageDownloadJob {
    const id = `coverage-download-${randomUUID()}`;
    const timestamp = now();
    const job: CoverageDownloadJob = {
      id,
      status: "queued",
      phase: "queued",
      files: plans.map((plan) => ({
        url: plan.url,
        name: plan.name,
        relativePath: plan.relativePath,
        ...(plan.sizeBytes === undefined ? {} : { sizeBytes: plan.sizeBytes }),
        ...(plan.sha256 ? { sha256: plan.sha256 } : {}),
        ...(plan.etag ? { etag: plan.etag } : {}),
        ...(plan.lastModified ? { lastModified: plan.lastModified } : {}),
        ...(plan.sourceId ? { sourceId: plan.sourceId } : {}),
        ...(plan.unitId ? { unitId: plan.unitId } : {}),
        ...(plan.nativeUnitId ? { nativeUnitId: plan.nativeUnitId } : {}),
        ...(plan.nativeUnitKind ? { nativeUnitKind: plan.nativeUnitKind } : {}),
        ...(plan.layerId ? { layerId: plan.layerId } : {}),
      })),
      transfer: plans.map((plan) => {
        const current = transferState(plan);
        const previous = context.resumeFrom?.transfer.find((entry) => entry.url === current.url && entry.relativePath === current.relativePath);
        if (!previous
          || (current.expectedSizeBytes !== undefined && previous.expectedSizeBytes !== undefined && current.expectedSizeBytes !== previous.expectedSizeBytes)
          || (current.expectedSha256 && previous.expectedSha256 && current.expectedSha256 !== previous.expectedSha256)
          || (current.etag && previous.etag && current.etag !== previous.etag)
          || (current.lastModified && previous.lastModified && current.lastModified !== previous.lastModified)) return current;
        return {
          ...current,
          ...(current.expectedSizeBytes === undefined && previous.expectedSizeBytes !== undefined ? { expectedSizeBytes: previous.expectedSizeBytes } : {}),
          ...(current.expectedSha256 ? {} : previous.expectedSha256 ? { expectedSha256: previous.expectedSha256 } : {}),
          ...(current.etag ? {} : previous.etag ? { etag: previous.etag } : {}),
          ...(current.lastModified ? {} : previous.lastModified ? { lastModified: previous.lastModified } : {}),
        };
      }),
      downloadedFiles: 0,
      totalFiles: plans.length,
      downloadedBytes: 0,
      totalBytes: plans.reduce((sum, plan) => sum + (plan.sizeBytes ?? 0), 0),
      concurrency: context.concurrency,
      ...(context.outputRoot ? { outputRoot: context.outputRoot } : {}),
      ...(context.outputPrefix ? { outputPrefix: context.outputPrefix } : {}),
      ...(context.requestKey ? { requestKey: context.requestKey } : {}),
      ...(context.inventorySha256 ? { inventorySha256: context.inventorySha256 } : {}),
      ...(context.componentId ? { componentId: context.componentId } : {}),
      ...(context.sourceIds ? { sourceIds: context.sourceIds } : {}),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.#jobs.set(job.id, job);
    this.#persist().catch(() => undefined);
    return job;
  }

  #directoryFor(job: CoverageDownloadJob): string {
    const base = job.outputPrefix ?? job.id;
    return job.outputRoot ? path.join(job.outputRoot, base) : path.join(this.#root, "files", base);
  }

  async #transferWithRetries(job: CoverageDownloadJob, entry: CoverageDownloadFileState, directory: string, signal: AbortSignal): Promise<void> {
    for (let retry = 0; ; retry += 1) {
      if (signal.aborted) throw signal.reason ?? Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
      try {
        await this.#transferOne(job, entry, directory, signal);
        delete entry.error;
        return;
      } catch (error) {
        if (signal.aborted || isAbortError(error)) throw error;
        if (!(error instanceof RetryableDownloadError)) {
          throw new Error(`文件 ${entry.relativePath} 下载失败：${errorMessage(error)}`);
        }
        if (retry >= MAX_TRANSFER_RETRIES) {
          throw new Error(`文件 ${entry.relativePath} 在 ${retry + 1} 次尝试后仍失败：${errorMessage(error)}`);
        }
        entry.status = entry.bytesPresent > 0 ? "partial" : "pending";
        entry.error = errorMessage(error).slice(0, 500);
        refreshProgress(job);
        job.updatedAt = now();
        await this.#persist();
        await waitForRetry(1_000 * (2 ** retry), signal);
      }
    }
  }

  async #run(id: string): Promise<void> {
    const job = this.#jobs.get(id);
    if (!job || job.status !== "queued") return;
    const directory = this.#directoryFor(job);
    job.status = "running";
    job.phase = "resuming";
    job.updatedAt = now();
    await this.#persist();

    const controller = new AbortController();
    this.#controllers.set(id, controller);
    try {
      await mkdir(directory, { recursive: true });
      job.phase = "downloading";
      job.updatedAt = now();
      await this.#persist();

      const queue = job.transfer.filter((entry) => entry.status !== "verified");
      const workerCount = Math.min(job.concurrency ?? 4, Math.max(1, queue.length));
      const runWorker = async (): Promise<void> => {
        while (queue.length) {
          if (controller.signal.aborted) return;
          const entry = queue.shift();
          if (!entry) return;
          try {
            await this.#transferWithRetries(job, entry, directory, controller.signal);
            refreshProgress(job);
            job.updatedAt = now();
            await this.#persist();
          } catch (error) {
            if (controller.signal.aborted || isAbortError(error)) throw error;
            entry.status = "failed";
            entry.error = errorMessage(error).slice(0, 500);
            refreshProgress(job);
            job.updatedAt = now();
            await this.#persist();
          }
        }
      };
      const results = await Promise.allSettled(Array.from({ length: workerCount }, () => runWorker()));
      const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failure) throw failure.reason;

      job.phase = "verifying";
      job.updatedAt = now();
      await this.#persist();
      refreshProgress(job);
      const failedFiles = job.transfer.filter((entry) => entry.status === "failed");
      if (job.transfer.some((entry) => entry.status !== "verified" && entry.status !== "failed")) {
        throw new Error("部分文件未完成下载或校验");
      }
      if (job.downloadedFiles === 0) {
        const firstError = failedFiles.find((entry) => entry.error)?.error;
        throw new Error(`全部 ${job.totalFiles} 个文件均下载失败${firstError ? `：${firstError}` : ""}`);
      }
      if (this.#registerConnector) {
        job.phase = "registering";
        job.updatedAt = now();
        await this.#persist();
        const connector = await this.#registerConnector({
          name: `Coverage download ${id.slice(-12)}`,
          kind: "local",
          config: { rootPath: this.#connectorPath ?? directory },
          status: "ready",
        });
        job.outputConnectorId = connector.id;
      }
      job.outputPath = directory;
      job.status = failedFiles.length ? "partial" : "completed";
      job.phase = failedFiles.length ? "partial" : "completed";
      if (failedFiles.length) job.error = `${job.downloadedFiles}/${job.totalFiles} 个文件已验证并保留；${failedFiles.length} 个失败文件已跳过`;
      job.updatedAt = now();
      await this.#persist();
    } catch (error) {
      const aborted = (error as Error)?.name === "AbortError" || controller.signal.aborted;
      const cancelled = aborted;
      job.status = cancelled ? "cancelled" : "failed";
      job.phase = cancelled ? "cancelled" : "failed";
      if (!cancelled) {
        job.error = error instanceof Error ? error.message : String(error);
      }
      job.updatedAt = now();
      // Staging files and the ledger are intentionally preserved so an
      // idempotent resubmission (requestKey) can resume verified/partial bytes.
      await this.#persist();
    } finally {
      if (this.#controllers.get(id) === controller) this.#controllers.delete(id);
    }
  }

  async #transferOne(job: CoverageDownloadJob, entry: CoverageDownloadFileState, directory: string, signal: AbortSignal): Promise<void> {
    const target = path.resolve(directory, entry.relativePath);
    if (!target.startsWith(directory + path.sep)) {
      throw new Error(`文件路径越界: ${entry.relativePath}`);
    }
    await mkdir(path.dirname(target), { recursive: true });
    const partPath = `${target}.part`;

    // A present final file is rehashed before reuse; a stale or tampered file
    // never skips verification and is simply re-downloaded.
    let finalStats;
    try {
      finalStats = await stat(target);
    } catch {
      finalStats = undefined;
    }
    if (finalStats) {
      const mismatch = entry.expectedSizeBytes !== undefined && finalStats.size !== entry.expectedSizeBytes;
      if (!mismatch) {
        const digest = await hashFile(target);
        if (entry.expectedSha256 && digest.sha256 !== entry.expectedSha256) {
          throw new Error(`已完成文件校验失败: ${entry.relativePath}`);
        }
        entry.status = "verified";
        entry.bytesPresent = finalStats.size;
        entry.actualSizeBytes = finalStats.size;
        entry.actualSha256 = digest.sha256;
        delete entry.error;
        return;
      }
      await rm(target, { force: true });
    }

    let offset = 0;
    let hash = createHash("sha256");
    const validator = strongValidator(entry.etag, entry.lastModified);
    try {
      const partStats = await stat(partPath);
      if (partStats.size > 0 && validator) {
        // Resume only with a strong validator so bytes are never concatenated
        // across different remote object versions.
        offset = await hashInto(partPath, hash);
        entry.status = "partial";
        entry.bytesPresent = offset;
      } else if (partStats.size > 0) {
        await rm(partPath, { force: true });
        entry.bytesPresent = 0;
        entry.status = "pending";
      }
    } catch {
      // No partial file; start from zero.
    }

    const headers: Record<string, string> = { "Accept-Encoding": "identity" };
    if (offset > 0) {
      headers.Range = `bytes=${offset}-`;
      headers["If-Range"] = validator!;
    } else if (validator) {
      if (entry.etag && !entry.etag.startsWith("W/")) headers["If-Match"] = entry.etag;
      else if (entry.lastModified) headers["If-Unmodified-Since"] = entry.lastModified;
    }
    const source = await assertPublicHttpUrl(entry.url, { resolveHostname: this.#resolveHostname, skipDnsLookup: this.#skipDnsLookup });
    let response: Response;
    try {
      response = await fetchPublicHttp(source, { headers, signal }, {
        fetchImpl: this.#fetchImpl, resolveHostname: this.#resolveHostname, skipDnsLookup: this.#skipDnsLookup,
      });
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      throw new RetryableDownloadError(errorMessage(error));
    }
    if (!response.ok) {
      if (response.status === 416 && offset > 0) {
        const contentRange = response.headers.get("content-range") ?? "";
        const match = contentRange.match(/bytes\s+\*\/(\d+)/i);
        if (match && Number(match[1]) === offset) {
          // The partial bytes already are the complete object.
          const digest = await hashFile(partPath);
          if (entry.expectedSizeBytes !== undefined && digest.sizeBytes !== entry.expectedSizeBytes) {
            throw new Error(`文件大小不符: 期望 ${entry.expectedSizeBytes} 字节，实际 ${digest.sizeBytes}`);
          }
          if (entry.expectedSha256 && digest.sha256 !== entry.expectedSha256) {
            throw new Error(`文件校验失败: ${entry.relativePath}`);
          }
          await this.#finalizeEntry(entry, partPath, target, offset, digest.sha256);
          return;
        }
      }
      await response.body?.cancel().catch(() => undefined);
      const message = `下载失败 HTTP ${response.status}: ${entry.relativePath}`;
      if (response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500) {
        throw new RetryableDownloadError(message);
      }
      throw new Error(message);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (/\.(?:fits?|fz)(?:\.gz)?$/i.test(entry.relativePath) && /^(?:text\/html|application\/json)(?:;|$)/i.test(contentType)) {
      await response.body?.cancel();
      throw new Error(`来源返回页面或元数据，未返回科学 FITS 文件: ${entry.relativePath}`);
    }
    const responseEtag = response.headers.get("etag");
    if (entry.etag && !entry.etag.startsWith("W/") && responseEtag && responseEtag !== entry.etag) {
      await response.body?.cancel();
      throw new Error(`源文件版本已变化；请重新预览后创建新任务: ${entry.relativePath}`);
    }

    let appending = false;
    if (offset > 0) {
      if (response.status === 206) {
        const contentRange = response.headers.get("content-range") ?? "";
        const match = contentRange.match(/^bytes\s+(\d+)-/i);
        if (!match || Number(match[1]) !== offset) throw new Error("服务器返回的 Content-Range 与续传偏移不一致");
        appending = true;
      } else if (response.status === 200) {
        // Server ignored Range; restart cleanly instead of concatenating
        // potentially different object versions.
        offset = 0;
        hash = createHash("sha256");
        await rm(partPath, { force: true });
        entry.bytesPresent = 0;
        entry.status = "pending";
      } else {
        throw new Error(`不支持的续传响应 HTTP ${response.status}`);
      }
    } else if (response.status !== 200) {
      throw new Error(`不支持的响应 HTTP ${response.status}`);
    }

    if (entry.expectedSizeBytes === undefined && response.status === 200) {
      const rawLength = response.headers.get("content-length");
      const length = rawLength === null ? undefined : Number(rawLength);
      if (length !== undefined && Number.isSafeInteger(length) && length >= 0) entry.expectedSizeBytes = length;
    }
    if (entry.etag === undefined) entry.etag = response.headers.get("etag") ?? undefined;
    if (entry.lastModified === undefined) entry.lastModified = response.headers.get("last-modified") ?? undefined;

    const handle = await open(partPath, appending ? "a" : "w");
    let lastProgressPersistMs = 0;
    try {
      const reader = response.body?.getReader();
      if (!reader) throw new Error("下载响应没有内容流");
      while (true) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (error) {
          if (signal.aborted) throw signal.reason ?? error;
          throw new RetryableDownloadError(errorMessage(error));
        }
        const { done, value } = chunk;
        if (done) break;
        if (!value?.byteLength) continue;
        let written = 0;
        while (written < value.byteLength) {
          const result = await handle.write(value, written, value.byteLength - written, null);
          if (result.bytesWritten <= 0) throw new Error(`写入下载文件时没有进展: ${entry.relativePath}`);
          written += result.bytesWritten;
        }
        hash.update(value);
        offset += value.byteLength;
        entry.bytesPresent = offset;
        entry.status = "partial";
        // Keep validators and partial progress recoverable during long files
        // without writing the full ledger for every incoming network chunk.
        if (Date.now() - lastProgressPersistMs >= 5_000) {
          lastProgressPersistMs = Date.now();
          refreshProgress(job);
          job.updatedAt = now();
          await this.#persist();
        }
      }
      if (entry.expectedSizeBytes !== undefined && offset !== entry.expectedSizeBytes) {
        const message = `文件大小不符: 期望 ${entry.expectedSizeBytes} 字节，实际 ${offset}`;
        if (offset < entry.expectedSizeBytes) throw new RetryableDownloadError(message);
        throw new Error(message);
      }
      const digest = hash.digest("hex");
      if (entry.expectedSha256 && digest !== entry.expectedSha256) {
        throw new Error(`文件校验失败: ${entry.relativePath}`);
      }
      await handle.sync();
      await this.#finalizeEntry(entry, partPath, target, offset, digest);
    } finally {
      await handle.close();
    }
  }

  async #finalizeEntry(entry: CoverageDownloadFileState, partPath: string, target: string, sizeBytes: number, sha256: string): Promise<void> {
    if (partPath !== target) await rename(partPath, target);
    entry.status = "verified";
    entry.bytesPresent = sizeBytes;
    entry.actualSizeBytes = sizeBytes;
    entry.actualSha256 = sha256;
    delete entry.error;
  }

  async #persist(): Promise<void> {
    const state: PersistedState = {
      schemaVersion: 2,
      jobs: [...this.#jobs.values()].slice(-200).map(clone),
    };
    const temporary = `${this.#statePath}.${randomUUID()}.tmp`;
    this.#persisting = this.#persisting
      .catch(() => undefined)
      .then(async () => {
        await mkdir(path.dirname(this.#statePath), { recursive: true });
        await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        await rename(temporary, this.#statePath);
      });
    return this.#persisting;
  }
}
