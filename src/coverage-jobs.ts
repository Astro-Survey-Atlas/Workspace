/**
 * The coverage task contract belongs to the private Workspace, not to the
 * public Assets site.  It deliberately describes the evidence source so a
 * catalog occupancy result is never presented as an image footprint.
 */
export const COVERAGE_JOB_MODES = ["catalog-radec", "nested-healpix", "fits-wcs"] as const;
export type CoverageJobMode = typeof COVERAGE_JOB_MODES[number];
export type CoverageEvidenceRole = "object_presence" | "image_extent";
export type CoverageCoordinateUnits = "deg" | "rad" | "hourangle";

export interface CoverageJobSpec {
  mode: CoverageJobMode;
  /** The scanner currently accepts ICRS only. */
  coordinateFrame: "ICRS";
  coordinateUnits?: CoverageCoordinateUnits;
  raColumn?: string;
  decColumn?: string;
  /** Declared NESTED pixel column. Required for `nested-healpix`. */
  healpixColumn?: string;
  /** Input and generated workspace coverage currently share this order. */
  healpixOrder?: number;
  evidenceRole: CoverageEvidenceRole;
}

/** Request body accepted by the private survey coverage-job endpoint. */
export interface CoverageJobSubmission {
  connectorId: string;
  assetId: string;
  releaseId: string;
  product: string;
  /** An optional child path. It is scoped to the registered connector server-side. */
  path?: string;
  allowedSuffixes?: string[];
  coverage: CoverageJobSpec;
}

/** Immutable scientific context retained with a submitted scan-run record. */
export interface CoverageJobSnapshot extends CoverageJobSpec {
  surveyId: string;
  releaseId: string;
  product: string;
}

export interface CoverageJobCapability {
  mode: CoverageJobMode;
  evidenceRole: CoverageEvidenceRole;
  requiredFields: string[];
}

export const COVERAGE_JOB_CAPABILITIES: readonly CoverageJobCapability[] = [
  { mode: "catalog-radec", evidenceRole: "object_presence", requiredFields: ["coverage.raColumn", "coverage.decColumn"] },
  { mode: "nested-healpix", evidenceRole: "object_presence", requiredFields: ["coverage.healpixColumn", "coverage.healpixOrder"] },
  { mode: "fits-wcs", evidenceRole: "image_extent", requiredFields: [] },
];

const SUBMISSION_FIELDS = new Set(["connectorId", "assetId", "releaseId", "product", "path", "allowedSuffixes", "coverage"]);
const SPEC_FIELDS = new Set(["mode", "coordinateFrame", "coordinateUnits", "raColumn", "decColumn", "healpixColumn", "healpixOrder", "evidenceRole"]);
const SNAPSHOT_FIELDS = new Set(["surveyId", "releaseId", "product", ...SPEC_FIELDS]);
const STABLE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,178}[a-z0-9])?$/;
const COLUMN_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,511}$/;
const SUFFIX = /^(?:\*|\.[A-Za-z0-9][A-Za-z0-9._-]{0,63})$/;

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RangeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function rejectUnknown(value: Record<string, unknown>, fields: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(value).find((field) => !fields.has(field));
  if (unknown) throw new RangeError(`${label} contains unknown field: ${unknown}`);
}

function stableId(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new RangeError(`${label} is required`);
  const result = value.trim();
  if (!STABLE_ID.test(result)) throw new RangeError(`${label} must be a stable identifier`);
  return result;
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim()) throw new RangeError(`${label} is required`);
  const result = value.trim();
  if (result.length > maximum) throw new RangeError(`${label} must contain at most ${maximum} characters`);
  return result;
}

function optionalText(value: unknown, label: string, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new RangeError(`${label} must be a string`);
  const result = value.trim();
  if (result.length > maximum) throw new RangeError(`${label} must contain at most ${maximum} characters`);
  return result || undefined;
}

function column(value: unknown, label: string, required: boolean): string | undefined {
  const result = required ? text(value, label, 512) : optionalText(value, label, 512);
  if (result && !COLUMN_NAME.test(result)) throw new RangeError(`${label} must be a column identifier`);
  return result;
}

function suffixes(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    throw new RangeError("allowedSuffixes must contain between 1 and 32 suffixes");
  }
  const result = value.map((entry, index) => {
    if (typeof entry !== "string") throw new RangeError(`allowedSuffixes[${index}] must be a string`);
    const suffix = entry.trim().toLowerCase();
    if (!SUFFIX.test(suffix)) throw new RangeError(`allowedSuffixes[${index}] is invalid`);
    return suffix;
  });
  if (new Set(result).size !== result.length) throw new RangeError("allowedSuffixes must not contain duplicates");
  return result;
}

function normalizedOrder(value: unknown, required: boolean): number | undefined {
  if (value === undefined && !required) return undefined;
  if (!Number.isInteger(value) || value !== 8) {
    throw new RangeError("coverage.healpixOrder must be 8 for current workspace coverage");
  }
  return value as number;
}

