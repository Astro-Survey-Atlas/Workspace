import { createHash } from "node:crypto";

export const EUCLID_CATALOG = "euclid-q1-mer-final";
export const DESI_CATALOG = "desi-dr10-tractor";
export const MAX_RESULT_ROWS = 1_000;

export type WorkflowCatalogSide = "euclid" | "desi";
export type WorkflowCatalogFormat = "csv" | "fits";
export type WorkflowCatalogColumn = "ra" | "dec" | "id" | "magnitude" | "classLabel" | "tileIndex" | "brickname" | "fitsPath" | "imageG" | "imageR" | "imageI" | "imageZ";
export type WorkflowCatalogFieldValue = string | number | boolean | null | Array<string | number | boolean | null>;
export type WorkflowCatalogFieldMap = Partial<Record<WorkflowCatalogSide, Record<string, string>>>;

export interface WorkflowCatalogSourceInput {
  assetId: string;
  side: WorkflowCatalogSide;
  format?: WorkflowCatalogFormat;
  accessIndex?: number;
  tableHdu?: number | string;
  columns?: Partial<Record<WorkflowCatalogColumn, string>>;
}

export type WorkflowCatalogSourcesInput = Partial<Record<WorkflowCatalogSide, Omit<WorkflowCatalogSourceInput, "side">>>;

export interface CrossmatchInput {
  raDeg: number;
  decDeg: number;
  queryRadiusArcsec: number;
  matchRadiusArcsec: number;
  limit: number;
  cutoutEnabled: boolean;
  cutoutSizeDeg: number;
  desiBands: Array<"g" | "r" | "i" | "z">;
  catalogSource?: WorkflowCatalogSourceInput;
  catalogSources?: WorkflowCatalogSourcesInput;
  catalogFields?: WorkflowCatalogFieldMap;
}

export interface CatalogRecord {
  catalog: "euclid" | "desi";
  objectId: string;
  raDeg: number;
  decDeg: number;
  magnitude: number | null;
  classLabel: string;
  tileIndex?: string;
  brickname?: string;
  release?: string;
  brickId?: string;
  brickObjectId?: string;
  fitsPath?: string;
  imagePaths?: Partial<Record<"g" | "r" | "i" | "z", string>>;
  fields?: Record<string, WorkflowCatalogFieldValue>;
}

export interface CrossmatchRecord {
  euclidObjectId: string;
  desiObjectId: string;
  euclidRaDeg: number;
  euclidDecDeg: number;
  desiRaDeg: number;
  desiDecDeg: number;
  euclidMagnitude: number | null;
  desiMagnitude: number | null;
  separationArcsec: number;
  classLabel: string;
  euclidTileIndex?: string;
  euclidFitsPath?: string;
  desiBrickname?: string;
  desiRelease?: string;
  desiBrickId?: string;
  desiBrickObjectId?: string;
  desiImageGPath?: string;
  desiImageRPath?: string;
  desiImageIPath?: string;
  desiImageZPath?: string;
  euclidFields?: Record<string, WorkflowCatalogFieldValue>;
  desiFields?: Record<string, WorkflowCatalogFieldValue>;
}

export type FilterOperator = "=" | "!=" | ">" | ">=" | "<" | "<=" | "contains";
export interface FilterCondition {
  field: string;
  op: FilterOperator;
  value: string | number;
}

export interface FilterSpec {
  logic: "and" | "or";
  conditions: FilterCondition[];
}

function finiteNumber(value: unknown): number | null {
  const converted = typeof value === "number" ? value : Number(value);
  return Number.isFinite(converted) ? converted : null;
}

export function normalizeRa(raDeg: number): number {
  return ((raDeg % 360) + 360) % 360;
}

