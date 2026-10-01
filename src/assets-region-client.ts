import type { PublicSourceIdentity } from "./public-source-identity.js";

export interface AssetsRegionLookupRequest {
  layerIds: string[];
  order: number;
  cells: number[];
  limit?: number;
  cursor?: string;
  querySnapshotId?: string;
  pageSize?: number;
}

export interface AssetsRegionSpatialUnit {
  layerId: string; productId: string; surveyId: string; releaseId: string; product: string; modality?: string;
  unitKind: string; unitId: string; order: number; nside: number; matchingCells: number[];
  precision: "exact" | "estimated" | "entrypoint-only" | "truncated";
  accessUri?: string; accessUris?: Array<{ uri: string; fileName?: string }>;
  accessAvailability?: "public" | "source-policy" | "unverified";
  sourceSnapshotSha256?: string; note?: string; sRegion?: string; instrument?: string; filters?: string; sourceUrl?: string;
  scannedFiles?: Array<{ fileId: string; fileName?: string; sourceUri?: string; scanRunId?: string; sourceSnapshotSha256?: string }>;
}

export interface AssetsRegionEntrypoint {
  kind: string; purpose: string; layerId?: string; surveyId?: string; releaseId?: string; productId?: string; product?: string;
  precision: string; url?: string; sourceUri?: string; note?: string; [key: string]: unknown;
}

export interface AssetsRegionPage { pageSize: number; shown: number; omitted: number; hasMore: boolean; nextCursor?: string }

export interface AssetsRegionFileMatch {
  layerId?: string;
  evidenceLayerId?: string;
  observationLayerId?: string;
  scopeId?: string;
  partitionId?: string;
  order: number;
  ipix: number;
  precision: "exact" | "estimated" | "entrypoint-only" | "truncated";
  coverageMethod?: string;
  coverageRole?: string;
  sourceOrder?: number;
  scanRunId?: string;
  sourceSnapshotSha256?: string;
}

export interface AssetsRegionFileObservation {
  /** Logical public layer identity. */
  layerId?: string;
  /** Immutable candidate index layer used to retrieve this observation. */
  observationLayerId?: string;
  scanRunId?: string;
  sourceSnapshotSha256?: string;
  fileName?: string;
  sizeBytes?: number;
  lastModified?: string;
  sourceUri?: string;
  metadataState?: "complete" | "missing";
}

export interface AssetsRegionScanScope {
  /** Logical scan/evidence layer identity. */
  layerId: string;
  publishedLayerId?: string;
  scopeId: string;
  scopeSnapshotSha256: string;
  expectedPartitions: number;
  committedPartitions: number;
  /** Completeness of this frozen scope only, not the complete survey. */
  completeness: "complete" | "incomplete";
}

export interface AssetsRegionCoverageEvidence {
  layerId: string;
  productId: string;
  surveyId: string;
  releaseId: string;
  product: string;
  modality?: string;
  evidenceKind: "observation-footprint" | "published-moc" | "tile-footprint" | "source-unit-footprint" | "wcs-coverage";
  order: number;
  nside: number;
  nativeMaxOrder: number;
  availableOrders: number[];
  matchedCells: number[];
  precision: "exact" | "estimated";
  completeness?: "complete" | "incomplete" | "unknown";
  scienceFileScan?: "not-scanned" | "partial" | "complete";
  sourceIdentity?: string;
  instrument?: string;
  filters?: string;
  sourceSnapshotSha256?: string;
  sourceLabel?: string;
  sourceUrl?: string;
  geometrySourceUrl?: string;
  coverageUrl?: string;
  summary: string;
}

export interface AssetsRegionLookupSummary {
  available: boolean;
  precision: "exact" | "estimated" | "entrypoint-only" | "truncated";
  truncated: boolean;
  expiresAt?: string;
}

