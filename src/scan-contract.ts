import path from "node:path";
import type { ConnectorRecord } from "./connectors.js";

function s3Uri(connector: ConnectorRecord, key: string): string {
  return key ? `s3://${connector.config.bucket}/${key}` : `s3://${connector.config.bucket}`;
}

function cleanS3Value(value: string | undefined): string {
  return (value ?? "").trim().replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
}

/** POSIX-relative sub path: no empty / '.' / '..' segments, no NULs. */
function relativeSubPath(value: string): string {
  const trimmed = value.trim().replace(/^\/+/, "");
  if (!trimmed) throw new RangeError("scan path is required");
  if (trimmed.includes("\0")) throw new RangeError("scan path must not contain NUL");
  if (trimmed.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new RangeError("scan path cannot contain empty or dot segments");
  }
  return trimmed;
}

/** Resolve a local connector scan root; the path is canonicalized lexically. */
function localRoot(connector: ConnectorRecord): string {
  const rootPath = (connector.config.rootPath ?? "").trim();
  if (!rootPath || !path.isAbsolute(rootPath)) throw new RangeError("local connector rootPath must be an absolute path");
  const normalized = path.normalize(rootPath);
  return normalized;
}

export function connectorScanPath(connector: ConnectorRecord, requested?: string): string {
  if (connector.kind === "local") {
    const rootPath = localRoot(connector);
    // Omitted path scans the whole registered root. An explicit path must be
    // a safe relative sub path contained by the root (no traversal).
    const subPath = requested === undefined ? "" : relativeSubPath(requested);
    const resolved = subPath ? path.normalize(path.join(rootPath, subPath)) : rootPath;
    if (resolved !== rootPath && !resolved.startsWith(rootPath + path.sep)) {
      throw new RangeError("scan path must stay inside the connector root");
    }
    return resolved;
  }
  const base = cleanS3Value(connector.config.prefix);
  // An empty registered prefix denotes the bucket root. Keep an omitted path
  // distinct from an explicitly empty request, which remains invalid input.
  if (requested === undefined && !base) return s3Uri(connector, "");
  const raw = (requested ?? base).trim();
  if (!raw) throw new RangeError("scan path is required");
  if (/^s3a?:\/\//i.test(raw)) {
    const rawPath = raw.replace(/^s3a?:\/\/[^/]+/i, "").split(/[?#]/, 1)[0] ?? "";
    let decodedRawPath: string;
    try { decodedRawPath = decodeURIComponent(rawPath); } catch { throw new RangeError("scan path contains invalid escaping"); }
    if (decodedRawPath.split("/").some((segment) => segment === ".." || segment === ".")) {
      throw new RangeError("scan path cannot contain dot segments");
    }
    let parsed: URL;
    try { parsed = new URL(raw); } catch { throw new RangeError("scan path must be a valid S3 URI"); }
    if (parsed.search || parsed.hash || parsed.hostname.toLowerCase() !== cleanS3Value(connector.config.bucket).toLowerCase()) {
      throw new RangeError("scan path must stay inside the connector bucket");
    }
    const key = decodedRawPath.replace(/^\/+/, "");
    if (base && key !== base && !key.startsWith(`${base}/`)) throw new RangeError("scan path must stay inside the connector prefix");
    return s3Uri(connector, key);
  }
  const requestedKey = raw.replace(/^\/+/, "");
  if (requestedKey.split("/").some((segment) => segment === ".." || segment === ".")) {
    throw new RangeError("scan path cannot contain dot segments");
  }
  // Accept both a bucket-relative key and a path relative to the registered
  // connector prefix while keeping the scan inside that prefix.
  const key = base && requestedKey !== base && !requestedKey.startsWith(`${base}/`)
    ? `${base}/${requestedKey}`
    : requestedKey;
  if (base && key !== base && !key.startsWith(`${base}/`)) throw new RangeError("scan path must stay inside the connector prefix");
  return s3Uri(connector, key);
}
