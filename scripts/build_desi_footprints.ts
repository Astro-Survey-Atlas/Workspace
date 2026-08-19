import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { Healpix, Pointing } from "healpixjs";

import {
  SURVEY_FOOTPRINT_SCHEMA_VERSION,
  normalizeSurveyFootprintManifest,
  type SurveyFootprint,
  type SurveyFootprintManifest,
} from "../src/survey-footprints.js";

const NSIDE = 16;
const INCLUSIVE_FACT = 8;
const TILE_RADIUS_DEG = 1.6280324520485583;
const FOCAL_PLANE_RADIUS_MM = 413.4839307227412;
const DESIMODEL_VERSION = "0.20.0";
const RAW_GEOMETRY_ROOT = path.resolve("artifacts/public-survey-footprints/raw/geometry");
const RAW_GEOMETRY_INDEX = path.join(RAW_GEOMETRY_ROOT, "index.json");

interface DesiSourceDefinition {
  key: "edr" | "dr1";
  surveyId: "desi";
  releaseId: "desi-edr" | "desi-dr1";
  product: string;
  label: string;
  sourceUrl: string;
  fileName: string;
}

const SOURCES: readonly DesiSourceDefinition[] = [
  {
    key: "edr",
    surveyId: "desi",
    releaseId: "desi-edr",
    product: "Early Data Release spectra",
    label: "DESI EDR observed spectroscopic tiles",
    sourceUrl: "https://data.desi.lbl.gov/public/edr/spectro/redux/fuji/tiles-fuji.fits",
    fileName: "desi-edr-tiles-fuji.fits",
  },
  {
    key: "dr1",
    surveyId: "desi",
    releaseId: "desi-dr1",
    product: "DR1 spectra and redshifts",
    label: "DESI DR1 observed spectroscopic tiles",
    sourceUrl: "https://data.desi.lbl.gov/public/dr1/spectro/redux/iron/tiles-iron.fits",
    fileName: "desi-dr1-tiles-iron.fits",
  },
] as const;

interface TileCenter {
  raDeg: number;
  decDeg: number;
  nexp: number;
}

interface FitsHeader {
  values: Map<string, string | number | boolean>;
  dataOffset: number;
}

interface GeometryArtifact extends Record<string, unknown> {
  surveyId: string;
  releaseId: string;
  product: string;
  sourceUrl: string;
  filePath: string;
  retrievedAt: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
  rowCount: number;
  selectedRowCount: number;
  filter: string;
  coordinateColumns: string[];
  tileRadiusDeg: number;
  focalPlaneRadiusMm: number;
  desimodelVersion: string;
  radiusSourceUrl: string;
  parser: string;
}

function parseFitsValue(card: string): string | number | boolean | undefined {
  if (card[8] !== "=") return undefined;
  const raw = card.slice(10);
  let quoted = false;
  let end = raw.length;
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] === "'") {
      if (quoted && raw[index + 1] === "'") index += 1;
      else quoted = !quoted;
    } else if (raw[index] === "/" && !quoted) {
      end = index;
      break;
    }
  }
  const value = raw.slice(0, end).trim();
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'").trim();
  if (value === "T") return true;
  if (value === "F") return false;
  const number = Number(value.replace(/[dD]/, "E"));
  return Number.isFinite(number) ? number : value;
}

function readFitsHeader(bytes: Buffer, offset: number): FitsHeader {
  const values = new Map<string, string | number | boolean>();
  for (let cardOffset = offset; cardOffset + 80 <= bytes.length; cardOffset += 80) {
    const card = bytes.toString("ascii", cardOffset, cardOffset + 80);
    const keyword = card.slice(0, 8).trim();
    if (keyword === "END") {
      const headerLength = cardOffset + 80 - offset;
      return { values, dataOffset: offset + Math.ceil(headerLength / 2880) * 2880 };
    }
    const value = parseFitsValue(card);
    if (keyword && value !== undefined) values.set(keyword, value);
  }
  throw new Error("FITS header does not contain END");
}

function headerNumber(header: FitsHeader, keyword: string): number {
  const value = header.values.get(keyword);
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`FITS header is missing numeric ${keyword}`);
  return value;
}

function hduDataLength(header: FitsHeader): number {
  const naxis = headerNumber(header, "NAXIS");
  const pcount = Number(header.values.get("PCOUNT") ?? 0);
  const gcount = Number(header.values.get("GCOUNT") ?? 1);
  if (header.values.get("XTENSION") === "BINTABLE") return headerNumber(header, "NAXIS1") * headerNumber(header, "NAXIS2") + pcount;
  if (naxis === 0) return 0;
  let elements = 1;
  for (let axis = 1; axis <= naxis; axis += 1) elements *= headerNumber(header, `NAXIS${axis}`);
  return Math.abs(headerNumber(header, "BITPIX")) / 8 * elements * gcount + pcount;
}

