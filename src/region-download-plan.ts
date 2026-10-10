import { createHash } from "node:crypto";
import { abortable } from "./abortable.js";

import {
  AssetsRegionRateLimitError,
  type AssetsRegionClient,
  type AssetsRegionLookupResponse,
  type AssetsRegionSpatialUnit,
} from "./assets-region-client.js";
import { formatPublicSourceId } from "./public-source-identity.js";
import {
  computeInventoryDigest,
  resolveSourceInventory,
  type DesiTileSourceUnit,
  type DirectFileSourceUnit,
  type ResolveSourceInventoryOptions,
  type SourceFileInventory,
  type SourceUnit,
} from "./source-crawler.js";

export interface NativeDownloadUnitIdentity {
  layerId: string;
  unitKind: string;
  unitId: string;
}

export interface RegionDownloadSelection {
  layerIds: string[];
  order: number;
  cells: number[];
  querySnapshotId?: string;
  nativeUnitIndexRevision?: string;
  units?: NativeDownloadUnitIdentity[];
}

export interface RegionDownloadPreview {
  selection: RegionDownloadSelection;
  inventory: SourceFileInventory;
  unavailable: Array<{ layerId: string; unitId?: string; reason: string }>;
  notices?: RegionDownloadNotice[];
  notes: string[];
  limits: { maxFiles: number };
  querySnapshotId: string;
  nativeUnitIndexRevision?: string;
  expiresAt: string;
  selectionTruncated: boolean;
  planSha256: string;
}

export interface RegionDownloadNotice {
  code: "inventory-incomplete" | "coverage-estimated" | "file-metadata-unverified" | "results-truncated";
  layerId?: string;
  unitId?: string;
  fileName?: string;
}

export interface RegionDownloadConfirmation {
  selection: RegionDownloadSelection;
  previewSha256: string;
  selectedFileUrls: string[];
}

export type RegionDownloadPreviewEvent =
  | { event: "progress"; value: { stage: "lookup" | "metadata"; completed: number; total?: number; files: number; unavailable: number } }
  | { event: "batch"; value: { files: SourceFileInventory["files"]; unavailable: RegionDownloadPreview["unavailable"] } };

export interface RegionDownloadPreviewOptions {
  signal?: AbortSignal;
  onUpdate?: (event: RegionDownloadPreviewEvent) => void;
}

export interface RegionDownloadPlanServiceOptions {
  client: Pick<AssetsRegionClient, "lookup">;
  sourceResolveOptions?: ResolveSourceInventoryOptions;
}

export class RegionDownloadPlanError extends Error {
  constructor(message: string, readonly statusCode: number, readonly retryAfterSeconds?: number) {
    super(message);
    this.name = "RegionDownloadPlanError";
  }
}

const MAX_NATIVE_UNITS = 128;
const MAX_REGION_CELLS = 4096;
const MAX_LOOKUP_UNITS = 4096;
const MAX_PREVIEW_FILES = 4096;
const MAX_DOWNLOAD_FILES = 128;
const PAGE_SIZE = 100;
const DESI_TILE_URL_PATTERN = /^https:\/\/data\.desi\.lbl\.gov\/public\/(dr1|edr)\/spectro\/redux\/(iron|fuji)\/tiles\/cumulative\/(\d{1,6})\/(\d{8})\/$/;
const SCIENCE_FILE_NAME = /\.(?:fits?(?:\.(?:gz|fz))?|fz|csv|ecsv|parquet|hdf5?|nc|zip|tar|tgz|tar\.gz)$/i;
const HST_OBSERVATION_NAME = /(?:^|[-_:])obs(?:ervation)?[-_:]?(\d{1,12})$/i;

interface SnapshotState {
  id: string;
  expiresAt: string;
  revision?: string;
}

interface SourceBinding {
  sourceUnit: SourceUnit;
  native: NativeDownloadUnitIdentity;
}

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

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function identityKey(identity: NativeDownloadUnitIdentity): string {
  return JSON.stringify([identity.layerId, identity.unitKind, identity.unitId]);
}

function validText(value: unknown, maxLength = 256): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= maxLength
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function normalizeIdentity(value: unknown): NativeDownloadUnitIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RegionDownloadPlanError("Each native unit selector must be an object", 400);
  const identity = value as Record<string, unknown>;
  if (!validText(identity.layerId) || !validText(identity.unitKind, 120) || !validText(identity.unitId, 240)) {
    throw new RegionDownloadPlanError("Native unit selectors require a layer, kind, and id", 400);
  }
  return { layerId: identity.layerId.trim(), unitKind: identity.unitKind.trim(), unitId: identity.unitId.trim() };
}

