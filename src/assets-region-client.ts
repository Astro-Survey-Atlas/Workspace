import type { PublicSourceIdentity } from "./public-source-identity.js";

export interface AssetsRegionLookupRequest {
  layerIds: string[];
  order: number;
  cells: number[];
  limit?: number;
}

export interface AssetsRegionFileMatch {
  layerId: string;
  order: number;
  ipix: number;
  precision: "exact" | "estimated" | "entrypoint-only" | "truncated";
  coverageMethod?: string;
  coverageRole?: string;
}

export interface AssetsRegionFileEvidence {
  fileId: string;
  fileName: string;
  sourceUri?: string;
  parentUri?: string;
  fileType?: string;
  sizeBytes?: number;
  lastModified?: string;
  downloadable: boolean;
  matchingCoverage: AssetsRegionFileMatch[];
}

export interface AssetsRegionLookupResponse {
  available: boolean;
  precision: "exact" | "estimated" | "entrypoint-only" | "truncated";
  truncated: boolean;
  requested: { layerIds: string[]; order: number; cells: number[] };
  expiresAt?: string;
  notes: string[];
  files: AssetsRegionFileEvidence[];
}

interface AssetsRegionClientOptions {
  catalogUrl: string;
  getApiKey: () => Promise<string | undefined>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const VALID_PRECISIONS = new Set(["exact", "estimated", "entrypoint-only", "truncated"]);

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function precision(value: unknown): AssetsRegionFileEvidence["matchingCoverage"][number]["precision"] {
  return typeof value === "string" && VALID_PRECISIONS.has(value)
    ? value as AssetsRegionFileEvidence["matchingCoverage"][number]["precision"]
    : "entrypoint-only";
}

function integer(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function endpointForCatalog(value: string): URL | undefined {
  try {
    const catalog = new URL(value);
    if (catalog.protocol !== "http:" && catalog.protocol !== "https:") return undefined;
    return new URL("/api/v1/coverage/reverse-lookup", catalog.origin);
  } catch {
    return undefined;
  }
}

function parseResponse(value: unknown): AssetsRegionLookupResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Assets region query returned an invalid response");
  const root = value as Record<string, unknown>;
  const requested = root.requested && typeof root.requested === "object" && !Array.isArray(root.requested)
    ? root.requested as Record<string, unknown>
    : undefined;
  const layerIds = Array.isArray(requested?.layerIds) ? requested.layerIds.filter((item): item is string => typeof item === "string") : [];
  const order = integer(requested?.order);
  const cells = Array.isArray(requested?.cells) ? requested.cells.filter((item): item is number => Number.isSafeInteger(item)) : [];
  if (!requested || !layerIds.length || order === undefined || !cells.length) throw new Error("Assets region query returned an invalid request echo");
  const plan = root.downloadPlan && typeof root.downloadPlan === "object" && !Array.isArray(root.downloadPlan)
    ? root.downloadPlan as Record<string, unknown>
    : {};
  const files = Array.isArray(plan.files) ? plan.files.flatMap((item): AssetsRegionFileEvidence[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const file = item as Record<string, unknown>;
    const fileId = text(file.fileId);
    const fileName = text(file.fileName);
    if (!fileId || !fileName) return [];
    const matchingCoverage = Array.isArray(file.matchingCoverage)
      ? file.matchingCoverage.flatMap((match): AssetsRegionFileMatch[] => {
        if (!match || typeof match !== "object" || Array.isArray(match)) return [];
        const entry = match as Record<string, unknown>;
        const layerId = text(entry.layerId);
        const matchOrder = integer(entry.order);
        const ipix = integer(entry.ipix);
        if (!layerId || matchOrder === undefined || ipix === undefined) return [];
        return [{ layerId, order: matchOrder, ipix, precision: precision(entry.precision), ...(text(entry.coverageMethod) ? { coverageMethod: text(entry.coverageMethod) } : {}), ...(text(entry.coverageRole) ? { coverageRole: text(entry.coverageRole) } : {}) }];
      })
      : [];
    return [{
      fileId,
      fileName,
      ...(text(file.sourceUri) ? { sourceUri: text(file.sourceUri) } : {}),
      ...(text(file.parentUri) ? { parentUri: text(file.parentUri) } : {}),
      ...(text(file.fileType) ? { fileType: text(file.fileType) } : {}),
      ...(integer(file.sizeBytes) !== undefined ? { sizeBytes: integer(file.sizeBytes) } : {}),
      ...(text(file.lastModified) ? { lastModified: text(file.lastModified) } : {}),
      downloadable: file.downloadable === true,
      matchingCoverage,
    }];
  }) : [];
  const notes = Array.isArray(root.notes) ? root.notes.filter((item): item is string => typeof item === "string").slice(0, 32) : [];
  return {
    available: root.available === true,
    precision: precision(root.precision),
    truncated: root.truncated === true,
    requested: { layerIds, order, cells },
    ...(text(root.expiresAt) ? { expiresAt: text(root.expiresAt) } : {}),
    notes,
    files,
  };
}

/** Server-side, bounded bridge to the Assets file/Tile reverse-lookup API. */
export class AssetsRegionClient {
  readonly #endpoint?: URL;
  readonly #getApiKey: () => Promise<string | undefined>;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: AssetsRegionClientOptions) {
    this.#endpoint = endpointForCatalog(options.catalogUrl);
    this.#getApiKey = options.getApiKey;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  async lookup(input: AssetsRegionLookupRequest): Promise<AssetsRegionLookupResponse | undefined> {
    const key = await this.#getApiKey();
    if (!key) return undefined;
    if (!this.#endpoint) throw new Error("Assets region query endpoint is not configured");
    const response = await this.#fetch(this.#endpoint, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "X-Assets-API-Key": key },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_RESPONSE_BYTES) throw new Error("Assets region query response is too large");
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error("Assets region query authorization failed; update the Workspace API Key");
      throw new Error(`Assets region query failed: HTTP ${response.status}`);
    }
    return parseResponse(JSON.parse(bytes.toString("utf8")) as unknown);
  }
}

export function assetsLayerIdForIdentity(identity: PublicSourceIdentity | undefined): string | undefined {
  const value = identity?.layerId ?? identity?.sourceId;
  return value && value.trim() ? value.trim() : undefined;
}