export interface AssetsRegionFileEvidence {
  fileId: string;
  metadataState?: "complete" | "missing";
  fileName?: string;
  unitKind?: string;
  unitId?: string;
  downloadProvider?: string;
  sourceUri?: string;
  downloadUrl?: string;
  parentUri?: string;
  fileType?: string;
  sizeBytes?: number;
  lastModified?: string;
  downloadable: boolean;
  matchingCoverage: AssetsRegionFileMatch[];
  matchingCoverageTruncated?: boolean;
  warnings?: string[];
  observations?: AssetsRegionFileObservation[];
}

export interface AssetsRegionLookupResponse {
  available: boolean;
  precision: "exact" | "estimated" | "entrypoint-only" | "truncated";
  truncated: boolean;
  requested: { layerIds: string[]; order: number; cells: number[] };
  expiresAt?: string;
  notes: string[];
  files: AssetsRegionFileEvidence[];
  coverageEvidence?: AssetsRegionCoverageEvidence[];
  scanScopes?: AssetsRegionScanScope[];
  spatialUnits?: AssetsRegionSpatialUnit[];
  entrypoints?: AssetsRegionEntrypoint[];
  page?: AssetsRegionPage;
  querySnapshot?: { id: string; expiresAt: string; queryExhausted: boolean; inventoryComplete: false };
  downloadPlan?: {
    schemaVersion: 1; spatialUnits: AssetsRegionSpatialUnit[]; files: AssetsRegionFileEvidence[]; entrypoints: AssetsRegionEntrypoint[];
    coverageEvidence: AssetsRegionCoverageEvidence[]; scanScopes: AssetsRegionScanScope[]; truncated: boolean; warnings: string[];
  };
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

function parseScanScopes(value: unknown): AssetsRegionScanScope[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): AssetsRegionScanScope[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const scope = item as Record<string, unknown>;
    const layerId = text(scope.layerId);
    const scopeId = text(scope.scopeId);
    const scopeSnapshotSha256 = text(scope.scopeSnapshotSha256);
    const expectedPartitions = integer(scope.expectedPartitions);
    const committedPartitions = integer(scope.committedPartitions);
    const completeness = scope.completeness;
    if (!layerId || !scopeId || !scopeSnapshotSha256 || !/^[a-f0-9]{64}$/.test(scopeSnapshotSha256)
      || expectedPartitions === undefined || expectedPartitions < 1 || committedPartitions === undefined
      || committedPartitions > expectedPartitions || (completeness !== "complete" && completeness !== "incomplete")) return [];
    const publishedLayerId = text(scope.publishedLayerId);
    return [{
      layerId,
      ...(publishedLayerId ? { publishedLayerId } : {}),
      scopeId,
      scopeSnapshotSha256,
      expectedPartitions,
      committedPartitions,
      completeness,
    }];
  });
}