function normalizeSelection(value: RegionDownloadSelection): RegionDownloadSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RegionDownloadPlanError("A region selection is required", 400);
  if (!Array.isArray(value.layerIds) || value.layerIds.length === 0 || value.layerIds.length > 128) {
    throw new RegionDownloadPlanError("Select between 1 and 128 public layer ids", 400);
  }
  const layerIds = value.layerIds.map((layerId) => {
    if (!validText(layerId) || /^(?:workspace|user|csst|private):/i.test(layerId) || /(^|[:/_-])csst([:/_-]|$)/i.test(layerId) || layerId.startsWith("geometry:public:")) {
      throw new RegionDownloadPlanError("Assets selectors must contain public layer ids only", 400);
    }
    return layerId.trim();
  });
  if (new Set(layerIds).size !== layerIds.length) throw new RegionDownloadPlanError("Layer ids must be unique", 400);
  if (!Number.isInteger(value.order) || value.order < 0 || value.order > 8) {
    throw new RegionDownloadPlanError("HEALPix order must be between 0 and 8", 400);
  }
  if (!Array.isArray(value.cells) || value.cells.length === 0 || value.cells.length > MAX_REGION_CELLS) {
    throw new RegionDownloadPlanError(`Select between 1 and ${MAX_REGION_CELLS} HEALPix cells`, 400);
  }
  const maxCell = 12 * 4 ** value.order;
  const cells = value.cells.map((cell) => {
    if (!Number.isSafeInteger(cell) || cell < 0 || cell >= maxCell) throw new RegionDownloadPlanError("A HEALPix cell is outside the selected order", 400);
    return cell;
  });
  if (new Set(cells).size !== cells.length) throw new RegionDownloadPlanError("HEALPix cells must be unique", 400);
  const areaSquareDegrees = cells.length * 41252.96124941927 / maxCell;
  if (areaSquareDegrees > 100 + 1e-9) throw new RegionDownloadPlanError("The selected region exceeds 100 square degrees", 400);

  let units: NativeDownloadUnitIdentity[] | undefined;
  if (value.units !== undefined) {
    if (!Array.isArray(value.units) || value.units.length === 0 || value.units.length > MAX_NATIVE_UNITS) {
      throw new RegionDownloadPlanError(`Explicit selection must contain between 1 and ${MAX_NATIVE_UNITS} native units`, 400);
    }
    units = value.units.map(normalizeIdentity);
    if (units.some((unit) => !layerIds.includes(unit.layerId))) throw new RegionDownloadPlanError("Every native unit must belong to a selected layer", 400);
    if (new Set(units.map(identityKey)).size !== units.length) throw new RegionDownloadPlanError("Native unit selectors must be unique", 400);
    units.sort((left, right) => identityKey(left).localeCompare(identityKey(right)));
  }

  let querySnapshotId: string | undefined;
  if (value.querySnapshotId !== undefined) {
    if (!validText(value.querySnapshotId, 256)) throw new RegionDownloadPlanError("Snapshot id is invalid", 400);
    querySnapshotId = value.querySnapshotId.trim();
  }
  let nativeUnitIndexRevision: string | undefined;
  if (value.nativeUnitIndexRevision !== undefined) {
    if (!validText(value.nativeUnitIndexRevision, 512)) throw new RegionDownloadPlanError("Native index revision is invalid", 400);
    nativeUnitIndexRevision = value.nativeUnitIndexRevision.trim();
  }
  return {
    layerIds: [...layerIds].sort(),
    order: value.order,
    cells: [...cells].sort((left, right) => left - right),
    ...(querySnapshotId ? { querySnapshotId } : {}),
    ...(nativeUnitIndexRevision ? { nativeUnitIndexRevision } : {}),
    ...(units ? { units } : {}),
  };
}

function snapshotFrom(response: AssetsRegionLookupResponse): SnapshotState {
  const id = response.querySnapshot?.id;
  const expiresAt = response.querySnapshot?.expiresAt ?? response.expiresAt;
  if (!validText(id, 256) || !validText(expiresAt, 128) || !Number.isFinite(Date.parse(expiresAt))) {
    throw new RegionDownloadPlanError("Assets did not return a valid frozen query snapshot", 409);
  }
  if (Date.parse(expiresAt) <= Date.now()) throw new RegionDownloadPlanError("Assets query snapshot has expired", 409);
  return {
    id,
    expiresAt,
    ...(validText(response.nativeUnitIndexRevision, 512) ? { revision: response.nativeUnitIndexRevision } : {}),
  };
}