export function parseCrossmatchInput(value: unknown): CrossmatchInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RangeError("Workflow input must be an object");
  const input = value as Record<string, unknown>;
  const raDeg = finiteNumber(input.raDeg);
  const decDeg = finiteNumber(input.decDeg);
  const queryRadiusArcsec = finiteNumber(input.queryRadiusArcsec ?? 250);
  const matchRadiusArcsec = finiteNumber(input.matchRadiusArcsec ?? 1.5);
  const limit = finiteNumber(input.limit ?? 500);
  const cutoutEnabled = input.cutoutEnabled !== false;
  const cutoutSizeDeg = finiteNumber(input.cutoutSizeDeg ?? 0.008);
  const rawBands = input.desiBands ?? ["g", "r", "i", "z"];
  if (raDeg === null || raDeg < 0 || raDeg >= 360) throw new RangeError("RA must be in [0, 360)");
  if (decDeg === null || decDeg < -90 || decDeg > 90) throw new RangeError("Dec must be in [-90, 90]");
  if (queryRadiusArcsec === null || queryRadiusArcsec < 1 || queryRadiusArcsec > 3_600) {
    throw new RangeError("Query radius must be between 1 and 3600 arcsec");
  }
  if (matchRadiusArcsec === null || matchRadiusArcsec < 0.1 || matchRadiusArcsec > 10) {
    throw new RangeError("Match radius must be between 0.1 and 10 arcsec");
  }
  if (limit === null || !Number.isInteger(limit) || limit < 1 || limit > MAX_RESULT_ROWS) {
    throw new RangeError(`Result limit must be an integer between 1 and ${MAX_RESULT_ROWS}`);
  }
  if (cutoutSizeDeg === null || cutoutSizeDeg < 0.001 || cutoutSizeDeg > 1) {
    throw new RangeError("Cutout size must be between 0.001 and 1 degree");
  }
  if (!Array.isArray(rawBands) || rawBands.length < 1 || rawBands.length > 4
    || rawBands.some((band) => !["g", "r", "i", "z"].includes(String(band)))) {
    throw new RangeError("DESI bands must contain between 1 and 4 values from g, r, i, z");
  }
  const desiBands = [...new Set(rawBands.map((band) => String(band) as "g" | "r" | "i" | "z"))];
  const catalogSource = parseWorkflowCatalogSource(input.catalogSource);
  const catalogSources = parseWorkflowCatalogSources(input.catalogSources);
  if (catalogSource && catalogSources?.[catalogSource.side]) throw new RangeError("Specify a catalog source only once per side");
  const catalogFields = parseWorkflowCatalogFields(input.catalogFields);
  return { raDeg, decDeg, queryRadiusArcsec, matchRadiusArcsec, limit, cutoutEnabled, cutoutSizeDeg, desiBands,
    ...(catalogSource ? { catalogSource } : {}), ...(catalogSources ? { catalogSources } : {}), ...(catalogFields ? { catalogFields } : {}) };
}

function parseWorkflowCatalogSources(value: unknown): WorkflowCatalogSourcesInput | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RangeError("catalogSources must be an object");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((side) => side !== "euclid" && side !== "desi")) throw new RangeError("catalogSources supports only euclid and desi sides");
  const result: WorkflowCatalogSourcesInput = {};
  for (const side of ["euclid", "desi"] as const) {
    if (raw[side] === undefined) continue;
    const entry = raw[side];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new RangeError(`catalogSources.${side} must be an object`);
    const source = parseWorkflowCatalogSource({ ...(entry as Record<string, unknown>), side });
    if (!source) throw new RangeError(`catalogSources.${side} is invalid`);
    const { side: _side, ...input } = source;
    result[side] = input;
  }
  return Object.keys(result).length ? result : undefined;
}

function parseWorkflowCatalogFields(value: unknown): WorkflowCatalogFieldMap | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RangeError("catalogFields must be an object");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((side) => side !== "euclid" && side !== "desi")) throw new RangeError("catalogFields supports only euclid and desi sides");
  const result: WorkflowCatalogFieldMap = {};
  for (const side of ["euclid", "desi"] as const) {
    const mapping = raw[side];
    if (mapping === undefined) continue;
    if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) throw new RangeError(`catalogFields.${side} must be an object`);
    const entries = Object.entries(mapping as Record<string, unknown>);
    if (entries.length > 16) throw new RangeError(`catalogFields.${side} may contain at most 16 fields`);
    const fields: Record<string, string> = {};
    for (const [alias, sourceColumn] of entries) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(alias)) throw new RangeError("catalogFields aliases must be simple field names");
      if (typeof sourceColumn !== "string" || !sourceColumn.trim() || sourceColumn.trim().length > 128) {
        throw new RangeError("catalogFields column names must contain between 1 and 128 characters");
      }
      fields[alias] = sourceColumn.trim();
    }
    if (entries.length) result[side] = fields;
  }
  return Object.keys(result).length ? result : undefined;
}

