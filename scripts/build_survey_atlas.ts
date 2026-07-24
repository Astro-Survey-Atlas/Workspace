import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parse } from "csv-parse";
import { Healpix, Pointing } from "healpixjs";

import {
  ATLAS_ANGULAR_MAGIC,
  ATLAS_ANGULAR_RECORD_BYTES,
  ATLAS_FORMAT_VERSION,
  ATLAS_HEADER_BYTES,
  ATLAS_JOINT_MAGIC,
  ATLAS_JOINT_RECORD_BYTES,
  atlasAngularByteLength,
  atlasJointByteLength,
  type AtlasCoverage,
  type AtlasLevelSummary,
  type AtlasSurvey,
  type JointLevelSummary,
  type SurveyAtlasManifest,
} from "../src/atlas-format.js";
import type { ContentFingerprint, ScanRun, ScanRunOutput } from "../src/provenance.js";
import { decodeVolumePoints, type VolumeManifest } from "../src/volume-format.js";

const ANGULAR_LEVELS = [8, 16, 32, 64, 128, 256, 512] as const;
const RADIAL_LEVELS = [1, 2, 4, 8, 16, 32] as const;
const FINEST_NSIDE = ANGULAR_LEVELS.at(-1)!;
const FINEST_RADIAL_BINS = RADIAL_LEVELS.at(-1)!;
const PRODUCER_VERSION = "0.5.0";

interface CoverageAccumulator {
  raMinDeg: number;
  raMaxDeg: number;
  decMinDeg: number;
  decMaxDeg: number;
  x: number;
  y: number;
  decSum: number;
  count: number;
}

interface SurveyBuildState {
  definition: Omit<AtlasSurvey, "objectCount" | "coverage" | "radialCoordinate">;
  finestCounts: Map<number, number>;
  coverage: CoverageAccumulator;
}

interface BuildSurveyAtlasOptions {
  atlasId: string;
  outputDirectory: string;
  membershipCsv: string;
  desiCsv: string;
  volumeManifest: string;
  volumePoints: string;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) digest.update(chunk as Buffer);
  return digest.digest("hex");
}

async function inputFingerprint(filePath: string, role: string, mediaType: string): Promise<ContentFingerprint> {
  const fileStat = await stat(filePath);
  const sha256 = await sha256File(filePath);
  return {
    role,
    uri: `urn:sha256:${sha256}`,
    fileName: path.basename(filePath),
    mediaType,
    byteLength: fileStat.size,
    modifiedAt: fileStat.mtime.toISOString(),
    sha256,
  };
}

async function outputFingerprint(filePath: string, role: string, artifactId: string, mediaType: string): Promise<ScanRunOutput> {
  const fileStat = await stat(filePath);
  return { role, artifactId, fileName: path.basename(filePath), mediaType, byteLength: fileStat.size, sha256: await sha256File(filePath) };
}

function emptyCoverage(): CoverageAccumulator {
  return {
    raMinDeg: Number.POSITIVE_INFINITY,
    raMaxDeg: Number.NEGATIVE_INFINITY,
    decMinDeg: Number.POSITIVE_INFINITY,
    decMaxDeg: Number.NEGATIVE_INFINITY,
    x: 0,
    y: 0,
    decSum: 0,
    count: 0,
  };
}

function updateCoverage(coverage: CoverageAccumulator, raDeg: number, decDeg: number): void {
  coverage.raMinDeg = Math.min(coverage.raMinDeg, raDeg);
  coverage.raMaxDeg = Math.max(coverage.raMaxDeg, raDeg);
  coverage.decMinDeg = Math.min(coverage.decMinDeg, decDeg);
  coverage.decMaxDeg = Math.max(coverage.decMaxDeg, decDeg);
  const ra = (raDeg * Math.PI) / 180;
  coverage.x += Math.cos(ra);
  coverage.y += Math.sin(ra);
  coverage.decSum += decDeg;
  coverage.count += 1;
}