function assertRequestEcho(response: AssetsRegionLookupResponse, selection: RegionDownloadSelection): void {
  // A frozen snapshot may echo the original selection order. Members define
  // the region; array ordering does not change its identity.
  const layerIds = [...response.requested.layerIds].sort();
  const cells = [...response.requested.cells].sort((left, right) => left - right);
  if (response.requested.order !== selection.order
    || layerIds.length !== selection.layerIds.length
    || layerIds.some((layerId, index) => layerId !== selection.layerIds[index])
    || cells.length !== selection.cells.length
    || cells.some((cell, index) => cell !== selection.cells[index])) {
    throw new RegionDownloadPlanError("Assets returned a different region or layer selection", 409);
  }
}

function nativeUnitIdentity(unit: AssetsRegionSpatialUnit): NativeDownloadUnitIdentity {
  return { layerId: unit.layerId, unitKind: unit.unitKind, unitId: unit.unitId };
}

function validateNativeUnit(unit: AssetsRegionSpatialUnit, selection: RegionDownloadSelection): NativeDownloadUnitIdentity {
  const identity = nativeUnitIdentity(unit);
  if (!selection.layerIds.includes(identity.layerId) || unit.order !== selection.order || unit.nside !== 2 ** selection.order) {
    throw new RegionDownloadPlanError("Assets returned a native unit with a different layer or HEALPix order", 409);
  }
  if (!Array.isArray(unit.matchingCells) || unit.matchingCells.length === 0
    || unit.matchingCells.some((cell) => !selection.cells.includes(cell))) {
    throw new RegionDownloadPlanError("Assets returned a native unit outside the selected cells", 409);
  }
  if (!validText(identity.unitKind, 120) || !validText(identity.unitId, 240)) {
    throw new RegionDownloadPlanError("Assets returned an invalid native unit identity", 409);
  }
  return identity;
}

function sourceIdFor(unit: AssetsRegionSpatialUnit): string {
  try {
    return formatPublicSourceId({ surveyId: unit.surveyId, releaseId: unit.releaseId, product: unit.product, layerId: unit.layerId });
  } catch {
    throw new RegionDownloadPlanError("Assets returned a public unit without a concrete source identity", 409);
  }
}

function filenameFromUri(uri: string, supplied?: string): string | undefined {
  if (supplied && validText(supplied, 180) && !/[\\/\u0000-\u001f\u007f]/.test(supplied)) return supplied.trim();
  try {
    const url = new URL(uri);
    for (const key of ["filename", "fileName", "file_name", "file"]) {
      const candidate = url.searchParams.get(key);
      if (!candidate) continue;
      const basename = candidate.split(/[\\/]/).pop();
      if (basename && validText(basename, 180) && !/[\u0000-\u001f\u007f]/.test(basename)) return basename;
    }
    const basename = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
    return basename && validText(basename, 180) ? basename : undefined;
  } catch {
    return undefined;
  }
}

function accessUris(unit: AssetsRegionSpatialUnit): Array<{ uri: string; fileName?: string }> {
  const values = [...(unit.accessUris ?? [])];
  if (unit.accessUri) values.push({ uri: unit.accessUri });
  const unique = new Map<string, { uri: string; fileName?: string }>();
  for (const item of values) {
    if (!item || !validText(item.uri, 4096)) continue;
    const uri = item.uri.trim();
    const fileName = typeof item.fileName === "string" ? item.fileName.trim() : undefined;
    const existing = unique.get(uri);
    if (!existing || (fileName && (!existing.fileName || fileName.localeCompare(existing.fileName) < 0))) {
      unique.set(uri, { uri, ...(fileName ? { fileName } : {}) });
    }
  }
  return [...unique.values()].sort((left, right) => left.uri.localeCompare(right.uri) || (left.fileName ?? "").localeCompare(right.fileName ?? ""));
}

function sourceUnitId(native: NativeDownloadUnitIdentity, suffix: string): string {
  const token = sha256(identityKey(native)).slice(0, 20);
  return `assets-unit:${token}:${suffix}`;
}

function mastObservationId(unit: AssetsRegionSpatialUnit): string | undefined {
  if (unit.unitKind.toLowerCase() !== "observation") return undefined;
  if (/^\d{1,12}$/.test(unit.unitId)) return unit.unitId;
  const match = unit.unitId.match(HST_OBSERVATION_NAME);
  if (match) return match[1];
  const label = (unit as AssetsRegionSpatialUnit & { sourceIdentity?: string }).sourceIdentity;
  const named = typeof label === "string" ? label.match(/^MAST observation (\d{1,12})$/i) : undefined;
  return named?.[1];
}

