import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { Healpix, Pointing } from "healpixjs";
import yauzl from "yauzl";

import {
  SURVEY_FOOTPRINT_SCHEMA_VERSION,
  type FootprintGeometryQuality,
  type SurveyFootprint,
  type SurveyFootprintManifest,
} from "../src/survey-footprints.js";

export const FOOTPRINT_NSIDE = 16;
const TARGET_ORDER = Math.log2(FOOTPRINT_NSIDE);
const MOC_SERVER_URL = "https://alasky.cds.unistra.fr/MocServer/query";

export interface MocJson {
  [order: string]: number[];
}

interface MocFootprintDefinition {
  surveyId: string;
  releaseId: string;
  product: string;
  label: string;
  sourceId: string;
  sourceUrl: string;
  notes: string;
  rawSourceIds?: readonly string[];
}

const MOC_FOOTPRINTS: readonly MocFootprintDefinition[] = [
  {
    surveyId: "galex",
    releaseId: "galex-gr6-gr7",
    product: "ultraviolet image coverage",
    label: "GALEX GR6/GR7 ultraviolet coverage",
    sourceId: "CDS/P/GALEXGR6_7/color",
    sourceUrl: "https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FGALEXGR6_7%2Fcolor&get=smoc&order=4&fmt=json",
    notes: "CDS HiPS MOC for the GR6/GR7 color image product, rasterized to NSIDE 16 for the bundled display catalog. Coverage depth and band availability vary by pointing.",
  },
  {
    surveyId: "galex",
    releaseId: "galex-gr6-gr7",
    product: "FUV imaging",
    label: "GALEX GR6/GR7 FUV imaging coverage",
    sourceId: "CDS/P/GALEXGR6_7/FUV",
    sourceUrl: "https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FGALEXGR6_7%2FFUV&get=smoc&order=4&fmt=json",
    notes: "CDS HiPS MOC for the GALEX GR6/GR7 far-ultraviolet image product, rasterized to NSIDE 16. It does not describe grism spectroscopy or time-domain completeness.",
  },
  {
    surveyId: "galex",
    releaseId: "galex-gr6-gr7",
    product: "NUV imaging",
    label: "GALEX GR6/GR7 NUV imaging coverage",
    sourceId: "CDS/P/GALEXGR6_7/NUV",
    sourceUrl: "https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FGALEXGR6_7%2FNUV&get=smoc&order=4&fmt=json",
    notes: "CDS HiPS MOC for the GALEX GR6/GR7 near-ultraviolet image product, rasterized to NSIDE 16. It does not describe grism spectroscopy or time-domain completeness.",
  },
  {
    surveyId: "legacy-surveys",
    releaseId: "legacy-dr10",
    product: "DR10 color imaging",
    label: "Legacy Surveys DR10 imaging coverage",
    sourceId: "CDS/P/DESI-Legacy-Surveys/DR10/color",
    sourceUrl: "https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FDESI-Legacy-Surveys%2FDR10%2Fcolor&get=smoc&order=4&fmt=json",
    notes: "CDS HiPS MOC for Legacy Surveys DR10 color imaging, rasterized to NSIDE 16. This is imaging coverage, not DESI spectroscopy.",
  },
  {
    surveyId: "sdss",
    releaseId: "sdss-dr09",
    product: "DR9 color imaging",
    label: "SDSS DR9 imaging reference coverage",
    sourceId: "CDS/P/SDSS9/color",
    sourceUrl: "https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FSDSS9%2Fcolor&get=smoc&order=4&fmt=json",
    notes: "CDS MOC for SDSS DR9 imaging. Later SDSS releases and non-imaging products require their own product footprints.",
  },
  {
    surveyId: "hsc-ssp",
    releaseId: "hsc-pdr2",
    product: "PDR2 Wide + Deep image coverage",
    label: "HSC-SSP PDR2 Wide + Deep coverage",
    sourceId: "CDS/P/HSC/DR2/wide/color-i-r-g,CDS/P/HSC/DR2/deep/color-i-r-g",
    sourceUrl: "https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FHSC%2FDR2%2Fwide%2Fcolor-i-r-g%2CCDS%2FP%2FHSC%2FDR2%2Fdeep%2Fcolor-i-r-g&get=smoc&order=4&fmt=json",
    notes: "Union of CDS PDR2 Wide and Deep image MOCs, rasterized to NSIDE 16. PDR3 is registered separately and remains pending an artifact.",
    rawSourceIds: ["CDS/P/HSC/DR2/wide/color-i-r-g", "CDS/P/HSC/DR2/deep/color-i-r-g"],
  },
  ...(["g", "r", "i", "z", "y"] as const).map((band) => ({
    surveyId: "hsc-ssp",
    releaseId: "hsc-pdr2",
    product: `PDR2 ${band}-band imaging`,
    label: `HSC-SSP PDR2 ${band}-band Wide + Deep coverage`,
    sourceId: `CDS/P/HSC/DR2/wide/${band},CDS/P/HSC/DR2/deep/${band}`,
    sourceUrl: `https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FHSC%2FDR2%2Fwide%2F${band}%2CCDS%2FP%2FHSC%2FDR2%2Fdeep%2F${band}&get=smoc&order=4&fmt=json`,
    notes: `Union of CDS HSC-SSP PDR2 Wide and Deep ${band}-band image MOCs, rasterized to NSIDE 16. This is an image-availability footprint, not a catalog selection mask.`,
    rawSourceIds: [`CDS/P/HSC/DR2/wide/${band}`, `CDS/P/HSC/DR2/deep/${band}`],
  })),
  {
    surveyId: "hst",
    releaseId: "hst-mast-snapshot-2026",
    product: "published HST HiPS pointings",
    label: "HST archive pointing coverage",
    sourceId: "*P/HST/*",
    sourceUrl: "https://alasky.cds.unistra.fr/MocServer/query?ID=*P%2FHST%2F*&get=smoc&order=4&fmt=json",
    notes: "Aggregate CDS MOC for published HST HiPS products. It is a discovery overview, not a claim that every MAST product exists at every highlighted cell.",
  },
  {
    surveyId: "panstarrs",
    releaseId: "panstarrs-dr1",
    product: "DR1 color imaging",
    label: "Pan-STARRS1 DR1 imaging coverage",
    sourceId: "CDS/P/PanSTARRS/DR1/color-i-r-g",
    sourceUrl: "https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FPanSTARRS%2FDR1%2Fcolor-i-r-g&get=smoc&order=4&fmt=json",
    notes: "CDS HiPS MOC for Pan-STARRS1 DR1 stacked color imaging. It does not represent DR2 catalogs or single-epoch warp coverage.",
  },
  ...(["g", "r", "i", "z", "y"] as const).map((band) => ({
    surveyId: "panstarrs",
    releaseId: "panstarrs-dr1",
    product: `DR1 ${band}-band imaging`,
    label: `Pan-STARRS1 DR1 ${band}-band imaging coverage`,
    sourceId: `CDS/P/PanSTARRS/DR1/${band}`,
    sourceUrl: `https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FPanSTARRS%2FDR1%2F${band}&get=smoc&order=4&fmt=json`,
    notes: `CDS HiPS MOC for Pan-STARRS1 DR1 ${band}-band imaging, rasterized to NSIDE 16. It does not represent catalog selection or single-epoch warp coverage.`,
  })),
  {
    surveyId: "des",
    releaseId: "des-dr2",
    product: "DR2 color imaging",
    label: "Dark Energy Survey DR2 imaging coverage",
    sourceId: "CDS/P/DES-DR2/ColorIRG",
    sourceUrl: "https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FDES-DR2%2FColorIRG&get=smoc&order=4&fmt=json",
    notes: "CDS HiPS MOC for the DES DR2 color imaging product. Masks, single epochs and supernova products have different validity regions.",
  },
  {
    surveyId: "2mass",
    releaseId: "2mass-all-sky",
    product: "J-band imaging",
    label: "2MASS All-Sky J-band coverage",
    sourceId: "CDS/P/2MASS/J",
    sourceUrl: "https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2F2MASS%2FJ&get=smoc&order=4&fmt=json",
    notes: "CDS/IRSA HiPS MOC for the 2MASS All-Sky J-band image product. Special mosaics and 6x observations are separate products.",
  },
  {
    surveyId: "2mass",
    releaseId: "2mass-all-sky",
    product: "H-band imaging",
    label: "2MASS All-Sky H-band coverage",
    sourceId: "CDS/P/2MASS/H",
    sourceUrl: "https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2F2MASS%2FH&get=smoc&order=4&fmt=json",
    notes: "CDS/IRSA HiPS MOC for the 2MASS All-Sky H-band image product, rasterized to NSIDE 16. Special mosaics and 6x observations are separate products.",
  },
  {
    surveyId: "2mass",
    releaseId: "2mass-all-sky",
    product: "K-band imaging",
    label: "2MASS All-Sky K-band coverage",
    sourceId: "CDS/P/2MASS/K",
    sourceUrl: "https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2F2MASS%2FK&get=smoc&order=4&fmt=json",
    notes: "CDS/IRSA HiPS MOC for the 2MASS All-Sky K-band image product, rasterized to NSIDE 16. Special mosaics and 6x observations are separate products.",
  },
  {
    surveyId: "allwise",
    releaseId: "allwise",
    product: "W1 imaging",
    label: "AllWISE W1 image coverage",
    sourceId: "CDS/P/allWISE/W1",
    sourceUrl: "https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FallWISE%2FW1&get=smoc&order=4&fmt=json",
    notes: "CDS/IRSA HiPS MOC for AllWISE W1 imaging. It is spatial coverage only and does not encode NEOWISE cadence or temporal completeness.",
  },
  ...(["W2", "W3", "W4"] as const).map((band) => ({
    surveyId: "allwise",
    releaseId: "allwise",
    product: `${band} imaging`,
    label: `AllWISE ${band} image coverage`,
    sourceId: `CDS/P/allWISE/${band}`,
    sourceUrl: `https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FallWISE%2F${band}&get=smoc&order=4&fmt=json`,
    notes: `CDS/IRSA HiPS MOC for AllWISE ${band} imaging, rasterized to NSIDE 16. It is spatial coverage only and does not encode NEOWISE cadence or temporal completeness.`,
  })),
  {
    surveyId: "kids",
    releaseId: "kids-dr5",
    product: "DR5 gri imaging",
    label: "KiDS DR5 imaging coverage",
    sourceId: "CDS/P/KiDS/DR5/color-gri",
    sourceUrl: "https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FKiDS%2FDR5%2Fcolor-gri&get=smoc&order=4&fmt=json",
    notes: "KiDS survey-endorsed CDS-hosted DR5 gri HiPS MOC. Per-band masks and weak-lensing selections have different valid regions.",
  },
  {
    surveyId: "nvss",
    releaseId: "nvss-final",
    product: "1.4 GHz radio imaging",
    label: "NVSS 1.4 GHz imaging coverage",
    sourceId: "CDS/P/NVSS",
    sourceUrl: "https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FNVSS&get=smoc&order=4&fmt=json",
    notes: "CDS HiPS MOC derived from the NVSS image grid. Stokes products and sensitivity thresholds require product-specific validity masks.",
  },
];

