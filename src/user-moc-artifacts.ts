import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CoverageDataOrigin, CoverageSourceTier } from "./assets-core.js";
import type { MocCoreAdapter, MocCoreCatalogResult } from "./moc-core-adapter.js";

export const USER_MOC_STATUS = ["pending", "ready", "failed", "unavailable"] as const;
export type UserMocStatus = typeof USER_MOC_STATUS[number];
export type UserMocPrecision = "exact" | "estimated" | "entrypoint-only";

export interface UserMocFile {
  name: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
}

export interface UserMocArtifact {
  id: string;
  layerId: string;
  scanRunId: string;
  status: UserMocStatus;
  maxOrder?: number;
  availableOrders: number[];
  precision: UserMocPrecision;
  coverageRole?: string;
  sourceSnapshotSha256?: string;
  files: UserMocFile[];
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UserMocArtifactContext {
  layerId: string;
  scanRunId: string;
  /** ScanRequest evidence uses the Warehouse batch/plan id, not the local run id. */
  evidenceScanRunId?: string;
  /** Optional expected layer identity from the evidence document. */
  evidenceLayerId?: string;
  coverageRole?: string;
  dataOrigin?: CoverageDataOrigin;
  sourceTier?: CoverageSourceTier;
  sourceSnapshotSha256?: string;
  precision?: UserMocPrecision;
  availableOrders?: number[];
  maxOrder?: number;
}

export interface UserMocArtifactStoreOptions {
  root: string;
}

const FILE_MEDIA_TYPES: Record<string, string> = {
  "moc.fits": "application/fits",
  "query-order8.json": "application/json",
  "preview-order4.json": "application/json",
  "statistics.json": "application/json",
  "provenance.json": "application/json",
};

function safePart(value: string, label: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized) throw new RangeError(`${label} must contain an identifier`);
  return normalized.slice(0, 180);
}

function artifactId(layerId: string, scanRunId: string): string {
  return `${safePart(layerId, "layerId")}-${safePart(scanRunId, "scanRunId")}`.slice(0, 360);
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedSha256(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value.trim())) return undefined;
  return value.trim().toLowerCase();
}

function jsonBytes(value: unknown): Uint8Array {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

/**
 * MOC Core records the generated cells input, while the Workspace owns the
 * user-facing scan identity and the source snapshot returned by Warehouse.
 * Keep both pieces of provenance explicit in the artifact without exposing
 * the evidence payload itself through the browser API.
 */
function enrichProvenance(
  value: Uint8Array | undefined,
  fallback: unknown,
  context: UserMocArtifactContext,
  layerId: string,
  scanRunId: string,
  sourceSnapshotSha256: string | undefined,
): Uint8Array | undefined {
  const needsWorkspaceProvenance = sourceSnapshotSha256 !== undefined || context.evidenceScanRunId !== undefined;
  const bytes = value ?? (fallback === undefined
    ? (needsWorkspaceProvenance ? jsonBytes({}) : undefined)
    : jsonBytes(fallback));
  if (!bytes) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  } catch {
    // Preserve a diagnostic provenance payload verbatim. MOC and projection
    // validation remains authoritative for deciding whether the artifact is
    // renderable.
    return bytes;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return bytes;

  const evidenceScanRunId = context.evidenceScanRunId
    ? safePart(context.evidenceScanRunId, "evidenceScanRunId")
    : undefined;
  const evidenceLayerId = context.evidenceLayerId
    ? safePart(context.evidenceLayerId, "evidenceLayerId")
    : layerId;
  const existingSnapshot = objectValue((parsed as Record<string, unknown>).snapshot);
  const existingEvidence = objectValue((parsed as Record<string, unknown>).evidence);
  const enriched: Record<string, unknown> = {
    ...(parsed as Record<string, unknown>),
    layerId,
    scanRunId,
    ...(sourceSnapshotSha256 ? {
      sourceSnapshotSha256,
      snapshot: { ...existingSnapshot, sha256: sourceSnapshotSha256 },
    } : {}),
    ...(evidenceScanRunId ? {
      evidenceScanRunId,
      evidence: {
        ...existingEvidence,
        layerId: evidenceLayerId,
        scanRunId: evidenceScanRunId,
        ...(sourceSnapshotSha256 ? { sourceSnapshotSha256 } : {}),
      },
    } : {}),
  };
  return jsonBytes(enriched);
}

function cloneArtifact(value: UserMocArtifact): UserMocArtifact {
  return structuredClone(value);
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2000) || "User MOC generation failed";
}

async function atomicWrite(filePath: string, value: Uint8Array | string): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, value, { flag: "wx" });
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function normalizeOrders(values: unknown): number[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 0 && value <= 29))].sort((a, b) => a - b);
}

/** Parse an authority order without allowing NaN/Infinity into persisted metadata. */
function optionalOrder(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0 || result > 29) {
    throw new Error(`${label} must be an integer between 0 and 29`);
  }
  return result;
}

