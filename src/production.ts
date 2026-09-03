import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ConnectorRegistry } from "./connectors.js";
import type { DataCatalogRegistry, DataAssetRecord } from "./data-catalog.js";
import type { AstroObjectIndexService, AstroObjectRecord } from "./astro-object-index.js";
import type { LocalConnectorRootsPolicy } from "./local-connector-roots.js";
import type { CoverageDownloadFile, CoverageDownloadJob, CoverageDownloadService } from "./coverage-downloads.js";

export type ProductionRunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type ProductionPipelineAvailability = "available" | "planned";

export interface RegionSnapshot {
  coordinateFrame: "ICRS";
  ordering: "NESTED";
  nside: number;
  pixels: number[];
  sourceIds: string[];
  componentId?: string;
  createdAt: string;
}

export interface ProductionArtifact {
  name: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
  createdAt: string;
  downloadUrl?: string;
}

export interface ProductionStep {
  id: string;
  title: string;
  status: "pending" | "running" | "succeeded" | "failed" | "cancelled" | "skipped";
  detail?: string;
  startedAt?: string;
  completedAt?: string;
  logs: ProductionStepLogEntry[];
}

export interface ProductionStepLogEntry {
  timestamp: string;
  level: "info" | "warning" | "error";
  message: string;
}

export interface ProductionPipelineDefinition {
  id: string;
  version: number;
  key: string;
  title: string;
  description: string;
  availability: ProductionPipelineAvailability;
  inputRequirements: string[];
  outputs: string[];
  dag: ProductionPipelineDagNode[];
  parameters: ProductionPipelineParameter[];
}

export interface ProductionPipelineDagNode {
  id: string;
  title: string;
  description: string;
  dependsOn?: string[];
}

export interface ProductionPipelineParameter {
  key: string;
  label: string;
  type: "text" | "number" | "select";
  defaultValue?: string | number;
  options?: string[];
}

export interface ProductionRun {
  id: string;
  pipelineKey: string;
  status: ProductionRunStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  input: Record<string, unknown>;
  steps: ProductionStep[];
  artifacts: ProductionArtifact[];
  summary: Record<string, unknown>;
  error?: string;
  outputConnectorId?: string;
  outputPath?: string;
}

export interface ProductionRunInput {
  pipelineKey: string;
  region?: unknown;
  files?: readonly CoverageDownloadFile[];
  exportFormat?: "json" | "csv";
  crawlerId?: string;
  concurrency?: number;
  storageConnectorId?: string;
  leftAssetId?: string;
  rightAssetId?: string;
  matchRadiusArcsec?: number;
  limit?: number;
}

export const PRODUCTION_PIPELINES: readonly ProductionPipelineDefinition[] = [
  {
    id: "overlap-download",
    version: 1,
    key: "overlap-download@1",
    title: "重合区域数据下载",
    description: "从重合区域反查公开文件，按选择的爬虫下载并登记新的 Connector。",
    availability: "available",
    inputRequirements: ["RegionSnapshot", "文件清单", "导出格式", "爬虫", "并发", "存储位置"],
    outputs: ["区域 JSON/CSV", "下载文件清单", "新的本地 Connector"],
    dag: [
      { id: "region", title: "固定区域快照", description: "保存重合区域的 ICRS / NESTED HEALPix 快照。" },
      { id: "download", title: "爬虫下载与校验", description: "按并发配置下载反查文件并校验内容。", dependsOn: ["region"] },
      { id: "connector", title: "登记结果 Connector", description: "把下载目录登记为新的 Workspace Connector。", dependsOn: ["download"] },
    ],
    parameters: [
      { key: "exportFormat", label: "区域导出格式", type: "select", defaultValue: "json", options: ["json", "csv"] },
      { key: "crawlerId", label: "爬虫执行器", type: "select", defaultValue: "builtin-http", options: ["builtin-http"] },
      { key: "concurrency", label: "并发数", type: "number", defaultValue: 4 },
    ],
  },
  {
    id: "object-crossmatch",
    version: 1,
    key: "object-crossmatch@1",
    title: "对象交叉匹配",
    description: "对两个具备 RA/Dec 对象索引的用户资产执行区域内最近邻匹配。",
    availability: "available",
    inputRequirements: ["RegionSnapshot", "两个 RA/Dec 对象资产", "匹配半径"],
    outputs: ["交叉匹配 CSV", "匹配摘要"],
    dag: [
      { id: "query", title: "读取对象索引", description: "读取区域内两个 catalog 资产的 RA / Dec 对象索引。" },
      { id: "match", title: "最近邻球面匹配", description: "按匹配半径执行球面最近邻匹配。", dependsOn: ["query"] },
      { id: "export", title: "导出结果与血缘", description: "写出 CSV / JSON 并保留输入资产和区域血缘。", dependsOn: ["match"] },
    ],
    parameters: [
      { key: "matchRadiusArcsec", label: "匹配半径（角秒）", type: "number", defaultValue: 1.5 },
      { key: "limit", label: "结果上限", type: "number", defaultValue: 10000 },
    ],
  },
  {
    id: "training-data-preparation",
    version: 1,
    key: "training-data-preparation@1",
    title: "训练数据准备",
    description: "预留切图、去噪和训练样本编排能力。",
    availability: "planned",
    inputRequirements: ["图像或立方体资产", "切图参数", "去噪策略"],
    outputs: ["训练样本集"],
    dag: [
      { id: "input", title: "准备输入资产", description: "选择图像或数据立方体作为训练输入。" },
      { id: "cutout", title: "切图", description: "按目标或固定窗口生成样本切片。", dependsOn: ["input"] },
      { id: "denoise", title: "去噪", description: "预留去噪策略和质量门控。", dependsOn: ["cutout"] },
      { id: "package", title: "编排训练集", description: "把样本和元数据组织为可交付训练集。", dependsOn: ["denoise"] },
    ],
    parameters: [
      { key: "cutoutSize", label: "切图尺寸", type: "number", defaultValue: 128 },
      { key: "denoise", label: "去噪策略", type: "select", defaultValue: "pending", options: ["pending"] },
    ],
  },
];