function parseCoverageEvidence(value: unknown): AssetsRegionCoverageEvidence[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): AssetsRegionCoverageEvidence[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const evidence = item as Record<string, unknown>;
    const layerId = text(evidence.layerId);
    const productId = text(evidence.productId);
    const surveyId = text(evidence.surveyId);
    const releaseId = text(evidence.releaseId);
    const product = text(evidence.product);
    const evidenceKind = evidence.evidenceKind;
    const order = integer(evidence.order);
    const nside = integer(evidence.nside);
    const nativeMaxOrder = integer(evidence.nativeMaxOrder);
    const availableOrders = Array.isArray(evidence.availableOrders) ? evidence.availableOrders.map(integer).filter((value): value is number => value !== undefined) : [];
    const matchedCells = Array.isArray(evidence.matchedCells) ? evidence.matchedCells.map(integer).filter((value): value is number => value !== undefined) : [];
    const precision = evidence.precision;
    const summary = text(evidence.summary);
    if (!layerId || !productId || !surveyId || !releaseId || !product
      || !(evidenceKind === "observation-footprint" || evidenceKind === "published-moc" || evidenceKind === "tile-footprint" || evidenceKind === "source-unit-footprint" || evidenceKind === "wcs-coverage")
      || order === undefined || nside === undefined || nside < 1 || nativeMaxOrder === undefined
      || !availableOrders.length || !matchedCells.length
      || !(precision === "exact" || precision === "estimated") || !summary) return [];
    const completeness = evidence.completeness;
    const scienceFileScan = evidence.scienceFileScan;
    const sourceSnapshotSha256 = text(evidence.sourceSnapshotSha256);
    return [{
      layerId,
      productId,
      surveyId,
      releaseId,
      product,
      ...(text(evidence.modality) ? { modality: text(evidence.modality) } : {}),
      evidenceKind,
      order,
      nside,
      nativeMaxOrder,
      availableOrders,
      matchedCells,
      precision,
      ...(completeness === "complete" || completeness === "incomplete" || completeness === "unknown" ? { completeness } : {}),
      ...(scienceFileScan === "not-scanned" || scienceFileScan === "partial" || scienceFileScan === "complete" ? { scienceFileScan } : {}),
      ...(text(evidence.sourceIdentity) ? { sourceIdentity: text(evidence.sourceIdentity) } : {}),
      ...(text(evidence.instrument) ? { instrument: text(evidence.instrument) } : {}),
      ...(text(evidence.filters) ? { filters: text(evidence.filters) } : {}),
      ...(sourceSnapshotSha256 && /^[a-f0-9]{64}$/.test(sourceSnapshotSha256) ? { sourceSnapshotSha256 } : {}),
      ...(text(evidence.sourceLabel) ? { sourceLabel: text(evidence.sourceLabel) } : {}),
      ...(text(evidence.sourceUrl) ? { sourceUrl: text(evidence.sourceUrl) } : {}),
      ...(text(evidence.geometrySourceUrl) ? { geometrySourceUrl: text(evidence.geometrySourceUrl) } : {}),
      ...(text(evidence.coverageUrl) ? { coverageUrl: text(evidence.coverageUrl) } : {}),
      summary,
    }];
  });
}

interface ResponseCoverageEdge {
  sourceFileId?: string;
  layerId?: string;
  observationLayerId?: string;
  order?: number;
  ipix?: number;
  scanRunId?: string;
}

function parseCoverageEdges(value: unknown): ResponseCoverageEdge[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): ResponseCoverageEdge[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const edge = item as Record<string, unknown>;
    return [{
      sourceFileId: text(edge.sourceFileId) ?? text(edge.source_file_id),
      layerId: text(edge.layerId) ?? text(edge.layer_id),
      observationLayerId: text(edge.observationLayerId) ?? text(edge.observation_layer_id),
      order: integer(edge.order),
      ipix: integer(edge.ipix),
      scanRunId: text(edge.scanRunId) ?? text(edge.scan_run_id),
    }];
  });
}