function sourceBindings(unit: AssetsRegionSpatialUnit): { bindings: SourceBinding[]; reason?: string } {
  const native = nativeUnitIdentity(unit);
  let sourceId: string;
  try {
    sourceId = sourceIdFor(unit);
  } catch (error) {
    return { bindings: [], reason: error instanceof Error ? error.message : String(error) };
  }
  if (unit.surveyId === "hst") {
    const observationId = mastObservationId(unit);
    if (!observationId) return { bindings: [], reason: "HST unit is not a supported MAST observation identity" };
    const unitId = sourceUnitId(native, `mast:${observationId}`);
    return { bindings: [{ native, sourceUnit: { sourceId, unitId, resolver: "mast-observation@1", observationId } }] };
  }

  const uris = accessUris(unit);
  if (unit.surveyId === "desi") {
    const candidate = uris.find(({ uri }) => DESI_TILE_URL_PATTERN.test(uri));
    const match = candidate?.uri.match(DESI_TILE_URL_PATTERN);
    if (!candidate || !match) return { bindings: [], reason: "DESI unit has no exact official tiles/cumulative/TILE/LASTNIGHT directory" };
    const [, release, redux, tileText, lastNight] = match;
    if (!release || !redux || !tileText || !lastNight) return { bindings: [], reason: "DESI tile directory identity is incomplete" };
    const releaseIdentity = unit.releaseId.toLowerCase().match(/(?:^|[-_])(dr1|edr)(?:$|[-_])/i)?.[1]?.toLowerCase();
    if (releaseIdentity && releaseIdentity !== release) return { bindings: [], reason: "DESI release identity does not match its returned tile directory" };
    const sourceUnit: DesiTileSourceUnit = {
      sourceId,
      unitId: sourceUnitId(native, `desi:${release}:${redux}:${tileText}:${lastNight}`),
      resolver: "desi-tile@1",
      directoryUrl: candidate.uri,
      release,
      redux,
      tileId: Number(tileText),
      lastNight,
    };
    return { bindings: [{ native, sourceUnit }] };
  }

  if (unit.surveyId !== "euclid" && unit.surveyId !== "legacy-surveys") {
    return { bindings: [], reason: `No executable public source adapter is registered for ${unit.surveyId}` };
  }
  const supported = uris.flatMap(({ uri, fileName }): SourceBinding[] => {
    let parsed: URL;
    try { parsed = new URL(uri); } catch { return []; }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return [];
    const filename = filenameFromUri(uri, fileName);
    if (!filename || !SCIENCE_FILE_NAME.test(filename)) return [];
    const unitId = sourceUnitId(native, `file:${sha256(`${uri}\n${filename}`).slice(0, 20)}`);
    const sourceUnit: DirectFileSourceUnit = { sourceId, unitId, resolver: "direct-file@1", url: uri, filename };
    return [{ native, sourceUnit }];
  });
  return supported.length
    ? { bindings: supported }
    : { bindings: [], reason: "Assets returned no supported direct science file URI for this unit" };
}

function inventoryPlanSha(preview: Omit<RegionDownloadPreview, "planSha256">): string {
  return sha256(canonicalJson({
    selection: preview.selection,
    querySnapshotId: preview.querySnapshotId,
    nativeUnitIndexRevision: preview.nativeUnitIndexRevision,
    expiresAt: preview.expiresAt,
    inventory: preview.inventory,
    limits: preview.limits,
  }));
}

function assertSnapshotStable(current: SnapshotState, expected: SnapshotState): void {
  if (current.id !== expected.id || current.expiresAt !== expected.expiresAt || current.revision !== expected.revision) {
    throw new RegionDownloadPlanError("Assets changed the snapshot, revision, or expiry during pagination", 409);
  }
  if (Date.parse(current.expiresAt) <= Date.now()) throw new RegionDownloadPlanError("Assets query snapshot has expired", 409);
}

function mapAssetsError(error: unknown): never {
  if (error instanceof RegionDownloadPlanError) throw error;
  if (error instanceof AssetsRegionRateLimitError) {
    throw new RegionDownloadPlanError(error.message, 429, error.retryAfterSeconds);
  }
  if (error instanceof Error && /authorization failed/i.test(error.message)) {
    throw new RegionDownloadPlanError("Assets region query authorization failed; configure the Workspace Assets API Key", 401);
  }
  if (error instanceof Error) {
    const status = error.message.match(/HTTP (401|403|409|429)\b/i)?.[1];
    if (status === "401" || status === "403") throw new RegionDownloadPlanError("Assets region query authorization failed; configure the Workspace Assets API Key", 401);
    if (status === "409") throw new RegionDownloadPlanError("Assets query snapshot is invalid or expired", 409);
    if (status === "429") throw new RegionDownloadPlanError("Assets region query reached its API Key rate limit", 429, 60);
  }
  throw error;
}

