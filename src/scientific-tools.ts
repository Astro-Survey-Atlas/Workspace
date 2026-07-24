import { createHash } from "node:crypto";

export const EUCLID_CATALOG = "euclid-q1-mer-final";
export const DESI_CATALOG = "desi-dr10-tractor";
export const MAX_RESULT_ROWS = 1_000;

export interface CrossmatchInput {
  raDeg: number;
  decDeg: number;
  queryRadiusArcsec: number;
  matchRadiusArcsec: number;
  limit: number;
}

export interface CatalogRecord {
  catalog: "euclid" | "desi";
  objectId: string;
  raDeg: number;
  decDeg: number;
  magnitude: number | null;
  classLabel: string;
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
}

export type FilterOperator = "=" | "!=" | ">" | ">=" | "<" | "<=" | "contains";
export interface FilterCondition {
  field: keyof CrossmatchRecord;
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
  if (!value || typeof value !== "object") throw new RangeError("Workflow input must be an object");
  const input = value as Record<string, unknown>;
  const raDeg = finiteNumber(input.raDeg);
  const decDeg = finiteNumber(input.decDeg);
  const queryRadiusArcsec = finiteNumber(input.queryRadiusArcsec ?? 600);
  const matchRadiusArcsec = finiteNumber(input.matchRadiusArcsec ?? 1.5);
  const limit = finiteNumber(input.limit ?? 500);
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
  return { raDeg, decDeg, queryRadiusArcsec, matchRadiusArcsec, limit };
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
  const filters: Array<Record<string, unknown>> = [
    raRangeFilter(raField, input.raDeg, Math.min(180, angularHalfWidth / cosine)),
    { range: { [decField]: { gte: Math.max(-90, input.decDeg - angularHalfWidth), lte: Math.min(90, input.decDeg + angularHalfWidth) } } },
  ];
  if (!isEuclid) filters.push({ term: { brick_primary: true } });
  return {
    catalog,
    mode: "search",
    body: { query: { bool: { filter: filters } }, from: 0, size: input.limit },
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
  const candidates = [
    nestedValue(payload, ["data", "result", "hits", "hits"]),
    nestedValue(payload, ["result", "hits", "hits"]),
    nestedValue(payload, ["hits", "hits"]),
    nestedValue(payload, ["objects"]),
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

export function normalizeCatalogRows(catalog: "euclid" | "desi", hits: Array<Record<string, unknown>>, input: CrossmatchInput): CatalogRecord[] {
  const rows: CatalogRecord[] = [];
  for (const hit of hits) {
    const source = hit._source && typeof hit._source === "object" ? hit._source as Record<string, unknown> : hit;
    const raDeg = finiteNumber(firstValue(source, ["RIGHT_ASCENSION", "right_ascension", "RA", "ra"]));
    const decDeg = finiteNumber(firstValue(source, ["DECLINATION", "declination", "DEC", "dec"]));
    if (raDeg === null || decDeg === null || decDeg < -90 || decDeg > 90) continue;
    if (angularDistanceArcsec(input.raDeg, input.decDeg, raDeg, decDeg) > input.queryRadiusArcsec) continue;
    const objectId = firstValue(source, ["OBJECT_ID", "object_id", "TARGETID", "targetid"]) ?? hit._id;
    if (objectId === undefined || objectId === null || String(objectId).length === 0) continue;
    rows.push({
      catalog,
      objectId: String(objectId),
      raDeg: normalizeRa(raDeg),
      decDeg,
      magnitude: finiteNumber(firstValue(source, ["MAG_VIS", "mag_vis", "MAG_AUTO", "mag_auto", "mag", "mag_r", "MAG", "MAG_R"])),
      classLabel: String(firstValue(source, ["EXTENDED_FLAG", "extended_flag", "type", "TYPE", "objtype"]) ?? "unknown"),
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
    });
  }
  return matches.slice(0, MAX_RESULT_ROWS);
}

const FILTER_FIELDS = new Set<keyof CrossmatchRecord>([
  "euclidObjectId", "desiObjectId", "euclidRaDeg", "euclidDecDeg", "desiRaDeg", "desiDecDeg",
  "euclidMagnitude", "desiMagnitude", "separationArcsec", "classLabel",
]);

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
      const field = String(raw.field) as keyof CrossmatchRecord;
      const op = String(raw.op) as FilterOperator;
      if (!FILTER_FIELDS.has(field)) throw new RangeError(`Unsupported filter field: ${field}`);
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

export function applyResultFilter(rows: CrossmatchRecord[], filter?: FilterSpec): CrossmatchRecord[] {
  if (!filter) return rows.slice(0, MAX_RESULT_ROWS);
  return rows.filter((row) => filter.logic === "or"
    ? filter.conditions.some((condition) => compare(row[condition.field], condition))
    : filter.conditions.every((condition) => compare(row[condition.field], condition))).slice(0, MAX_RESULT_ROWS);
}

function csvValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function rowsToCsv(rows: CrossmatchRecord[]): string {
  const fields: Array<keyof CrossmatchRecord> = [
    "euclidObjectId", "desiObjectId", "euclidRaDeg", "euclidDecDeg", "desiRaDeg", "desiDecDeg",
    "euclidMagnitude", "desiMagnitude", "separationArcsec", "classLabel",
  ];
  return `${fields.join(",")}\n${rows.map((row) => fields.map((field) => csvValue(row[field])).join(",")).join("\n")}${rows.length ? "\n" : ""}`;
}

export function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
