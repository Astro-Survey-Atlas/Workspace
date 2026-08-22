/**
 * Private contract for an Atlas-owned user's optional remote scan. Assets Core
 * is the geometry authority; public coverage tasks do not enter this service.
 */
import { COVERAGE_ROLES, DATA_ORIGINS, SOURCE_TIERS, type CoverageDataOrigin, type CoverageRole, type CoverageSourceTier } from "./assets-core.js";

export const COVERAGE_JOB_MODES = ["catalog-radec", "nested-healpix", "fits-wcs"] as const;
export type CoverageJobMode = typeof COVERAGE_JOB_MODES[number];
export type { CoverageDataOrigin, CoverageRole, CoverageSourceTier } from "./assets-core.js";
export type CoverageCoordinateUnits = "deg" | "rad" | "hourangle";
export interface CoverageCenterAliases { centerRaAliases?: string[]; centerDecAliases?: string[]; centerUnits?: CoverageCoordinateUnits; centerFrame?: "ICRS"; }

export interface CoverageJobSpec extends CoverageCenterAliases {
  mode: CoverageJobMode;
  coordinateFrame: "ICRS";
  coordinateUnits?: CoverageCoordinateUnits;
  raColumn?: string;
  decColumn?: string;
  /** Declared input order only. It does not describe the authority MOC. */
  healpixOrder?: number;
  healpixColumn?: string;
  coverageRole: CoverageRole;
  dataOrigin: CoverageDataOrigin;
  sourceTier: CoverageSourceTier;
  /** Assets Core authority order. Ordinary user data is fixed at order 10. */
  maxOrder: number;
  queryOrder: 8;
  previewOrder: 4;
  fileNamePattern?: string;
}

export interface CoverageJobSubmission {
  connectorId: string;
  assetId: string;
  releaseId: string;
  product: string;
  path?: string;
  fileNamePattern?: string;
  allowedSuffixes?: string[];
  coverage: CoverageJobSpec;
}

export interface CoverageJobSnapshot extends CoverageJobSpec {
  surveyId: string;
  releaseId: string;
  product: string;
}

export interface CoverageJobCapability {
  mode: CoverageJobMode;
  coverageRole: CoverageRole;
  requiredFields: string[];
}

export const COVERAGE_JOB_CAPABILITIES: readonly CoverageJobCapability[] = [
  { mode: "catalog-radec", coverageRole: "object_presence", requiredFields: ["coverage.raColumn", "coverage.decColumn"] },
  { mode: "nested-healpix", coverageRole: "object_presence", requiredFields: ["coverage.healpixColumn", "coverage.healpixOrder"] },
  { mode: "fits-wcs", coverageRole: "image_extent", requiredFields: [] },
];

const SUBMISSION_FIELDS = new Set(["connectorId", "assetId", "releaseId", "product", "path", "fileNamePattern", "allowedSuffixes", "coverage"]);
const SPEC_FIELDS = new Set(["mode", "coordinateFrame", "coordinateUnits", "raColumn", "decColumn", "healpixColumn", "healpixOrder", "coverageRole", "dataOrigin", "sourceTier", "maxOrder", "queryOrder", "previewOrder", "fileNamePattern", "centerRaAliases", "centerDecAliases", "centerUnits", "centerFrame"]);
const SNAPSHOT_FIELDS = new Set(["surveyId", "releaseId", "product", ...SPEC_FIELDS]);
const STABLE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,178}[a-z0-9])?$/;
const COLUMN_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,511}$/;
const SUFFIX = /^(?:\*|\.[A-Za-z0-9][A-Za-z0-9._-]{0,63})$/;
const FILE_NAME_PATTERN_MAX = 512;

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
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) throw new RangeError("allowedSuffixes must contain between 1 and 32 suffixes");
  const result = value.map((entry, index) => {
    if (typeof entry !== "string") throw new RangeError(`allowedSuffixes[${index}] must be a string`);
    const suffix = entry.trim().toLowerCase();
    if (!SUFFIX.test(suffix)) throw new RangeError(`allowedSuffixes[${index}] is invalid`);
    return suffix;
  });
  if (new Set(result).size !== result.length) throw new RangeError("allowedSuffixes must not contain duplicates");
  return result;
}