function deduplicatedMetadataFetch(delegate: typeof fetch, maximumBytes: number): typeof fetch {
  // Independent, bounded bodies avoid Response.clone() tees. Cancelling one
  // tee can otherwise wait forever for the unread cached branch.
  const responses = new Map<string, Promise<{ status: number; statusText: string; headers: Headers; url: string; body: Uint8Array | null }>>();
  return (async (input, init) => {
    init?.signal?.throwIfAborted();
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body === undefined ? "" : String(init.body);
    const key = `${method}\n${url}\n${body}`;
    let response = responses.get(key);
    if (!response) {
      response = abortable(Promise.resolve(delegate(input, init)), init?.signal).then(async (result) => {
        const metadata = { status: result.status, statusText: result.statusText, headers: result.headers, url: result.url, body: null as Uint8Array | null };
        if (!result.body) return metadata;
        if ([301, 302, 303, 307, 308].includes(result.status)) {
          await abortable(result.body.cancel(), init?.signal);
          return metadata;
        }
        const reader = result.body.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          while (bytes <= maximumBytes) {
            const next = await abortable(reader.read(), init?.signal);
            if (next.done) break;
            const chunk = next.value.subarray(0, maximumBytes + 1 - bytes);
            chunks.push(chunk);
            bytes += chunk.byteLength;
          }
        } finally {
          void reader.cancel().catch(() => undefined);
        }
        const body = new Uint8Array(bytes);
        let offset = 0;
        for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
        return { ...metadata, body };
      });
      responses.set(key, response);
    }
    const value = await abortable(response, init?.signal);
    const buffered = new Response(value.body?.slice() ?? null, value);
    // Directory adapters resolve relative links against the actual source URL.
    Object.defineProperty(buffered, "url", { value: value.url });
    return buffered;
  }) as typeof fetch;
}

export class RegionDownloadPlanService {
  readonly #client: RegionDownloadPlanServiceOptions["client"];
  readonly #sourceResolveOptions: ResolveSourceInventoryOptions;

  constructor(options: RegionDownloadPlanServiceOptions) {
    if (!options?.client || typeof options.client.lookup !== "function") throw new TypeError("Assets region client is required");
    this.#client = options.client;
    this.#sourceResolveOptions = options.sourceResolveOptions ?? {};
  }

