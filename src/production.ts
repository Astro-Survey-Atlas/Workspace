import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ConnectorRegistry } from "./connectors.js";
import type { DataCatalogRegistry, DataAssetRecord } from "./data-catalog.js";
import type { AstroObjectIndexService, AstroObjectRecord } from "./astro-object-index.js";
import type { LocalConnectorRootsPolicy } from "./local-connector-roots.js";
import type { CoverageDownloadFile, CoverageDownloadJob, CoverageDownloadService } from "./coverage-downloads.js";
import {
  resolveSourceInventory, computeInventoryDigest, validateRelativePath,
  type SourceFileInventory, type SourceInventoryFile, type SourceUnit, type SourceUnitResolution,
} from "./source-crawler.js";

export type ProductionRunStatus = "queued" | "resolving" | "awaiting-approval" | "running" | "succeeded" | "failed" | "cancelled" | "rejected";
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

/**
 * Human approval of one immutable, checksummed download inventory. The plan
 * SHA-256 binds the decision to exactly the file list that will transfer.
 */
export interface ProductionApproval {
  state: "pending" | "approved" | "rejected";
  planSha256: string;
  decidedAt?: string;
  decidedBy?: "user" | "system-legacy" | "agent";
  /** True when a retry reused a previously approved inventory unchanged. */
  reused?: boolean;
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
  approval?: ProductionApproval;
  /** Canonical resolved inventory persisted before approval. */
  inventory?: SourceFileInventory;
  /** Origin run id for staging/inventory reuse across retries. */
  retryOfRunId?: string;
}

export interface ProductionRunInput {
  pipelineKey: string;
  region?: unknown;
  /** @deprecated Pre-expanded file list; bypasses in-run resolution and approval. */
  files?: readonly CoverageDownloadFile[];
  exportFormat?: "json" | "csv";
  crawlerId?: string;
  concurrency?: number;
  storageConnectorId?: string;
  warehouseHandoff?: "none" | "submit";
  leftAssetId?: string;
  rightAssetId?: string;
  matchRadiusArcsec?: number;
  limit?: number;
}

/** Adapter that derives typed source units from an immutable region snapshot. */
export interface ProductionSourceResolver {
  resolve(region: RegionSnapshot): Promise<ProductionSourceResolution>;
}

export interface ProductionSourceResolution {
  units: SourceUnit[];
  /** Sources that could not be mapped to any executable unit. */
  blocked: Array<{ sourceId: string; reason: string }>;
}

/** Adapter that hands a verified production output Connector to Warehouse. */
export interface ProductionWarehouseHandoff {
  submit(input: ProductionWarehouseHandoffInput): Promise<ProductionWarehouseHandoffReceipt>;
}

export interface ProductionWarehouseHandoffInput {
  runId: string;
  connectorId: string;
  inventorySha256: string;
}

export interface ProductionWarehouseHandoffReceipt {
  accepted: boolean;
  scanRunIds: string[];
}

/** Conflict-style state errors surfaced as HTTP 409. */
export class ProductionStateError extends Error {
  readonly statusCode = 409;
  constructor(message: string) {
    super(message);
    this.name = "ProductionStateError";
  }
}