const WORKFLOW_CATALOG_COLUMNS = new Set<WorkflowCatalogColumn>([
  "ra", "dec", "id", "magnitude", "classLabel", "tileIndex", "brickname", "fitsPath", "imageG", "imageR", "imageI", "imageZ",
]);

function parseWorkflowCatalogSource(value: unknown): WorkflowCatalogSourceInput | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RangeError("catalogSource must be an object");
  const source = value as Record<string, unknown>;
  const assetId = typeof source.assetId === "string" ? source.assetId.trim() : "";
  if (!assetId || assetId.length > 120) throw new RangeError("catalogSource.assetId is invalid");
  if (source.side !== "euclid" && source.side !== "desi") throw new RangeError("catalogSource.side must be euclid or desi");
  if (source.format !== undefined && source.format !== "csv" && source.format !== "fits") throw new RangeError("catalogSource.format must be csv or fits");
  let accessIndex: number | undefined;
  if (source.accessIndex !== undefined) {
    if (typeof source.accessIndex !== "number" || !Number.isSafeInteger(source.accessIndex) || source.accessIndex < 0 || source.accessIndex > 31) {
      throw new RangeError("catalogSource.accessIndex must be an integer between 0 and 31");
    }
    accessIndex = source.accessIndex;
  }
  let tableHdu: number | string | undefined;
  if (source.tableHdu !== undefined) {
    if (typeof source.tableHdu === "number" && Number.isSafeInteger(source.tableHdu) && source.tableHdu >= 0 && source.tableHdu <= 2048) tableHdu = source.tableHdu;
    else if (typeof source.tableHdu === "string" && source.tableHdu.trim() && source.tableHdu.trim().length <= 80) tableHdu = source.tableHdu.trim();
    else throw new RangeError("catalogSource.tableHdu must be a non-negative HDU index or name");
  }
  let columns: WorkflowCatalogSourceInput["columns"];
  if (source.columns !== undefined) {
    if (!source.columns || typeof source.columns !== "object" || Array.isArray(source.columns)) throw new RangeError("catalogSource.columns must be an object");
    columns = {};
    for (const [key, rawColumn] of Object.entries(source.columns)) {
      if (!WORKFLOW_CATALOG_COLUMNS.has(key as WorkflowCatalogColumn)) throw new RangeError("catalogSource.columns contains an unsupported field");
      if (typeof rawColumn !== "string" || !rawColumn.trim() || rawColumn.trim().length > 128) throw new RangeError("catalogSource column names must contain between 1 and 128 characters");
      columns[key as WorkflowCatalogColumn] = rawColumn.trim();
    }
  }
  return { assetId, side: source.side, ...(source.format ? { format: source.format } : {}), ...(accessIndex === undefined ? {} : { accessIndex }),
    ...(tableHdu === undefined ? {} : { tableHdu }), ...(columns && Object.keys(columns).length ? { columns } : {}) };
}

export function workflowCatalogSourceForSide(input: CrossmatchInput, side: WorkflowCatalogSide): WorkflowCatalogSourceInput | undefined {
  const source = input.catalogSources?.[side];
  if (source) return { ...source, side };
  return input.catalogSource?.side === side ? input.catalogSource : undefined;
}

export function angularDistanceArcsec(ra1Deg: number, dec1Deg: number, ra2Deg: number, dec2Deg: number): number {
  const radians = Math.PI / 180;
  const dec1 = dec1Deg * radians;
  const dec2 = dec2Deg * radians;
  const deltaDec = (dec2Deg - dec1Deg) * radians;
  let deltaRaDeg = normalizeRa(ra2Deg) - normalizeRa(ra1Deg);
  if (deltaRaDeg > 180) deltaRaDeg -= 360;
  if (deltaRaDeg < -180) deltaRaDeg += 360;
  const deltaRa = deltaRaDeg * radians;
  const sinDec = Math.sin(deltaDec / 2);
  const sinRa = Math.sin(deltaRa / 2);
  const haversine = Math.min(1, sinDec * sinDec + Math.cos(dec1) * Math.cos(dec2) * sinRa * sinRa);
  return 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(Math.max(0, 1 - haversine))) * 206_264.80624709636;
}

