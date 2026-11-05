import { parse } from "csv-parse/sync";
import { SpanKind } from "@opentelemetry/api";
import {
  type CatalogQueryBackend,
  type CatalogQueryClient,
  type CatalogQueryContext,
} from "./catalog-mcp-client.js";
import { DESI_CATALOG, EUCLID_CATALOG, extractCatalogHits } from "./scientific-tools.js";
import { withSpan } from "./telemetry.js";

const EUCLID_TAP_DEFAULT = "https://eas.esac.esa.int/tap-server/tap";
const DESI_TAP_DEFAULT = "https://datalab.noirlab.edu/tap";
const MAX_QUERY_LIMIT = 1_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_RECORD_BYTES = 1024 * 1024;

interface CatalogBackendDefinition {
  provider: CatalogQueryBackend["provider"];
  release: string;
  table: string;
  raColumn: string;
  decColumn: string;
  columns: string[];
  filters: string[];
  staticColumns: Set<string>;
}

function backendDefinition(catalog: string): CatalogBackendDefinition {
  if (catalog === EUCLID_CATALOG) {
    const columns = ["object_id", "right_ascension", "declination", "segmentation_map_id", "extended_flag"];
    return {
      provider: "esa-tap",
      release: "euclid-q1-mer",
      table: "catalogue.mer_catalogue",
      raColumn: "right_ascension",
      decColumn: "declination",
      columns,
      filters: [],
      staticColumns: new Set(columns.map((column) => column.toLowerCase())),
    };
  }
  if (catalog === DESI_CATALOG) {
    const columns = ["ls_id", "ra", "dec", "release", "brickid", "brickname", "objid", "brick_primary", "type", "flux_r"];
    return {
      provider: "noirlab-datalab",
      release: "legacysurvey-dr10",
      table: "ls_dr10.tractor",
      raColumn: "ra",
      decColumn: "dec",
      columns,
      filters: ["brick_primary = 1"],
      staticColumns: new Set(columns.map((column) => column.toLowerCase())),
    };
  }
  throw new RangeError(`Unsupported official catalog: ${catalog}`);
}

function validateTapBaseUrl(value: string | undefined, fallback: string, label: string): string {
  const url = new URL(value?.trim() || fallback);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new RangeError(`${label} must be a credential-free HTTPS URL without query or fragment`);
  }
  return url.toString().replace(/\/+$/, "");
}

function validateIdentifier(value: string, label: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(value)) {
    throw new RangeError(`${label} must be a simple catalog column identifier`);
  }
  return value;
}

function selectedColumns(definition: CatalogBackendDefinition, fields: Record<string, string> | undefined): string[] {
  const columns = [...definition.columns];
  const selected = new Set(definition.staticColumns);
  const entries = Object.entries(fields ?? {});
  if (entries.length > 16) throw new RangeError("At most 16 additional catalog fields may be queried");
  for (const [alias, column] of entries) {
    validateIdentifier(alias, "Catalog field alias");
    const quoted = validateIdentifier(column, "Catalog field column");
    const normalized = column.toLowerCase();
    if (selected.has(normalized)) continue;
    columns.push(quoted);
    selected.add(normalized);
  }
  return columns;
}

function finiteCoordinate(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new RangeError(`${label} is outside its supported range`);
  return value;
}

