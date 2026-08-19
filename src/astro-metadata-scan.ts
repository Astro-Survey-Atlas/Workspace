import { createHash } from "node:crypto";

export const ASTRO_METADATA_API = "org.zhejianglab.astro.metadata/v1alpha1";
export const HANDLER_NAMES = ["default", "fits", "coverage", "object"] as const;
export type HandlerName = typeof HANDLER_NAMES[number];
export type DataSourceType = "s3" | "oss" | "elasticsearch" | "local";
export type ScanBackend = "job" | "flink";

export interface AstroDataSource { apiVersion?: string; kind?: "AstroDataSource"; metadata?: { name?: string; namespace?: string }; spec: { type: DataSourceType; endpoint?: string; bucket?: string; prefix?: string; credentialSecretRef?: { name: string }; mount?: { pvcName: string; subPath?: string } } }
export interface ScanDataSourceRef { name: string }
export interface AstroMetadataScanTask { apiVersion?: string; kind?: "AstroMetadataScanTask"; metadata?: { name?: string; namespace?: string; labels?: Record<string, string> }; spec: { backend?: ScanBackend; source: { dataSourceRef?: ScanDataSourceRef; paths: string[] }; tags?: string[]; userProperties?: Record<string, string>; pathPatterns?: Record<string, string>; handlers?: string[]; sink?: { dataSourceRef: ScanDataSourceRef }; extraEnv?: Record<string, string> } }
export interface ScanExecutionPlan { apiVersion: string; taskName: string; backend: ScanBackend; source: { dataSourceRef?: ScanDataSourceRef; paths: string[] }; tags: string[]; userProperties: Record<string, string>; pathPatterns: Record<string, string>; handlers: HandlerName[]; sink?: { dataSourceRef: ScanDataSourceRef }; extraEnv: Record<string, string> }
export type ScanPhase = "Pending" | "Running" | "Succeeded" | "Failed";
export interface AstroMetadataScanStatus { phase: ScanPhase; backend: ScanBackend; runId: string; discoveredFiles: number; processedHdus: number; coverageDocuments: number; objectDocuments: number; startedAt?: string; completedAt?: string; message?: string }

export function scanPhase(value: unknown): ScanPhase {
  const textValue = typeof value === "string" ? value.toLowerCase() : "";
  if (["succeeded", "finished", "complete", "completed"].includes(textValue)) return "Succeeded";
  if (["failed", "error", "canceled", "cancelled"].includes(textValue)) return "Failed";
  if (["running", "active"].includes(textValue)) return "Running";
  return "Pending";
}

const text = (value: unknown, name: string, max = 512): string => { if (typeof value !== "string" || !value.trim()) throw new RangeError(`${name} is required`); if (value.trim().length > max) throw new RangeError(`${name} is too long`); return value.trim(); };
const record = (value: unknown, name: string): Record<string, unknown> => { if (value === undefined) return {}; if (!value || typeof value !== "object" || Array.isArray(value)) throw new RangeError(`${name} must be an object`); return value as Record<string, unknown>; };
const name = (value: unknown, field: string): string => { const result = text(value, field, 253); if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(result)) throw new RangeError(`${field} must be a DNS label`); return result; };
const MANAGED_ENV_KEYS = new Set(["S3_ENDPOINT", "S3_ACCESS_KEY", "S3_ACCESS_SECRET", "S3_REGION", "ES_HOST", "ES_PORT", "ES_USER", "ES_PASSWORD", "SCAN_PATHS", "SCAN_PATH", "SCAN_CONFIG", "BATCH_ID"]);