function fitsColumnWidth(format: string): number {
  const match = /^(\d*)([LXBIJKAEDCMQP])/.exec(format.trim());
  if (!match) throw new Error(`Unsupported FITS TFORM: ${format}`);
  const repeat = Number(match[1] || 1);
  const widths: Record<string, number> = { L: 1, X: 1 / 8, B: 1, I: 2, J: 4, K: 8, A: 1, E: 4, D: 8, C: 8, M: 16, P: 8, Q: 16 };
  return match[2] === "X" ? Math.ceil(repeat / 8) : repeat * widths[match[2]!]!;
}

/** Reads only the official tile-center and observation-count columns from a DESI TILE_COMPLETENESS BINTABLE. */
export function parseDesiObservedTiles(bytes: Buffer): { rowCount: number; tiles: TileCenter[] } {
  let offset = 0;
  while (offset < bytes.length) {
    const header = readFitsHeader(bytes, offset);
    const dataLength = hduDataLength(header);
    if (header.values.get("XTENSION") === "BINTABLE" && header.values.get("EXTNAME") === "TILE_COMPLETENESS") {
      const rowLength = headerNumber(header, "NAXIS1");
      const rowCount = headerNumber(header, "NAXIS2");
      const fields = headerNumber(header, "TFIELDS");
      const columns = new Map<string, { offset: number; format: string }>();
      let columnOffset = 0;
      for (let index = 1; index <= fields; index += 1) {
        const name = String(header.values.get(`TTYPE${index}`) ?? "").trim();
        const format = String(header.values.get(`TFORM${index}`) ?? "").trim();
        if (!name || !format) throw new Error(`FITS table has an invalid column ${index}`);
        columns.set(name, { offset: columnOffset, format });
        columnOffset += fitsColumnWidth(format);
      }
      if (columnOffset !== rowLength) throw new Error(`FITS row width mismatch: header ${rowLength}, columns ${columnOffset}`);
      const ra = columns.get("TILERA");
      const dec = columns.get("TILEDEC");
      const nexp = columns.get("NEXP");
      if (!ra || !dec || !nexp || !ra.format.endsWith("D") || !dec.format.endsWith("D") || !nexp.format.endsWith("K")) {
        throw new Error("DESI tile table does not contain the expected TILERA/TILEDEC/NEXP columns");
      }
      const tiles: TileCenter[] = [];
      for (let row = 0; row < rowCount; row += 1) {
        const rowOffset = header.dataOffset + row * rowLength;
        const count = Number(bytes.readBigInt64BE(rowOffset + nexp.offset));
        if (count <= 0) continue;
        const raDeg = bytes.readDoubleBE(rowOffset + ra.offset);
        const decDeg = bytes.readDoubleBE(rowOffset + dec.offset);
        if (!Number.isFinite(raDeg) || raDeg < 0 || raDeg >= 360 || !Number.isFinite(decDeg) || decDeg < -90 || decDeg > 90) {
          throw new Error(`DESI tile table contains an invalid center at row ${row}`);
        }
        tiles.push({ raDeg, decDeg, nexp: count });
      }
      if (!tiles.length) throw new Error("DESI tile table has no rows matching NEXP > 0");
      return { rowCount, tiles };
    }
    offset = header.dataOffset + Math.ceil(dataLength / 2880) * 2880;
  }
  throw new Error("FITS file does not contain the TILE_COMPLETENESS extension");
}

function rangeSetPixels(ranges: { r: Int32Array; sz: number }): number[] {
  const pixels: number[] = [];
  for (let index = 0; index < ranges.sz; index += 2) {
    for (let pixel = ranges.r[index]!; pixel < ranges.r[index + 1]!; pixel += 1) pixels.push(pixel);
  }
  return pixels;
}