export function raRangeFilter(field: string, centerRaDeg: number, halfWidthDeg: number): Record<string, unknown> {
  if (halfWidthDeg >= 180) return { match_all: {} };
  const minimum = normalizeRa(centerRaDeg - halfWidthDeg);
  const maximum = normalizeRa(centerRaDeg + halfWidthDeg);
  if (minimum <= maximum) return { range: { [field]: { gte: minimum, lte: maximum } } };
  return {
    bool: {
      should: [
        { range: { [field]: { gte: minimum, lt: 360 } } },
        { range: { [field]: { gte: 0, lte: maximum } } },
      ],
      minimum_should_match: 1,
    },
  };
}

export function catalogQueryBody(catalog: typeof EUCLID_CATALOG | typeof DESI_CATALOG, input: CrossmatchInput): Record<string, unknown> {
  const isEuclid = catalog === EUCLID_CATALOG;
  const raField = isEuclid ? "RIGHT_ASCENSION" : "ra";
  const decField = isEuclid ? "DECLINATION" : "dec";
  const angularHalfWidth = input.queryRadiusArcsec / 3_600;
  const cosine = Math.max(0.01, Math.cos(input.decDeg * Math.PI / 180));
  const crossesPole = Math.abs(input.decDeg) + angularHalfWidth >= 90;
  const filters: Array<Record<string, unknown>> = [
    crossesPole ? { match_all: {} } : raRangeFilter(raField, input.raDeg, Math.min(180, angularHalfWidth / cosine)),
    { range: { [decField]: { gte: Math.max(-90, input.decDeg - angularHalfWidth), lte: Math.min(90, input.decDeg + angularHalfWidth) } } },
  ];
  if (!isEuclid) filters.push({ term: { brick_primary: true } });
  const side = isEuclid ? "euclid" : "desi";
  const requestedFields = Object.values(input.catalogFields?.[side] ?? {});
  const sourceFields = isEuclid
    ? ["OBJECT_ID", "RIGHT_ASCENSION", "DECLINATION", "MAG_VIS", "MAG_AUTO", "EXTENDED_FLAG", "TILE_INDEX", "fits_path", "FITS_PATH", "image_path", "IMAGE_PATH"]
    : ["TARGETID", "ra", "dec", "MAG", "MAG_R", "TYPE", "BRICKNAME", "fits_path", "FITS_PATH", "image_g_path", "image_r_path", "image_i_path", "image_z_path"];
  return {
    catalog,
    mode: "search",
    body: {
      _source: [...new Set([...sourceFields, ...requestedFields])],
      query: { bool: { filter: filters } },
      from: 0,
      size: input.limit,
    },
  };
}

function nestedValue(value: unknown, keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function extractCatalogHits(payload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) return payload.filter((hit): hit is Record<string, unknown> => Boolean(hit) && typeof hit === "object" && !Array.isArray(hit));
  const candidates = [
    nestedValue(payload, ["hits"]),
    nestedValue(payload, ["data", "result", "hits", "hits"]),
    nestedValue(payload, ["result", "hits", "hits"]),
    nestedValue(payload, ["hits", "hits"]),
    nestedValue(payload, ["data", "hits"]),
    nestedValue(payload, ["result", "hits"]),
    nestedValue(payload, ["data", "objects"]),
    nestedValue(payload, ["result", "objects"]),
    nestedValue(payload, ["data", "rows"]),
    nestedValue(payload, ["result", "rows"]),
    nestedValue(payload, ["data", "records"]),
    nestedValue(payload, ["result", "records"]),
    nestedValue(payload, ["objects"]),
    nestedValue(payload, ["rows"]),
    nestedValue(payload, ["records"]),
    nestedValue(payload, ["result"]),
    nestedValue(payload, ["data"]),
  ];
  const hits = candidates.find(Array.isArray) as unknown[] | undefined;
  if (!hits) return [];
  return hits.filter((hit): hit is Record<string, unknown> => Boolean(hit) && typeof hit === "object");
}

function firstValue(record: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) {
    if (record[name] !== undefined && record[name] !== null) return record[name];
  }
  return undefined;
}