export function validateAstroDataSource(input: unknown): AstroDataSource {
  if (!input || typeof input !== "object") throw new RangeError("AstroDataSource must be an object");
  const value = input as Partial<AstroDataSource>;
  const spec = value.spec as Partial<AstroDataSource["spec"]> | undefined;
  if (!spec || typeof spec !== "object") throw new RangeError("AstroDataSource.spec is required");
  if (!["s3", "oss", "elasticsearch", "local"].includes(spec.type as string)) throw new RangeError("AstroDataSource.spec.type is unsupported");
  const type = spec.type as DataSourceType;
  const endpoint = spec.endpoint === undefined ? undefined : text(spec.endpoint, "spec.endpoint", 2048);
  if (type !== "local" && !endpoint) throw new RangeError("spec.endpoint is required for remote data sources");
  if (endpoint) { try { const parsed = new URL(endpoint); if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(); } catch { throw new RangeError("spec.endpoint must be an HTTP(S) URL"); } }
  if ((type === "s3" || type === "oss") && !spec.bucket) throw new RangeError("spec.bucket is required for object storage data sources");
  if (type === "local" && (!spec.mount || !name(spec.mount.pvcName, "spec.mount.pvcName"))) throw new RangeError("spec.mount.pvcName is required for local data sources");
  if (spec.prefix && spec.prefix.split("/").some((segment) => segment === "." || segment === "..")) throw new RangeError("spec.prefix cannot contain dot segments");
  if (spec.mount?.subPath && (spec.mount.subPath.startsWith("/") || spec.mount.subPath.split("/").some((segment) => segment === "." || segment === ".."))) throw new RangeError("spec.mount.subPath must stay inside the managed PVC");
  return structuredClone({ ...value, spec: { ...spec, type, ...(endpoint ? { endpoint } : {}) } }) as AstroDataSource;
}

export function validateAstroMetadataScanTask(input: unknown): AstroMetadataScanTask {
  if (!input || typeof input !== "object") throw new RangeError("AstroMetadataScanTask must be an object");
  const value = input as Partial<AstroMetadataScanTask>;
  const spec = value.spec;
  if (!spec || typeof spec !== "object") throw new RangeError("AstroMetadataScanTask.spec is required");
  const source = spec.source;
  if (!source || typeof source !== "object" || !Array.isArray(source.paths) || source.paths.length === 0) throw new RangeError("spec.source.paths must contain at least one path");
  const paths = source.paths.map((path, index) => text(path, `spec.source.paths[${index}]`, 4096));
  const handlers: HandlerName[] = (spec.handlers ?? ["default", "fits", "coverage"]).map((handler, index): HandlerName => { const value = text(handler, `spec.handlers[${index}]`, 64); if (!(HANDLER_NAMES as readonly string[]).includes(value)) throw new RangeError(`unknown handler: ${value}`); return value as HandlerName; });
  if (!handlers.includes("default")) throw new RangeError("spec.handlers must include default");
  if (new Set(handlers).size !== handlers.length) throw new RangeError("spec.handlers must not contain duplicates");
  const backend = spec.backend ?? "job";
  if (backend !== "job" && backend !== "flink") throw new RangeError("spec.backend must be job or flink");
  const tags = (spec.tags ?? []).map((tag, index) => text(tag, `spec.tags[${index}]`, 128));
  const userProperties = Object.fromEntries(Object.entries(record(spec.userProperties, "spec.userProperties")).map(([key, value]) => [text(key, "userProperties key", 256), text(value, `userProperties.${key}`, 4096)]));
  const pathPatterns = Object.fromEntries(Object.entries(record(spec.pathPatterns, "spec.pathPatterns")).map(([key, value]) => { const pattern = text(value, `pathPatterns.${key}`, 4096); try { new RegExp(pattern); } catch { throw new RangeError(`pathPatterns.${key} is not a valid regular expression`); } return [text(key, "pathPatterns key", 256), pattern]; }));
  const extraEnv = Object.fromEntries(Object.entries(record(spec.extraEnv, "spec.extraEnv")).map(([key, value]) => { const normalized = text(key, "extraEnv key", 256); if (MANAGED_ENV_KEYS.has(normalized)) throw new RangeError(`extraEnv cannot override managed key: ${normalized}`); return [normalized, text(value, `extraEnv.${key}`, 8192)]; }));
  return structuredClone({ ...value, apiVersion: ASTRO_METADATA_API, kind: "AstroMetadataScanTask", spec: { ...spec, backend, source: { ...source, paths }, handlers, tags, userProperties, pathPatterns, extraEnv } }) as AstroMetadataScanTask;
}