export function rasterizeObservedTiles(tiles: readonly TileCenter[]): number[] {
  const healpix = new Healpix(NSIDE);
  const pixels = new Set<number>();
  const radians = Math.PI / 180;
  for (const tile of tiles) {
    const center = new Pointing(null, false, (90 - tile.decDeg) * radians, tile.raDeg * radians);
    for (const pixel of rangeSetPixels(healpix.queryDiscInclusive(center, TILE_RADIUS_DEG * radians, INCLUSIVE_FACT))) pixels.add(pixel);
  }
  return [...pixels].sort((left, right) => left - right);
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a file path`);
  return path.resolve(value);
}

async function sourceBytes(definition: DesiSourceDefinition): Promise<{ bytes: Buffer; mediaType: string }> {
  const localPath = option(`--${definition.key}`);
  if (localPath) return { bytes: await readFile(localPath), mediaType: "application/fits" };
  const response = await fetch(definition.sourceUrl, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`DESI tile table request failed for ${definition.releaseId}: ${response.status}`);
  return { bytes: Buffer.from(await response.arrayBuffer()), mediaType: response.headers.get("content-type") ?? "application/fits" };
}

async function main(): Promise<void> {
  const manifestPath = path.resolve(option("--manifest") ?? "src/footprints/survey-footprints.json");
  const retrievedAt = new Date().toISOString();
  const manifest = normalizeSurveyFootprintManifest(JSON.parse(await readFile(manifestPath, "utf8")) as SurveyFootprintManifest);
  const geometryIndex = JSON.parse(await readFile(RAW_GEOMETRY_INDEX, "utf8")) as { schemaVersion: number; generatedAt: string; coordinateFrame: "ICRS"; artifacts: Array<Record<string, unknown>> };
  const footprints: SurveyFootprint[] = [];
  const artifacts: GeometryArtifact[] = [];
  await mkdir(RAW_GEOMETRY_ROOT, { recursive: true });

  for (const definition of SOURCES) {
    const source = await sourceBytes(definition);
    const parsed = parseDesiObservedTiles(source.bytes);
    const pixels = rasterizeObservedTiles(parsed.tiles);
    await writeFile(path.join(RAW_GEOMETRY_ROOT, definition.fileName), source.bytes);
    footprints.push({
      surveyId: definition.surveyId,
      releaseId: definition.releaseId,
      product: definition.product,
      label: definition.label,
      nside: NSIDE,
      pixels,
      quality: "moc",
      sourceUrl: definition.sourceUrl,
      sourceId: definition.fileName,
      retrievedAt,
      notes: `Official DESI TILE_COMPLETENESS rows with NEXP > 0 (${parsed.tiles.length}/${parsed.rowCount} rows), represented by ${TILE_RADIUS_DEG.toFixed(12)} deg circular DESI focal-plane envelopes and rasterized inclusively to NESTED NSIDE ${NSIDE} with fact ${INCLUSIVE_FACT}. This is observed tile coverage, not fiber-level completeness.`,
    });
    artifacts.push({
      surveyId: definition.surveyId,
      releaseId: definition.releaseId,
      product: definition.product,
      sourceUrl: definition.sourceUrl,
      filePath: definition.fileName,
      retrievedAt,
      mediaType: source.mediaType,
      byteLength: source.bytes.byteLength,
      sha256: createHash("sha256").update(source.bytes).digest("hex"),
      rowCount: parsed.rowCount,
      selectedRowCount: parsed.tiles.length,
      filter: "NEXP > 0",
      coordinateColumns: ["TILERA", "TILEDEC"],
      tileRadiusDeg: TILE_RADIUS_DEG,
      focalPlaneRadiusMm: FOCAL_PLANE_RADIUS_MM,
      desimodelVersion: DESIMODEL_VERSION,
      radiusSourceUrl: `https://github.com/desihub/desimodel/tree/${DESIMODEL_VERSION}`,
      parser: `FITS TILE_COMPLETENESS BINTABLE; Healpix.queryDiscInclusive at NSIDE ${NSIDE} with fact ${INCLUSIVE_FACT}`,
    });
  }

  const identities = new Set(footprints.map((footprint) => `${footprint.surveyId}:${footprint.releaseId}:${footprint.product}`));
  const output: SurveyFootprintManifest = {
    ...manifest,
    schemaVersion: SURVEY_FOOTPRINT_SCHEMA_VERSION,
    generatedAt: retrievedAt,
    footprints: [...manifest.footprints.filter((footprint) => !identities.has(`${footprint.surveyId}:${footprint.releaseId}:${footprint.product}`)), ...footprints],
  };
  geometryIndex.generatedAt = retrievedAt;
  geometryIndex.artifacts = [
    ...geometryIndex.artifacts.filter((artifact) => !identities.has(`${artifact.surveyId}:${artifact.releaseId}:${artifact.product}`)),
    ...artifacts,
  ];
  await Promise.all([
    writeFile(manifestPath, `${JSON.stringify(output, null, 2)}\n`, "utf8"),
    writeFile(RAW_GEOMETRY_INDEX, `${JSON.stringify(geometryIndex, null, 2)}\n`, "utf8"),
  ]);
  console.log(footprints.map((footprint) => `${footprint.releaseId}: ${footprint.pixels.length} NSIDE ${NSIDE} cells`).join("\n"));
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
