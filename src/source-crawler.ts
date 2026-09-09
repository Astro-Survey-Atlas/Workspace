import { createHash } from "node:crypto";
import path from "node:path";

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
  const value = Number(response.headers.get("content-length") ?? "");
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
      head = await fetchImpl(source, { method: "HEAD", redirect: "error", headers, signal: AbortSignal.timeout(timeoutMs) });
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
      ? await fetchImpl(source, { method: "GET", redirect: "error", headers, signal: AbortSignal.timeout(timeoutMs) })
      : await fetchImpl(source, { method: "GET", redirect: "error", headers, signal: AbortSignal.timeout(timeoutMs) });
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

export type SourceResolverKey = "direct-file@1" | "http-directory@1" | "desi-tile@1";

export interface DirectFileSourceUnit {
  sourceId: string;
  unitId: string;
  resolver: "direct-file@1";
  url: string;
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

export type SourceUnit = DirectFileSourceUnit | HttpDirectorySourceUnit | DesiTileSourceUnit;

export interface SourceInventoryFile {
  sourceId: string;
  unitId: string;
  resolver: SourceResolverKey;
  relativePath: string;
  url: string;
  sizeBytes?: number;
  sha256?: string;
  etag?: string;
  lastModified?: string;
}

export interface SourceUnitResolution {
  sourceId: string;
  unitId: string;
  resolver: SourceResolverKey;
  status: "resolved" | "unavailable";
  reason?: string;
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
  /** Maximum number of files per directory-style unit. Default 512. */
  maxFilesPerUnit?: number;
  /** Maximum total inventory files across all units. Default 4096. */
  maxTotalFiles?: number;
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
    .map(({ sourceId, unitId, resolver, relativePath, url, sizeBytes, sha256 }) => ({ sourceId, unitId, resolver, relativePath, url, sizeBytes, sha256 }))
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
    const response = await fetchImpl(directoryUrl, { method: "GET", redirect: "error", headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { urls: [], truncated: false, reason: `目录返回 HTTP ${response.status}` };
    const contentType = response.headers.get("content-type") ?? "";
    if (!LISTING_CONTENT_TYPES.test(contentType)) {
      return { urls: [], truncated: false, reason: "来源不是目录列表（内容类型不符）" };
    }
    const body = await readLimited(response, maxListingBytes);
    const children = directoryChildLinks(body, directoryUrl);
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

async function resolveDirectFileUnit(unit: DirectFileSourceUnit, options: ResolveSourceInventoryOptions): Promise<SourceInventoryFile> {
  const url = await assertPublicHttpUrl(unit.url, {
    resolveHostname: options.resolveHostname,
    skipDnsLookup: options.skipDnsLookup ?? Boolean(options.fetchImpl && !options.resolveHostname),
  });
  const name = candidateName(url);
  if (!name) throw new RangeError(`直链没有可用文件名: ${unit.url}`);
  const relativePath = validateRelativePath(`sources/${safeSegment(unit.sourceId)}/${safeSegment(unit.unitId)}/${name}`);
  // Best-effort metadata enrichment; transfer revalidates before fetching.
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = Math.max(500, Math.min(60_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  let sizeBytes = unit.sizeBytes;
  let etag: string | undefined;
  let lastModified: string | undefined;
  try {
    const head = await fetchImpl(url, { method: "HEAD", redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    if (head.ok) {
      sizeBytes = sizeBytes ?? declaredSize(head);
      etag = head.headers.get("etag") ?? undefined;
      lastModified = head.headers.get("last-modified") ?? undefined;
    }
  } catch {
    // Enrichment is optional.
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
  };
}

async function resolveHttpDirectoryUnit(
  unit: HttpDirectorySourceUnit,
  options: ResolveSourceInventoryOptions,
): Promise<{ files: SourceInventoryFile[]; truncated: boolean; reason?: string }> {
  const directory = await assertPublicHttpUrl(unit.directoryUrl, {
    resolveHostname: options.resolveHostname,
    skipDnsLookup: options.skipDnsLookup ?? Boolean(options.fetchImpl && !options.resolveHostname),
  });
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
  const directory = await assertPublicHttpUrl(unit.directoryUrl, {
    resolveHostname: options.resolveHostname,
    skipDnsLookup: options.skipDnsLookup ?? Boolean(options.fetchImpl && !options.resolveHostname),
  });
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
      const response = await fetchImpl(new URL(checksumName, directory), { redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
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

/**
 * Resolve source units into the canonical download inventory. Duplicate
 * relative paths are a hard error (never silently renamed). Unreachable or
 * invalid units are reported per-unit; the caller decides whether to block.
 */
export async function resolveSourceInventory(
  units: readonly SourceUnit[],
  options: ResolveSourceInventoryOptions = {},
): Promise<SourceFileInventory> {
  const maxTotal = Math.max(1, Math.min(65_536, options.maxTotalFiles ?? DEFAULT_MAX_TOTAL_FILES));
  const files: SourceInventoryFile[] = [];
  const resolutions: SourceUnitResolution[] = [];
  let truncated = false;

  for (const unit of units) {
    try {
      if (unit.resolver === "direct-file@1") {
        const file = await resolveDirectFileUnit(unit, options);
        files.push(file);
        resolutions.push({ sourceId: unit.sourceId, unitId: unit.unitId, resolver: unit.resolver, status: "resolved", fileCount: 1 });
      } else if (unit.resolver === "http-directory@1") {
        const result = await resolveHttpDirectoryUnit(unit, options);
        truncated = truncated || result.truncated;
        files.push(...result.files);
        resolutions.push({
          sourceId: unit.sourceId,
          unitId: unit.unitId,
          resolver: unit.resolver,
          status: result.files.length ? "resolved" : "unavailable",
          fileCount: result.files.length,
          ...(result.reason ? { reason: result.reason } : {}),
          ...(result.truncated ? { truncated: true } : {}),
        });
      } else if (unit.resolver === "desi-tile@1") {
        const result = await resolveDesiTileUnit(unit, options);
        truncated = truncated || result.truncated;
        files.push(...result.files);
        resolutions.push({
          sourceId: unit.sourceId,
          unitId: unit.unitId,
          resolver: unit.resolver,
          status: result.files.length ? "resolved" : "unavailable",
          fileCount: result.files.length,
          ...(result.reason ? { reason: result.reason } : {}),
          ...(result.truncated ? { truncated: true } : {}),
        });
      } else {
        resolutions.push({ sourceId: String((unit as SourceUnit).sourceId), unitId: String((unit as SourceUnit).unitId), resolver: (unit as SourceUnit).resolver, status: "unavailable", reason: `未知解析器: ${String((unit as SourceUnit).resolver)}`, fileCount: 0 });
      }
    } catch (error) {
      resolutions.push({
        sourceId: unit.sourceId,
        unitId: unit.unitId,
        resolver: unit.resolver,
        status: "unavailable",
        reason: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
        fileCount: 0,
      });
    }
    if (files.length > maxTotal) throw new RangeError(`清单文件数超过上限 ${maxTotal}`);
  }

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