  async preview(input: RegionDownloadSelection, options: RegionDownloadPreviewOptions = {}): Promise<RegionDownloadPreview> {
    options.signal?.throwIfAborted();
    const selection = normalizeSelection(input);
    options.onUpdate?.({ event: "progress", value: { stage: "lookup", completed: 0, files: 0, unavailable: 0 } });
    let expectedSnapshot: SnapshotState | undefined;
    const snapshotId = selection.querySnapshotId;
    const requestedUnits = selection.units;
    const found = new Map<string, AssetsRegionSpatialUnit>();
    const responses: AssetsRegionLookupResponse[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let firstPageHasMore = false;
    let scannedUnits = 0;

    const desired = requestedUnits ? new Set(requestedUnits.map(identityKey)) : undefined;
    while (true) {
      options.signal?.throwIfAborted();
      let response: AssetsRegionLookupResponse | undefined;
      const activeSnapshotId = expectedSnapshot?.id ?? snapshotId;
      try {
        response = await abortable(this.#client.lookup({
          layerIds: selection.layerIds,
          order: selection.order,
          cells: selection.cells,
          pageSize: PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
          ...(activeSnapshotId ? { querySnapshotId: activeSnapshotId } : {}),
        }, undefined, { signal: options.signal }), options.signal);
      } catch (error) {
        mapAssetsError(error);
      }
      if (!response) throw new RegionDownloadPlanError("Assets public lookup is unavailable without a Workspace API Key", 401);
      assertRequestEcho(response, selection);
      const pageSnapshot = snapshotFrom(response);
      if (snapshotId && pageSnapshot.id !== snapshotId) throw new RegionDownloadPlanError("Assets returned a different query snapshot", 409);
      if (selection.nativeUnitIndexRevision && pageSnapshot.revision !== selection.nativeUnitIndexRevision) {
        throw new RegionDownloadPlanError("Assets returned a different native unit index revision", 409);
      }
      if (!expectedSnapshot) expectedSnapshot = pageSnapshot;
      else assertSnapshotStable(pageSnapshot, expectedSnapshot);
      responses.push(response);

      const pageUnits = response.spatialUnits ?? [];
      for (const unit of pageUnits) {
        const identity = validateNativeUnit(unit, selection);
        const key = identityKey(identity);
        if (desired && !desired.has(key)) continue;
        const previous = found.get(key);
        if (previous && canonicalJson(previous) !== canonicalJson(unit)) {
          throw new RegionDownloadPlanError("Assets returned conflicting copies of a native unit identity", 409);
        }
        if (!previous) found.set(key, unit);
      }
      scannedUnits += pageUnits.length;
      options.onUpdate?.({ event: "progress", value: { stage: "lookup", completed: found.size, ...(requestedUnits ? { total: requestedUnits.length } : {}), files: 0, unavailable: 0 } });
      if (!requestedUnits) {
        firstPageHasMore = response.page?.hasMore === true;
        break;
      }
      if (requestedUnits.every((unit) => found.has(identityKey(unit)))) break;
      const page = response.page;
      if (!page?.hasMore) break;
      if (scannedUnits >= MAX_LOOKUP_UNITS) break;
      if (!validText(page.nextCursor, 2048) || seenCursors.has(page.nextCursor)) {
        throw new RegionDownloadPlanError("Assets pagination did not return a new cursor", 409);
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }

    if (!expectedSnapshot) throw new RegionDownloadPlanError("Assets did not return a query snapshot", 409);
    if (requestedUnits) {
      const missing = requestedUnits.filter((unit) => !found.has(identityKey(unit)));
      if (missing.length) throw new RegionDownloadPlanError("One or more explicit native unit identities are absent from the frozen Assets snapshot", 409);
    }

    const selectedSpatialUnits = [...found.values()]
      .sort((left, right) => identityKey(nativeUnitIdentity(left)).localeCompare(identityKey(nativeUnitIdentity(right))))
      .slice(0, requestedUnits ? MAX_NATIVE_UNITS : MAX_NATIVE_UNITS);
    const explicitUnits = selectedSpatialUnits.map(nativeUnitIdentity);
    const previewSelection: RegionDownloadSelection = {
      ...selection,
      querySnapshotId: expectedSnapshot.id,
      ...(expectedSnapshot.revision ? { nativeUnitIndexRevision: expectedSnapshot.revision } : {}),
      ...(explicitUnits.length ? { units: explicitUnits } : {}),
    };

    const notes = [...new Set(responses.flatMap((response) => response.notes))];
    const notices = new Map<string, RegionDownloadNotice>();
    const addNotice = (notice: RegionDownloadNotice) => {
      const key = JSON.stringify([notice.code, notice.layerId ?? "", notice.unitId ?? "", notice.fileName ?? ""]);
      notices.set(key, notice);
    };
    for (const response of responses) {
      for (const scope of response.scanScopes ?? []) {
        if (scope.completeness === "incomplete" && selection.layerIds.includes(scope.layerId)) {
          addNotice({ code: "inventory-incomplete", layerId: scope.layerId });
          notes.push(`Public scan scope ${scope.scopeId} for ${scope.layerId} is incomplete (${scope.committedPartitions}/${scope.expectedPartitions} partitions).`);
        }
      }
      for (const evidence of response.coverageEvidence ?? []) {
        if (selection.layerIds.includes(evidence.layerId) && evidence.completeness === "incomplete") {
          addNotice({ code: "inventory-incomplete", layerId: evidence.layerId });
          notes.push(`Public source inventory for ${evidence.layerId} is incomplete.`);
        }
      }
    }
    for (const unit of selectedSpatialUnits) {
      if (unit.note) notes.push(unit.note);
      if (unit.precision === "estimated") addNotice({ code: "coverage-estimated", layerId: unit.layerId, unitId: unit.unitId });
    }
    if (!requestedUnits && firstPageHasMore) notes.push("More native units exist in the Assets snapshot; this preview contains only the first bounded page.");
    const sourceBindingsList: SourceBinding[] = [];
    const unavailable: RegionDownloadPreview["unavailable"] = [];
    const layersWithUnits = new Set<string>();
    for (const unit of selectedSpatialUnits) {
      const native = nativeUnitIdentity(unit);
      layersWithUnits.add(native.layerId);
      const adapted = sourceBindings(unit);
      if (!adapted.bindings.length) {
        unavailable.push({ layerId: native.layerId, unitId: native.unitId, reason: adapted.reason ?? "No executable public source is available" });
      } else sourceBindingsList.push(...adapted.bindings);
    }
    if (!requestedUnits) {
      for (const layerId of selection.layerIds) {
        if (!layersWithUnits.has(layerId)) unavailable.push({ layerId, reason: "Assets returned no native public units for this selected layer and region" });
      }
    }

    const bindingsByUnitId = new Map(sourceBindingsList.map(({ sourceUnit, native }) => [sourceUnit.unitId, native]));
    const maxTotalFiles = Math.max(1, Math.min(MAX_PREVIEW_FILES, this.#sourceResolveOptions.maxTotalFiles ?? MAX_PREVIEW_FILES));
    const skipDnsLookup = this.#sourceResolveOptions.skipDnsLookup
      ?? Boolean(this.#sourceResolveOptions.fetchImpl && !this.#sourceResolveOptions.resolveHostname);
    const maxListingBytes = Math.max(1024, Math.min(1024 * 1024, this.#sourceResolveOptions.maxListingBytes ?? 256 * 1024));
    const metadataFetch = deduplicatedMetadataFetch(this.#sourceResolveOptions.fetchImpl ?? fetch, maxListingBytes);
    const provisionalFiles = new Map<string, { file: SourceFileInventory["files"][number]; ownerKey: string }>();
    const attributeFile = (file: SourceFileInventory["files"][number]) => {
      const native = bindingsByUnitId.get(file.unitId);
      return {
        file: native ? { ...file, layerId: native.layerId, nativeUnitKind: native.unitKind, nativeUnitId: native.unitId } : file,
        ownerKey: `${native ? identityKey(native) : file.unitId}\n${file.unitId}\n${file.relativePath}`,
      };
    };
    let unavailableCount = unavailable.length;
    options.onUpdate?.({ event: "batch", value: { files: [], unavailable: [...unavailable] } });
    options.onUpdate?.({ event: "progress", value: { stage: "metadata", completed: 0, total: sourceBindingsList.length, files: 0, unavailable: unavailableCount } });
    const resolvedInventory = await resolveSourceInventory(sourceBindingsList.map(({ sourceUnit }) => sourceUnit), {
      ...this.#sourceResolveOptions,
      fetchImpl: metadataFetch,
      skipDnsLookup,
      timeoutMs: Math.min(30_000, this.#sourceResolveOptions.timeoutMs ?? 30_000),
      maxListingBytes,
      maxTotalFiles,
      maxFilesPerUnit: Math.min(512, this.#sourceResolveOptions.maxFilesPerUnit ?? 512),
      maxConcurrency: 4,
      signal: options.signal,
      onUnitResolved: (result) => {
        options.signal?.throwIfAborted();
        const files: SourceFileInventory["files"] = [];
        for (const sourceFile of result.files) {
          const attributed = attributeFile(sourceFile);
          const previous = provisionalFiles.get(sourceFile.url);
          if (!previous || attributed.ownerKey.localeCompare(previous.ownerKey) < 0) {
            provisionalFiles.set(sourceFile.url, attributed);
            files.push(attributed.file);
          }
        }
        const failed: RegionDownloadPreview["unavailable"] = [];
        if (result.resolution.status === "unavailable") {
          const native = bindingsByUnitId.get(result.resolution.unitId);
          failed.push({ layerId: native?.layerId ?? "unknown", ...(native ? { unitId: native.unitId } : {}), reason: result.resolution.reason ?? "Source metadata is unavailable" });
          unavailableCount++;
        }
        if (files.length || failed.length) options.onUpdate?.({ event: "batch", value: { files, unavailable: failed } });
        options.onUpdate?.({ event: "progress", value: { stage: "metadata", completed: result.completed, total: result.total, files: provisionalFiles.size, unavailable: unavailableCount } });
      },
    });
    options.signal?.throwIfAborted();
    for (const resolution of resolvedInventory.units) {
      if (resolution.note) notes.push(resolution.note);
    }
    for (const file of resolvedInventory.files) {
      if (file.metadataState === "unverified") {
        const native = bindingsByUnitId.get(file.unitId);
        addNotice({
          code: "file-metadata-unverified",
          ...(native ? { layerId: native.layerId } : {}),
          unitId: file.unitId,
          fileName: file.relativePath.split(/[\\/]/).pop() ?? file.relativePath,
        });
      }
    }
    for (const resolution of resolvedInventory.units) {
      if (resolution.status === "unavailable") {
        const native = bindingsByUnitId.get(resolution.unitId);
        unavailable.push({
          layerId: native?.layerId ?? "unknown",
          ...(native ? { unitId: native.unitId } : {}),
          reason: resolution.reason ?? "Source metadata is unavailable",
        });
      }
    }
    const resolvedFileLayers = new Set<string>();
    const inventoryFilesByUrl = new Map<string, { file: SourceFileInventory["files"][number]; ownerKey: string }>();
    for (const file of resolvedInventory.files) {
      const native = bindingsByUnitId.get(file.unitId);
      const { file: attributed, ownerKey } = attributeFile(file);
      if (native) resolvedFileLayers.add(native.layerId);
      const previous = inventoryFilesByUrl.get(file.url);
      if (!previous || ownerKey.localeCompare(previous.ownerKey) < 0) {
        inventoryFilesByUrl.set(file.url, { file: attributed, ownerKey });
      }
    }
    const inventoryFiles = [...inventoryFilesByUrl.values()]
      .map(({ file }) => file)
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    const inventoryFileCounts = new Map<string, number>();
    inventoryFiles.forEach((file) => inventoryFileCounts.set(file.unitId, (inventoryFileCounts.get(file.unitId) ?? 0) + 1));
    const inventoryUnits = resolvedInventory.units.map((resolution) => ({
      ...resolution,
      fileCount: inventoryFileCounts.get(resolution.unitId) ?? 0,
    }));
    const assetsTruncated = responses.some((response) => response.truncated || response.downloadPlan?.truncated);
    const inventory: SourceFileInventory = {
      ...resolvedInventory,
      files: inventoryFiles,
      units: inventoryUnits,
      inventorySha256: computeInventoryDigest(inventoryFiles, inventoryUnits),
      truncated: resolvedInventory.truncated || assetsTruncated,
    };
    const normalizedNotes = [...new Set(notes)].slice(0, 256);
    for (const layerId of selection.layerIds) {
      const layerFiles = inventory.files.filter((file) => {
        const native = bindingsByUnitId.get(file.unitId);
        return native?.layerId === layerId;
      });
      const layerBindings = sourceBindingsList.filter(({ native }) => native.layerId === layerId);
      if (layerBindings.length && layerFiles.length === 0 && !resolvedFileLayers.has(layerId)
        && !unavailable.some((item) => item.layerId === layerId)) {
        unavailable.push({ layerId, reason: "No selected source unit produced a downloadable file" });
      }
    }

    const uniqueUnavailable = new Map<string, RegionDownloadPreview["unavailable"][number]>();
    unavailable.forEach((item) => uniqueUnavailable.set(`${item.layerId}\n${item.unitId ?? ""}\n${item.reason}`, item));
    const selectionTruncated = (!requestedUnits && firstPageHasMore)
      || responses.some((response) => response.truncated || response.downloadPlan?.truncated)
      || inventory.truncated;
    if (selectionTruncated) addNotice({ code: "results-truncated" });
    const base: Omit<RegionDownloadPreview, "planSha256"> = {
      selection: previewSelection,
      inventory,
      unavailable: [...uniqueUnavailable.values()].sort((left, right) => left.layerId.localeCompare(right.layerId) || (left.unitId ?? "").localeCompare(right.unitId ?? "")),
      notices: [...notices.values()],
      notes: normalizedNotes,
      limits: { maxFiles: MAX_DOWNLOAD_FILES },
      querySnapshotId: expectedSnapshot.id,
      ...(expectedSnapshot.revision ? { nativeUnitIndexRevision: expectedSnapshot.revision } : {}),
      expiresAt: expectedSnapshot.expiresAt,
      selectionTruncated,
    };
    return { ...base, planSha256: inventoryPlanSha(base) };
  }

  async confirm(input: RegionDownloadConfirmation): Promise<SourceFileInventory> {
    if (!input || typeof input !== "object" || !validText(input.previewSha256, 64) || !/^[a-f0-9]{64}$/i.test(input.previewSha256)) {
      throw new RegionDownloadPlanError("A valid preview SHA-256 is required for confirmation", 400);
    }
    if (!Array.isArray(input.selectedFileUrls) || input.selectedFileUrls.length === 0 || input.selectedFileUrls.length > MAX_DOWNLOAD_FILES) {
      throw new RegionDownloadPlanError(`Select between 1 and ${MAX_DOWNLOAD_FILES} previewed files`, 400);
    }
    if (new Set(input.selectedFileUrls).size !== input.selectedFileUrls.length || input.selectedFileUrls.some((url) => !validText(url, 4096))) {
      throw new RegionDownloadPlanError("Selected file URLs must be unique previewed URLs", 400);
    }
    if (!input.selection?.units?.length) throw new RegionDownloadPlanError("Confirmation must name explicit native units from a preview", 400);

    const current = await this.preview(input.selection);
    if (current.planSha256 !== input.previewSha256) {
      throw new RegionDownloadPlanError("The source inventory changed after preview; review a fresh plan", 409);
    }
    const filesByUrl = new Map(current.inventory.files.map((file) => [file.url, file]));
    const selectedFiles = input.selectedFileUrls.map((url) => {
      const file = filesByUrl.get(url);
      if (!file) throw new RegionDownloadPlanError("A selected URL is not part of the confirmed preview inventory", 409);
      return file;
    }).sort((left, right) => left.relativePath.localeCompare(right.relativePath));

    const counts = new Map<string, number>();
    selectedFiles.forEach((file) => counts.set(file.unitId, (counts.get(file.unitId) ?? 0) + 1));
    const selectedUnits = current.inventory.units.flatMap((unit) => {
      const fileCount = counts.get(unit.unitId);
      if (!fileCount) return [];
      return [{
        ...unit,
        status: "resolved" as const,
        fileCount,
      }];
    });
    return {
      schemaVersion: 1,
      inventorySha256: computeInventoryDigest(selectedFiles, selectedUnits),
      files: selectedFiles,
      units: selectedUnits,
      truncated: current.inventory.truncated || selectedUnits.some((unit) => unit.truncated === true),
    };
  }
}