function firstText(record: Record<string, unknown>, names: string[]): string | undefined {
  const value = firstValue(record, names);
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

export function normalizeCatalogRows(catalog: "euclid" | "desi", hits: Array<Record<string, unknown>>, input: CrossmatchInput): CatalogRecord[] {
  const rows: CatalogRecord[] = [];
  for (const hit of hits) {
    const source = hit._source && typeof hit._source === "object" ? hit._source as Record<string, unknown> : hit;
    const raDeg = finiteNumber(firstValue(source, ["RIGHT_ASCENSION", "right_ascension", "RA", "ra"]));
    const decDeg = finiteNumber(firstValue(source, ["DECLINATION", "declination", "DEC", "dec"]));
    if (raDeg === null || decDeg === null || decDeg < -90 || decDeg > 90) continue;
    if (angularDistanceArcsec(input.raDeg, input.decDeg, raDeg, decDeg) > input.queryRadiusArcsec) continue;
    const objectId = firstValue(source, ["OBJECT_ID", "object_id", "TARGETID", "targetid", "LS_ID", "ls_id"]) ?? hit._id;
    if (objectId === undefined || objectId === null || String(objectId).length === 0) continue;
    let magnitude = finiteNumber(firstValue(source, ["MAG_VIS", "mag_vis", "MAG_AUTO", "mag_auto", "mag", "mag_r", "MAG", "MAG_R"]));
    if (magnitude === null && catalog === "desi") {
      const fluxR = finiteNumber(firstValue(source, ["flux_r", "FLUX_R"]));
      if (fluxR !== null && fluxR > 0) magnitude = 22.5 - 2.5 * Math.log10(fluxR);
    }
    const imagePaths: Partial<Record<"g" | "r" | "i" | "z", string>> = {};
    for (const band of ["g", "r", "i", "z"] as const) {
      const imagePath = firstText(source, [
        `desi_image_${band}_path`, `DESI_IMAGE_${band.toUpperCase()}_PATH`, `image_${band}_path`, `IMAGE_${band.toUpperCase()}_PATH`,
      ]);
      if (imagePath) imagePaths[band] = imagePath;
    }
    const tileIndex = firstText(source, ["TILE_INDEX", "tile_index", "TILEID", "tileid", "tile_id"]);
    const brickname = firstText(source, ["BRICKNAME", "brickname"]);
    const release = catalog === "desi" ? firstText(source, ["RELEASE", "release"]) : undefined;
    const brickId = catalog === "desi" ? firstText(source, ["BRICKID", "brickid"]) : undefined;
    const brickObjectId = catalog === "desi" ? firstText(source, ["OBJID", "objid"]) : undefined;
    const fitsPath = firstText(source, catalog === "euclid"
      ? ["euclid_fits_path", "EUCLID_FITS_PATH", "fits_path", "FITS_PATH", "image_path", "IMAGE_PATH"]
      : ["fits_path", "FITS_PATH"]);
    const fields = mappedCatalogFields(source, catalog, input.catalogFields?.[catalog]);
    rows.push({
      catalog,
      objectId: String(objectId),
      raDeg: normalizeRa(raDeg),
      decDeg,
      magnitude,
      classLabel: String(firstValue(source, ["EXTENDED_FLAG", "extended_flag", "type", "TYPE", "objtype"]) ?? "unknown"),
      ...(tileIndex ? { tileIndex } : {}),
      ...(brickname ? { brickname } : {}),
      ...(release ? { release } : {}),
      ...(brickId ? { brickId } : {}),
      ...(brickObjectId ? { brickObjectId } : {}),
      ...(fitsPath ? { fitsPath } : {}),
      ...(Object.keys(imagePaths).length > 0 ? { imagePaths } : {}),
      ...(fields ? { fields } : {}),
    });
  }
  return rows.slice(0, input.limit);
}

export function nearestNeighborCrossmatch(euclidRows: CatalogRecord[], desiRows: CatalogRecord[], radiusArcsec: number): CrossmatchRecord[] {
  const matches: CrossmatchRecord[] = [];
  for (const euclid of euclidRows) {
    let nearest: CatalogRecord | undefined;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const desi of desiRows) {
      const distance = angularDistanceArcsec(euclid.raDeg, euclid.decDeg, desi.raDeg, desi.decDeg);
      if (distance <= radiusArcsec && distance < nearestDistance) {
        nearest = desi;
        nearestDistance = distance;
      }
    }
    if (!nearest) continue;
    matches.push({
      euclidObjectId: euclid.objectId,
      desiObjectId: nearest.objectId,
      euclidRaDeg: euclid.raDeg,
      euclidDecDeg: euclid.decDeg,
      desiRaDeg: nearest.raDeg,
      desiDecDeg: nearest.decDeg,
      euclidMagnitude: euclid.magnitude,
      desiMagnitude: nearest.magnitude,
      separationArcsec: Number(nearestDistance.toFixed(6)),
      classLabel: euclid.classLabel,
      ...(euclid.tileIndex ? { euclidTileIndex: euclid.tileIndex } : {}),
      ...(euclid.fitsPath ? { euclidFitsPath: euclid.fitsPath } : {}),
      ...(nearest.brickname ? { desiBrickname: nearest.brickname } : {}),
      ...(nearest.release ? { desiRelease: nearest.release } : {}),
      ...(nearest.brickId ? { desiBrickId: nearest.brickId } : {}),
      ...(nearest.brickObjectId ? { desiBrickObjectId: nearest.brickObjectId } : {}),
      ...(nearest.imagePaths?.g ? { desiImageGPath: nearest.imagePaths.g } : {}),
      ...(nearest.imagePaths?.r ? { desiImageRPath: nearest.imagePaths.r } : {}),
      ...(nearest.imagePaths?.i ? { desiImageIPath: nearest.imagePaths.i } : {}),
      ...(nearest.imagePaths?.z ? { desiImageZPath: nearest.imagePaths.z } : {}),
      ...(euclid.fields ? { euclidFields: euclid.fields } : {}),
      ...(nearest.fields ? { desiFields: nearest.fields } : {}),
    });
  }
  return matches.slice(0, MAX_RESULT_ROWS);
}