function normalizeSpec(value: unknown): CoverageJobSpec {
  const raw = objectValue(value, "coverage");
  rejectUnknown(raw, SPEC_FIELDS, "coverage");
  if (!(COVERAGE_JOB_MODES as readonly string[]).includes(raw.mode as string)) {
    throw new RangeError("coverage.mode is not supported");
  }
  const mode = raw.mode as CoverageJobMode;
  const coordinateFrame = raw.coordinateFrame ?? "ICRS";
  if (coordinateFrame !== "ICRS") throw new RangeError("coverage.coordinateFrame must be ICRS");
  const coordinateUnits = raw.coordinateUnits === undefined ? undefined : raw.coordinateUnits as CoverageCoordinateUnits;
  if (coordinateUnits !== undefined && !["deg", "rad", "hourangle"].includes(coordinateUnits)) {
    throw new RangeError("coverage.coordinateUnits must be deg, rad, or hourangle");
  }
  const requestedRole = raw.evidenceRole;

  if (mode === "catalog-radec") {
    if (requestedRole !== undefined && requestedRole !== "object_presence") {
      throw new RangeError("catalog-radec coverage must use object_presence evidence");
    }
    return {
      mode,
      coordinateFrame,
      coordinateUnits: coordinateUnits ?? "deg",
      raColumn: column(raw.raColumn, "coverage.raColumn", true),
      decColumn: column(raw.decColumn, "coverage.decColumn", true),
      healpixOrder: normalizedOrder(raw.healpixOrder ?? 8, true),
      evidenceRole: "object_presence",
    };
  }
  if (mode === "nested-healpix") {
    if (requestedRole !== undefined && requestedRole !== "object_presence") {
      throw new RangeError("nested-healpix coverage must use object_presence evidence");
    }
    return {
      mode,
      coordinateFrame,
      healpixColumn: column(raw.healpixColumn, "coverage.healpixColumn", true),
      healpixOrder: normalizedOrder(raw.healpixOrder, true),
      evidenceRole: "object_presence",
    };
  }
  if (requestedRole !== undefined && requestedRole !== "image_extent") {
    throw new RangeError("fits-wcs coverage must use image_extent evidence");
  }
  if (raw.raColumn !== undefined || raw.decColumn !== undefined || raw.healpixColumn !== undefined || raw.healpixOrder !== undefined || coordinateUnits !== undefined) {
    throw new RangeError("fits-wcs coverage does not accept catalog coordinate fields");
  }
  return { mode, coordinateFrame, evidenceRole: "image_extent" };
}

export function validateCoverageJobSubmission(value: unknown): CoverageJobSubmission {
  const raw = objectValue(value, "coverage job");
  rejectUnknown(raw, SUBMISSION_FIELDS, "coverage job");
  const path = optionalText(raw.path, "path", 4096);
  const allowedSuffixes = suffixes(raw.allowedSuffixes);
  if (path?.includes("\0")) throw new RangeError("path must not contain a NUL byte");
  return {
    connectorId: stableId(raw.connectorId, "connectorId"),
    assetId: stableId(raw.assetId, "assetId"),
    releaseId: stableId(raw.releaseId, "releaseId"),
    product: text(raw.product, "product", 160),
    ...(path === undefined ? {} : { path }),
    ...(allowedSuffixes === undefined ? {} : { allowedSuffixes }),
    coverage: normalizeSpec(raw.coverage),
  };
}

export function coverageJobSnapshot(surveyId: string, submission: CoverageJobSubmission): CoverageJobSnapshot {
  return {
    surveyId: stableId(surveyId, "surveyId"),
    releaseId: submission.releaseId,
    product: submission.product,
    ...submission.coverage,
  };
}

export function validateCoverageJobSnapshot(value: unknown): CoverageJobSnapshot {
  const raw = objectValue(value, "coverage job snapshot");
  rejectUnknown(raw, SNAPSHOT_FIELDS, "coverage job snapshot");
  const { surveyId, releaseId, product, ...specInput } = raw;
  const spec = normalizeSpec(specInput);
  return {
    surveyId: stableId(surveyId, "coverage.surveyId"),
    releaseId: stableId(releaseId, "coverage.releaseId"),
    product: text(product, "coverage.product", 160),
    ...spec,
  };
}

/** Translate the human-facing evidence mode into the scanner's stable keys. */
export function scannerCoverageProperties(coverage: CoverageJobSpec): Record<string, string> {
  if (coverage.mode === "catalog-radec") {
    return {
      spatialMode: "catalog",
      raColumn: coverage.raColumn!,
      decColumn: coverage.decColumn!,
      coordinateFrame: coverage.coordinateFrame,
      coordinateUnits: coverage.coordinateUnits ?? "deg",
      coverageRole: coverage.evidenceRole,
      healpixOrder: String(coverage.healpixOrder ?? 8),
    };
  }
  if (coverage.mode === "nested-healpix") {
    return {
      spatialMode: "healpix",
      healpixColumn: coverage.healpixColumn!,
      coordinateFrame: coverage.coordinateFrame,
      coverageRole: coverage.evidenceRole,
      healpixOrder: String(coverage.healpixOrder!),
    };
  }
  return {
    spatialMode: "auto",
    coordinateFrame: coverage.coordinateFrame,
    coverageRole: coverage.evidenceRole,
  };
}
