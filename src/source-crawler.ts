import { createHash } from "node:crypto";
import path from "node:path";
import { abortable } from "./abortable.js";

import { fetchPublicHttp } from "./public-http.js";
import { assertPublicHttpUrl, type RemoteHostnameResolver } from "./remote-url-policy.js";

export interface SourceFileCandidate {
  url: string;
  name: string;
  sizeBytes?: number;
}

export interface SourceCrawlResult {
  files: SourceFileCandidate[];
  reason?: string;
  truncated?: boolean;
}

export interface SourceCrawlerOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  resolveHostname?: RemoteHostnameResolver;
  skipDnsLookup?: boolean;
  maxFiles?: number;
  maxListingBytes?: number;
  timeoutMs?: number;
}

const DEFAULT_MAX_FILES = 128;
const DEFAULT_MAX_LISTING_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

function sourceSignal(options: SourceCrawlerOptions, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
}
const FILE_EXTENSIONS = /\.(?:fits?|fits?\.gz|fz|csv|tsv|ecsv|jsonl?|parquet|zip|tgz|tar|gz|hdf5?|nc|xml|reg|txt)(?:$|[?#])/i;
const LISTING_CONTENT_TYPES = /^(?:text\/html|application\/json|application\/xml|text\/xml|text\/plain)(?:\s*;|$)/i;

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function candidateName(url: URL): string | undefined {
  const basename = path.basename(url.pathname.replace(/\/$/, ""));
  if (!basename || basename === "." || basename === "..") return undefined;
  const decoded = decodeURIComponent(basename);
  if (decoded.length > 180 || decoded.includes("/") || decoded.includes("\\")) return undefined;
  return decoded;
}

function likelyFile(url: URL, contentType = "", disposition = ""): boolean {
  return FILE_EXTENSIONS.test(url.href) || /attachment/i.test(disposition) || (Boolean(contentType) && !LISTING_CONTENT_TYPES.test(contentType));
}

function validUrl(value: string, base: URL): URL | undefined {
  try {
    const url = new URL(value, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.hash = "";
    return url;
  } catch {
    return undefined;
  }
}

function declaredSize(response: Response): number | undefined {
  const header = response.headers.get("content-length");
  if (!header || !/^\d+$/.test(header.trim())) return undefined;
  const value = Number(header);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

async function readLimited(response: Response, maximum: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximum) {
        await reader.cancel();
        return new TextDecoder().decode(concat(chunks));
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(concat(chunks));
}

async function readLimitedResult(response: Response, maximum: number): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: "", truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximum) {
        await reader.cancel();
        return { text: new TextDecoder().decode(concat(chunks)), truncated: true };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return { text: new TextDecoder().decode(concat(chunks)), truncated: false };
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  chunks.forEach((chunk) => {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  });
  return result;
}

function listingLinks(body: string, base: URL): URL[] {
  const values: string[] = [];
  const anchorPattern = /<a\b[^>]*\bhref\s*=\s*(['"])(.*?)\1/gi;
  for (const match of body.matchAll(anchorPattern)) if (match[2]) values.push(decodeHtml(match[2].trim()));
  const keyPattern = /<(?:Key|key)>\s*([^<]+?)\s*<\/(?:Key|key)>/g;
  for (const match of body.matchAll(keyPattern)) if (match[1]) values.push(decodeHtml(match[1].trim()));
  return values.flatMap((value) => {
    const url = validUrl(value, base);
    if (!url || !likelyFile(url)) return [];
    return [url];
  });
}

function uniqueCandidates(urls: readonly URL[], maxFiles: number): { files: SourceFileCandidate[]; truncated: boolean } {
  const files: SourceFileCandidate[] = [];
  const seen = new Set<string>();
  let truncated = false;
  for (const url of urls) {
    const name = candidateName(url);
    if (!name || seen.has(url.href)) continue;
    seen.add(url.href);
    if (files.length >= maxFiles) {
      truncated = true;
      continue;
    }
    files.push({ url: url.href, name });
  }
  return { files, truncated };
}

/** Discover direct files or file links from a public source URL. */
export async function discoverSourceFiles(sourceUrl: string, options: SourceCrawlerOptions = {}): Promise<SourceCrawlResult> {
  let source: URL;
  try {
    source = new URL(sourceUrl);
  } catch {
    return { files: [], reason: "来源 URL 无法解析" };
  }
  try {
    source = await assertPublicHttpUrl(source, {
      resolveHostname: options.resolveHostname,
      skipDnsLookup: options.skipDnsLookup ?? Boolean(options.fetchImpl && !options.resolveHostname),
    });
  } catch (error) {
    return { files: [], reason: error instanceof Error ? error.message : String(error) };
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxFiles = Math.max(1, Math.min(DEFAULT_MAX_FILES, options.maxFiles ?? DEFAULT_MAX_FILES));
  const maxListingBytes = Math.max(1024, Math.min(8 * 1024 * 1024, options.maxListingBytes ?? DEFAULT_MAX_LISTING_BYTES));
  const timeoutMs = Math.max(500, Math.min(60_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const headers = { Accept: "text/html, application/xml, application/json, application/octet-stream;q=0.5" };

  try {
    let head: Response | undefined;
    try {
      head = await fetchImpl(source, { method: "HEAD", redirect: "error", headers, signal: sourceSignal(options, timeoutMs) });
    } catch {
      // Some object stores do not implement HEAD. Fall back to a bounded GET.
    }
    if (head?.ok && likelyFile(source, head.headers.get("content-type") ?? "", head.headers.get("content-disposition") ?? "")) {
      const name = candidateName(source);
      if (!name) return { files: [], reason: "直链没有可用文件名" };
      const sizeBytes = declaredSize(head);
      return { files: [{ url: source.href, name, ...(sizeBytes === undefined ? {} : { sizeBytes }) }] };
    }

    const response = head?.ok && !likelyFile(source, head.headers.get("content-type") ?? "", head.headers.get("content-disposition") ?? "")
      ? await fetchImpl(source, { method: "GET", redirect: "error", headers, signal: sourceSignal(options, timeoutMs) })
      : await fetchImpl(source, { method: "GET", redirect: "error", headers, signal: sourceSignal(options, timeoutMs) });
    if (!response.ok) return { files: [], reason: `来源返回 HTTP ${response.status}` };
    const contentType = response.headers.get("content-type") ?? "";
    const disposition = response.headers.get("content-disposition") ?? "";
    if (likelyFile(source, contentType, disposition)) {
      const name = candidateName(source);
      if (!name) return { files: [], reason: "直链没有可用文件名" };
      const sizeBytes = declaredSize(response);
      return { files: [{ url: source.href, name, ...(sizeBytes === undefined ? {} : { sizeBytes }) }] };
    }
    const body = await readLimited(response, maxListingBytes);
    const listing = listingLinks(body, source);
    const checked = await Promise.all(listing.map(async (url) => {
      try {
        return await assertPublicHttpUrl(url, {
          resolveHostname: options.resolveHostname,
          skipDnsLookup: options.skipDnsLookup ?? Boolean(options.fetchImpl && !options.resolveHostname),
        });
      } catch {
        return undefined;
      }
    }));
    const discovered = uniqueCandidates(checked.filter((url): url is URL => Boolean(url)), maxFiles);
    if (!discovered.files.length) return { files: [], reason: "爬虫未发现可下载文件（来源可能是说明页或 MOC 服务）", truncated: discovered.truncated };
    return discovered;
  } catch (error) {
    return { files: [], reason: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) };
  }
}

/* -------------------------------------------------------------------------
 * Source-unit resolution (production inventory)
 *
 * Versioned adapters that turn typed source units into a canonical,
 * deterministic inventory. `discoverSourceFiles` above remains the legacy
 * single-source crawler used by the compatibility reverse-lookup route.
 * ---------------------------------------------------------------------- */

export type SourceResolverKey = "direct-file@1" | "http-directory@1" | "desi-tile@1" | "mast-observation@1";

export interface DirectFileSourceUnit {
  sourceId: string;
  unitId: string;
  resolver: "direct-file@1";
  url: string;
  filename?: string;
  sizeBytes?: number;
  sha256?: string;
}

export interface HttpDirectorySourceUnit {
  sourceId: string;
  unitId: string;
  resolver: "http-directory@1";
  directoryUrl: string;
}

export interface DesiTileSourceUnit {
  sourceId: string;
  unitId: string;
  resolver: "desi-tile@1";
  directoryUrl: string;
  release: string;
  redux: string;
  tileId: number;
  lastNight: string;
}

export interface MastObservationSourceUnit {
  sourceId: string;
  unitId: string;
  resolver: "mast-observation@1";
  observationId: string;
}

export type SourceUnit = DirectFileSourceUnit | HttpDirectorySourceUnit | DesiTileSourceUnit | MastObservationSourceUnit;

export interface SourceInventoryFile {
  sourceId: string;
  unitId: string;
  resolver: SourceResolverKey;
  layerId?: string;
  nativeUnitKind?: string;
  nativeUnitId?: string;
  relativePath: string;
  url: string;
  sizeBytes?: number;
  sha256?: string;
  etag?: string;
  lastModified?: string;
  metadataState?: "verified" | "unverified";
}

export interface SourceUnitResolution {
  sourceId: string;
  unitId: string;
  resolver: SourceResolverKey;
  status: "resolved" | "unavailable";
  reason?: string;
  note?: string;
  truncated?: boolean;
  fileCount: number;
}

export interface SourceFileInventory {
  schemaVersion: 1;
  inventorySha256: string;
  files: SourceInventoryFile[];
  units: SourceUnitResolution[];
  truncated: boolean;
}

export interface ResolveSourceInventoryOptions extends SourceCrawlerOptions {
  onUnitResolved?: (result: SourceInventoryUnitResult & { completed: number; total: number }) => void;
  /** Maximum number of files per directory-style unit. Default 512. */
  maxFilesPerUnit?: number;
  /** Maximum total inventory files across all units. Default 4096. */
  maxTotalFiles?: number;
  /** Maximum number of independent metadata units resolved at once. Default 1. */
  maxConcurrency?: number;
}

export interface SourceInventoryUnitResult {
  files: SourceInventoryFile[];
  resolution: SourceUnitResolution;
  truncated: boolean;
}

const DEFAULT_MAX_FILES_PER_UNIT = 512;
const DEFAULT_MAX_TOTAL_FILES = 4096;
const DESI_TILE_URL_PATTERN = /^https:\/\/data\.desi\.lbl\.gov\/public\/(dr1|edr)\/spectro\/redux\/(iron|fuji)\/tiles\/cumulative\/(\d{1,6})\/(\d{8})\/$/;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Deterministic collision-resistant filesystem-safe segment for source/unit ids. */
function safeSegment(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "").slice(0, 40) || "src";
  return `${slug}-${sha256Hex(value).slice(0, 8)}`;
}

function validateRelativePath(value: string): string {
  if (!value || value.length > 512) throw new RangeError("relativePath must contain 1..512 characters");
  if (value.includes("\0")) throw new RangeError("relativePath must not contain NUL");
  if (path.isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value)) throw new RangeError("relativePath must be relative");
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new RangeError("relativePath must not contain empty, '.' or '..' segments");
  }
  return value;
}

export { validateRelativePath };

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, member]) => member !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Hash only stable identity/metadata; volatile server hints (etag/lastModified) are excluded. */
function inventoryDigest(files: readonly SourceInventoryFile[], units: readonly SourceUnitResolution[]): string {
  const stableFiles = files
    .map(({ sourceId, unitId, resolver, layerId, nativeUnitKind, nativeUnitId, relativePath, url, sizeBytes, sha256 }) => ({ sourceId, unitId, resolver, layerId, nativeUnitKind, nativeUnitId, relativePath, url, sizeBytes, sha256 }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const stableUnits = [...units].sort((left, right) => left.unitId.localeCompare(right.unitId) || left.sourceId.localeCompare(right.sourceId));
  return sha256Hex(canonicalJson({ schemaVersion: 1, files: stableFiles, units: stableUnits }));
}

export { inventoryDigest as computeInventoryDigest };

/**
 * Extract immediate child file links from a directory listing document.
 * Only same-origin direct children are accepted; nested paths, parent links
 * and sub-directory anchors are rejected. Unlike the legacy crawler this does
 * not filter by known extensions because survey checksum files (.sha256sum)
 * are meaningful payloads.
 */
function directoryChildLinks(body: string, base: URL): URL[] {
  const values: string[] = [];
  const anchorPattern = /<a\b[^>]*\bhref\s*=\s*(['"])(.*?)\1/gi;
  for (const match of body.matchAll(anchorPattern)) if (match[2]) values.push(decodeHtml(match[2].trim()));
  const keyPattern = /<(?:Key|key)>\s*([^<]+?)\s*<\/(?:Key|key)>/g;
  for (const match of body.matchAll(keyPattern)) if (match[1]) values.push(decodeHtml(match[1].trim()));
  const basePath = base.pathname.replace(/\/?$/, "/");
  const children: URL[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const url = validUrl(value, base);
    if (!url) continue;
    // The link must resolve to a direct child: same origin, parent directory
    // exactly equals the listing directory, and no trailing slash (directory).
    if (url.origin !== base.origin) continue;
    if (url.pathname.endsWith("/")) continue;
    if (url.pathname === base.pathname) continue;
    const parent = `${url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1)}`;
    if (parent !== basePath) continue;
    if (url.search) continue;
    if (!candidateName(url)) continue;
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    children.push(url);
  }
  return children;
}

async function fetchDirectoryListing(
  directoryUrl: URL,
  options: ResolveSourceInventoryOptions,
): Promise<{ urls: URL[]; truncated: boolean; reason?: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxListingBytes = Math.max(1024, Math.min(8 * 1024 * 1024, options.maxListingBytes ?? DEFAULT_MAX_LISTING_BYTES));
  const timeoutMs = Math.max(500, Math.min(60_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const headers = { Accept: "text/html, application/xml, application/json, text/plain" };
  const maxPerUnit = Math.max(1, Math.min(4096, options.maxFilesPerUnit ?? DEFAULT_MAX_FILES_PER_UNIT));
  try {
    const response = await fetchPublicHttp(directoryUrl, { method: "GET", headers, signal: sourceSignal(options, timeoutMs) }, {
      fetchImpl,
      resolveHostname: options.resolveHostname,
      skipDnsLookup: options.skipDnsLookup ?? Boolean(options.fetchImpl && !options.resolveHostname),
    });
    if (!response.ok) return { urls: [], truncated: false, reason: `目录返回 HTTP ${response.status}` };
    const contentType = response.headers.get("content-type") ?? "";
    if (!LISTING_CONTENT_TYPES.test(contentType)) {
      return { urls: [], truncated: false, reason: "来源不是目录列表（内容类型不符）" };
    }
    const body = await readLimited(response, maxListingBytes);
    let listingBase = directoryUrl;
    if (response.url) {
      try { listingBase = new URL(response.url); }
      catch { return { urls: [], truncated: false, reason: "目录列表重定向目标无效" }; }
    }
    const children = directoryChildLinks(body, listingBase);
    if (!children.length) {
      return { urls: [], truncated: false, reason: "目录没有可下载的直接子文件" };
    }
    return {
      urls: children.slice(0, maxPerUnit),
      truncated: children.length > maxPerUnit,
    };
  } catch (error) {
    return { urls: [], truncated: false, reason: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) };
  }
}

/** Parse official DESI sha256sum listing content into name -> hash entries. */
function parseSha256Sum(body: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^([0-9a-fA-F]{64})\s+\*?([^\s*][^\r\n]*)$/);
    if (match && match[2]) entries.set(match[2].trim(), match[1]!.toLowerCase());
  }
  return entries;
}

function safeFileName(value: string): string | undefined {
  const name = value.trim();
  if (!name || name.length > 180 || name === "." || name === ".." || /[\\/\0\u0001-\u001f\u007f]/.test(name)) return undefined;
  return name;
}

async function resolveDirectFileUnit(unit: DirectFileSourceUnit, options: ResolveSourceInventoryOptions): Promise<SourceInventoryFile> {
  const url = new URL(unit.url);
  const name = unit.filename ? safeFileName(unit.filename) : candidateName(url);
  if (!name) throw new RangeError(`直链没有可用文件名: ${unit.url}`);
  const relativePath = validateRelativePath(`sources/${safeSegment(unit.sourceId)}/${safeSegment(unit.unitId)}/${name}`);
  // Best-effort metadata enrichment; transfer revalidates before fetching.
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = Math.max(500, Math.min(60_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  let sizeBytes = unit.sizeBytes;
  let etag: string | undefined;
  let lastModified: string | undefined;
  let metadataState: SourceInventoryFile["metadataState"] = "unverified";
  try {
    const head = await fetchPublicHttp(url, { method: "HEAD", signal: sourceSignal(options, timeoutMs) }, {
      fetchImpl,
      resolveHostname: options.resolveHostname,
      skipDnsLookup: options.skipDnsLookup ?? Boolean(options.fetchImpl && !options.resolveHostname),
    });
    if (head.status === 405 || head.status === 501) {
      metadataState = "unverified";
    } else if (!head.ok) {
      throw new InvalidSourceMetadataError(`Source metadata returned HTTP ${head.status}`);
    } else if (LISTING_CONTENT_TYPES.test(head.headers.get("content-type") ?? "")) {
      throw new InvalidSourceMetadataError("Source metadata identified an HTML, JSON, or text listing instead of a data file");
    } else {
      metadataState = "verified";
      sizeBytes = declaredSize(head) ?? unit.sizeBytes;
      etag = head.headers.get("etag") ?? undefined;
      lastModified = head.headers.get("last-modified") ?? undefined;
    }
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof InvalidSourceMetadataError) throw error;
    if (error instanceof RangeError || (error instanceof Error && /源站重定向/.test(error.message))) {
      throw new InvalidSourceMetadataError(error instanceof Error ? error.message : "Source metadata redirect is invalid");
    }
    metadataState = "unverified";
  }
  return {
    sourceId: unit.sourceId,
    unitId: unit.unitId,
    resolver: unit.resolver,
    relativePath,
    url: url.href,
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
    ...(unit.sha256 ? { sha256: unit.sha256 } : {}),
    ...(etag ? { etag } : {}),
    ...(lastModified ? { lastModified } : {}),
    ...(metadataState ? { metadataState } : {}),
  };
}

class InvalidSourceMetadataError extends Error {}

async function resolveHttpDirectoryUnit(
  unit: HttpDirectorySourceUnit,
  options: ResolveSourceInventoryOptions,
): Promise<{ files: SourceInventoryFile[]; truncated: boolean; reason?: string }> {
  const directory = new URL(unit.directoryUrl);
  const listing = await fetchDirectoryListing(directory, options);
  if (listing.reason) return { files: [], truncated: false, reason: listing.reason };
  const sourceKey = safeSegment(unit.sourceId);
  const unitKey = safeSegment(unit.unitId);
  const files: SourceInventoryFile[] = listing.urls.map((url) => ({
    sourceId: unit.sourceId,
    unitId: unit.unitId,
    resolver: unit.resolver,
    relativePath: validateRelativePath(`sources/${sourceKey}/${unitKey}/${candidateName(url)}`),
    url: url.href,
  }));
  return { files, truncated: listing.truncated };
}

async function resolveDesiTileUnit(
  unit: DesiTileSourceUnit,
  options: ResolveSourceInventoryOptions,
): Promise<{ files: SourceInventoryFile[]; truncated: boolean; reason?: string }> {
  const directory = new URL(unit.directoryUrl);
  const match = directory.href.match(DESI_TILE_URL_PATTERN);
  if (!match) {
    return { files: [], truncated: false, reason: "DESI tile 目录必须精确匹配 tiles/cumulative/TILEID/LASTNIGHT/ 叶子路径" };
  }
  const [, release, redux, tileIdText, lastNight] = match;
  if (unit.release !== release || unit.redux !== redux || String(unit.tileId) !== tileIdText || unit.lastNight !== lastNight) {
    return { files: [], truncated: false, reason: "DESI tile 单元声明与目录 URL 不一致" };
  }
  const listing = await fetchDirectoryListing(directory, options);
  if (listing.reason) return { files: [], truncated: false, reason: listing.reason };
  if (!listing.urls.length) return { files: [], truncated: listing.truncated, reason: "DESI tile 目录没有直接子文件" };

  const checksumName = `redux_${redux}_tiles_cumulative_${tileIdText}_${lastNight}.sha256sum`;
  let checksums = new Map<string, string>();
  if (listing.urls.some((url) => candidateName(url) === checksumName)) {
    const fetchImpl = options.fetchImpl ?? fetch;
    const timeoutMs = Math.max(500, Math.min(60_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    try {
      const response = await fetchPublicHttp(new URL(checksumName, directory), { signal: sourceSignal(options, timeoutMs) }, {
        fetchImpl,
        resolveHostname: options.resolveHostname,
        skipDnsLookup: options.skipDnsLookup ?? Boolean(options.fetchImpl && !options.resolveHostname),
      });
      if (response.ok) checksums = parseSha256Sum(await response.text());
    } catch {
      // Checksum enrichment is best-effort.
    }
  }

  const sourceKey = safeSegment(unit.sourceId);
  const prefix = `sources/${sourceKey}/desi/${release}/spectro/redux/${redux}/tiles/cumulative/${tileIdText}/${lastNight}`;
  const files: SourceInventoryFile[] = listing.urls.flatMap((url) => {
    const name = candidateName(url);
    if (!name) return [];
    const sha256 = checksums.get(name);
    return [{
      sourceId: unit.sourceId,
      unitId: unit.unitId,
      resolver: unit.resolver,
      relativePath: validateRelativePath(`${prefix}/${name}`),
      url: url.href,
      ...(sha256 ? { sha256 } : {}),
    }];
  });
  return { files, truncated: listing.truncated };
}

const MAST_PRODUCTS_URL = "https://mast.stsci.edu/api/v0/invoke";
const MAST_DOWNLOAD_URL = "https://mast.stsci.edu/api/v0.1/Download/file";
const HST_SCIENCE_FITS = /\.fits(?:\.gz|\.fz)?$/i;

function mastProductRows(value: unknown): { rows: Array<Record<string, unknown>>; pages?: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { rows: [] };
  const root = value as Record<string, unknown>;
  const tables = Array.isArray(root.Tables) ? root.Tables : [];
  const table = tables[0] && typeof tables[0] === "object" && !Array.isArray(tables[0])
    ? tables[0] as Record<string, unknown>
    : undefined;
  if (table && Array.isArray(table.Columns) && Array.isArray(table.Rows)) {
    const columns = table.Columns.map((column) => column && typeof column === "object" && !Array.isArray(column)
      ? (column as Record<string, unknown>).dataIndex
      : undefined);
    if (columns.length > 256 || columns.some((column) => typeof column !== "string")) return { rows: [] };
    const rows = table.Rows.flatMap((row): Array<Record<string, unknown>> => Array.isArray(row) && row.length === columns.length
      ? [Object.fromEntries(columns.map((column, index) => [column as string, row[index]]))]
      : []);
    const paging = root.paging && typeof root.paging === "object" ? root.paging as Record<string, unknown> : undefined;
    const pagesValue = Number(paging?.pagesFiltered ?? paging?.pages ?? root.pages ?? 1);
    return { rows, ...(Number.isSafeInteger(pagesValue) && pagesValue >= 0 ? { pages: pagesValue } : {}) };
  }
  const data = Array.isArray(root.data) ? root.data.flatMap((row): Array<Record<string, unknown>> => row && typeof row === "object" && !Array.isArray(row) ? [row as Record<string, unknown>] : []) : [];
  const paging = root.paging && typeof root.paging === "object" ? root.paging as Record<string, unknown> : undefined;
  const pagesValue = Number(paging?.pagesFiltered ?? paging?.pages ?? root.pages ?? 1);
  return { rows: data, ...(Number.isSafeInteger(pagesValue) && pagesValue >= 0 ? { pages: pagesValue } : {}) };
}

async function resolveMastObservationUnit(
  unit: MastObservationSourceUnit,
  options: ResolveSourceInventoryOptions,
): Promise<{ files: SourceInventoryFile[]; truncated: boolean; reason?: string }> {
  if (!/^\d{1,12}$/.test(unit.observationId)) {
    return { files: [], truncated: false, reason: "MAST observation id is invalid" };
  }
  const endpoint = new URL(MAST_PRODUCTS_URL);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = Math.max(500, Math.min(60_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const maxPerUnit = Math.max(1, Math.min(4096, options.maxFilesPerUnit ?? DEFAULT_MAX_FILES_PER_UNIT));
  const body = new URLSearchParams({ request: JSON.stringify({
    service: "Mast.Caom.Products",
    params: {
      obsid: Number(unit.observationId),
      columns: "obsid,parent_obsid,dataproduct_type,productFilename,dataURI,productType,dataSize,dataRights",
    },
    format: "json",
    pagesize: maxPerUnit + 1,
    page: 1,
  }) });

  try {
    const response = await fetchPublicHttp(endpoint, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: sourceSignal(options, timeoutMs),
    }, {
      fetchImpl,
      resolveHostname: options.resolveHostname,
      skipDnsLookup: options.skipDnsLookup ?? Boolean(options.fetchImpl && !options.resolveHostname),
    });
    if (!response.ok) return { files: [], truncated: false, reason: `MAST products returned HTTP ${response.status}` };
    const contentType = response.headers.get("content-type") ?? "";
    if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
      return { files: [], truncated: false, reason: "MAST products response is not JSON" };
    }
    const maximum = Math.max(1024, Math.min(8 * 1024 * 1024, options.maxListingBytes ?? DEFAULT_MAX_LISTING_BYTES));
    const limited = await readLimitedResult(response, maximum);
    if (limited.truncated) return { files: [], truncated: true, reason: "MAST products response exceeded the metadata limit" };
    const payload = JSON.parse(limited.text) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { files: [], truncated: false, reason: "MAST products response is invalid" };
    }
    const root = payload as Record<string, unknown>;
    if (typeof root.status === "string" && root.status.toUpperCase() !== "COMPLETE") {
      return { files: [], truncated: false, reason: "MAST did not complete the products query" };
    }
    const productRows = mastProductRows(payload);
    const data = productRows.rows;
    const truncated = data.length > maxPerUnit || (productRows.pages !== undefined && productRows.pages > 1);
    const sourceKey = safeSegment(unit.sourceId);
    const unitKey = safeSegment(unit.unitId);
    const files = data.slice(0, maxPerUnit).flatMap((item): SourceInventoryFile[] => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const record = item;
      if (String(record.productType ?? "").trim().toUpperCase() !== "SCIENCE"
        || String(record.dataRights ?? "").trim().toUpperCase() !== "PUBLIC") return [];
      const rowObservationId = record.parent_obsid ?? record.obsid;
      if (rowObservationId !== undefined && String(rowObservationId) !== unit.observationId) return [];
      if (record.dataproduct_type && String(record.dataproduct_type).toLowerCase() !== "image") return [];
      const fileName = typeof record.productFilename === "string" ? safeFileName(record.productFilename) : undefined;
      const dataUri = typeof record.dataURI === "string" ? record.dataURI.trim() : "";
      if (!fileName || !HST_SCIENCE_FITS.test(fileName) || !/^mast:HST\/product\/[A-Za-z0-9._+\-/]+$/i.test(dataUri)) return [];
      const download = new URL(MAST_DOWNLOAD_URL);
      download.searchParams.set("uri", dataUri);
      const sizeValue = Number(record.dataSize ?? record.sizeBytes ?? record.size);
      const sizeBytes = Number.isSafeInteger(sizeValue) && sizeValue >= 0 ? sizeValue : undefined;
      return [{
        sourceId: unit.sourceId,
        unitId: unit.unitId,
        resolver: unit.resolver,
        relativePath: validateRelativePath(`sources/${sourceKey}/${unitKey}/${fileName}`),
        url: download.href,
        ...(sizeBytes === undefined ? {} : { sizeBytes }),
      }];
    });
    return {
      files,
      truncated,
      ...(files.length ? {} : { reason: "MAST returned no public SCIENCE FITS products for this observation" }),
    };
  } catch (error) {
    return { files: [], truncated: false, reason: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) };
  }
}

async function resolveSourceUnit(
  unit: SourceUnit,
  options: ResolveSourceInventoryOptions,
): Promise<SourceInventoryUnitResult> {
  options.signal?.throwIfAborted();
  try {
    if (unit.resolver === "direct-file@1") {
      const file = await resolveDirectFileUnit(unit, options);
      return {
        files: [file],
        resolution: {
          sourceId: unit.sourceId,
          unitId: unit.unitId,
          resolver: unit.resolver,
          status: "resolved",
          fileCount: 1,
          ...(file.metadataState === "unverified" ? { note: "Source metadata could not be verified by HEAD; confirm the source before transfer." } : {}),
        },
        truncated: false,
      };
    }
    if (unit.resolver === "http-directory@1") {
      const result = await resolveHttpDirectoryUnit(unit, options);
      return {
        files: result.files,
        resolution: {
          sourceId: unit.sourceId,
          unitId: unit.unitId,
          resolver: unit.resolver,
          status: result.files.length ? "resolved" : "unavailable",
          fileCount: result.files.length,
          ...(result.reason ? { reason: result.reason } : {}),
          ...(result.truncated ? { truncated: true } : {}),
        },
        truncated: result.truncated,
      };
    }
    if (unit.resolver === "desi-tile@1") {
      const result = await resolveDesiTileUnit(unit, options);
      return {
        files: result.files,
        resolution: {
          sourceId: unit.sourceId,
          unitId: unit.unitId,
          resolver: unit.resolver,
          status: result.files.length ? "resolved" : "unavailable",
          fileCount: result.files.length,
          ...(result.reason ? { reason: result.reason } : {}),
          ...(result.truncated ? { truncated: true } : {}),
        },
        truncated: result.truncated,
      };
    }
    if (unit.resolver === "mast-observation@1") {
      const result = await resolveMastObservationUnit(unit, options);
      return {
        files: result.files,
        resolution: {
          sourceId: unit.sourceId,
          unitId: unit.unitId,
          resolver: unit.resolver,
          status: result.files.length ? "resolved" : "unavailable",
          fileCount: result.files.length,
          ...(result.reason ? { reason: result.reason } : {}),
          ...(result.truncated ? { truncated: true } : {}),
        },
        truncated: result.truncated,
      };
    }
    return {
      files: [],
      resolution: {
        sourceId: String((unit as SourceUnit).sourceId),
        unitId: String((unit as SourceUnit).unitId),
        resolver: (unit as SourceUnit).resolver,
        status: "unavailable",
        reason: `未知解析器: ${String((unit as SourceUnit).resolver)}`,
        fileCount: 0,
      },
      truncated: false,
    };
  } catch (error) {
    options.signal?.throwIfAborted();
    return {
      files: [],
      resolution: {
        sourceId: unit.sourceId,
        unitId: unit.unitId,
        resolver: unit.resolver,
        status: "unavailable",
        reason: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
        fileCount: 0,
      },
      truncated: false,
    };
  }
}

/**
 * Resolve source units into the canonical download inventory. Duplicate
 * relative paths are a hard error (never silently renamed). Unreachable or
 * invalid units are reported per-unit; the caller decides whether to block.
 */
export async function resolveSourceInventory(
  units: readonly SourceUnit[],
  options: ResolveSourceInventoryOptions = {},
): Promise<SourceFileInventory> {
  options.signal?.throwIfAborted();
  const maxTotal = Math.max(1, Math.min(65_536, options.maxTotalFiles ?? DEFAULT_MAX_TOTAL_FILES));
  const files: SourceInventoryFile[] = [];
  const resolutions: SourceUnitResolution[] = [];
  let truncated = false;

  const concurrency = Math.max(1, Math.min(8, Math.trunc(options.maxConcurrency ?? 1)));
  const perUnitMaximum = Math.max(1, Math.min(4096, options.maxFilesPerUnit ?? DEFAULT_MAX_FILES_PER_UNIT));
  let offset = 0;
  let completed = 0;
  const notify = (result: SourceInventoryUnitResult) => {
    options.signal?.throwIfAborted();
    options.onUnitResolved?.({ ...result, completed: ++completed, total: units.length });
    return result;
  };
  while (offset < units.length) {
    options.signal?.throwIfAborted();
    const remaining = maxTotal - files.length;
    if (remaining <= 0) {
      truncated = true;
      for (const unit of units.slice(offset)) {
        const resolution: SourceUnitResolution = { sourceId: unit.sourceId, unitId: unit.unitId, resolver: unit.resolver, status: "unavailable", reason: `inventory file limit ${maxTotal} reached`, truncated: true, fileCount: 0 };
        resolutions.push(resolution);
        notify({ files: [], resolution, truncated: true });
      }
      break;
    }
    const batchLength = Math.min(concurrency, units.length - offset, remaining);
    const batch = units.slice(offset, offset + batchLength);
    const baseQuota = Math.floor(remaining / batchLength);
    const extraQuota = remaining % batchLength;
    const resolved = await abortable(Promise.all(batch.map((unit, index) => {
      const quota = baseQuota + (index < extraQuota ? 1 : 0);
      return resolveSourceUnit(unit, {
        ...options,
        maxFilesPerUnit: Math.min(perUnitMaximum, quota),
      }).then(notify);
    })), options.signal);
    resolved.forEach((result) => {
      files.push(...result.files);
      resolutions.push(result.resolution);
      truncated = truncated || result.truncated;
    });
    offset += batchLength;
  }

  options.signal?.throwIfAborted();
  const seen = new Map<string, string>();
  for (const file of files) {
    const existing = seen.get(file.relativePath);
    if (existing) throw new RangeError(`清单相对路径冲突: ${file.relativePath}（${existing} 与 ${file.unitId}）`);
    seen.set(file.relativePath, file.unitId);
  }

  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return {
    schemaVersion: 1,
    inventorySha256: inventoryDigest(files, resolutions),
    files,
    units: resolutions,
    truncated,
  };
}