function observationLayerForFile(
  edges: ResponseCoverageEdge[],
  fileId: string,
  layerId?: string,
  scanRunId?: string,
  order?: number,
  ipix?: number,
): string | undefined {
  const matches = new Set(edges.flatMap((edge) => {
    if (edge.sourceFileId !== fileId || !edge.observationLayerId) return [];
    if (layerId && edge.layerId !== layerId) return [];
    if (scanRunId && edge.scanRunId !== scanRunId) return [];
    if (order !== undefined && edge.order !== order) return [];
    if (ipix !== undefined && edge.ipix !== ipix) return [];
    return [edge.observationLayerId];
  }));
  return matches.size === 1 ? [...matches][0] : undefined;
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
  const edges = parseCoverageEdges(root.edges);
  const files = Array.isArray(plan.files) ? plan.files.flatMap((item): AssetsRegionFileEvidence[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const file = item as Record<string, unknown>;
    const fileId = text(file.fileId);
    if (!fileId) return [];
    const fileName = text(file.fileName);
    const matchingCoverage = Array.isArray(file.matchingCoverage)
      ? file.matchingCoverage.flatMap((match): AssetsRegionFileMatch[] => {
        if (!match || typeof match !== "object" || Array.isArray(match)) return [];
        const entry = match as Record<string, unknown>;
        const layerId = text(entry.layerId);
        const matchOrder = integer(entry.order);
        const ipix = integer(entry.ipix);
        if (matchOrder === undefined || ipix === undefined) return [];
        const scanRunId = text(entry.scanRunId);
        const observationLayerId = text(entry.observationLayerId)
          ?? observationLayerForFile(edges, fileId, layerId, scanRunId, matchOrder, ipix);
        return [{
          ...(layerId ? { layerId } : {}),
          ...(text(entry.evidenceLayerId) ? { evidenceLayerId: text(entry.evidenceLayerId) } : {}),
          ...(observationLayerId ? { observationLayerId } : {}),
          ...(text(entry.scopeId) ? { scopeId: text(entry.scopeId) } : {}),
          ...(text(entry.partitionId) ? { partitionId: text(entry.partitionId) } : {}),
          order: matchOrder,
          ipix,
          precision: precision(entry.precision),
          ...(text(entry.coverageMethod) ? { coverageMethod: text(entry.coverageMethod) } : {}),
          ...(text(entry.coverageRole) ? { coverageRole: text(entry.coverageRole) } : {}),
          ...(integer(entry.sourceOrder) !== undefined ? { sourceOrder: integer(entry.sourceOrder) } : {}),
          ...(scanRunId ? { scanRunId } : {}),
          ...(text(entry.sourceSnapshotSha256) ? { sourceSnapshotSha256: text(entry.sourceSnapshotSha256) } : {}),
        }];
      })
      : [];
    const observations = Array.isArray(file.observations)
      ? file.observations.flatMap((observation): AssetsRegionFileObservation[] => {
        if (!observation || typeof observation !== "object" || Array.isArray(observation)) return [];
        const entry = observation as Record<string, unknown>;
        const layerId = text(entry.layerId);
        const scanRunId = text(entry.scanRunId);
        const observationLayerId = text(entry.observationLayerId)
          ?? observationLayerForFile(edges, fileId, layerId, scanRunId);
        return [{
          ...(layerId ? { layerId } : {}),
          ...(observationLayerId ? { observationLayerId } : {}),
          ...(scanRunId ? { scanRunId } : {}),
          ...(text(entry.sourceSnapshotSha256) ? { sourceSnapshotSha256: text(entry.sourceSnapshotSha256) } : {}),
          ...(text(entry.fileName) ? { fileName: text(entry.fileName) } : {}),
          ...(integer(entry.sizeBytes) !== undefined ? { sizeBytes: integer(entry.sizeBytes) } : {}),
          ...(text(entry.lastModified) ? { lastModified: text(entry.lastModified) } : {}),
          ...(text(entry.sourceUri) ? { sourceUri: text(entry.sourceUri) } : {}),
          ...(entry.metadataState === "complete" || entry.metadataState === "missing" ? { metadataState: entry.metadataState } : {}),
        }];
      })
      : [];
    const metadataState = file.metadataState === "complete" || file.metadataState === "missing" ? file.metadataState : undefined;
    return [{
      fileId,
      ...(metadataState ? { metadataState } : {}),
      ...(fileName ? { fileName } : {}),
      ...(text(file.unitKind) ? { unitKind: text(file.unitKind) } : {}),
      ...(text(file.unitId) ? { unitId: text(file.unitId) } : {}),
      ...(text(file.downloadProvider) ? { downloadProvider: text(file.downloadProvider) } : {}),
      ...(text(file.sourceUri) ? { sourceUri: text(file.sourceUri) } : {}),
      ...(text(file.downloadUrl) ? { downloadUrl: text(file.downloadUrl) } : {}),
      ...(text(file.parentUri) ? { parentUri: text(file.parentUri) } : {}),
      ...(text(file.fileType) ? { fileType: text(file.fileType) } : {}),
      ...(integer(file.sizeBytes) !== undefined ? { sizeBytes: integer(file.sizeBytes) } : {}),
      ...(text(file.lastModified) ? { lastModified: text(file.lastModified) } : {}),
      downloadable: file.downloadable === true,
      matchingCoverage,
      ...(typeof file.matchingCoverageTruncated === "boolean" ? { matchingCoverageTruncated: file.matchingCoverageTruncated } : {}),
      ...(Array.isArray(file.warnings) ? { warnings: file.warnings.filter((item): item is string => typeof item === "string") } : {}),
      ...(Array.isArray(file.observations) ? { observations } : {}),
    }];
  }) : [];
  const notes = Array.isArray(root.notes) ? root.notes.filter((item): item is string => typeof item === "string").slice(0, 32) : [];
  const planScanScopes = parseScanScopes(plan.scanScopes);
  const scanScopes = planScanScopes.length ? planScanScopes : parseScanScopes(root.scanScopes);
  const coverageEvidence = parseCoverageEvidence(plan.coverageEvidence);
  const spatialUnits = Array.isArray(plan.spatialUnits) ? plan.spatialUnits.flatMap((item): AssetsRegionSpatialUnit[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const unit = item as Record<string, unknown>;
    if (!["layerId", "productId", "surveyId", "releaseId", "product", "unitKind", "unitId"].every((key) => text(unit[key]))
      || !layerIds.includes(String(unit.layerId)) || integer(unit.order) === undefined || unit.nside !== 2 ** Number(unit.order)
      || !Array.isArray(unit.matchingCells) || unit.matchingCells.some((cell) => !Number.isSafeInteger(cell) || Number(cell) < 0)) return [];
    return [{ ...unit, precision: precision(unit.precision) } as unknown as AssetsRegionSpatialUnit];
  }) : [];
  const entrypoints = Array.isArray(plan.entrypoints) ? plan.entrypoints.flatMap((item): AssetsRegionEntrypoint[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const entry = item as Record<string, unknown>;
    return text(entry.kind) && text(entry.purpose) ? [entry as unknown as AssetsRegionEntrypoint] : [];
  }) : [];
  const page = root.page && typeof root.page === "object" ? root.page as AssetsRegionPage : undefined;
  const snapshot = root.querySnapshot && typeof root.querySnapshot === "object" ? root.querySnapshot as NonNullable<AssetsRegionLookupResponse["querySnapshot"]> : undefined;
  const warnings = Array.isArray(plan.warnings) ? plan.warnings.filter((item): item is string => typeof item === "string") : [];
  return {
    available: root.available === true,
    precision: precision(root.precision),
    truncated: root.truncated === true,
    requested: { layerIds, order, cells },
    ...(text(root.expiresAt) ? { expiresAt: text(root.expiresAt) } : {}),
    notes: [...new Set([...notes, ...warnings])],
    files,
    ...(coverageEvidence.length ? { coverageEvidence } : {}),
    ...(scanScopes.length ? { scanScopes } : {}),
    spatialUnits, entrypoints,
    ...(page ? { page } : {}),
    ...(snapshot ? { querySnapshot: snapshot } : {}),
    downloadPlan: { schemaVersion: 1, spatialUnits, files, entrypoints, coverageEvidence, scanScopes, truncated: plan.truncated === true, warnings },
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
    this.#timeoutMs = options.timeoutMs ?? 60_000;
  }

  async lookup(input: AssetsRegionLookupRequest): Promise<AssetsRegionLookupResponse | undefined> {
    const key = await this.#getApiKey();
    if (!key) return undefined;
    if (!this.#endpoint) throw new Error("Assets region query endpoint is not configured");
    const response = await this.#fetch(this.#endpoint, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "X-Assets-API-Key": key },
      // Deliberately construct the public request: no private IDs, paths or scan metadata cross this boundary.
      body: JSON.stringify({ layerIds: input.layerIds, order: input.order, cells: input.cells,
        ...(input.limit === undefined ? {} : { limit: input.limit }), pageSize: input.pageSize ?? 100,
        ...(input.cursor ? { cursor: input.cursor } : {}), ...(input.querySnapshotId ? { querySnapshotId: input.querySnapshotId } : {}) }),
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
