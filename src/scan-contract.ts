import { connectorLocationKey, type ConnectorRecord } from "./connectors.js";
import type { CoverageJobSnapshot } from "./coverage-jobs.js";
import type { ConnectorScanTargetSnapshot } from "./connector-history.js";

/** Input shared by the Workspace scan adapters. It is deliberately independent
 * from either the legacy metadata CRD or the current Warehouse CRD. */
export interface GenericScanInput {
  assetId: string;
  path?: string;
  fileNamePattern?: string;
  allowedSuffixes?: string[];
  spatial?: {
    mode?: "none" | "auto" | "catalog" | "healpix";
    raColumn?: string;
    decColumn?: string;
    /** Name of a NESTED HEALPix pixel column for catalogs without RA/Dec. */
    healpixColumn?: string;
    frame?: string;
    units?: string;
    coverageRole?: string;
    healpixOrder?: number;
  };
  /** Optional MOC Core scan context for a user-owned remote asset. */
  coverage?: CoverageJobSnapshot;
}

export function validateConnectorSelfScanBody(body: unknown): void {
  if (body !== undefined && (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).length > 0)) {
    throw new RangeError("Connector scan runs do not accept a request body");
  }
}

export class DataWarehouseDisabledError extends Error {
  constructor() {
    super("Data warehouse is disabled");
    this.name = "DataWarehouseDisabledError";
  }
}

export class ConnectorScanCapabilityError extends Error {
  constructor(kind: ConnectorRecord["kind"]) {
    super(`Connector scan executor is not implemented for ${kind} connectors`);
    this.name = "ConnectorScanCapabilityError";
  }
}

export class ConnectorScanPreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorScanPreconditionError";
  }
}

export function dataWarehouseEnabled(value = process.env.ASTRO_DATA_WAREHOUSE_ENABLED): boolean {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new RangeError("ASTRO_DATA_WAREHOUSE_ENABLED must be true or false");
}

function s3Uri(connector: ConnectorRecord, key: string): string {
  return key ? `s3://${connector.config.bucket}/${key}` : `s3://${connector.config.bucket}`;
}

function cleanS3Value(value: string | undefined): string {
  return (value ?? "").trim().replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
}

export function connectorScanTarget(connector: ConnectorRecord): ConnectorScanTargetSnapshot {
  if (connector.kind !== "s3") throw new ConnectorScanCapabilityError(connector.kind);
  const bucket = cleanS3Value(connector.config.bucket).toLowerCase();
  const prefix = cleanS3Value(connector.config.prefix);
  if (!bucket || bucket.includes("/")) throw new RangeError("S3 connector bucket is invalid");
  if (prefix.split("/").some((segment) => segment === "." || segment === "..")) throw new RangeError("S3 connector prefix cannot contain dot segments");
  return { uri: connectorLocationKey("s3", { bucket, prefix }), bucket, prefix };
}

export function connectorScanPath(connector: ConnectorRecord, requested?: string): string {
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