function sourcePathWithin(sourcePath: string, dataSource: AstroDataSource): boolean {
  const type = dataSource.spec.type;
  if (type === "local") { const path = sourcePath.startsWith("file:") ? (() => { try { return new URL(sourcePath).pathname; } catch { return ""; } })() : sourcePath; return path === "/data" || path.startsWith("/data/"); }
  let parsed: URL; try { parsed = new URL(sourcePath); } catch { return false; }
  if (parsed.search || parsed.hash) return false;
  if (type === "s3" || type === "oss") {
    if (parsed.protocol !== "s3:" && parsed.protocol !== "s3a:" && parsed.protocol !== "oss:") return false;
    if (dataSource.spec.bucket && parsed.hostname !== dataSource.spec.bucket) return false;
    const prefix = (dataSource.spec.prefix ?? "").replace(/^\/+|\/+$/g, "");
    let key: string; try { key = decodeURIComponent(parsed.pathname).replace(/^\/+/, ""); } catch { return false; }
    return !prefix || key === prefix || key.startsWith(`${prefix}/`);
  }
  return !!dataSource.spec.endpoint && new URL(dataSource.spec.endpoint).origin === parsed.origin;
}

export function validateSourcePaths(task: AstroMetadataScanTask, dataSource?: AstroDataSource): void {
  if (!task.spec.source.dataSourceRef && dataSource) throw new RangeError("dataSourceRef is required when validating a data source");
  if (!dataSource) return;
  for (const path of task.spec.source.paths) if (!sourcePathWithin(path, dataSource)) throw new RangeError(`source path is outside DataSource ${dataSource.metadata?.name ?? "scope"}: ${path}`);
}

export function compileScanExecutionPlan(taskInput: unknown, dataSource?: AstroDataSource): ScanExecutionPlan {
  const task = validateAstroMetadataScanTask(taskInput); if (dataSource) validateSourcePaths(task, validateAstroDataSource(dataSource));
  return { apiVersion: ASTRO_METADATA_API, taskName: name(task.metadata?.name ?? "scan", "metadata.name"), backend: task.spec.backend ?? "job", source: structuredClone(task.spec.source), tags: [...(task.spec.tags ?? [])], userProperties: { ...(task.spec.userProperties ?? {}) }, pathPatterns: { ...(task.spec.pathPatterns ?? {}) }, handlers: [...(task.spec.handlers ?? ["default", "fits", "coverage"])] as HandlerName[], ...(task.spec.sink ? { sink: structuredClone(task.spec.sink) } : {}), extraEnv: { ...(task.spec.extraEnv ?? {}) } };
}