export function buildOfficialCatalogAdql(context: CatalogQueryContext): string {
  const definition = backendDefinition(context.catalog);
  const ra = finiteCoordinate(context.raDeg, "RA", 0, 360);
  if (ra >= 360) throw new RangeError("RA must be less than 360 degrees");
  const dec = finiteCoordinate(context.decDeg, "Dec", -90, 90);
  const radiusArcsec = finiteCoordinate(context.radiusArcsec, "Query radius", 1, 3_600);
  if (!Number.isInteger(context.limit) || context.limit < 1 || context.limit > MAX_QUERY_LIMIT) {
    throw new RangeError(`Catalog limit must be between 1 and ${MAX_QUERY_LIMIT}`);
  }
  const top = context.limit + 1;
  const radiusDeg = radiusArcsec / 3_600;
  const minimumDec = Math.max(-90, dec - radiusDeg);
  const maximumDec = Math.min(90, dec + radiusDeg);
  const clauses = [
    `${definition.decColumn} >= ${minimumDec}`,
    `${definition.decColumn} <= ${maximumDec}`,
    ...definition.filters,
  ];
  const crossesPole = Math.abs(dec) + radiusDeg >= 90;
  const raHalfWidth = Math.min(180, radiusDeg / Math.max(0.01, Math.cos(dec * Math.PI / 180)));
  if (!crossesPole && raHalfWidth < 180) {
    const normalizeRa = (value: number): number => ((value % 360) + 360) % 360;
    const minimumRa = normalizeRa(ra - raHalfWidth);
    const maximumRa = normalizeRa(ra + raHalfWidth);
    clauses.push(minimumRa <= maximumRa
      ? `${definition.raColumn} >= ${minimumRa} AND ${definition.raColumn} <= ${maximumRa}`
      : `(${definition.raColumn} >= ${minimumRa} OR ${definition.raColumn} <= ${maximumRa})`);
  }
  const columns = selectedColumns(definition, context.fields);
  return [
    `SELECT TOP ${top} ${columns.join(", ")}`,
    `FROM ${definition.table}`,
    `WHERE ${clauses.map((clause) => `(${clause})`).join(" AND ")}`,
  ].join(" ");
}

async function readBoundedText(response: Response, maximumBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new RangeError("Catalog response exceeded the configured size limit");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), byteLength).toString("utf8");
}

function readCell(row: Record<string, unknown>, column: string): unknown {
  if (Object.hasOwn(row, column)) return row[column];
  const normalized = column.toLowerCase();
  const match = Object.keys(row).find((key) => key.toLowerCase() === normalized);
  return match === undefined ? undefined : row[match];
}

function euclidTileIndex(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") return undefined;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return undefined;
  return (BigInt(text) / 1_000_000n).toString();
}

function normalizeOfficialRows(
  rows: Array<Record<string, unknown>>,
  definition: CatalogBackendDefinition,
  fields: Record<string, string> | undefined,
): Array<Record<string, unknown>> {
  return rows.map((row) => {
    const normalized: Record<string, unknown> = { ...row };
    if (definition.provider === "esa-tap") {
      const tileIndex = euclidTileIndex(readCell(row, "segmentation_map_id"));
      if (tileIndex) normalized.TILE_INDEX = tileIndex;
      const objectId = readCell(row, "object_id");
      if (objectId !== undefined && objectId !== null) normalized.object_id = String(objectId);
    } else {
      const objectId = readCell(row, "ls_id");
      if (objectId !== undefined && objectId !== null) normalized.TARGETID = String(objectId);
      const flux = Number(readCell(row, "flux_r"));
      if (Number.isFinite(flux) && flux > 0) normalized.MAG_R = 22.5 - 2.5 * Math.log10(flux);
    }
    if (fields && Object.keys(fields).length) {
      const mapped: Record<string, unknown> = {};
      for (const [alias, column] of Object.entries(fields)) mapped[alias] = readCell(row, column) ?? null;
      normalized.asa_catalog_fields = mapped;
    }
    return normalized;
  });
}

function validateCsvContentType(contentType: string, csv: string): void {
  const normalized = contentType.toLowerCase();
  if (/application\/(?:json|xml)|text\/(?:html|xml)/.test(normalized) || csv.trimStart().startsWith("<")) {
    throw new Error("Catalog archive returned a non-CSV response");
  }
}

function validateCatalogHeaders(csv: string, provider: CatalogBackendDefinition["provider"]): void {
  let header: unknown;
  try {
    const records = parse(csv, { bom: true, to_line: 1, skip_empty_lines: true, trim: true }) as unknown[];
    header = records[0];
  } catch {
    throw new Error("Catalog archive returned malformed CSV");
  }
  const names = Array.isArray(header) ? new Set(header.map((name) => String(name).toLowerCase())) : new Set<string>();
  const required = provider === "esa-tap"
    ? ["object_id", "right_ascension", "declination", "segmentation_map_id"]
    : ["ls_id", "ra", "dec", "release", "brickid", "brickname", "objid", "brick_primary"];
  if (required.some((column) => !names.has(column))) throw new Error("Catalog archive CSV does not match the expected release schema");
}

export class OfficialArchiveCatalogQueryClient implements CatalogQueryClient {
  private readonly euclidTapUrl: string;
  private readonly desiTapUrl: string;

