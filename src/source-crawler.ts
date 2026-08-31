import path from "node:path";

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
  if (source.protocol !== "http:" && source.protocol !== "https:") return { files: [], reason: "仅支持 HTTP/HTTPS 来源" };
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
    const discovered = uniqueCandidates(listingLinks(body, source), maxFiles);
    if (!discovered.files.length) return { files: [], reason: "爬虫未发现可下载文件（来源可能是说明页或 MOC 服务）", truncated: discovered.truncated };
    return discovered;
  } catch (error) {
    return { files: [], reason: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) };
  }
}