export interface FileContext { uri: string; size?: number; modifiedAt?: string; fileType?: string; hdu?: FitsHdu[]; fields?: Record<string, unknown>; errors?: string[]; }
export interface FitsHdu { index: number; name?: string; type: "image" | "binary_table" | "ascii_table" | "unknown"; columns: string[]; header: Record<string, string | number | boolean>; }
export interface HandlerContext { file: FileContext; userProperties: Record<string, string>; documents: Record<string, unknown>[]; }
export type ScanHandler = (context: HandlerContext) => void | Promise<void>;
export class HandlerRegistry { readonly #handlers = new Map<HandlerName, ScanHandler>(); register(name: HandlerName, handler: ScanHandler): void { this.#handlers.set(name, handler); } get(name: string): ScanHandler { const handler = this.#handlers.get(name as HandlerName); if (!handler) throw new RangeError(`unknown handler: ${name}`); return handler; } async execute(names: readonly string[], context: HandlerContext): Promise<void> { for (const handler of names) await this.get(handler)(context); } }

export function parseFitsHeader(buffer: Uint8Array): FitsHdu[] {
  const decoder = new TextDecoder("ascii"); const result: FitsHdu[] = []; let offset = 0; let index = 0;
  while (offset + 80 <= buffer.length) {
    const hdu: FitsHdu = { index, type: "unknown", columns: [], header: {} }; let cards = 0; let ended = false;
    while (offset + 80 <= buffer.length) { const card = decoder.decode(buffer.slice(offset, offset + 80)); offset += 80; cards += 1; const key = card.slice(0, 8).trim(); if (key === "END") { ended = true; break; } if (!key || card[8] !== "=") continue; const raw = card.slice(10, 80).split("/")[0]!.trim(); const value = raw.startsWith("'") ? raw.replace(/^'|'$/g, "").trim() : raw === "T" ? true : raw === "F" ? false : Number.isFinite(Number(raw)) ? Number(raw) : raw; hdu.header[key] = value; if (key === "XTENSION") { const extension = String(value).toUpperCase(); hdu.type = extension.includes("BINTABLE") ? "binary_table" : extension.includes("TABLE") ? "ascii_table" : "unknown"; } if (/^TTYPE\d+$/.test(key)) hdu.columns.push(String(value)); if (key === "NAXIS" && Number(value) > 0 && hdu.type === "unknown") hdu.type = "image"; if (key === "EXTNAME") hdu.name = String(value); }
    if (!ended) break; result.push(hdu); index += 1;
    const bitpix = Math.abs(Number(hdu.header.BITPIX) || 0); const naxis = Number(hdu.header.NAXIS) || 0; let elements = 1; for (let axis = 1; axis <= naxis; axis += 1) elements *= Math.max(0, Number(hdu.header[`NAXIS${axis}`]) || 0); const rows = Number(hdu.header.NAXIS2) || 0; const rowBytes = Number(hdu.header.NAXIS1) || 0; const dataBytes = hdu.type === "binary_table" || hdu.type === "ascii_table" ? rows * rowBytes : elements * bitpix / 8; offset += Math.ceil(Math.max(0, dataBytes) / 2880) * 2880; cards = Math.ceil(cards * 80 / 2880) * 36;
    if (offset >= buffer.length) break;
  }
  return result;
}

export function createDefaultHandlerRegistry(): HandlerRegistry { const registry = new HandlerRegistry(); registry.register("default", ({ file }) => { file.fileType ??= file.uri.toLowerCase().endsWith(".fits") ? "fits" : "unknown"; file.fields ??= {}; file.errors ??= []; }); registry.register("fits", ({ file }) => { if (file.fileType === "fits" && !file.hdu) { file.errors ??= []; file.errors.push("FITS bytes are required for HDU parsing"); } }); registry.register("coverage", ({ file, documents, userProperties }) => { documents.push({ _index: "astro_coverage_index_v1", source_file_id: stableSourceFileId(file.uri), source_connector: userProperties.connector ?? userProperties.source_connector ?? "", asset_id: userProperties.assetId ?? userProperties.asset_id ?? "", run_id: userProperties.runId ?? userProperties.run_id ?? "", method: file.hdu?.some((hdu) => hdu.header.CTYPE1) ? "fits_wcs" : "catalog_radec", status: file.errors?.length ? "failed" : "succeeded" }); }); registry.register("object", ({ file, documents, userProperties }) => { if (userProperties.objectRows) documents.push({ _index: "astro_object_index_v1", source_file_id: stableSourceFileId(file.uri), source_connector: userProperties.connector ?? "", asset_id: userProperties.assetId ?? "", run_id: userProperties.runId ?? "" }); }); return registry; }
export function stableSourceFileId(uri: string): string { return createHash("sha256").update(uri).digest("hex"); }

export function buildJobManifest(plan: ScanExecutionPlan, options: { namespace: string; image: string; serviceAccountName?: string; dataSourceSecretName?: string }): Record<string, unknown> { const nameValue = name(plan.taskName, "taskName"); return { apiVersion: "batch/v1", kind: "Job", metadata: { name: nameValue, namespace: options.namespace, labels: { "app.kubernetes.io/managed-by": "astro-metadata-scan" } }, spec: { backoffLimit: 1, template: { metadata: { labels: { "app.kubernetes.io/name": "astro-metadata-scan", "astro.zhejianglab.org/task": nameValue } }, spec: { restartPolicy: "Never", ...(options.serviceAccountName ? { serviceAccountName: options.serviceAccountName } : {}), containers: [{ name: "harvester", image: options.image, args: ["scan", "--plan-json", JSON.stringify(plan)], env: Object.entries(plan.extraEnv).map(([name, value]) => ({ name, value })), ...(options.dataSourceSecretName ? { envFrom: [{ secretRef: { name: options.dataSourceSecretName } }] } : {}) }] } } } };
}