const EUCLID_Q1_REGIONS_URL = "https://www.euclid-ec.org/wp-content/uploads/q1_region_files.zip";
const EUCLID_Q1_REGION_FILES = ["q1_edff.reg", "q1_edfn.reg", "q1_edfs.reg"] as const;
const EUCLID_Q1_POLYGON_FACT = 8;

export function expandMocToNside(moc: MocJson, targetOrder = TARGET_ORDER): number[] {
  const pixels = new Set<number>();
  for (const [key, values] of Object.entries(moc)) {
    const order = Number(key);
    if (!Number.isInteger(order) || order < 0 || !Array.isArray(values)) throw new Error(`Invalid MOC order: ${key}`);
    const factor = 4 ** Math.abs(targetOrder - order);
    for (const sourcePixel of values) {
      if (!Number.isInteger(sourcePixel) || sourcePixel < 0) throw new Error(`Invalid MOC pixel: ${sourcePixel}`);
      if (order <= targetOrder) {
        const first = sourcePixel * factor;
        for (let pixel = first; pixel < first + factor; pixel += 1) pixels.add(pixel);
      } else {
        pixels.add(Math.floor(sourcePixel / factor));
      }
    }
  }
  return [...pixels].sort((left, right) => left - right);
}

interface EuclidQ1RegionSource {
  archive: Buffer;
  polygons: Pointing[][];
  retrievedAt: string;
  mediaType: string;
  etag?: string;
  lastModified?: string;
}