const MAX_STATE_RUNS = 200;
const MAX_STEP_LOGS = 200;
const MAX_PIXELS = 4096;
const MAX_MATCH_ROWS = 10_000;

function now(): string {
  return new Date().toISOString();
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function stepLog(timestamp: string, level: ProductionStepLogEntry["level"], message: string): ProductionStepLogEntry {
  return { timestamp, level, message: message.slice(0, 2_000) };
}

function normalizeStep(step: ProductionStep): ProductionStep {
  const logs = Array.isArray(step.logs)
    ? step.logs.filter((entry) => entry && typeof entry.timestamp === "string" && typeof entry.message === "string")
      .map((entry) => stepLog(entry.timestamp, entry.level === "warning" || entry.level === "error" ? entry.level : "info", entry.message))
      .slice(-MAX_STEP_LOGS)
    : [];
  if (!logs.length && step.status !== "pending") {
    const timestamp = step.completedAt ?? step.startedAt ?? now();
    const level = step.status === "failed" ? "error" : step.status === "cancelled" ? "warning" : "info";
    logs.push(stepLog(timestamp, level, step.detail ?? `节点状态：${step.status}`));
  }
  return { ...step, logs };
}

function text(value: unknown, name: string, maximum = 180): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) throw new RangeError(`${name} must be a non-empty string`);
  return value.trim();
}

function finiteNumber(value: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw new RangeError(`${name} must be between ${minimum} and ${maximum}`);
  return value;
}

function validNside(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 256 || (value & (value - 1)) !== 0) {
    throw new RangeError("region.nside must be a power of two between 1 and 256");
  }
  return value;
}

function regionSnapshot(value: unknown): RegionSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RangeError("region is required");
  const input = value as Record<string, unknown>;
  const nside = validNside(input.nside);
  if (!Array.isArray(input.pixels) || input.pixels.length < 1 || input.pixels.length > MAX_PIXELS) throw new RangeError(`region.pixels must contain between 1 and ${MAX_PIXELS} cells`);
  const pixels = [...new Set(input.pixels.map((pixel, index) => {
    if (typeof pixel !== "number" || !Number.isSafeInteger(pixel) || pixel < 0 || pixel >= 12 * nside ** 2) throw new RangeError(`region.pixels[${index}] is invalid for nside ${nside}`);
    return pixel;
  }))].sort((left, right) => left - right);
  const sourceIds = input.sourceIds === undefined ? [] : input.sourceIds;
  if (!Array.isArray(sourceIds) || sourceIds.some((entry) => typeof entry !== "string" || !entry.trim())) throw new RangeError("region.sourceIds must be an array of strings");
  const frame = input.coordinateFrame ?? "ICRS";
  const ordering = input.ordering ?? "NESTED";
  if (frame !== "ICRS" || ordering !== "NESTED") throw new RangeError("region must use ICRS and NESTED coordinates");
  const componentId = input.componentId === undefined ? undefined : text(input.componentId, "region.componentId");
  return {
    coordinateFrame: "ICRS",
    ordering: "NESTED",
    nside,
    pixels,
    sourceIds: [...new Set(sourceIds.map((entry) => (entry as string).trim()))],
    ...(componentId ? { componentId } : {}),
    createdAt: typeof input.createdAt === "string" ? input.createdAt : now(),
  };
}