const FILTER_FIELDS = new Set<keyof CrossmatchRecord>([
  "euclidObjectId", "desiObjectId", "euclidRaDeg", "euclidDecDeg", "desiRaDeg", "desiDecDeg",
  "euclidMagnitude", "desiMagnitude", "separationArcsec", "classLabel", "desiRelease", "desiBrickId", "desiBrickObjectId",
]);

function mappedCatalogFields(source: Record<string, unknown>, catalog: WorkflowCatalogSide, mapping: Record<string, string> | undefined): Record<string, WorkflowCatalogFieldValue> | undefined {
  if (!mapping) return undefined;
  const embedded = source.asa_catalog_fields && typeof source.asa_catalog_fields === "object" && !Array.isArray(source.asa_catalog_fields)
    ? source.asa_catalog_fields as Record<string, unknown>
    : undefined;
  const values: Record<string, WorkflowCatalogFieldValue> = {};
  for (const [alias, sourceColumn] of Object.entries(mapping)) {
    const raw = embedded && Object.hasOwn(embedded, alias) ? embedded[alias] : source[sourceColumn];
    const value = catalogFieldValue(raw, `${catalog}.${alias}`);
    values[alias] = value ?? null;
  }
  return Object.keys(values).length ? values : undefined;
}

function catalogFieldValue(value: unknown, label: string): WorkflowCatalogFieldValue | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    if (value.length > 256) throw new RangeError(`Selected catalog field ${label} exceeds the 256-character limit`);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 16) throw new RangeError(`Selected catalog field ${label} exceeds the 16-value limit`);
    const items: Array<string | number | boolean | null> = [];
    for (const item of value) {
      const normalized = catalogFieldValue(item, label);
      if (normalized === undefined || Array.isArray(normalized) || (normalized !== null && typeof normalized === "object")) {
        throw new RangeError(`Selected catalog field ${label} must contain scalar values`);
      }
      items.push(normalized);
    }
    return items;
  }
  return undefined;
}

function dynamicFieldPath(field: string): { side: WorkflowCatalogSide; alias: string } | undefined {
  const match = /^(euclid|desi)Fields\.([A-Za-z][A-Za-z0-9_]{0,63})$/.exec(field);
  return match ? { side: match[1] as WorkflowCatalogSide, alias: match[2]! } : undefined;
}

export function availableFilterFields(row: CrossmatchRecord): string[] {
  return [
    ...FILTER_FIELDS,
    ...Object.keys(row.euclidFields ?? {}).map((alias) => `euclidFields.${alias}`),
    ...Object.keys(row.desiFields ?? {}).map((alias) => `desiFields.${alias}`),
  ];
}