function pointingFromRaDec(raDeg: number, decDeg: number): Pointing {
  if (!Number.isFinite(raDeg) || raDeg < 0 || raDeg >= 360 || !Number.isFinite(decDeg) || decDeg < -90 || decDeg > 90) {
    throw new Error(`Invalid ICRS coordinate in Euclid Q1 region: ${raDeg}, ${decDeg}`);
  }
  const radians = Math.PI / 180;
  return new Pointing(null, false, (90 - decDeg) * radians, raDeg * radians);
}

export function parseDs9IcrsPolygons(source: string, name = "DS9 region"): Pointing[][] {
  let frameSeen = false;
  const polygons: Pointing[][] = [];
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("global")) continue;
    if (line.toLowerCase() === "icrs") {
      frameSeen = true;
      continue;
    }
    const match = /^polygon\((.*)\)$/i.exec(line);
    if (!match) throw new Error(`Unsupported ${name} statement: ${line}`);
    if (!frameSeen) throw new Error(`${name} polygon appears before an ICRS frame declaration`);
    const values = match[1]!.split(",").map((value) => Number(value.trim()));
    if (values.length < 6 || values.length % 2 !== 0 || values.some((value) => !Number.isFinite(value))) {
      throw new Error(`Invalid ${name} polygon coordinates`);
    }
    polygons.push(values.reduce<Pointing[]>((points, value, index) => index % 2 === 0
      ? [...points, pointingFromRaDec(value, values[index + 1]!)]
      : points, []));
  }
  if (!frameSeen || !polygons.length) throw new Error(`${name} has no ICRS polygons`);
  return polygons;
}