export const PRODUCTION_PIPELINES: readonly ProductionPipelineDefinition[] = [
  {
    id: "overlap-download",
    version: 1,
    key: "overlap-download@1",
    title: "重合区域数据下载",
    description: "解析重合区域的来源单元，审批清单后流式下载并登记新的 Connector，可移交 Warehouse 扫描。",
    availability: "available",
    inputRequirements: ["RegionSnapshot", "来源解析", "清单审批", "并发", "存储位置", "Warehouse 提交"],
    outputs: ["区域 JSON/CSV", "下载清单 download-plan.json", "下载账本 download-manifest.json", "新的本地 Connector"],
    dag: [
      { id: "region", title: "固定区域快照", description: "保存重合区域的 ICRS / NESTED HEALPix 快照。" },
      { id: "resolve", title: "来源单元解析", description: "把区域来源解析为 typed source units 并展开规范文件清单。", dependsOn: ["region"] },
      { id: "approval", title: "清单审批", description: "人工确认清单内容与目标；审批绑定清单 SHA-256。", dependsOn: ["resolve"] },
      { id: "download", title: "流式下载与校验", description: "按并发配置流式下载清单文件，支持断点续传与校验。", dependsOn: ["approval"] },
      { id: "connector", title: "登记结果 Connector", description: "把下载目录登记为新的 Workspace Connector。", dependsOn: ["download"] },
      { id: "warehouse", title: "Warehouse 扫描提交", description: "可选：把输出 Connector 移交 Warehouse 扫描。", dependsOn: ["connector"] },
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
const DOWNLOAD_POLL_ATTEMPTS = 7_200;
const DOWNLOAD_POLL_INTERVAL_MS = 500;

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

/** Build the canonical inventory from pre-expanded legacy files without I/O. */
function directFilesInventory(files: readonly CoverageDownloadFile[]): SourceFileInventory {
  const entries: SourceInventoryFile[] = files.map((file, index) => {
    const relativePath = validateRelativePath(file.relativePath ?? file.name);
    return {
      sourceId: file.sourceId ?? "direct",
      unitId: file.unitId ?? `direct-${index}`,
      resolver: "direct-file@1",
      relativePath,
      url: file.url,
      ...(file.sizeBytes !== undefined ? { sizeBytes: file.sizeBytes } : {}),
      ...(file.sha256 ? { sha256: file.sha256 } : {}),
      ...(file.etag ? { etag: file.etag } : {}),
      ...(file.lastModified ? { lastModified: file.lastModified } : {}),
    };
  });
  const seen = new Set<string>();
  entries.forEach((entry) => {
    if (seen.has(entry.relativePath)) throw new RangeError(`清单相对路径冲突: ${entry.relativePath}`);
    seen.add(entry.relativePath);
  });
  entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const counts = new Map<string, number>();
  entries.forEach((entry) => counts.set(entry.unitId, (counts.get(entry.unitId) ?? 0) + 1));
  const unitKeys = new Map(entries.map((entry) => [entry.unitId, entry]));
  const units: SourceUnitResolution[] = [...unitKeys.values()].map((entry) => ({
    sourceId: entry.sourceId,
    unitId: entry.unitId,
    resolver: entry.resolver,
    status: "resolved",
    fileCount: counts.get(entry.unitId) ?? 0,
  }));
  return {
    schemaVersion: 1,
    inventorySha256: computeInventoryDigest(entries, units),
    files: entries,
    units,
    truncated: false,
  };
}

interface ProductionServiceOptions {
  root: string;
  downloads: CoverageDownloadService;
  connectors: ConnectorRegistry;
  dataCatalog: DataCatalogRegistry;
  objectIndex: AstroObjectIndexService;
  localRoots: LocalConnectorRootsPolicy;
  sourceResolver?: ProductionSourceResolver;
  warehouseHandoff?: ProductionWarehouseHandoff;
}

interface PersistedState {
  schemaVersion: 2;
  runs: ProductionRun[];
}

export class ProductionService {
  readonly #root: string;
  readonly #statePath: string;
  readonly #downloads: CoverageDownloadService;
  readonly #connectors: ConnectorRegistry;
  readonly #dataCatalog: DataCatalogRegistry;
  readonly #objectIndex: AstroObjectIndexService;
  readonly #localRoots: LocalConnectorRootsPolicy;
  readonly #sourceResolver?: ProductionSourceResolver;
  readonly #warehouseHandoff?: ProductionWarehouseHandoff;
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
    this.#sourceResolver = options.sourceResolver;
    this.#warehouseHandoff = options.warehouseHandoff;
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
      const entries = Array.isArray(parsed)
        ? parsed // legacy raw array
        : parsed && typeof parsed === "object" && Array.isArray((parsed as PersistedState).runs)
          ? (parsed as PersistedState).runs
          : null;
      if (!entries) throw new Error("production state must be an array or a versioned envelope");
      for (const entry of entries) {
        if (!entry || typeof entry !== "object" || typeof (entry as ProductionRun).id !== "string") continue;
        const legacyRun = clone(entry as ProductionRun & { pipelinePresetId?: unknown });
        delete legacyRun.pipelinePresetId;
        const run: ProductionRun = {
          ...legacyRun,
          steps: Array.isArray(legacyRun.steps) ? legacyRun.steps.map(normalizeStep) : [],
        };
        if (run.status === "queued" || run.status === "running" || run.status === "resolving") {
          run.status = "failed";
          run.error = "服务重启前生产任务尚未完成；请手动重试（已验证/部分文件会被复用）";
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
        // Backfill DAG nodes introduced after the run was persisted so
        // historical records never render phantom pending steps.
        const pipeline = PRODUCTION_PIPELINES.find((candidate) => candidate.key === run.pipelineKey);
        if (pipeline) {
          pipeline.dag.forEach((node) => {
            if (run.steps.some((step) => step.id === node.id)) return;
            run.steps.push(normalizeStep({ id: node.id, title: node.title, status: "skipped", detail: "历史记录：该节点在任务执行后引入", logs: [] }));
          });
          const order = new Map(pipeline.dag.map((node, index) => [node.id, index]));
          run.steps.sort((left, right) => (order.get(left.id) ?? 999) - (order.get(right.id) ?? 999));
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
    return this.#submitValidated(inputValue);
  }

  async #submitValidated(inputValue: unknown, reuse?: { inventory: SourceFileInventory; approval: ProductionApproval; originId: string }): Promise<ProductionRun> {
    await this.initialize();
    if (!inputValue || typeof inputValue !== "object" || Array.isArray(inputValue)) throw new RangeError("production input must be an object");
    const input = inputValue as ProductionRunInput;
    const pipelineKey = text(input.pipelineKey, "pipelineKey");
    const pipeline = PRODUCTION_PIPELINES.find((candidate) => candidate.key === pipelineKey);
    if (!pipeline) throw new RangeError(`Unknown production pipeline: ${pipelineKey}`);
    if (pipeline.availability !== "available") throw new RangeError("该流水线尚未开放提交");
    const region = regionSnapshot(input.region);
    const normalized: Record<string, unknown> = { pipelineKey, region };
    const steps: ProductionStep[] = pipeline.dag.map((node) => ({ id: node.id, title: node.title, status: "pending", logs: [] }));
    let initialStatus: ProductionRunStatus = "queued";
    if (pipeline.id === "overlap-download") {
      const hasLegacyFiles = Array.isArray(input.files) && input.files.length > 0;
      if (input.files !== undefined && !hasLegacyFiles) throw new RangeError("overlap-download files must be a non-empty array when provided");
      const exportFormat = input.exportFormat ?? "json";
      if (exportFormat !== "json" && exportFormat !== "csv") throw new RangeError("exportFormat must be json or csv");
      const crawlerId = input.crawlerId === undefined ? "builtin-http" : text(input.crawlerId, "crawlerId");
      const concurrency = input.concurrency === undefined ? 4 : input.concurrency;
      if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new RangeError("concurrency must be an integer between 1 and 16");
      if (hasLegacyFiles) normalized.files = clone(input.files);
      normalized.exportFormat = exportFormat;
      normalized.crawlerId = crawlerId;
      normalized.concurrency = concurrency;
      if (input.storageConnectorId !== undefined) normalized.storageConnectorId = text(input.storageConnectorId, "storageConnectorId");
      const warehouseHandoff = input.warehouseHandoff ?? "none";
      if (warehouseHandoff !== "none" && warehouseHandoff !== "submit") throw new RangeError("warehouseHandoff must be none or submit");
      normalized.warehouseHandoff = warehouseHandoff;
      // Runs without pre-expanded files resolve their source units inside the
      // run and pause at a human approval gate before any transfer.
      if (!hasLegacyFiles) initialStatus = "resolving";
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
    }
    const createdAt = now();
    const run: ProductionRun = {
      id: `prd_${createdAt.replace(/[-:.TZ]/g, "").slice(0, 14)}_${randomUUID().slice(0, 8)}`,
      pipelineKey,
      status: initialStatus,
      createdAt,
      updatedAt: createdAt,
      input: normalized,
      steps,
      artifacts: [],
      summary: {},
      ...(reuse ? { inventory: clone(reuse.inventory), approval: { ...clone(reuse.approval), reused: true }, retryOfRunId: reuse.originId } : {}),
    };
    if (reuse) {
      run.summary = {
        ...run.summary,
        inventorySha256: reuse.inventory.inventorySha256,
        inventoryFiles: reuse.inventory.files.length,
        inventoryUnits: reuse.inventory.units.length,
      };
      this.appendStepLog(run, "resolve", "info", `复用来源运行 ${reuse.originId} 的已审批清单`);
    }
    this.#runs.set(run.id, run);
    await this.#persist();
    void this.#execute(run.id);
    return clone(run);
  }

  /** Approve the pending inventory; the decision binds to the plan SHA-256. */
  async approve(id: string, planSha256: string, decidedBy: "user" | "agent" = "user"): Promise<ProductionRun> {
    await this.initialize();
    const run = this.#runs.get(text(id, "production run id"));
    if (!run) throw new Error(`Production run not found: ${id}`);
    if (run.status !== "awaiting-approval") throw new ProductionStateError("只有等待审批的生产任务可以审批");
    const expected = run.approval?.planSha256 ?? "";
    if (typeof planSha256 !== "string" || !/^[0-9a-f]{64}$/.test(planSha256) || planSha256 !== expected) {
      throw new ProductionStateError("清单校验值不匹配；请刷新清单后重试");
    }
    run.approval = { ...run.approval!, state: "approved", decidedAt: now(), decidedBy };
    this.appendStepLog(run, "approval", "info", `已批准下载清单 ${planSha256.slice(0, 12)}…`);
    await this.setStep(run, "approval", "succeeded", "清单已批准");
    run.status = "queued";
    await this.#save(run);
    void this.#execute(run.id);
    return clone(run);
  }

  /** Reject the pending inventory; the run terminates without any transfer. */
  async reject(id: string): Promise<ProductionRun> {
    await this.initialize();
    const run = this.#runs.get(text(id, "production run id"));
    if (!run) throw new Error(`Production run not found: ${id}`);
    if (run.status !== "awaiting-approval") throw new ProductionStateError("只有等待审批的生产任务可以拒绝");
    run.approval = { ...run.approval!, state: "rejected", decidedAt: now() };
    run.status = "rejected";
    run.completedAt = now();
    const approvalStep = run.steps.find((step) => step.id === "approval");
    if (approvalStep) this.updateStep(approvalStep, "cancelled", "用户拒绝下载清单", "warning");
    run.steps.forEach((step) => {
      if (step.status === "pending") this.updateStep(step, "skipped", "清单被拒绝，未执行");
    });
    await this.#save(run);
    return clone(run);
  }

  async cancel(id: string): Promise<ProductionRun> {
    const run = await this.getRun(id);
    if (run.status === "queued" || run.status === "resolving" || run.status === "awaiting-approval") {
      const live = this.#runs.get(run.id)!;
      if (live.status === "running") return this.#cancelRunning(live);
      live.status = "cancelled";
      live.completedAt = now();
      live.error = "用户取消任务";
      const first = live.steps.find((step) => step.status === "running" || step.status === "pending");
      if (first) this.updateStep(first, "cancelled", live.error, "warning");
      live.steps.forEach((step) => {
        if (step.status === "pending") this.updateStep(step, "skipped", "任务已取消");
      });
      await this.#save(live);
      return clone(live);
    }
    if (run.status === "running" && run.pipelineKey === "overlap-download@1") {
      return this.#cancelRunning(this.#runs.get(run.id)!);
    }
    return clone(run);
  }

  async #cancelRunning(live: ProductionRun): Promise<ProductionRun> {
    const downloadId = typeof live.summary.downloadJobId === "string" ? live.summary.downloadJobId : undefined;
    if (downloadId) await this.#downloads.cancel(downloadId).catch(() => undefined);
    live.status = "cancelled";
    live.completedAt = now();
    live.error = "用户取消任务";
    const active = live.steps.find((step) => step.status === "running");
    if (active) this.updateStep(active, "cancelled", live.error, "warning");
    await this.#save(live);
    return clone(live);
  }

  async retry(id: string): Promise<ProductionRun> {
    const run = await this.getRun(id);
    if (run.status !== "failed" && run.status !== "cancelled") throw new RangeError("Only failed or cancelled production runs can be retried");
    const input = clone(run.input);
    // Reuse the previously approved inventory and staging when it exists so a
    // retry never re-resolves or re-downloads verified bytes.
    if (run.inventory && run.approval?.state === "approved" && !input.files) {
      return this.#submitValidated(input, { inventory: run.inventory, approval: run.approval, originId: run.retryOfRunId ?? run.id });
    }
    return this.#submitValidated(input);
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
    if (!run || (run.status !== "queued" && run.status !== "resolving")) return;
    run.startedAt ??= now();
    if (run.status === "queued") run.status = "running";
    await this.#save(run);
    try {
      if (run.pipelineKey === "overlap-download@1") await this.#executeDownload(run);
      else await this.#executeCrossmatch(run);
      // Paused or terminal states set inside the execution body win.
      const statusAfter: ProductionRunStatus = String(run.status) as ProductionRunStatus;
      if (statusAfter === "awaiting-approval" || statusAfter === "rejected" || statusAfter === "cancelled") {
        await this.#save(run);
        return;
      }
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
    const originId = run.retryOfRunId ?? run.id;

    // --- region ---
    const regionStep = run.steps.find((step) => step.id === "region");
    if (regionStep?.status !== "succeeded") {
      const exportFormat = run.input.exportFormat === "csv" ? "csv" : "json";
      const regionName = exportFormat === "csv" ? "region.csv" : "region.json";
      const regionContent = exportFormat === "csv" ? regionCsv(region) : `${JSON.stringify(region, null, 2)}\n`;
      await this.setStep(run, "region", "running", `准备 ${region.pixels.length} 个 HEALPix 单元`);
      await this.writeArtifact(run, regionName, exportFormat === "csv" ? "text/csv; charset=utf-8" : "application/json", regionContent);
      await this.setStep(run, "region", "succeeded", `已生成 ${regionName}`);
    }

    // --- resolve ---
    const resolveStep = run.steps.find((step) => step.id === "resolve");
    if (resolveStep?.status !== "succeeded" && !run.inventory) {
      await this.setStep(run, "resolve", "running", run.input.files ? "直接文件输入，构造清单" : "解析区域来源单元");
      let inventory: SourceFileInventory;
      if (Array.isArray(run.input.files)) {
        inventory = directFilesInventory(run.input.files as CoverageDownloadFile[]);
      } else if (run.retryOfRunId) {
        throw new Error("重试运行缺少可复用的清单；请重新提交任务");
      } else if (this.#sourceResolver) {
        const resolution = await this.#sourceResolver.resolve(region);
        // A cancelled run must not continue past its in-flight resolution.
        if (run.status !== "resolving" && run.status !== "running") return;
        inventory = await resolveSourceInventory(resolution.units);
        inventory.units = [...inventory.units, ...resolution.blocked.map((entry) => ({
          sourceId: entry.sourceId,
          unitId: `blocked:${entry.sourceId}`,
          resolver: "direct-file@1" as const,
          status: "unavailable" as const,
          reason: entry.reason,
          fileCount: 0,
        }))];
      } else {
        throw new Error("当前部署未配置来源解析适配器，无法解析该区域");
      }
      const blocked = inventory.units.filter((unit) => unit.status === "unavailable");
      const knownBytes = inventory.files.reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0);
      run.inventory = inventory;
      run.summary = {
        ...run.summary,
        inventorySha256: inventory.inventorySha256,
        inventoryFiles: inventory.files.length,
        inventoryBytes: knownBytes,
        inventoryUnits: inventory.units.length,
        ...(blocked.length ? { blockedUnits: blocked.map((unit) => ({ sourceId: unit.sourceId, unitId: unit.unitId, reason: unit.reason ?? "未知原因" })) } : {}),
        ...(inventory.truncated ? { inventoryTruncated: true } : {}),
      };
      await this.writeArtifact(run, "download-plan.json", "application/json", `${JSON.stringify({ inventory, summary: run.summary }, null, 2)}\n`);
      if (blocked.length) {
        const detail = blocked.map((unit) => `${unit.sourceId}/${unit.unitId}: ${unit.reason ?? "未知原因"}`).join("；");
        this.appendStepLog(run, "resolve", "error", `以下来源单元无法解析，任务整体阻断：${detail}`);
        await this.setStep(run, "resolve", "failed", "存在无法解析的来源单元");
        throw new Error(`来源解析受阻（${blocked.length} 个单元）：${detail}`.slice(0, 2_000));
      }
      if (!inventory.files.length) {
        await this.setStep(run, "resolve", "failed", "未解析到任何可下载文件");
        throw new Error("来源解析完成但没有可下载文件");
      }
      await this.setStep(run, "resolve", "succeeded", `${inventory.units.length} 个来源单元 · ${inventory.files.length} 个文件`);
    }
    if (!run.inventory) throw new Error("缺少下载清单");
    const inventory = run.inventory;

    // --- approval ---
    if (run.approval?.state === "approved") {
      await this.setStep(run, "approval", "succeeded", run.approval.reused ? "复用先前审批的清单" : "清单已批准");
    } else if (Array.isArray(run.input.files)) {
      // Legacy pre-expanded input is treated as pre-approved by the caller.
      run.approval = { state: "approved", planSha256: inventory.inventorySha256, decidedAt: now(), decidedBy: "system-legacy" };
      this.appendStepLog(run, "approval", "info", "直接文件输入按兼容策略视为已审批");
      await this.setStep(run, "approval", "succeeded", "直接文件输入（免审批）");
    } else {
      run.approval = { state: "pending", planSha256: inventory.inventorySha256 };
      run.status = "awaiting-approval";
      await this.setStep(run, "approval", "pending", "等待人工审批下载清单");
      await this.#save(run);
      return; // execution resumes through approve()
    }

    // --- download ---
    await this.setStep(run, "download", "running", `流式下载 ${inventory.files.length} 个文件，并发数 ${Number(run.input.concurrency ?? 4)}`);
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
      files: inventory.files.map((file) => ({
        url: file.url,
        name: file.relativePath.split("/").pop() ?? file.relativePath,
        relativePath: file.relativePath,
        ...(file.sizeBytes !== undefined ? { sizeBytes: file.sizeBytes } : {}),
        ...(file.sha256 ? { sha256: file.sha256 } : {}),
        ...(file.etag ? { etag: file.etag } : {}),
        ...(file.lastModified ? { lastModified: file.lastModified } : {}),
      })),
      componentId: region.componentId,
      sourceIds: region.sourceIds,
      concurrency: Number(run.input.concurrency ?? 4),
      requestKey: `production:${originId}`,
      inventorySha256: inventory.inventorySha256,
      ...(outputRoot ? { outputRoot } : {}),
      outputPrefix: originId,
    });
    run.summary = { ...run.summary, downloadJobId: download.id, files: download.totalFiles };
    this.appendStepLog(run, "download", "info", `下载任务 ${download.id} 已提交，共 ${download.totalFiles} 个文件`);
    await this.#save(run);
    let current: CoverageDownloadJob = download;
    let loggedFiles = current.downloadedFiles;
    for (let attempt = 0; attempt < DOWNLOAD_POLL_ATTEMPTS; attempt += 1) {
      if (current.status === "completed" || current.status === "failed" || current.status === "cancelled") break;
      await new Promise((resolve) => setTimeout(resolve, DOWNLOAD_POLL_INTERVAL_MS));
      current = await this.#downloads.get(download.id);
      run.summary = { ...run.summary, downloadedFiles: current.downloadedFiles, downloadedBytes: current.downloadedBytes };
      if (current.downloadedFiles !== loggedFiles) {
        loggedFiles = current.downloadedFiles;
        this.appendStepLog(run, "download", "info", `已完成 ${current.downloadedFiles}/${current.totalFiles} 个文件，${current.downloadedBytes} bytes`);
      }
      await this.#save(run);
    }
    if (current.status !== "completed" && current.status !== "failed" && current.status !== "cancelled") {
      await this.#downloads.cancel(download.id).catch(() => undefined);
      throw new Error("下载任务超时（1 小时），已请求取消；可重试复用已下载内容");
    }
    if (current.status === "cancelled") { run.status = "cancelled"; throw new Error(current.error ?? "下载已取消"); }
    if (current.status !== "completed") throw new Error(current.error ?? "下载失败");
    run.outputConnectorId = current.outputConnectorId;
    run.outputPath = current.outputPath;
    await this.setStep(run, "download", "succeeded", `${current.downloadedFiles} 个文件下载完成`);

    // --- connector ---
    await this.setStep(run, "connector", "running", "正在登记下载结果");
    await this.writeArtifact(run, "download-manifest.json", "application/json", `${JSON.stringify({ region, crawlerId: run.input.crawlerId, inventory, job: current }, null, 2)}\n`);
    await this.setStep(run, "connector", "succeeded", current.outputConnectorId ?? "已登记");

    // --- warehouse ---
    const handoffMode = run.input.warehouseHandoff === "submit" ? "submit" : "none";
    if (handoffMode === "none") {
      await this.setStep(run, "warehouse", "skipped", "未请求 Warehouse 扫描");
      return;
    }
    if (!this.#warehouseHandoff) {
      await this.setStep(run, "warehouse", "failed", "当前部署未启用 Warehouse 扫描适配器");
      throw new Error("请求提交 Warehouse 扫描，但当前部署未启用 Warehouse（请设置 warehouseHandoff=none 或启用 Warehouse）");
    }
    if (!run.outputConnectorId) throw new Error("缺少输出 Connector，无法提交 Warehouse 扫描");
    await this.setStep(run, "warehouse", "running", "提交 Warehouse 扫描请求");
    const receipt = await this.#warehouseHandoff.submit({
      runId: originId,
      connectorId: run.outputConnectorId,
      inventorySha256: inventory.inventorySha256,
    });
    run.summary = { ...run.summary, warehouseScanRuns: receipt.scanRunIds };
    await this.setStep(run, "warehouse", "succeeded", `Warehouse 已受理 ${receipt.scanRunIds.length} 个扫描请求`);
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
    const directory = path.join(this.#root, run.id);
    await mkdir(directory, { recursive: true });
    const bytes = Buffer.from(content, "utf8");
    // Atomic publication: readers never observe a partial artifact.
    const temporary = path.join(directory, `.${name}.${randomUUID()}.tmp`);
    await writeFile(temporary, bytes, { mode: 0o600 });
    await rename(temporary, path.join(directory, name));
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
    const state: PersistedState = { schemaVersion: 2, runs: snapshot };
    const previous = this.#writes.get("state") ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      const temporary = `${this.#statePath}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.#statePath);
    });
    this.#writes.set("state", current);
    try { await current; } finally { if (this.#writes.get("state") === current) this.#writes.delete("state"); }
  }

}

export type { CoverageDownloadFile, CoverageDownloadJob, SourceFileInventory, SourceUnit };