export function parseFilterSpec(value: unknown): FilterSpec {
  if (!value || typeof value !== "object") throw new RangeError("Filter decision must include a filter object");
  const candidate = value as Record<string, unknown>;
  const conditions = candidate.conditions;
  if (!Array.isArray(conditions) || conditions.length < 1 || conditions.length > 5) {
    throw new RangeError("Filter must contain between 1 and 5 conditions");
  }
  return {
    logic: candidate.logic === "or" ? "or" : "and",
    conditions: conditions.map((condition) => {
      if (!condition || typeof condition !== "object") throw new RangeError("Invalid filter condition");
      const raw = condition as Record<string, unknown>;
      const field = String(raw.field);
      const op = String(raw.op) as FilterOperator;
      if (!FILTER_FIELDS.has(field as keyof CrossmatchRecord) && !dynamicFieldPath(field)) throw new RangeError(`Unsupported filter field: ${field}`);
      if (!["=", "!=", ">", ">=", "<", "<=", "contains"].includes(op)) throw new RangeError(`Unsupported filter operator: ${op}`);
      if (raw.value === undefined) throw new RangeError("Filter condition value is required");
      return { field, op, value: typeof raw.value === "number" ? raw.value : String(raw.value) };
    }),
  };
}

function compare(left: unknown, condition: FilterCondition): boolean {
  const right = condition.value;
  if (condition.op === "contains") return String(left ?? "").toLowerCase().includes(String(right).toLowerCase());
  if (condition.op === "=" || condition.op === "!=") {
    const equal = typeof left === "number" || typeof right === "number" ? Number(left) === Number(right) : String(left) === String(right);
    return condition.op === "=" ? equal : !equal;
  }
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (!Number.isFinite(leftNumber) || !Number.isFinite(rightNumber)) return false;
  if (condition.op === ">") return leftNumber > rightNumber;
  if (condition.op === ">=") return leftNumber >= rightNumber;
  if (condition.op === "<") return leftNumber < rightNumber;
  return leftNumber <= rightNumber;
}

function filterValue(row: CrossmatchRecord, field: string): unknown {
  const mapped = dynamicFieldPath(field);
  if (mapped) return row[`${mapped.side}Fields`]?.[mapped.alias];
  return row[field as keyof CrossmatchRecord];
}

export function applyResultFilter(rows: CrossmatchRecord[], filter?: FilterSpec): CrossmatchRecord[] {
  if (!filter) return rows.slice(0, MAX_RESULT_ROWS);
  return rows.filter((row) => filter.logic === "or"
    ? filter.conditions.some((condition) => compare(filterValue(row, condition.field), condition))
    : filter.conditions.every((condition) => compare(filterValue(row, condition.field), condition))).slice(0, MAX_RESULT_ROWS);
}

function csvValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? (/^[=+\-@]/.test(value) ? `'${value}` : value)
    : typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function rowsToCsv(rows: CrossmatchRecord[]): string {
  const fields: string[] = [
    "euclidObjectId", "desiObjectId", "euclidRaDeg", "euclidDecDeg", "desiRaDeg", "desiDecDeg",
    "euclidMagnitude", "desiMagnitude", "separationArcsec", "classLabel", "euclidTileIndex", "euclidFitsPath",
    "desiBrickname", "desiRelease", "desiBrickId", "desiBrickObjectId", "desiImageGPath", "desiImageRPath", "desiImageIPath", "desiImageZPath",
  ];
  const euclidFields = [...new Set(rows.flatMap((row) => Object.keys(row.euclidFields ?? {})))].sort();
  const desiFields = [...new Set(rows.flatMap((row) => Object.keys(row.desiFields ?? {})))].sort();
  const headers = [...fields, ...euclidFields.map((field) => `euclid_${field}`), ...desiFields.map((field) => `desi_${field}`)];
  const valueFor = (row: CrossmatchRecord, field: string): unknown => {
    if (field.startsWith("euclid_") && euclidFields.includes(field.slice("euclid_".length))) return row.euclidFields?.[field.slice("euclid_".length)];
    if (field.startsWith("desi_") && desiFields.includes(field.slice("desi_".length))) return row.desiFields?.[field.slice("desi_".length)];
    return row[field as keyof CrossmatchRecord];
  };
  return `${headers.join(",")}\n${rows.map((row) => headers.map((field) => csvValue(valueFor(row, field))).join(",")).join("\n")}${rows.length ? "\n" : ""}`;
}

export function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