function openZipBuffer(bytes: Buffer): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => yauzl.fromBuffer(bytes, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (error, zip) => {
    if (error || !zip) reject(error ?? new Error("Unable to open Euclid Q1 region archive"));
    else resolve(zip);
  }));
}

async function readStreamBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function readEuclidQ1RegionArchive(archive: Buffer): Promise<Pointing[][]> {
  const zip = await openZipBuffer(archive);
  const expected = new Set<string>(EUCLID_Q1_REGION_FILES);
  const entries = new Map<string, string>();
  return new Promise<Pointing[][]>((resolve, reject) => {
    const fail = (error: Error) => { zip.close(); reject(error); };
    zip.on("error", fail);
    zip.on("entry", (entry) => {
      void (async () => {
        const name = entry.fileName.replaceAll("\\", "/");
        if (!expected.has(name) || entries.has(name) || entry.uncompressedSize > 1_000_000) throw new Error(`Unexpected Euclid Q1 region archive entry: ${name}`);
        const stream = await new Promise<NodeJS.ReadableStream>((entryResolve, entryReject) => zip.openReadStream(entry, (error, value) => {
          if (error || !value) entryReject(error ?? new Error(`Unable to read Euclid Q1 region archive entry: ${name}`));
          else entryResolve(value);
        }));
        entries.set(name, (await readStreamBuffer(stream)).toString("utf8"));
        zip.readEntry();
      })().catch((error: unknown) => fail(error instanceof Error ? error : new Error(String(error))));
    });
    zip.on("end", () => {
      try {
        if (entries.size !== expected.size || [...expected].some((name) => !entries.has(name))) throw new Error("Euclid Q1 region archive is missing an expected field file");
        resolve(EUCLID_Q1_REGION_FILES.flatMap((name) => parseDs9IcrsPolygons(entries.get(name)!, name)));
      } catch (error) {
        reject(error);
      }
    });
    zip.readEntry();
  });
}

function rangeSetPixels(ranges: { r: Int32Array; sz: number }): number[] {
  const pixels: number[] = [];
  for (let index = 0; index < ranges.sz; index += 2) {
    for (let pixel = ranges.r[index]!; pixel < ranges.r[index + 1]!; pixel += 1) pixels.push(pixel);
  }
  return pixels;
}

/** Rasterizes official convex ICRS boundary polygons into inclusive NESTED HEALPix cells. */
export function rasterizeIcrsPolygons(polygons: readonly Pointing[][], nside = FOOTPRINT_NSIDE, fact = EUCLID_Q1_POLYGON_FACT): number[] {
  if (!Number.isInteger(nside) || nside <= 0 || (nside & (nside - 1)) !== 0 || !Number.isInteger(fact) || fact < 1 || (fact & (fact - 1)) !== 0) {
    throw new Error("Invalid HEALPix polygon rasterization parameters");
  }
  const healpix = new Healpix(nside);
  const pixels = new Set<number>();
  for (const polygon of polygons) {
    if (polygon.length < 3) throw new Error("ICRS polygon needs at least three vertices");
    for (const pixel of rangeSetPixels(healpix.queryPolygonInclusive(polygon, fact))) pixels.add(pixel);
  }
  return [...pixels].sort((left, right) => left - right);
}