function regionCsv(region: RegionSnapshot): string {
  const header = "coordinate_frame,ordering,nside,pixel,component_id,source_ids";
  const sourceIds = region.sourceIds.join(";");
  return `${header}\n${region.pixels.map((pixel) => [region.coordinateFrame, region.ordering, region.nside, pixel, region.componentId ?? "", sourceIds].map((value) => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\n")}\n`;
}

function angularDistanceArcsec(left: Pick<AstroObjectRecord, "ra_deg" | "dec_deg">, right: Pick<AstroObjectRecord, "ra_deg" | "dec_deg">): number {
  const ra1 = left.ra_deg * Math.PI / 180;
  const ra2 = right.ra_deg * Math.PI / 180;
  const dec1 = left.dec_deg * Math.PI / 180;
  const dec2 = right.dec_deg * Math.PI / 180;
  const sinDec = Math.sin((dec2 - dec1) / 2);
  const sinRa = Math.sin((ra2 - ra1) / 2);
  const haversine = Math.min(1, Math.max(0, sinDec * sinDec + Math.cos(dec1) * Math.cos(dec2) * sinRa * sinRa));
  return 2 * Math.asin(Math.sqrt(haversine)) * 180 / Math.PI * 3600;
}

function crossmatchCsv(rows: readonly Record<string, unknown>[]): string {
  const fields = ["left_object_id", "right_object_id", "left_ra_deg", "left_dec_deg", "right_ra_deg", "right_dec_deg", "separation_arcsec", "left_asset_id", "right_asset_id"];
  const quote = (value: unknown): string => `"${String(value ?? "").replaceAll('"', '""')}"`;
  return `${fields.join(",")}\n${rows.map((row) => fields.map((field) => quote(row[field])).join(",")).join("\n")}\n`;
}

function assetSupportsObjects(asset: DataAssetRecord): boolean {
  const scan = asset.scanSpec;
  if (!scan) return false;
  return asset.kind === "catalog" && Boolean(scan.raColumn && scan.decColumn && scan.objectIdColumn)
    && scan.coordinateFrame === "ICRS" && scan.coordinateUnits === "deg";
}

interface ProductionServiceOptions {
  root: string;
  downloads: CoverageDownloadService;
  connectors: ConnectorRegistry;
  dataCatalog: DataCatalogRegistry;
  objectIndex: AstroObjectIndexService;
  localRoots: LocalConnectorRootsPolicy;
}

export class ProductionService {
  readonly #root: string;
  readonly #statePath: string;
  readonly #downloads: CoverageDownloadService;
  readonly #connectors: ConnectorRegistry;
  readonly #dataCatalog: DataCatalogRegistry;
  readonly #objectIndex: AstroObjectIndexService;
  readonly #localRoots: LocalConnectorRootsPolicy;
  readonly #runs = new Map<string, ProductionRun>();
  readonly #writes = new Map<string, Promise<void>>();
  #initialized = false;
  #initializationPromise: Promise<void> | null = null;