function fileNamePattern(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new RangeError("fileNamePattern must be a string");
  const pattern = value.trim();
  if (!pattern || pattern.length > FILE_NAME_PATTERN_MAX) throw new RangeError("fileNamePattern must contain between 1 and 512 characters");
  if (/[\0/]/.test(pattern) || /[\n\r]/.test(pattern)) throw new RangeError("fileNamePattern must match a safe basename");
  try {
    const compiled = new RegExp(pattern);
    if (compiled.test("a/b") || compiled.test("a\\b")) throw new Error();
  } catch { throw new RangeError("fileNamePattern must be a safe basename regular expression"); }
  return pattern;
}

function aliases(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 32) throw new RangeError(`${label} must contain at most 32 aliases`);
  const result = value.map((entry, index) => {
    const alias = text(entry, `${label}[${index}]`, 8).toUpperCase();
    if (!/^[A-Z0-9_-]+$/.test(alias)) throw new RangeError(`${label} contains an invalid FITS keyword`);
    return alias;
  });
  if (new Set(result).size !== result.length) throw new RangeError(`${label} must not contain duplicates`);
  return result;
}

function normalizedOrder(value: unknown, required: boolean): number | undefined {
  if (value === undefined && !required) return undefined;
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 29) throw new RangeError("coverage.healpixOrder must be an integer between 0 and 29");
  return value as number;
}

function normalizedRole(value: unknown, fallback: CoverageRole): CoverageRole {
  const role = value === undefined ? fallback : value;
  if (!(COVERAGE_ROLES as readonly unknown[]).includes(role)) throw new RangeError("coverage.coverageRole is unsupported");
  return role as CoverageRole;
}

function normalizedOrigin(value: unknown): CoverageDataOrigin {
  const origin = value === undefined ? "observed" : value;
  if (!(DATA_ORIGINS as readonly unknown[]).includes(origin)) throw new RangeError("coverage.dataOrigin is unsupported");
  return origin as CoverageDataOrigin;
}

function normalizedTier(value: unknown): CoverageSourceTier {
  const tier = value === undefined ? "user_file_derived" : value;
  if (!(SOURCE_TIERS as readonly unknown[]).includes(tier)) throw new RangeError("coverage.sourceTier is unsupported");
  return tier as CoverageSourceTier;
}

function normalizedAuthorityOrder(value: unknown, origin: CoverageDataOrigin, tier: CoverageSourceTier, role: CoverageRole): number {
  const maxOrder = value === undefined ? 10 : value;
  if (!Number.isInteger(maxOrder) || (maxOrder as number) < 0 || (maxOrder as number) > 29) throw new RangeError("coverage.maxOrder must be an integer between 0 and 29");
  if (maxOrder !== 10 && !(maxOrder === 8 && origin === "simulated" && tier === "user_file_derived" && role === "image_extent")) throw new RangeError("coverage.maxOrder must be 10 for ordinary data");
  return maxOrder as number;
}