function finishCoverage(coverage: CoverageAccumulator): AtlasCoverage {
  if (coverage.count === 0) throw new Error("Survey selected no valid coordinates");
  return {
    raMinDeg: coverage.raMinDeg,
    raMaxDeg: coverage.raMaxDeg,
    decMinDeg: coverage.decMinDeg,
    decMaxDeg: coverage.decMaxDeg,
    centerRaDeg: ((Math.atan2(coverage.y, coverage.x) * 180) / Math.PI + 360) % 360,
    centerDecDeg: coverage.decSum / coverage.count,
  };
}

function pointing(raDeg: number, decDeg: number): Pointing {
  return new Pointing(null, false, ((90 - decDeg) * Math.PI) / 180, (raDeg * Math.PI) / 180);
}

function enabled(value: unknown): boolean {
  return ["1", "true", "t", "yes"].includes(String(value ?? "").trim().toLowerCase());
}

function increment(map: Map<number, number>, key: number, count = 1): void {
  map.set(key, (map.get(key) ?? 0) + count);
}

async function streamCsv(filePath: string, onRow: (row: Record<string, string>) => void): Promise<void> {
  const parser = createReadStream(filePath).pipe(parse({ columns: true, bom: true, skip_empty_lines: true, trim: true }));
  for await (const row of parser) onRow(row as Record<string, string>);
}

function parseCoordinate(row: Record<string, string>, raColumn: string, decColumn: string): [number, number] | null {
  const raDeg = Number(row[raColumn]);
  const decDeg = Number(row[decColumn]);
  if (!Number.isFinite(raDeg) || !Number.isFinite(decDeg) || raDeg < 0 || raDeg > 360 || decDeg < -90 || decDeg > 90) return null;
  return [raDeg === 360 ? 0 : raDeg, decDeg];
}

function writeHeader(buffer: Buffer, magic: string, recordCount: number, recordBytes: number): void {
  buffer.write(magic, 0, "ascii");
  buffer.writeUInt32LE(ATLAS_FORMAT_VERSION, 8);
  buffer.writeUInt32LE(recordCount, 12);
  buffer.writeUInt32LE(recordBytes, 16);
  buffer.writeUInt32LE(ATLAS_HEADER_BYTES, 20);
}