  constructor(
    readonly timeoutMs = 30_000,
    private readonly fetchImpl: typeof fetch = fetch,
    euclidTapUrl = process.env.ASTRO_EUCLID_TAP_URL,
    desiTapUrl = process.env.ASTRO_DESI_TAP_URL,
  ) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
      throw new RangeError("Official catalog query timeout must be between 1000 and 120000 milliseconds");
    }
    this.euclidTapUrl = validateTapBaseUrl(euclidTapUrl, EUCLID_TAP_DEFAULT, "ASTRO_EUCLID_TAP_URL");
    this.desiTapUrl = validateTapBaseUrl(desiTapUrl, DESI_TAP_DEFAULT, "ASTRO_DESI_TAP_URL");
  }

  async query(_request: Record<string, unknown>, context?: CatalogQueryContext): Promise<unknown> {
    if (!context) throw new Error("Official catalog query requires validated Workflow parameters");
    const definition = backendDefinition(context.catalog);
    const baseUrl = definition.provider === "esa-tap" ? this.euclidTapUrl : this.desiTapUrl;
    const query = buildOfficialCatalogAdql(context);
    const endpoint = `${baseUrl}/sync`;
    const params = new URLSearchParams({
      REQUEST: "doQuery",
      LANG: "ADQL",
      FORMAT: "csv",
      MAXREC: String(context.limit + 1),
      QUERY: query,
    });
    const providerLabel = definition.provider === "esa-tap" ? "ESA Euclid" : "NOIRLab Data Lab";
    const backend: CatalogQueryBackend = {
      provider: definition.provider,
      release: definition.release,
      table: definition.table,
    };

    return withSpan("catalog.archive.query", {
      "asa.component": "workflow",
      "asa.catalog.provider": definition.provider,
      "asa.catalog.release": definition.release,
      "asa.catalog.table": definition.table,
      "asa.catalog.limit": context.limit,
      "server.address": new URL(baseUrl).hostname,
    }, async (span) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(endpoint, {
          method: "POST",
          headers: {
            Accept: "text/csv",
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          },
          body: params,
          signal: controller.signal,
          redirect: "error",
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new Error(`${providerLabel} TAP returned HTTP ${response.status}`);
        }
        const csv = await readBoundedText(response, MAX_RESPONSE_BYTES);
        validateCsvContentType(response.headers.get("content-type") ?? "", csv);
        validateCatalogHeaders(csv, definition.provider);
        let rows: Array<Record<string, unknown>>;
        try {
          rows = parse(csv, {
            bom: true,
            columns: true,
            skip_empty_lines: true,
            trim: true,
            max_record_size: MAX_RECORD_BYTES,
          }) as Array<Record<string, unknown>>;
        } catch {
          throw new Error(`${providerLabel} TAP returned malformed CSV`);
        }
        const truncated = rows.length > context.limit;
        const hits = normalizeOfficialRows(rows.slice(0, context.limit), definition, context.fields);
        span.setAttributes({
          "asa.catalog.rows_returned": hits.length,
          "asa.catalog.truncated": truncated,
        });
        return { hits, backend, queryLimit: context.limit, truncated };
      } catch (error) {
        if (controller.signal.aborted) throw new Error(`${providerLabel} TAP query timed out after ${this.timeoutMs} ms`);
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    }, { kind: SpanKind.CLIENT });
  }
}

export class CatalogQueryFallbackClient implements CatalogQueryClient {
  constructor(
    private readonly primary: CatalogQueryClient,
    private readonly fallback: CatalogQueryClient,
  ) {}

  async query(request: Record<string, unknown>, context?: CatalogQueryContext): Promise<unknown> {
    try {
      const payload = await this.primary.query(request, context);
      if (!context) return payload;
      return {
        hits: extractCatalogHits(payload),
        backend: {
          provider: "catalog-mcp",
          release: context.catalog === EUCLID_CATALOG ? "euclid-q1-mer" : "desi-dr10",
          table: context.catalog,
        } satisfies CatalogQueryBackend,
        queryLimit: context.limit,
      };
    } catch (primaryError) {
      if (!context) throw primaryError;
      try {
        return await this.fallback.query(request, context);
      } catch (fallbackError) {
        throw new AggregateError([primaryError, fallbackError], "Catalog MCP and official archive query both failed");
      }
    }
  }
}