function normalizeSpec(value: unknown): CoverageJobSpec {
  const raw = objectValue(value, "coverage");
  rejectUnknown(raw, SPEC_FIELDS, "coverage");
  if (!(COVERAGE_JOB_MODES as readonly string[]).includes(raw.mode as string)) throw new RangeError("coverage.mode is not supported");
  const mode = raw.mode as CoverageJobMode;
  const coordinateFrame = raw.coordinateFrame ?? "ICRS";
  if (coordinateFrame !== "ICRS") throw new RangeError("coverage.coordinateFrame must be ICRS");
  const coordinateUnits = raw.coordinateUnits === undefined ? undefined : raw.coordinateUnits as CoverageCoordinateUnits;
  if (coordinateUnits !== undefined && !["deg", "rad", "hourangle"].includes(coordinateUnits)) throw new RangeError("coverage.coordinateUnits must be deg, rad, or hourangle");
  const role = normalizedRole(raw.coverageRole, mode === "fits-wcs" ? "image_extent" : "object_presence");
  const dataOrigin = normalizedOrigin(raw.dataOrigin);
  const sourceTier = normalizedTier(raw.sourceTier);
  const maxOrder = normalizedAuthorityOrder(raw.maxOrder, dataOrigin, sourceTier, role);
  if (raw.queryOrder !== undefined && raw.queryOrder !== 8) throw new RangeError("coverage.queryOrder is fixed at 8");
  if (raw.previewOrder !== undefined && raw.previewOrder !== 4) throw new RangeError("coverage.previewOrder is fixed at 4");
  const pattern = fileNamePattern(raw.fileNamePattern);
  const centerRaAliases = aliases(raw.centerRaAliases, "coverage.centerRaAliases");
  const centerDecAliases = aliases(raw.centerDecAliases, "coverage.centerDecAliases");
  const centerUnits = raw.centerUnits === undefined ? undefined : raw.centerUnits as CoverageCoordinateUnits;
  const centerFrame = raw.centerFrame === undefined ? undefined : raw.centerFrame as "ICRS";
  if (centerUnits !== undefined && !["deg", "rad", "hourangle"].includes(centerUnits)) throw new RangeError("coverage.centerUnits must be deg, rad, or hourangle");
  if (centerFrame !== undefined && centerFrame !== "ICRS") throw new RangeError("coverage.centerFrame must be ICRS");
  const common = { coverageRole: role, dataOrigin, sourceTier, maxOrder, queryOrder: 8 as const, previewOrder: 4 as const, ...(pattern === undefined ? {} : { fileNamePattern: pattern }), ...(centerRaAliases === undefined ? {} : { centerRaAliases }), ...(centerDecAliases === undefined ? {} : { centerDecAliases }), ...(centerUnits === undefined ? {} : { centerUnits }), ...(centerFrame === undefined ? {} : { centerFrame }) };
  if (mode === "catalog-radec") {
    if (role !== "object_presence" && role !== "footprint_extent") throw new RangeError("catalog-radec coverage must use object_presence or footprint_extent");
    const inputOrder = normalizedOrder(raw.healpixOrder, false);
    return { mode, coordinateFrame, coordinateUnits: coordinateUnits ?? "deg", raColumn: column(raw.raColumn, "coverage.raColumn", true), decColumn: column(raw.decColumn, "coverage.decColumn", true), ...(inputOrder === undefined ? {} : { healpixOrder: inputOrder }), ...common };
  }
  if (mode === "nested-healpix") {
    if (role !== "object_presence" && role !== "footprint_extent") throw new RangeError("nested-healpix coverage must use object_presence or footprint_extent");
    return { mode, coordinateFrame, healpixColumn: column(raw.healpixColumn, "coverage.healpixColumn", true), healpixOrder: normalizedOrder(raw.healpixOrder, true), ...common };
  }
  if (role !== "image_extent" && role !== "footprint_extent") throw new RangeError("fits-wcs coverage must use image_extent or footprint_extent");
  if (raw.raColumn !== undefined || raw.decColumn !== undefined || raw.healpixColumn !== undefined || raw.healpixOrder !== undefined || coordinateUnits !== undefined) throw new RangeError("fits-wcs coverage does not accept catalog coordinate fields");
  return { mode, coordinateFrame, ...common };
}