export async function buildSurveyAtlas(options: BuildSurveyAtlasOptions): Promise<SurveyAtlasManifest> {
  const startedAt = new Date().toISOString();
  const [membershipSource, desiSource, volumeManifestSource, volumePointsSource, codeSha256] = await Promise.all([
    inputFingerprint(options.membershipCsv, "survey-membership", "text/csv"),
    inputFingerprint(options.desiCsv, "desi-angular-catalog", "text/csv"),
    inputFingerprint(options.volumeManifest, "redshift-volume-manifest", "application/json"),
    inputFingerprint(options.volumePoints, "redshift-volume-points", "application/octet-stream"),
    sha256File(fileURLToPath(import.meta.url)),
  ]);
  const states: SurveyBuildState[] = [
    { definition: { id: "desi", name: "DESI-COSMOS", modality: "spectroscopy", color: "#f2cf62" }, finestCounts: new Map(), coverage: emptyCoverage() },
    { definition: { id: "hsc", name: "HSC PDR3", modality: "optical", color: "#42d4c6" }, finestCounts: new Map(), coverage: emptyCoverage() },
    { definition: { id: "hst", name: "HST ACS", modality: "optical", color: "#f07768" }, finestCounts: new Map(), coverage: emptyCoverage() },
    { definition: { id: "galex", name: "GALEX", modality: "ultraviolet", color: "#78a8ff" }, finestCounts: new Map(), coverage: emptyCoverage() },
  ];
  const stateById = new Map(states.map((state) => [state.definition.id, state]));
  const healpix = new Healpix(FINEST_NSIDE);
  const addPoint = (surveyId: string, raDeg: number, decDeg: number): void => {
    const state = stateById.get(surveyId)!;
    increment(state.finestCounts, healpix.ang2pix(pointing(raDeg, decDeg)));
    updateCoverage(state.coverage, raDeg, decDeg);
  };

  await streamCsv(options.desiCsv, (row) => {
    const coordinate = parseCoordinate(row, "RA", "DEC");
    if (coordinate) addPoint("desi", ...coordinate);
  });
  await streamCsv(options.membershipCsv, (row) => {
    const coordinate = parseCoordinate(row, "ra", "dec");
    if (!coordinate) return;
    if (enabled(row.HSC)) addPoint("hsc", ...coordinate);
    if (enabled(row.HST_ACS)) addPoint("hst", ...coordinate);
    if (enabled(row.GALEX)) addPoint("galex", ...coordinate);
  });

  const volumeManifest = JSON.parse(await readFile(options.volumeManifest, "utf8")) as VolumeManifest;
  const rawVolume = await readFile(options.volumePoints);
  const volumeBuffer = rawVolume.buffer.slice(rawVolume.byteOffset, rawVolume.byteOffset + rawVolume.byteLength) as ArrayBuffer;
  const volumePoints = decodeVolumePoints(volumeBuffer, volumeManifest.pointCount);
  const desiIndex = states.findIndex((state) => state.definition.id === "desi");
  const radialCoordinate: NonNullable<AtlasSurvey["radialCoordinate"]> = {
    kind: "comoving_distance",
    unit: "Mpc",
    sourceVolumeId: volumeManifest.id,
    cosmology: "Planck18",
    domainMinMpc: 0,
    domainMaxMpc: volumeManifest.radialCoordinate.domainMaxMpc,
    semantics: "redshift_inferred",
  };
  const parameters = {
    coordinateFrame: "ICRS",
    angularLevels: [...ANGULAR_LEVELS],
    radialLevels: [...RADIAL_LEVELS],
    layerRadiusSemantics: "visual_offset_only",
    filters: {
      desi: "finite RA/Dec",
      membership: "finite ra/dec and survey membership flag == 1",
      volume: volumeManifest.source.filter,
    },
    sourceVolumeId: volumeManifest.id,
  };
  const inputs = [membershipSource, desiSource, volumeManifestSource, volumePointsSource];
  const configSha256 = sha256Text(canonicalJson({
    kind: "survey-atlas",
    artifactId: options.atlasId,
    producerVersion: PRODUCER_VERSION,
    codeSha256,
    inputSha256: inputs.map((input) => input.sha256),
    parameters,
  }));
  const scanRunId = `${options.atlasId}-scan-${configSha256.slice(0, 16)}`;
  const surveys: AtlasSurvey[] = states.map((state) => ({
    ...state.definition,
    objectCount: state.coverage.count,
    coverage: finishCoverage(state.coverage),
    radialCoordinate: state.definition.id === "desi" ? radialCoordinate : null,
  }));

  const angularRecords: Array<{ surveyIndex: number; nside: number; pixel: number; count: number }> = [];
  const angularLevelSummaries: AtlasLevelSummary[] = [];
  states.forEach((state, surveyIndex) => {
    for (const nside of ANGULAR_LEVELS) {
      const divisor = (FINEST_NSIDE / nside) ** 2;
      const counts = new Map<number, number>();
      state.finestCounts.forEach((count, finestPixel) => increment(counts, Math.floor(finestPixel / divisor), count));
      [...counts.entries()].sort(([left], [right]) => left - right).forEach(([pixel, count]) => {
        angularRecords.push({ surveyIndex, nside, pixel, count });
      });
      angularLevelSummaries.push({
        nside,
        surveyId: state.definition.id,
        occupiedCellCount: counts.size,
        maxCellCount: Math.max(...counts.values()),
      });
    }
  });

  const fineJointCounts = new Map<number, number>();
  for (let index = 0; index < volumePoints.count; index += 1) {
    const pixel = healpix.ang2pix(pointing(volumePoints.raDeg[index]!, volumePoints.decDeg[index]!));
    const radialBin = Math.min(
      FINEST_RADIAL_BINS - 1,
      Math.floor((volumePoints.comovingDistanceMpc[index]! / radialCoordinate.domainMaxMpc) * FINEST_RADIAL_BINS),
    );
    increment(fineJointCounts, pixel * FINEST_RADIAL_BINS + radialBin);
  }

  const jointRecords: Array<{ surveyIndex: number; nside: number; radialBins: number; radialBin: number; pixel: number; count: number }> = [];
  const jointLevelSummaries: JointLevelSummary[] = [];
  for (const nside of ANGULAR_LEVELS) {
    const angularDivisor = (FINEST_NSIDE / nside) ** 2;
    for (const radialBins of RADIAL_LEVELS) {
      const radialDivisor = FINEST_RADIAL_BINS / radialBins;
      const counts = new Map<number, number>();
      fineJointCounts.forEach((count, key) => {
        const finestPixel = Math.floor(key / FINEST_RADIAL_BINS);
        const finestRadialBin = key % FINEST_RADIAL_BINS;
        const pixel = Math.floor(finestPixel / angularDivisor);
        const radialBin = Math.floor(finestRadialBin / radialDivisor);
        increment(counts, pixel * radialBins + radialBin, count);
      });
      [...counts.entries()].sort(([left], [right]) => left - right).forEach(([key, count]) => {
        jointRecords.push({
          surveyIndex: desiIndex,
          nside,
          radialBins,
          radialBin: key % radialBins,
          pixel: Math.floor(key / radialBins),
          count,
        });
      });
      jointLevelSummaries.push({
        nside,
        radialBins,
        occupiedCellCount: counts.size,
        maxCellCount: Math.max(...counts.values()),
      });
    }
  }

  await mkdir(options.outputDirectory, { recursive: true });
  const angularFile = "angular-cells.bin";
  const angularBuffer = Buffer.alloc(atlasAngularByteLength(angularRecords.length));
  writeHeader(angularBuffer, ATLAS_ANGULAR_MAGIC, angularRecords.length, ATLAS_ANGULAR_RECORD_BYTES);
  angularRecords.forEach((record, index) => {
    const offset = ATLAS_HEADER_BYTES + index * ATLAS_ANGULAR_RECORD_BYTES;
    angularBuffer.writeUInt16LE(record.surveyIndex, offset);
    angularBuffer.writeUInt16LE(record.nside, offset + 2);
    angularBuffer.writeUInt32LE(record.pixel, offset + 4);
    angularBuffer.writeUInt32LE(record.count, offset + 8);
  });
  await writeFile(path.join(options.outputDirectory, angularFile), angularBuffer);
  const angularSha256 = await sha256File(path.join(options.outputDirectory, angularFile));

  const jointFile = "joint-cells.bin";
  const jointBuffer = Buffer.alloc(atlasJointByteLength(jointRecords.length));
  writeHeader(jointBuffer, ATLAS_JOINT_MAGIC, jointRecords.length, ATLAS_JOINT_RECORD_BYTES);
  jointRecords.forEach((record, index) => {
    const offset = ATLAS_HEADER_BYTES + index * ATLAS_JOINT_RECORD_BYTES;
    jointBuffer.writeUInt16LE(record.surveyIndex, offset);
    jointBuffer.writeUInt16LE(record.nside, offset + 2);
    jointBuffer.writeUInt16LE(record.radialBins, offset + 4);
    jointBuffer.writeUInt16LE(record.radialBin, offset + 6);
    jointBuffer.writeUInt32LE(record.pixel, offset + 8);
    jointBuffer.writeUInt32LE(record.count, offset + 12);
  });
  await writeFile(path.join(options.outputDirectory, jointFile), jointBuffer);
  const jointSha256 = await sha256File(path.join(options.outputDirectory, jointFile));

  const manifest: SurveyAtlasManifest = {
    schemaVersion: 1,
    id: options.atlasId,
    name: "COSMOS Multi-Survey Atlas",
    coordinateFrame: "ICRS",
    layerRadiusSemantics: "visual_offset_only",
    surveys,
    angularLevels: [...ANGULAR_LEVELS],
    angularLevelSummaries,
    angularBinary: {
      file: angularFile,
      format: "astro-atlas-angular-v1",
      byteLength: angularBuffer.byteLength,
      recordCount: angularRecords.length,
      recordBytes: ATLAS_ANGULAR_RECORD_BYTES,
      sha256: angularSha256,
    },
    jointIndex: {
      file: jointFile,
      format: "astro-atlas-joint-v1",
      byteLength: jointBuffer.byteLength,
      recordCount: jointRecords.length,
      recordBytes: ATLAS_JOINT_RECORD_BYTES,
      surveyId: "desi",
      angularLevels: [...ANGULAR_LEVELS],
      radialLevels: [...RADIAL_LEVELS],
      radialCoordinate,
      levelSummaries: jointLevelSummaries,
      sha256: jointSha256,
    },
    sources: [
      { surveyIds: ["desi"], fileName: desiSource.fileName, filter: "finite RA/Dec", uri: desiSource.uri, byteLength: desiSource.byteLength, modifiedAt: desiSource.modifiedAt, sha256: desiSource.sha256 },
      { surveyIds: ["hsc", "hst", "galex"], fileName: membershipSource.fileName, filter: "finite ra/dec and survey membership flag == 1", uri: membershipSource.uri, byteLength: membershipSource.byteLength, modifiedAt: membershipSource.modifiedAt, sha256: membershipSource.sha256 },
      { surveyIds: ["desi"], fileName: volumeManifestSource.fileName, filter: volumeManifest.source.filter, uri: volumeManifestSource.uri, byteLength: volumeManifestSource.byteLength, modifiedAt: volumeManifestSource.modifiedAt, sha256: volumeManifestSource.sha256 },
      { surveyIds: ["desi"], fileName: volumePointsSource.fileName, filter: "selected rows encoded by source volume manifest", uri: volumePointsSource.uri, byteLength: volumePointsSource.byteLength, modifiedAt: volumePointsSource.modifiedAt, sha256: volumePointsSource.sha256 },
    ],
    provenance: { scanRunId, configSha256 },
    generatedAt: new Date().toISOString(),
  };
  const manifestPath = path.join(options.outputDirectory, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const outputs = await Promise.all([
    outputFingerprint(path.join(options.outputDirectory, angularFile), "angular-index", options.atlasId, "application/octet-stream"),
    outputFingerprint(path.join(options.outputDirectory, jointFile), "joint-index", options.atlasId, "application/octet-stream"),
    outputFingerprint(manifestPath, "manifest", options.atlasId, "application/json"),
  ]);
  const scanRun: ScanRun = {
    schemaVersion: 1,
    id: scanRunId,
    kind: "survey-atlas",
    status: "succeeded",
    startedAt,
    completedAt: new Date().toISOString(),
    producer: { name: "build_survey_atlas.ts", version: PRODUCER_VERSION, gitCommit: process.env.ASTRO_GIT_COMMIT ?? null, codeSha256 },
    configSha256,
    parameters,
    inputs,
    outputs,
    lineage: inputs.flatMap((input) => outputs.map((output) => ({ from: input.uri, to: `urn:sha256:${output.sha256}`, relation: "derived_from" as const }))),
  };
  await writeFile(path.join(options.outputDirectory, "scan-run.json"), `${JSON.stringify(scanRun, null, 2)}\n`, "utf8");
  return manifest;
}

function option(name: string, fallback?: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : fallback;
  if (!value) throw new Error(`Missing required option: ${name}`);
  return value;
}

async function main(): Promise<void> {
  const manifest = await buildSurveyAtlas({
    atlasId: option("--id", "cosmos-multisurvey-v1"),
    outputDirectory: option("--output"),
    membershipCsv: option("--membership-csv"),
    desiCsv: option("--desi-csv"),
    volumeManifest: option("--volume-manifest"),
    volumePoints: option("--volume-points"),
  });
  console.log(JSON.stringify({
    id: manifest.id,
    surveys: manifest.surveys.map(({ id, objectCount }) => ({ id, objectCount })),
    angularRecords: manifest.angularBinary.recordCount,
    jointRecords: manifest.jointIndex.recordCount,
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