async function fetchEuclidQ1RegionSource(retrievedAt: string): Promise<EuclidQ1RegionSource> {
  const response = await fetch(EUCLID_Q1_REGIONS_URL, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Euclid Q1 region archive request failed: ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (!archive.byteLength || archive.byteLength > 8 * 1024 * 1024) throw new Error("Euclid Q1 region archive has an invalid size");
  return {
    archive,
    polygons: await readEuclidQ1RegionArchive(archive),
    retrievedAt,
    mediaType: response.headers.get("content-type") ?? "application/zip",
    ...(response.headers.get("etag") ? { etag: response.headers.get("etag")! } : {}),
    ...(response.headers.get("last-modified") ? { lastModified: response.headers.get("last-modified")! } : {}),
  };
}

async function requestMoc(sourceId: string): Promise<MocJson> {
  const parameters = new URLSearchParams({ ID: sourceId, get: "smoc", order: String(TARGET_ORDER), fmt: "json" });
  const response = await fetch(`${MOC_SERVER_URL}?${parameters}`, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`MOC request failed for ${sourceId}: ${response.status}`);
  return response.json() as Promise<MocJson>;
}

interface RawMocArtifact {
  surveyId: string;
  releaseId: string;
  product: string;
  sourceId: string;
  sourceUrl: string;
  metadataUrl: string;
  fitsPath: string;
  metadataPath: string;
  retrievedAt: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
}

function rawFileStem(definition: MocFootprintDefinition, sourceId: string): string {
  const suffix = definition.rawSourceIds && definition.rawSourceIds.length > 1
    ? `-${sourceId.includes("/wide/") ? "wide" : "deep"}`
    : "";
  return `${definition.surveyId}-${definition.releaseId}-${definition.product}${suffix}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function mapConcurrent<T, R>(values: readonly T[], concurrency: number, operation: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < values.length) {
      const index = next++;
      results[index] = await operation(values[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}

async function preserveNativeMocs(rawRoot: string, retrievedAt: string): Promise<void> {
  await mkdir(rawRoot, { recursive: true });
  const sources = MOC_FOOTPRINTS.flatMap((definition) => (definition.rawSourceIds ?? [definition.sourceId]).map((sourceId) => ({ definition, sourceId })));
  const artifacts = await mapConcurrent(sources, 4, async ({ definition, sourceId }): Promise<RawMocArtifact> => {
    const fitsParameters = new URLSearchParams({ ID: sourceId, get: "smoc", fmt: "fits" });
    const metadataParameters = new URLSearchParams({ ID: sourceId, get: "record", fmt: "json" });
    const sourceUrl = `${MOC_SERVER_URL}?${fitsParameters}`;
    const metadataUrl = `${MOC_SERVER_URL}?${metadataParameters}`;
    const [fitsResponse, metadataResponse] = await Promise.all([
      fetch(sourceUrl, { signal: AbortSignal.timeout(120_000) }),
      fetch(metadataUrl, { signal: AbortSignal.timeout(120_000) }),
    ]);
    if (!fitsResponse.ok) throw new Error(`Native MOC request failed for ${sourceId}: ${fitsResponse.status}`);
    if (!metadataResponse.ok) throw new Error(`MOC metadata request failed for ${sourceId}: ${metadataResponse.status}`);
    const fits = Buffer.from(await fitsResponse.arrayBuffer());
    const metadata = await metadataResponse.text();
    JSON.parse(metadata);
    const stem = rawFileStem(definition, sourceId);
    const fitsName = `${stem}.fits`;
    const metadataName = `${stem}.record.json`;
    await Promise.all([
      writeFile(path.join(rawRoot, fitsName), fits),
      writeFile(path.join(rawRoot, metadataName), `${JSON.stringify(JSON.parse(metadata), null, 2)}\n`, "utf8"),
    ]);
    return {
      surveyId: definition.surveyId,
      releaseId: definition.releaseId,
      product: definition.product,
      sourceId,
      sourceUrl,
      metadataUrl,
      fitsPath: fitsName,
      metadataPath: metadataName,
      retrievedAt,
      mediaType: fitsResponse.headers.get("content-type") ?? "application/fits",
      byteLength: fits.byteLength,
      sha256: createHash("sha256").update(fits).digest("hex"),
    };
  });
  await writeFile(path.join(rawRoot, "index.json"), `${JSON.stringify({
    schemaVersion: 1,
    generatedAt: retrievedAt,
    coordinateFrame: "ICRS",
    format: "FITS MOC 2.0 (native resolution)",
    artifacts,
  }, null, 2)}\n`, "utf8");
}

async function preserveEuclidQ1RegionSource(rawRoot: string, source: EuclidQ1RegionSource): Promise<void> {
  await mkdir(rawRoot, { recursive: true });
  const archiveName = "euclid-q1-region-files.zip";
  await writeFile(path.join(rawRoot, archiveName), source.archive);
  await writeFile(path.join(rawRoot, "index.json"), `${JSON.stringify({
    schemaVersion: 1,
    generatedAt: source.retrievedAt,
    coordinateFrame: "ICRS",
    artifacts: [{
      surveyId: "euclid",
      releaseId: "euclid-q1",
      product: "Euclid Q1 deep fields",
      sourceUrl: EUCLID_Q1_REGIONS_URL,
      filePath: archiveName,
      retrievedAt: source.retrievedAt,
      mediaType: source.mediaType,
      ...(source.etag ? { etag: source.etag } : {}),
      ...(source.lastModified ? { lastModified: source.lastModified } : {}),
      byteLength: source.archive.byteLength,
      sha256: createHash("sha256").update(source.archive).digest("hex"),
      polygonCount: source.polygons.length,
      parser: "DS9 ICRS polygon; Healpix.queryPolygonInclusive at NSIDE 16 with fact 8",
    }],
  }, null, 2)}\n`, "utf8");
}

function mocFootprint(definition: MocFootprintDefinition, pixels: number[], retrievedAt: string): SurveyFootprint {
  return {
    surveyId: definition.surveyId,
    releaseId: definition.releaseId,
    product: definition.product,
    label: definition.label,
    nside: FOOTPRINT_NSIDE,
    pixels,
    quality: "moc" satisfies FootprintGeometryQuality,
    sourceUrl: definition.sourceUrl,
    sourceId: definition.sourceId,
    retrievedAt,
    notes: definition.notes,
  };
}

export async function buildSurveyFootprints(euclidQ1Source?: EuclidQ1RegionSource): Promise<SurveyFootprintManifest> {
  const retrievedAt = new Date().toISOString();
  const q1 = euclidQ1Source ?? await fetchEuclidQ1RegionSource(retrievedAt);
  const footprints = await mapConcurrent(MOC_FOOTPRINTS, 4, async (definition) => mocFootprint(definition, expandMocToNside(await requestMoc(definition.sourceId)), retrievedAt));
  footprints.unshift({
    surveyId: "euclid",
    releaseId: "euclid-q1",
    product: "Euclid Q1 deep fields",
    label: "Euclid Q1 deep-field DS9 coverage",
    nside: FOOTPRINT_NSIDE,
    pixels: rasterizeIcrsPolygons(q1.polygons),
    quality: "moc",
    sourceUrl: EUCLID_Q1_REGIONS_URL,
    retrievedAt,
    notes: `Official Euclid Q1 DS9 ICRS field polygons (${q1.polygons.length} polygons) rasterized inclusively to NSIDE 16 with fact ${EUCLID_Q1_POLYGON_FACT}.`,
  });
  return {
    schemaVersion: SURVEY_FOOTPRINT_SCHEMA_VERSION,
    generatedAt: retrievedAt,
    coordinateFrame: "ICRS",
    nside: FOOTPRINT_NSIDE,
    footprints,
  };
}

async function main(): Promise<void> {
  const outputDirectory = path.resolve(process.argv[2] ?? "src/footprints");
  const retrievedAt = new Date().toISOString();
  const euclidQ1Source = await fetchEuclidQ1RegionSource(retrievedAt);
  const manifest = await buildSurveyFootprints(euclidQ1Source);
  const rawMocRoot = path.resolve("artifacts/public-survey-footprints/raw/moc");
  const rawGeometryRoot = path.resolve("artifacts/public-survey-footprints/raw/geometry");
  await Promise.all([preserveNativeMocs(rawMocRoot, manifest.generatedAt), preserveEuclidQ1RegionSource(rawGeometryRoot, euclidQ1Source)]);
  await mkdir(outputDirectory, { recursive: true });
  const outputPath = path.join(outputDirectory, "survey-footprints.json");
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${manifest.footprints.length} survey footprints (${manifest.footprints.reduce((total, footprint) => total + footprint.pixels.length, 0)} cells) to ${outputPath}; native MOCs to ${rawMocRoot}; derived geometry source to ${rawGeometryRoot}`);
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