  constructor(options: ProductionServiceOptions) {
    if (!path.isAbsolute(options.root)) throw new RangeError("production root must be absolute");
    this.#root = path.resolve(options.root);
    this.#statePath = path.join(this.#root, "production-runs.json");
    this.#downloads = options.downloads;
    this.#connectors = options.connectors;
    this.#dataCatalog = options.dataCatalog;
    this.#objectIndex = options.objectIndex;
    this.#localRoots = options.localRoots;
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    if (this.#initializationPromise) return this.#initializationPromise;
    const initialization = this.#initializeState();
    this.#initializationPromise = initialization;
    try {
      await initialization;
      this.#initialized = true;
    } finally {
      if (this.#initializationPromise === initialization) this.#initializationPromise = null;
    }
  }

  async #initializeState(): Promise<void> {
    await mkdir(this.#root, { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.#statePath, "utf8")) as unknown;
      if (!Array.isArray(parsed)) throw new Error("production state must be an array");
      for (const entry of parsed) {
        if (!entry || typeof entry !== "object" || typeof (entry as ProductionRun).id !== "string") continue;
        const legacyRun = clone(entry as ProductionRun & { pipelinePresetId?: unknown });
        delete legacyRun.pipelinePresetId;
        const run: ProductionRun = {
          ...legacyRun,
          steps: Array.isArray(legacyRun.steps) ? legacyRun.steps.map(normalizeStep) : [],
        };
        if (run.status === "queued" || run.status === "running") {
          run.status = "failed";
          run.error = "服务重启前生产任务尚未完成";
          run.completedAt = now();
          run.updatedAt = run.completedAt;
          const active = run.steps.find((step) => step.status === "running") ?? run.steps.find((step) => step.status === "pending");
          if (active) {
            active.status = "failed";
            active.completedAt = run.completedAt;
            active.detail = run.error;
            active.logs = [...active.logs, stepLog(run.completedAt, "error", run.error)].slice(-MAX_STEP_LOGS);
          }
        }
        this.#runs.set(run.id, clone(run));
      }
      await this.#persist();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("Ignoring invalid production state", error);
    }
  }

  listPipelines(): ProductionPipelineDefinition[] {
    return PRODUCTION_PIPELINES.map(clone);
  }

  async listRuns(): Promise<ProductionRun[]> {
    await this.initialize();
    return [...this.#runs.values()].map(clone).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async getRun(id: string): Promise<ProductionRun> {
    await this.initialize();
    const run = this.#runs.get(text(id, "production run id"));
    if (!run) throw new Error(`Production run not found: ${id}`);
    return clone(run);
  }

  async submit(inputValue: unknown): Promise<ProductionRun> {
    await this.initialize();
    if (!inputValue || typeof inputValue !== "object" || Array.isArray(inputValue)) throw new RangeError("production input must be an object");
    const input = inputValue as ProductionRunInput;
    const pipelineKey = text(input.pipelineKey, "pipelineKey");
    const pipeline = PRODUCTION_PIPELINES.find((candidate) => candidate.key === pipelineKey);
    if (!pipeline) throw new RangeError(`Unknown production pipeline: ${pipelineKey}`);
    if (pipeline.availability !== "available") throw new RangeError("该流水线尚未开放提交");
    const region = regionSnapshot(input.region);
    const normalized: Record<string, unknown> = { pipelineKey, region };
    const steps: ProductionStep[] = [];
    if (pipeline.id === "overlap-download") {
      if (!Array.isArray(input.files) || input.files.length < 1) throw new RangeError("overlap-download requires a non-empty files list");
      const exportFormat = input.exportFormat ?? "json";
      if (exportFormat !== "json" && exportFormat !== "csv") throw new RangeError("exportFormat must be json or csv");
      const crawlerId = input.crawlerId === undefined ? "builtin-http" : text(input.crawlerId, "crawlerId");
      const concurrency = input.concurrency === undefined ? 4 : input.concurrency;
      if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new RangeError("concurrency must be an integer between 1 and 16");
      normalized.files = clone(input.files);
      normalized.exportFormat = exportFormat;
      normalized.crawlerId = crawlerId;
      normalized.concurrency = concurrency;
      if (input.storageConnectorId !== undefined) normalized.storageConnectorId = text(input.storageConnectorId, "storageConnectorId");
      steps.push(
        { id: "region", title: "固定重合区域快照", status: "pending", logs: [] },
        { id: "download", title: "爬虫下载与校验", status: "pending", logs: [] },
        { id: "connector", title: "登记结果 Connector", status: "pending", logs: [] },
      );
    } else {
      if (!input.leftAssetId || !input.rightAssetId) throw new RangeError("object-crossmatch requires two assets");
      const leftAssetId = text(input.leftAssetId, "leftAssetId");
      const rightAssetId = text(input.rightAssetId, "rightAssetId");
      if (leftAssetId === rightAssetId) throw new RangeError("leftAssetId and rightAssetId must be different");
      const matchRadiusArcsec = input.matchRadiusArcsec === undefined ? 1.5 : finiteNumber(input.matchRadiusArcsec, "matchRadiusArcsec", 0.01, 60);
      const limit = input.limit === undefined ? 10_000 : input.limit;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_MATCH_ROWS) throw new RangeError(`limit must be between 1 and ${MAX_MATCH_ROWS}`);
      const [leftAsset, rightAsset] = await Promise.all([this.#dataCatalog.get(leftAssetId), this.#dataCatalog.get(rightAssetId)]);
      if (!assetSupportsObjects(leftAsset) || !assetSupportsObjects(rightAsset)) throw new RangeError("交叉匹配只支持已建立 RA/Dec 对象索引的 catalog 资产；MOC-only 资产不能匹配");
      normalized.leftAssetId = leftAssetId;
      normalized.rightAssetId = rightAssetId;
      normalized.matchRadiusArcsec = matchRadiusArcsec;
      normalized.limit = limit;
      steps.push(
        { id: "query", title: "读取两个对象索引", status: "pending", logs: [] },
        { id: "match", title: "最近邻球面匹配", status: "pending", logs: [] },
        { id: "export", title: "导出结果与血缘", status: "pending", logs: [] },
      );
    }
    const createdAt = now();
    const run: ProductionRun = {
      id: `prd_${createdAt.replace(/[-:.TZ]/g, "").slice(0, 14)}_${randomUUID().slice(0, 8)}`,
      pipelineKey,
      status: "queued",
      createdAt,
      updatedAt: createdAt,
      input: normalized,
      steps,
      artifacts: [],
      summary: {},
    };
    this.#runs.set(run.id, run);
    await this.#persist();
    void this.#execute(run.id);
    return clone(run);
  }

  async cancel(id: string): Promise<ProductionRun> {
    const run = await this.getRun(id);
    if (run.status === "queued") {
      run.status = "cancelled";
      run.completedAt = now();
      run.error = "用户取消任务";
      const first = run.steps.find((step) => step.status === "pending");
      if (first) this.updateStep(first, "cancelled", run.error, "warning");
      await this.#save(run);
      return run;
    }
    if (run.status === "running" && run.pipelineKey === "overlap-download@1") {
      const downloadId = typeof run.summary.downloadJobId === "string" ? run.summary.downloadJobId : undefined;
      if (downloadId) await this.#downloads.cancel(downloadId);
      run.status = "cancelled";
      run.completedAt = now();
      run.error = "用户取消任务";
      const active = run.steps.find((step) => step.status === "running");
      if (active) this.updateStep(active, "cancelled", run.error, "warning");
      await this.#save(run);
    }
    return clone(run);
  }

  async retry(id: string): Promise<ProductionRun> {
    const run = await this.getRun(id);
    if (run.status !== "failed" && run.status !== "cancelled") throw new RangeError("Only failed or cancelled production runs can be retried");
    const input = clone(run.input);
    return this.submit(input);
  }

  async artifactPath(id: string, name: string): Promise<{ run: ProductionRun; artifact: ProductionArtifact; filePath: string }> {
    const run = await this.getRun(id);
    const artifactName = text(name, "artifact name", 180);
    const artifact = run.artifacts.find((candidate) => candidate.name === artifactName);
    if (!artifact) throw new Error(`Production artifact not found: ${id}/${artifactName}`);
    const filePath = path.join(this.#root, id, artifactName);
    return { run, artifact, filePath };
  }

  async #execute(id: string): Promise<void> {
    const run = this.#runs.get(id);
    if (!run || run.status !== "queued") return;
    run.status = "running";
    run.startedAt = now();
    await this.#save(run);
    try {
      if (run.pipelineKey === "overlap-download@1") await this.#executeDownload(run);
      else await this.#executeCrossmatch(run);
      run.status = "succeeded";
      run.completedAt = now();
      await this.#save(run);
    } catch (error) {
      const cancelled = (run.status as ProductionRunStatus) === "cancelled";
      run.status = cancelled ? "cancelled" : "failed";
      run.error = error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000);
      run.completedAt = now();
      const active = run.steps.find((step) => step.status === "running") ?? run.steps.find((step) => step.status === "pending");
      if (active && active.status !== "cancelled") this.updateStep(active, cancelled ? "cancelled" : "failed", run.error, cancelled ? "warning" : "error");
      await this.#save(run);
    }
  }

  async #executeDownload(run: ProductionRun): Promise<void> {
    const region = run.input.region as RegionSnapshot;
    const exportFormat = run.input.exportFormat === "csv" ? "csv" : "json";
    const regionName = exportFormat === "csv" ? "region.csv" : "region.json";
    const regionContent = exportFormat === "csv" ? regionCsv(region) : `${JSON.stringify(region, null, 2)}\n`;
    await this.setStep(run, "region", "running", `准备 ${region.pixels.length} 个 HEALPix 单元`);
    await this.writeArtifact(run, regionName, exportFormat === "csv" ? "text/csv; charset=utf-8" : "application/json", regionContent);
    await this.setStep(run, "region", "succeeded", `已生成 ${regionName}`);
    await this.setStep(run, "download", "running", `使用 ${String(run.input.crawlerId)}，并发数 ${Number(run.input.concurrency)}`);
    const storageConnectorId = typeof run.input.storageConnectorId === "string" ? run.input.storageConnectorId : undefined;
    let outputRoot: string | undefined;
    if (storageConnectorId) {
      const connector = await this.#connectors.get(storageConnectorId);
      if (connector.kind !== "local" || connector.status === "disabled") throw new RangeError("存储位置必须是启用的 local Connector");
      const configuredRoot = connector.config.rootPath;
      if (!configuredRoot) throw new RangeError("local Connector 没有 rootPath");
      outputRoot = configuredRoot;
      this.#localRoots.assertConfiguredPath(configuredRoot);
    }
    const download = await this.#downloads.submit({
      files: run.input.files as CoverageDownloadFile[],
      componentId: region.componentId,
      sourceIds: region.sourceIds,
      concurrency: Number(run.input.concurrency ?? 4),
      ...(outputRoot ? { outputRoot, outputPrefix: run.id } : { outputPrefix: run.id }),
    });
    run.summary = { ...run.summary, downloadJobId: download.id, files: download.totalFiles };
    this.appendStepLog(run, "download", "info", `下载任务 ${download.id} 已提交，共 ${download.totalFiles} 个文件`);
    await this.#save(run);
    let current = download;
    let loggedFiles = current.downloadedFiles;
    for (let attempt = 0; attempt < 1_200; attempt += 1) {
      if (current.status === "completed" || current.status === "failed" || current.status === "cancelled") break;
      await new Promise((resolve) => setTimeout(resolve, 500));
      current = await this.#downloads.get(download.id);
      run.summary = { ...run.summary, downloadedFiles: current.downloadedFiles, downloadedBytes: current.downloadedBytes };
      if (current.downloadedFiles !== loggedFiles) {
        loggedFiles = current.downloadedFiles;
        this.appendStepLog(run, "download", "info", `已下载 ${current.downloadedFiles}/${current.totalFiles} 个文件，${current.downloadedBytes} bytes`);
      }
      await this.#save(run);
    }
    if (current.status === "cancelled") { run.status = "cancelled"; throw new Error(current.error ?? "下载已取消"); }
    if (current.status !== "completed") throw new Error(current.error ?? "下载任务超时");
    run.outputConnectorId = current.outputConnectorId;
    run.outputPath = current.outputPath;
    await this.setStep(run, "download", "succeeded", `${current.downloadedFiles} 个文件下载完成`);
    await this.setStep(run, "connector", "running", "正在登记下载结果");
    await this.writeArtifact(run, "download-manifest.json", "application/json", `${JSON.stringify({ region, crawlerId: run.input.crawlerId, files: run.input.files, job: current }, null, 2)}\n`);
    await this.setStep(run, "connector", "succeeded", current.outputConnectorId ?? "已登记");
  }

  async #executeCrossmatch(run: ProductionRun): Promise<void> {
    const region = run.input.region as RegionSnapshot;
    const leftAssetId = String(run.input.leftAssetId);
    const rightAssetId = String(run.input.rightAssetId);
    const matchRadius = Number(run.input.matchRadiusArcsec);
    await this.setStep(run, "query", "running", `读取资产 ${leftAssetId} 与 ${rightAssetId}`);
    const query = {
      region: { nside: region.nside, pixels: region.pixels, coordinateFrame: "ICRS", ordering: "NESTED" },
      includeAttributes: false,
      limit: 10_000,
    } as const;
    const [left, right] = await Promise.all([
      this.#objectIndex.queryObjects({ ...query, assetIds: [leftAssetId] }),
      this.#objectIndex.queryObjects({ ...query, assetIds: [rightAssetId] }),
    ]);
    if (left.status !== "ready" || right.status !== "ready") throw new Error(left.message ?? right.message ?? "对象索引不可用，请先完成资产扫描");
    if (!left.objects.length || !right.objects.length) throw new Error("选定区域内没有可匹配的对象");
    await this.setStep(run, "query", "succeeded", `${left.objects.length} + ${right.objects.length} 个对象`);
    await this.setStep(run, "match", "running", `匹配半径 ${matchRadius} 角秒`);
    const rows: Array<Record<string, unknown>> = [];
    for (const source of left.objects) {
      let best: { object: AstroObjectRecord; separation: number } | undefined;
      for (const candidate of right.objects) {
        const separation = angularDistanceArcsec(source, candidate);
        if (separation <= matchRadius && (!best || separation < best.separation)) best = { object: candidate, separation };
      }
      if (!best) continue;
      rows.push({
        left_object_id: source.object_id,
        right_object_id: best.object.object_id,
        left_ra_deg: source.ra_deg,
        left_dec_deg: source.dec_deg,
        right_ra_deg: best.object.ra_deg,
        right_dec_deg: best.object.dec_deg,
        separation_arcsec: Number(best.separation.toFixed(6)),
        left_asset_id: leftAssetId,
        right_asset_id: rightAssetId,
      });
      if (rows.length >= Number(run.input.limit ?? MAX_MATCH_ROWS)) break;
    }
    await this.setStep(run, "match", "succeeded", `${rows.length} 个匹配`);
    await this.setStep(run, "export", "running", "写出 CSV、JSON 和输入血缘");
    run.summary = { ...run.summary, leftRows: left.objects.length, rightRows: right.objects.length, matchRows: rows.length, matchRadiusArcsec: matchRadius };
    await this.writeArtifact(run, "crossmatch.csv", "text/csv; charset=utf-8", crossmatchCsv(rows));
    await this.writeArtifact(run, "crossmatch.json", "application/json", `${JSON.stringify({ region, summary: run.summary, rows }, null, 2)}\n`);
    await this.setStep(run, "export", "succeeded", "CSV + JSON");
  }

  private updateStep(step: ProductionStep, status: ProductionStep["status"], detail?: string, level?: ProductionStepLogEntry["level"]): void {
    const timestamp = now();
    if (status === "running" && !step.startedAt) step.startedAt = timestamp;
    if (["succeeded", "failed", "cancelled", "skipped"].includes(status)) step.completedAt = timestamp;
    step.status = status;
    if (detail) step.detail = detail;
    const resolvedLevel = level ?? (status === "failed" ? "error" : status === "cancelled" ? "warning" : "info");
    const message = detail ?? (status === "running" ? `${step.title}开始执行` : `${step.title}：${status}`);
    step.logs = [...step.logs, stepLog(timestamp, resolvedLevel, message)].slice(-MAX_STEP_LOGS);
  }

  private appendStepLog(run: ProductionRun, id: string, level: ProductionStepLogEntry["level"], message: string): void {
    const step = run.steps.find((candidate) => candidate.id === id);
    if (!step) return;
    step.logs = [...step.logs, stepLog(now(), level, message)].slice(-MAX_STEP_LOGS);
  }

  private async setStep(run: ProductionRun, id: string, status: ProductionStep["status"], detail?: string): Promise<void> {
    const step = run.steps.find((candidate) => candidate.id === id);
    if (!step) return;
    this.updateStep(step, status, detail);
    await this.#save(run);
  }

  private async writeArtifact(run: ProductionRun, name: string, mediaType: string, content: string): Promise<void> {
    await mkdir(path.join(this.#root, run.id), { recursive: true });
    const bytes = Buffer.from(content, "utf8");
    await writeFile(path.join(this.#root, run.id, name), bytes);
    const artifact: ProductionArtifact = { name, mediaType, byteLength: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"), createdAt: now() };
    run.artifacts = [...run.artifacts.filter((candidate) => candidate.name !== name), artifact];
    await this.#save(run);
  }

  async #save(run: ProductionRun): Promise<void> {
    run.updatedAt = now();
    this.#runs.set(run.id, clone(run));
    await this.#persist();
  }

  async #persist(): Promise<void> {
    const snapshot = [...this.#runs.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, MAX_STATE_RUNS);
    const previous = this.#writes.get("state") ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      const temporary = `${this.#statePath}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.#statePath);
    });
    this.#writes.set("state", current);
    try { await current; } finally { if (this.#writes.get("state") === current) this.#writes.delete("state"); }
  }

}

export type { CoverageDownloadFile, CoverageDownloadJob };