function declaredOrders(values: unknown, label: string): number[] {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array of HEALPix orders`);
  const orders = values.map((value) => Number(value));
  if (orders.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 29)) {
    throw new Error(`${label} contains an invalid HEALPix order`);
  }
  return [...new Set(orders)].sort((left, right) => left - right);
}

function normalizePixels(values: unknown, order: number): number[] {
  const maximum = Number.isInteger(order) && order >= 0 && order <= 29 ? 12 * 4 ** order : Number.MAX_SAFE_INTEGER;
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => Number(value)).filter((value) => Number.isSafeInteger(value) && value >= 0 && value < maximum))].sort((a, b) => a - b);
}

const FITS_BLOCK_BYTES = 2_880;
const FITS_CARD_BYTES = 80;

interface ValidatedMoc {
  sha256: string;
  orders: number[];
  maxOrder?: number;
}

function fitsCardValue(card: string): string | undefined {
  if (card.length < FITS_CARD_BYTES || card.slice(8, 9) !== "=") return undefined;
  const raw = card.slice(10).split("/", 1)[0]?.trim() ?? "";
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).trim();
  return raw;
}

function fitsHeader(bytes: Uint8Array, offset: number): { cards: Map<string, string>; dataOffset: number; dataBytes: number } {
  if (offset < 0 || offset % FITS_BLOCK_BYTES !== 0 || offset + FITS_BLOCK_BYTES > bytes.byteLength) {
    throw new Error("FITS MOC header is truncated");
  }
  const cards = new Map<string, string>();
  let end = false;
  let cardOffset = offset;
  while (cardOffset + FITS_CARD_BYTES <= bytes.byteLength) {
    const card = Buffer.from(bytes.subarray(cardOffset, cardOffset + FITS_CARD_BYTES)).toString("ascii");
    cardOffset += FITS_CARD_BYTES;
    const key = card.slice(0, 8).trim();
    if (key === "END") {
      end = true;
      break;
    }
    const value = fitsCardValue(card);
    if (key && value !== undefined) cards.set(key, value);
  }
  if (!end) throw new Error("FITS MOC header has no END card");
  const headerBytes = Math.ceil((cardOffset - offset) / FITS_BLOCK_BYTES) * FITS_BLOCK_BYTES;
  const dataOffset = offset + headerBytes;
  const axisCount = Number.parseInt(cards.get("NAXIS") ?? "0", 10);
  const bitpix = Number.parseInt(cards.get("BITPIX") ?? "0", 10);
  const axisBytes = Array.from({ length: Math.max(0, axisCount) }, (_, index) => Number.parseInt(cards.get(`NAXIS${index + 1}`) ?? "0", 10));
  const elements = axisCount === 0
    ? 0
    : axisBytes.every((value) => Number.isSafeInteger(value) && value >= 0)
      ? axisBytes.reduce((product, value) => product * value, 1)
    : Number.NaN;
  const pcount = Number.parseInt(cards.get("PCOUNT") ?? "0", 10);
  const gcount = Number.parseInt(cards.get("GCOUNT") ?? "1", 10);
  const bytesPerElement = Math.abs(bitpix) / 8;
  const dataBytes = cards.get("XTENSION")?.toUpperCase() === "'BINTABLE'" || cards.get("XTENSION")?.toUpperCase() === "BINTABLE"
    ? (Number.isSafeInteger(axisBytes[0]) && Number.isSafeInteger(axisBytes[1]) && axisBytes[0]! >= 0 && axisBytes[1]! >= 0
      ? axisBytes[0]! * axisBytes[1]! + Math.max(0, pcount)
      : Number.NaN)
    : Number.isFinite(elements) && Number.isFinite(bytesPerElement) && bytesPerElement >= 0 && Number.isSafeInteger(gcount) && gcount >= 0
      ? elements * bytesPerElement * gcount + Math.max(0, pcount)
      : Number.NaN;
  if (!Number.isSafeInteger(dataBytes) || dataBytes < 0 || dataOffset + dataBytes > bytes.byteLength) throw new Error("FITS MOC data is truncated");
  return { cards, dataOffset, dataBytes };
}

function uniqOrder(value: bigint): number | undefined {
  if (value < 4n) return undefined;
  for (let candidate = 0; candidate <= 29; candidate += 1) {
    const base = 4n * (4n ** BigInt(candidate));
    const next = 4n * (4n ** BigInt(candidate + 1));
    if (value >= base && value < next) {
      const ipix = value - base;
      const max = 12n * (4n ** BigInt(candidate));
      return ipix >= 0n && ipix < max ? candidate : undefined;
    }
  }
  return undefined;
}

function validateMoc(bytes: Uint8Array): ValidatedMoc {
  if (!bytes.byteLength || bytes.byteLength % FITS_BLOCK_BYTES !== 0) throw new Error("MOC FITS byte length must be a multiple of 2880");
  let offset = 0;
  let found = false;
  const orders = new Set<number>();
  let maxOrder: number | undefined;
  while (offset < bytes.byteLength) {
    const header = fitsHeader(bytes, offset);
    const extension = (header.cards.get("XTENSION") ?? "").replace(/^'|'$/g, "").toUpperCase();
    if (extension === "BINTABLE") {
      const fields = Number.parseInt(header.cards.get("TFIELDS") ?? "0", 10);
      const rowBytes = Number.parseInt(header.cards.get("NAXIS1") ?? "0", 10);
      const rowCount = Number.parseInt(header.cards.get("NAXIS2") ?? "0", 10);
      const uniqField = Array.from({ length: Math.max(0, fields) }, (_, index) => index + 1).find((index) =>
        (header.cards.get(`TTYPE${index}`) ?? "").replace(/^'|'$/g, "").trim().toUpperCase() === "UNIQ");
      if (uniqField !== undefined) {
        found = true;
        const ordering = (header.cards.get("ORDERING") ?? "").replace(/^'|'$/g, "").trim().toUpperCase();
        const coordinateSystem = (header.cards.get("COORDSYS") ?? "").replace(/^'|'$/g, "").trim().toUpperCase();
        const mocVersion = (header.cards.get("MOCVERS") ?? "").replace(/^'|'$/g, "").trim();
        const mocDimension = (header.cards.get("MOCDIM") ?? "").replace(/^'|'$/g, "").trim().toUpperCase();
        if (ordering !== "NUNIQ" || coordinateSystem !== "C" || mocVersion !== "2.0" || mocDimension !== "SPACE") {
          throw new Error("FITS MOC must declare MOCVERS=2.0, ORDERING=NUNIQ, COORDSYS=C, and MOCDIM=SPACE");
        }
        if (!Number.isSafeInteger(fields) || fields < 1 || !Number.isSafeInteger(rowBytes) || rowBytes < 8 || !Number.isSafeInteger(rowCount) || rowCount < 0) {
          throw new Error("FITS MOC binary table dimensions are invalid");
        }
        const fieldForm = (header.cards.get(`TFORM${uniqField}`) ?? "").replace(/^'|'$/g, "").trim().toUpperCase();
        if (fieldForm !== "1K" && fieldForm !== "K") throw new Error("FITS MOC UNIQ column must use an 8-byte integer format");
        const fieldOffsets: number[] = [];
        let cursor = 0;
        for (let index = 1; index <= fields; index += 1) {
          fieldOffsets[index] = cursor;
          const form = (header.cards.get(`TFORM${index}`) ?? "").replace(/^'|'$/g, "").trim().toUpperCase();
          const match = /^(\d+)([A-Z])$/.exec(form);
          if (!match) throw new Error("FITS MOC binary table column format is invalid");
          const repeat = match[1];
          const type = match[2];
          if (!repeat || !type) throw new Error("FITS MOC binary table column format is invalid");
          const elementWidth = ({ A: 1, B: 1, I: 2, J: 4, K: 8, E: 4, D: 8, L: 1, X: 1, C: 8, M: 16 } as Record<string, number>)[type];
          if (elementWidth === undefined) throw new Error("FITS MOC binary table column type is invalid");
          const width = Number(repeat) * elementWidth;
          if (!Number.isSafeInteger(width) || width < 0) throw new Error("FITS MOC binary table column width is invalid");
          cursor += width;
        }
        if (cursor > rowBytes || fieldOffsets[uniqField] === undefined) throw new Error("FITS MOC UNIQ column exceeds row width");
        const cellOffset = header.dataOffset + Number.parseInt(header.cards.get("THEAP") ?? "0", 10);
        for (let row = 0; row < rowCount; row += 1) {
          const position = cellOffset + row * rowBytes + fieldOffsets[uniqField]!;
          if (position + 8 > bytes.byteLength) throw new Error("FITS MOC UNIQ data is truncated");
          const value = new DataView(bytes.buffer, bytes.byteOffset + position, 8).getBigInt64(0, false);
          const cellOrder = uniqOrder(value);
          if (cellOrder === undefined) throw new Error("FITS MOC contains an invalid NUNIQ value");
          orders.add(cellOrder);
          maxOrder = maxOrder === undefined ? cellOrder : Math.max(maxOrder, cellOrder);
        }
      }
    }
    const paddedData = Math.ceil(header.dataBytes / FITS_BLOCK_BYTES) * FITS_BLOCK_BYTES;
    offset = header.dataOffset + paddedData;
    if (offset <= 0 || offset > bytes.byteLength) throw new Error("FITS MOC has an invalid HDU boundary");
  }
  if (!found) throw new Error("FITS MOC has no UNIQ binary table");
  return { sha256: digest(bytes), orders: [...orders].sort((a, b) => a - b), ...(maxOrder === undefined ? {} : { maxOrder }) };
}

function projectionBytes(value: Uint8Array, expectedOrder: number, label: string): { order: number; pixels: number[] } {
  let parsed: Record<string, unknown>;
  try {
    const decoded = JSON.parse(Buffer.from(value).toString("utf8")) as unknown;
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error();
    parsed = decoded as Record<string, unknown>;
  } catch {
    throw new Error(`${label} projection is not valid JSON`);
  }
  const rawOrder = Number(parsed.order);
  if (rawOrder !== expectedOrder || parsed.ordering !== "NESTED" || !Array.isArray(parsed.pixels)) {
    throw new Error(`${label} projection must be NESTED order ${expectedOrder}`);
  }
  if (parsed.pixels.some((pixel) => !Number.isSafeInteger(Number(pixel)) || Number(pixel) < 0 || Number(pixel) >= 12 * 4 ** expectedOrder)) {
    throw new Error(`${label} projection contains an invalid HEALPix pixel`);
  }
  return { order: expectedOrder, pixels: normalizePixels(parsed.pixels, expectedOrder) };
}

function lessPrecise(left: UserMocPrecision, right: UserMocPrecision): UserMocPrecision {
  const rank: Record<UserMocPrecision, number> = { exact: 0, estimated: 1, "entrypoint-only": 2 };
  return rank[left] >= rank[right] ? left : right;
}

function filesFromDirectory(directory: string, entries: UserMocFile[]): UserMocFile[] {
  return entries.map((entry) => ({ ...entry, name: path.basename(entry.name), mediaType: FILE_MEDIA_TYPES[path.basename(entry.name)] ?? entry.mediaType }));
}

export class UserMocArtifactStore {
  readonly #root: string;

  constructor(options: UserMocArtifactStoreOptions) {
    if (!options || typeof options.root !== "string" || !options.root.trim()) throw new TypeError("user MOC artifact root is required");
    this.#root = path.resolve(options.root);
  }

  get root(): string { return this.#root; }

  async createPending(context: UserMocArtifactContext): Promise<UserMocArtifact> {
    const sourceSnapshotSha256 = context.sourceSnapshotSha256 === undefined
      ? undefined
      : normalizedSha256(context.sourceSnapshotSha256);
    if (context.sourceSnapshotSha256 !== undefined && !sourceSnapshotSha256) {
      throw new RangeError("sourceSnapshotSha256 must be a hexadecimal SHA-256");
    }
    const maxOrder = optionalOrder(context.maxOrder, "maxOrder");
    const now = new Date().toISOString();
    const artifact: UserMocArtifact = {
      id: artifactId(context.layerId, context.scanRunId),
      layerId: safePart(context.layerId, "layerId"),
      scanRunId: safePart(context.scanRunId, "scanRunId"),
      status: "pending",
      ...(maxOrder === undefined ? {} : { maxOrder }),
      availableOrders: normalizeOrders(context.availableOrders),
      precision: context.precision ?? "exact",
      ...(context.coverageRole ? { coverageRole: context.coverageRole } : {}),
      ...(sourceSnapshotSha256 ? { sourceSnapshotSha256 } : {}),
      files: [],
      createdAt: now,
      updatedAt: now,
    };
    await this.#writeMetadata(artifact);
    return cloneArtifact(artifact);
  }

  async persist(result: MocCoreCatalogResult, context: UserMocArtifactContext, extra?: {
    statistics?: unknown;
    provenance?: unknown;
  }): Promise<UserMocArtifact> {
    const layerId = safePart(context.layerId, "layerId");
    const scanRunId = safePart(context.scanRunId, "scanRunId");
    const sourceSnapshotSha256 = context.sourceSnapshotSha256 === undefined
      ? undefined
      : normalizedSha256(context.sourceSnapshotSha256);
    if (context.sourceSnapshotSha256 !== undefined && !sourceSnapshotSha256) {
      throw new RangeError("sourceSnapshotSha256 must be a hexadecimal SHA-256");
    }
    const contextMaxOrder = optionalOrder(context.maxOrder, "maxOrder");
    const resultMaxOrder = optionalOrder(result.maxOrder, "MOC Core maxOrder");
    if (resultMaxOrder === undefined) throw new Error("MOC Core maxOrder is required");
    const directory = this.#directory(layerId, scanRunId);
    // A declared source order is an upper bound on what may be exposed. A
    // fixed order projection can be coarsened from a finer native source, but
    // it must never be written by refining an order-4 (or coarser) overview.
    // Keep the distinction between an omitted declaration and an explicit
    // empty declaration: the latter means that no native order is known.
    const hasDeclaredOrders = context.availableOrders !== undefined;
    const availableOrders = hasDeclaredOrders ? normalizeOrders(context.availableOrders) : [];
    const nativeMaxOrder = availableOrders.length ? Math.max(...availableOrders) : undefined;
    const canExposeQuery = !hasDeclaredOrders || (nativeMaxOrder !== undefined && nativeMaxOrder >= 8);
    const canExposePreview = !hasDeclaredOrders || (nativeMaxOrder !== undefined && nativeMaxOrder >= 4);
    const mocBytes = result.artifacts?.moc;
    const mocValidation = mocBytes ? validateMoc(mocBytes) : undefined;
    if (result.mocSha256 !== undefined) {
      if (!/^[a-f0-9]{64}$/i.test(result.mocSha256)) throw new Error("MOC Core returned an invalid SHA-256");
      if (!mocValidation) throw new Error("MOC Core reported a SHA-256 without emitting a FITS MOC");
      if (mocValidation.sha256 !== result.mocSha256.toLowerCase()) throw new Error("MOC Core MOC SHA-256 does not match emitted FITS bytes");
    }
    const queryOrder = Number(result.queryOrder);
    const previewOrder = Number(result.previewOrder);
    if (queryOrder !== 8 || previewOrder !== 4) throw new Error("MOC Core projections must be order 8 and order 4");
    const queryBytes = result.artifacts?.query ?? jsonBytes({ schemaVersion: 1, order: queryOrder, ordering: "NESTED", pixels: result.queryPixels });
    const previewBytes = result.artifacts?.preview ?? jsonBytes({ schemaVersion: 1, order: previewOrder, ordering: "NESTED", pixels: result.previewPixels });
    projectionBytes(queryBytes, 8, "query");
    projectionBytes(previewBytes, 4, "preview");
    await mkdir(directory, { recursive: true });
    const files: UserMocFile[] = [];
    const writeArtifact = async (name: string, bytes: Uint8Array | undefined): Promise<void> => {
      if (!bytes) return;
      const normalizedName = path.basename(name);
      if (!FILE_MEDIA_TYPES[normalizedName]) return;
      await atomicWrite(path.join(directory, normalizedName), bytes);
      files.push({ name: normalizedName, mediaType: FILE_MEDIA_TYPES[normalizedName]!, byteLength: bytes.byteLength, sha256: digest(bytes) });
    };

    const artifacts = result.artifacts;
    await writeArtifact("moc.fits", mocBytes);
    if (canExposeQuery) await writeArtifact("query-order8.json", queryBytes);
    else await rm(path.join(directory, "query-order8.json"), { force: true });
    if (canExposePreview) await writeArtifact("preview-order4.json", previewBytes);
    else await rm(path.join(directory, "preview-order4.json"), { force: true });
    await writeArtifact("statistics.json", artifacts?.statistics ?? (extra?.statistics === undefined ? undefined : jsonBytes(extra.statistics)));
    await writeArtifact(
      "provenance.json",
      enrichProvenance(
        artifacts?.provenance,
        extra?.provenance,
        context,
        layerId,
        scanRunId,
        sourceSnapshotSha256,
      ),
    );

    const now = new Date().toISOString();
    // The FITS MOC is hierarchically compressed. Its NUNIQ rows may contain
    // order-4 parents even when the scanner measured only order 8/10 cells.
    // Native orders therefore come from the scan/evidence declaration, never
    // from the MOC rows themselves. An absent declaration is deliberately
    // represented as an empty set instead of making a precision claim.
    const effectiveMaxOrder = contextMaxOrder ?? resultMaxOrder;
    const precision = context.precision ?? "exact";
    const effectivePrecision = effectiveMaxOrder !== undefined && effectiveMaxOrder < queryOrder
      ? lessPrecise(precision, "estimated")
      : precision;
    const artifact: UserMocArtifact = {
      id: artifactId(layerId, scanRunId), layerId, scanRunId,
      status: mocValidation ? "ready" : "unavailable",
      maxOrder: effectiveMaxOrder,
      availableOrders,
      precision: effectivePrecision,
      ...(context.coverageRole ? { coverageRole: context.coverageRole } : {}),
      ...(sourceSnapshotSha256 ? { sourceSnapshotSha256 } : {}),
      files: filesFromDirectory(directory, files),
      ...(!mocValidation ? { error: "MOC Core did not produce an IVOA FITS MOC artifact" } : {}),
      createdAt: now,
      updatedAt: now,
    };
    const existing = await this.get(artifact.layerId, artifact.scanRunId).catch(() => undefined);
    artifact.createdAt = existing?.createdAt ?? now;
    await this.#writeMetadata(artifact);
    return cloneArtifact(artifact);
  }

  async importEvidence(directoryPath: string, context: UserMocArtifactContext, mocCore?: MocCoreAdapter): Promise<UserMocArtifact> {
    const directory = path.resolve(directoryPath);
    const layerId = safePart(context.layerId, "layerId");
    const scanRunId = safePart(context.scanRunId, "scanRunId");
    const names = (await readdir(directory, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isFile()).map((entry) => entry.name);
    const readOptional = async (predicate: (name: string) => boolean): Promise<Uint8Array | undefined> => {
      const name = names.find(predicate);
      return name ? readFile(path.join(directory, name)) : undefined;
    };
    const normalizedBytes = await readOptional((name) => name === "normalized-scan.json");
    const query = await readOptional((name) => name === "query-order8.json");
    const preview = await readOptional((name) => name === "preview-order4.json");
    const statistics = await readOptional((name) => name === "statistics.json" || name === "run-statistics.json");
    const provenance = await readOptional((name) => name === "provenance.json");
    const moc = await readOptional((name) => name.endsWith(".moc.fits") || name === "moc.fits");
    let result: MocCoreCatalogResult;
    try {
      const parse = (value: Uint8Array | undefined): Record<string, unknown> => {
        if (!value) return {};
        const parsed = JSON.parse(Buffer.from(value).toString("utf8")) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("MOC evidence JSON must be an object");
        return parsed as Record<string, unknown>;
      };
      if (!normalizedBytes) throw new Error("Warehouse evidence is missing normalized-scan.json");
      const normalized = parse(normalizedBytes);
      const normalizedPhase = typeof normalized.phase === "string" ? normalized.phase.trim().toUpperCase() : undefined;
      if (normalizedPhase !== "COMPLETED") {
        throw new Error(`Warehouse evidence is not complete (phase=${normalizedPhase})`);
      }
      const expectedLayerId = safePart(context.evidenceLayerId ?? context.layerId, "layerId");
      const normalizedLayerId = typeof normalized.layerId === "string" ? safePart(normalized.layerId, "normalized layerId") : undefined;
      if (!normalizedLayerId || normalizedLayerId !== expectedLayerId) throw new Error("Warehouse evidence layer identity does not match the Workspace asset");
      const expectedScanRunId = safePart(context.evidenceScanRunId ?? context.scanRunId, "scanRunId");
      const normalizedScanRunId = typeof normalized.scanRunId === "string" ? safePart(normalized.scanRunId, "normalized scanRunId") : undefined;
      if (!normalizedScanRunId || normalizedScanRunId !== expectedScanRunId) throw new Error("Warehouse evidence scan identity does not match the Workspace run");
      const sourceSnapshot = normalized.sourceSnapshot;
      if (!sourceSnapshot || typeof sourceSnapshot !== "object" || Array.isArray(sourceSnapshot)) throw new Error("Warehouse evidence source snapshot is missing");
      const evidenceSnapshotHash = normalizedSha256((sourceSnapshot as Record<string, unknown>).sha256);
      if (!evidenceSnapshotHash) throw new Error("Warehouse evidence source snapshot SHA-256 is invalid");
      const summarySnapshotHash = normalizedSha256(context.sourceSnapshotSha256);
      if (summarySnapshotHash && summarySnapshotHash !== evidenceSnapshotHash) throw new Error("Warehouse evidence source snapshot SHA-256 does not match the ScanRequest summary");
      const sourceOrders = Object.prototype.hasOwnProperty.call(sourceSnapshot, "availableOrders")
        ? declaredOrders((sourceSnapshot as Record<string, unknown>).availableOrders, "Warehouse evidence sourceSnapshot.availableOrders")
        : undefined;
      const parseProjection = (value: Uint8Array | undefined, fallbackOrder: number, label: string): { order: number; pixels: number[] } => {
        if (!value) return { order: fallbackOrder, pixels: [] };
        const parsed = parse(value);
        const rawOrder = Number(parsed.order ?? fallbackOrder);
        if (!Number.isInteger(rawOrder) || rawOrder < 0 || rawOrder > 29 || parsed.ordering !== "NESTED" || !Array.isArray(parsed.pixels)) {
          throw new Error(`${label} projection has an invalid order, ordering, or pixel list`);
        }
        if (parsed.pixels.some((pixel) => !Number.isSafeInteger(Number(pixel)) || Number(pixel) < 0 || Number(pixel) >= 12 * 4 ** rawOrder)) {
          throw new Error(`${label} projection contains an invalid HEALPix pixel`);
        }
        return { order: rawOrder, pixels: normalizePixels(parsed.pixels, rawOrder) };
      };
      const queryProjection = parseProjection(query, 8, "query");
      const previewProjection = parseProjection(preview, 4, "preview");
      const rawCoverage = normalized.coverage;
      if (rawCoverage !== undefined && !Array.isArray(rawCoverage)) throw new Error("Warehouse normalized coverage must be an array");
      const cells = Array.isArray(rawCoverage)
        ? rawCoverage.map((entry, index) => {
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`Warehouse coverage entry ${index} is invalid`);
            const row = entry as Record<string, unknown>;
            const rowLayerId = row.layer_id ?? row.layerId;
            if (rowLayerId !== undefined && (typeof rowLayerId !== "string" || safePart(rowLayerId, "coverage layer id") !== expectedLayerId)) {
              throw new Error(`Warehouse coverage entry ${index} belongs to another layer`);
            }
            const coordinateFrame = row.coordinate_frame ?? row.coordinateFrame;
            if (coordinateFrame !== "ICRS") throw new Error(`Warehouse coverage entry ${index} must use ICRS`);
            const nesting = row.nesting ?? row.ordering;
            if (nesting !== "NESTED") throw new Error(`Warehouse coverage entry ${index} must use NESTED ordering`);
            const rawOrder = Number(row.healpix_order ?? row.order);
            const rawPixel = Number(row.healpix_cell ?? row.healpix_pixel ?? row.ipix ?? row.pixel);
            if (!Number.isSafeInteger(rawOrder) || !Number.isSafeInteger(rawPixel) || rawOrder < 0 || rawOrder > 29 || rawPixel < 0 || rawPixel >= 12 * 4 ** rawOrder) {
              throw new Error(`Warehouse coverage entry ${index} contains an invalid NESTED HEALPix cell`);
            }
            return { order: rawOrder, ipix: rawPixel };
          })
        : [];
      const cellOrders = [...new Set(cells.map((cell) => cell.order))].sort((left, right) => left - right);
      const nativeOrders = sourceOrders ?? (cellOrders.length ? cellOrders : normalizeOrders(context.availableOrders));
      if (sourceOrders && cells.some((cell) => !sourceOrders.includes(cell.order))) {
        throw new Error("Warehouse coverage orders do not match sourceSnapshot.availableOrders");
      }
      const evidencePrecision = (rawCoverage as unknown[] | undefined)?.reduce<UserMocPrecision>((currentPrecision, entry) => {
        const row = entry as Record<string, unknown>;
        const value = row.precision ?? row.coverage_precision;
        if (value === undefined) return currentPrecision;
        if (value !== "exact" && value !== "estimated" && value !== "entrypoint-only") throw new Error("Warehouse coverage precision is invalid");
        return lessPrecise(currentPrecision, value);
      }, context.precision ?? "exact") ?? (context.precision ?? "exact");
      const statisticsObject = parse(statistics);
      const statisticsMaxOrder = optionalOrder(
        statisticsObject.maxOrder ?? statisticsObject.max_order,
        "Warehouse evidence statistics.maxOrder",
      );
      let generated: MocCoreCatalogResult | undefined;
      // Warehouse normally emits only normalized coverage evidence. Generate
      // the fixed-order projections (and the FITS MOC when absent) through the
      // pinned Assets Core adapter. If a raw MOC was supplied, keep its bytes
      // authoritative while still filling missing projections.
      if ((!moc || !query || !preview) && mocCore?.buildNestedHealpix) {
        generated = await mocCore.buildNestedHealpix({
          layerId,
          cells,
          coverageRole: context.coverageRole === "image_extent" || context.coverageRole === "footprint_extent" ? context.coverageRole : "object_presence",
          dataOrigin: context.dataOrigin ?? "catalog",
          sourceTier: context.sourceTier ?? "user_file_derived",
          maxOrder: context.maxOrder ?? (nativeOrders.length ? Math.max(...nativeOrders) : 10),
          queryOrder: 8,
          previewOrder: 4,
        });
      }
      const effectiveQuery = generated?.artifacts?.query ? parseProjection(generated.artifacts.query, 8, "query") : queryProjection;
      const effectivePreview = generated?.artifacts?.preview ? parseProjection(generated.artifacts.preview, 4, "preview") : previewProjection;
      result = {
        layerId,
        maxOrder: optionalOrder(context.maxOrder, "maxOrder")
          ?? optionalOrder(generated?.maxOrder, "MOC Core maxOrder")
          ?? statisticsMaxOrder
          ?? (nativeOrders.length ? Math.max(...nativeOrders) : 10),
        queryOrder: effectiveQuery.order, previewOrder: effectivePreview.order,
        queryPixels: effectiveQuery.pixels,
        previewPixels: effectivePreview.pixels,
        artifacts: {
          ...((generated?.artifacts?.moc ?? moc) ? { moc: generated?.artifacts?.moc ?? moc } : {}),
          ...((generated?.artifacts?.query ?? query) ? { query: generated?.artifacts?.query ?? query } : {}),
          ...((generated?.artifacts?.preview ?? preview) ? { preview: generated?.artifacts?.preview ?? preview } : {}),
          ...((generated?.artifacts?.statistics ?? statistics) ? { statistics: generated?.artifacts?.statistics ?? statistics } : {}),
          ...((generated?.artifacts?.provenance ?? provenance) ? { provenance: generated?.artifacts?.provenance ?? provenance } : {}),
        },
      };
      return this.persist(result, {
        ...context,
        availableOrders: nativeOrders,
        precision: evidencePrecision,
        sourceSnapshotSha256: evidenceSnapshotHash,
      });
    } catch (error) {
      return this.fail(context, errorText(error));
    }
  }

  async fail(context: UserMocArtifactContext, error: unknown, status: "failed" | "unavailable" = "failed"): Promise<UserMocArtifact> {
    const layerId = safePart(context.layerId, "layerId");
    const scanRunId = safePart(context.scanRunId, "scanRunId");
    const sourceSnapshotSha256 = context.sourceSnapshotSha256 === undefined
      ? undefined
      : normalizedSha256(context.sourceSnapshotSha256);
    if (context.sourceSnapshotSha256 !== undefined && !sourceSnapshotSha256) {
      throw new RangeError("sourceSnapshotSha256 must be a hexadecimal SHA-256");
    }
    const maxOrder = optionalOrder(context.maxOrder, "maxOrder");
    const existing = await this.get(layerId, scanRunId).catch(() => undefined);
    const now = new Date().toISOString();
    const artifact: UserMocArtifact = {
      id: artifactId(layerId, scanRunId), layerId, scanRunId, status,
      ...(maxOrder === undefined ? {} : { maxOrder }),
      availableOrders: normalizeOrders(context.availableOrders), precision: context.precision ?? "exact",
      ...(context.coverageRole ? { coverageRole: context.coverageRole } : {}),
      ...(sourceSnapshotSha256 ? { sourceSnapshotSha256 } : {}),
      files: existing?.files ?? [], error: errorText(error), createdAt: existing?.createdAt ?? now, updatedAt: now,
    };
    await this.#writeMetadata(artifact);
    return cloneArtifact(artifact);
  }

  async get(layerId: string, scanRunId: string): Promise<UserMocArtifact> {
    const normalizedLayer = safePart(layerId, "layerId");
    const normalizedRun = safePart(scanRunId, "scanRunId");
    const value = JSON.parse(await readFile(path.join(this.#directory(normalizedLayer, normalizedRun), "metadata.json"), "utf8")) as UserMocArtifact;
    if (!value || value.layerId !== normalizedLayer || value.scanRunId !== normalizedRun || !USER_MOC_STATUS.includes(value.status)) throw new Error("User MOC artifact metadata is invalid");
    return cloneArtifact(value);
  }

  async list(): Promise<UserMocArtifact[]> {
    const result: UserMocArtifact[] = [];
    for (const layerEntry of await readdir(this.#root, { withFileTypes: true }).catch(() => [])) {
      if (!layerEntry.isDirectory()) continue;
      for (const runEntry of await readdir(path.join(this.#root, layerEntry.name), { withFileTypes: true }).catch(() => [])) {
        if (!runEntry.isDirectory()) continue;
        try { result.push(await this.get(layerEntry.name, runEntry.name)); } catch { /* ignore incomplete directories */ }
      }
    }
    return result.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async filePath(layerId: string, scanRunId: string, name: string): Promise<{ artifact: UserMocArtifact; filePath: string }> {
    const artifact = await this.get(layerId, scanRunId);
    const normalized = path.basename(name);
    const file = artifact.files.find((candidate) => candidate.name === normalized);
    if (!file || !FILE_MEDIA_TYPES[normalized]) throw new Error(`User MOC artifact file not found: ${name}`);
    const filePath = path.join(this.#directory(artifact.layerId, artifact.scanRunId), normalized);
    const details = await stat(filePath);
    if (!details.isFile()) throw new Error(`User MOC artifact file not found: ${name}`);
    await this.#readVerifiedFile(filePath, file);
    return { artifact, filePath };
  }

  async projection(layerId: string, scanRunId: string, targetOrder: number): Promise<{ order: number; pixels: number[] }> {
    if (!Number.isSafeInteger(targetOrder) || targetOrder < 0 || targetOrder > 29) throw new RangeError("targetOrder must be an integer between 0 and 29");
    const artifact = await this.get(layerId, scanRunId);
    // Only a validated FITS MOC is renderable. An unavailable artifact may
    // retain diagnostic projections, but must never masquerade as coverage.
    if (artifact.status !== "ready") return { order: targetOrder, pixels: [] };
    // A projection may coarsen native cells, but it must never refine a
    // coarse source into synthetic fine-order measurement cells. `maxOrder`
    // is the MOC authority limit; `availableOrders` records actual scan
    // orders and therefore controls this direction of projection.
    const nativeMaxOrder = artifact.availableOrders.length ? Math.max(...artifact.availableOrders) : undefined;
    if (nativeMaxOrder === undefined || nativeMaxOrder < targetOrder) return { order: targetOrder, pixels: [] };
    const candidate = targetOrder <= 4 ? "preview-order4.json" : "query-order8.json";
    const file = artifact.files.find((entry) => entry.name === candidate);
    if (!file) return { order: targetOrder, pixels: [] };
    const bytes = await this.#readVerifiedFile(path.join(this.#directory(artifact.layerId, artifact.scanRunId), candidate), file);
    const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as Record<string, unknown>;
    const sourceOrder = Number(parsed.order);
    if (!Number.isSafeInteger(sourceOrder) || sourceOrder < 0 || sourceOrder > 29 || parsed.ordering !== "NESTED") return { order: targetOrder, pixels: [] };
    const sourcePixels = normalizePixels(parsed.pixels, sourceOrder);
    if (sourceOrder < targetOrder) return { order: targetOrder, pixels: [] };
    const projected = sourceOrder === targetOrder
      ? sourcePixels
      : [...new Set(sourcePixels.map((pixel) => Math.floor(pixel / 4 ** (sourceOrder - targetOrder))))].sort((left, right) => left - right);
    return { order: targetOrder, pixels: projected };
  }

  #directory(layerId: string, scanRunId: string): string { return path.join(this.#root, layerId, scanRunId); }

  async #readVerifiedFile(filePath: string, file: UserMocFile): Promise<Uint8Array> {
    const bytes = await readFile(filePath);
    if (bytes.byteLength !== file.byteLength || digest(bytes) !== file.sha256.toLowerCase()) {
      throw new Error(`User MOC artifact file integrity check failed: ${file.name}`);
    }
    return bytes;
  }

  async #writeMetadata(artifact: UserMocArtifact): Promise<void> {
    await atomicWrite(path.join(this.#directory(artifact.layerId, artifact.scanRunId), "metadata.json"), `${JSON.stringify(artifact)}\n`);
  }
}