export function validateCoverageJobSubmission(value: unknown): CoverageJobSubmission {
  const raw = objectValue(value, "coverage job");
  rejectUnknown(raw, SUBMISSION_FIELDS, "coverage job");
  const path = optionalText(raw.path, "path", 4096);
  const pattern = fileNamePattern(raw.fileNamePattern);
  const allowedSuffixes = suffixes(raw.allowedSuffixes);
  if (path?.includes("\0")) throw new RangeError("path must not contain a NUL byte");
  const normalizedCoverage = normalizeSpec(raw.coverage);
  if (pattern !== undefined && normalizedCoverage.fileNamePattern !== undefined && normalizedCoverage.fileNamePattern !== pattern) throw new RangeError("fileNamePattern must be consistent between submission and coverage");
  return { connectorId: stableId(raw.connectorId, "connectorId"), assetId: stableId(raw.assetId, "assetId"), releaseId: stableId(raw.releaseId, "releaseId"), product: text(raw.product, "product", 160), ...(path === undefined ? {} : { path }), ...(pattern === undefined ? {} : { fileNamePattern: pattern }), ...(allowedSuffixes === undefined ? {} : { allowedSuffixes }), coverage: { ...normalizedCoverage, ...(pattern === undefined || normalizedCoverage.fileNamePattern !== undefined ? {} : { fileNamePattern: pattern }) } };
}

export function coverageJobSnapshot(surveyId: string, submission: CoverageJobSubmission): CoverageJobSnapshot {
  return { surveyId: stableId(surveyId, "surveyId"), releaseId: submission.releaseId, product: submission.product, ...submission.coverage };
}

export function validateCoverageJobSnapshot(value: unknown): CoverageJobSnapshot {
  const raw = objectValue(value, "coverage job snapshot");
  rejectUnknown(raw, SNAPSHOT_FIELDS, "coverage job snapshot");
  const { surveyId, releaseId, product, ...specInput } = raw;
  const spec = normalizeSpec(specInput);
  return { surveyId: stableId(surveyId, "coverage.surveyId"), releaseId: stableId(releaseId, "coverage.releaseId"), product: text(product, "coverage.product", 160), ...spec };
}

/** Stable JSON properties consumed by the scanner Core adapter. */
export function scannerCoverageProperties(coverage: CoverageJobSpec): Record<string, string> {
  const pattern = coverage.fileNamePattern ? { fileNamePattern: coverage.fileNamePattern } : {};
  const aliases = { ...(coverage.centerRaAliases === undefined ? {} : { centerRaAliases: coverage.centerRaAliases.join(",") }), ...(coverage.centerDecAliases === undefined ? {} : { centerDecAliases: coverage.centerDecAliases.join(",") }), ...(coverage.centerUnits === undefined ? {} : { centerUnits: coverage.centerUnits }), ...(coverage.centerFrame === undefined ? {} : { centerFrame: coverage.centerFrame }) };
  const base = { coverageRole: coverage.coverageRole, dataOrigin: coverage.dataOrigin, sourceTier: coverage.sourceTier, maxOrder: String(coverage.maxOrder), queryOrder: String(coverage.queryOrder), previewOrder: String(coverage.previewOrder), ...pattern, ...aliases };
  if (coverage.mode === "catalog-radec") return Object.fromEntries(Object.entries({ spatialMode: "catalog", raColumn: coverage.raColumn!, decColumn: coverage.decColumn!, coordinateFrame: coverage.coordinateFrame, coordinateUnits: coverage.coordinateUnits ?? "deg", ...(coverage.healpixOrder === undefined ? {} : { inputHealpixOrder: String(coverage.healpixOrder) }), ...base }).filter(([, value]) => value !== undefined)) as Record<string, string>;
  if (coverage.mode === "nested-healpix") return Object.fromEntries(Object.entries({ spatialMode: "healpix", healpixColumn: coverage.healpixColumn!, coordinateFrame: coverage.coordinateFrame, inputHealpixOrder: String(coverage.healpixOrder!), ...base }).filter(([, value]) => value !== undefined)) as Record<string, string>;
  return Object.fromEntries(Object.entries({ spatialMode: "auto", coordinateFrame: coverage.coordinateFrame, ...base }).filter(([, value]) => value !== undefined)) as Record<string, string>;
}
