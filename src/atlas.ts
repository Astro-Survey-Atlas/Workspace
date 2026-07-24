import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import {
  decodeAtlasAngularCells,
  decodeAtlasJointCells,
  type AtlasJointCellData,
  type SurveyAtlasManifest,
} from "./atlas-format.js";
import { radialBinBounds, sphericalCellVolumeMpc3 } from "./joint-math.js";

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

function parseJson(text: string): unknown {
  return JSON.parse(text.replace(/^\uFEFF/, "")) as unknown;
}

interface JointCellRecord {
  pixel: number;
  radialBin: number;
  count: number;
}

interface JointLevelIndex {
  records: JointCellRecord[];
  byPixel: Map<number, JointCellRecord[]>;
}

interface LoadedAtlas {
  manifest: SurveyAtlasManifest;
  joint: AtlasJointCellData;
  jointLevels: Map<string, JointLevelIndex>;
}

export interface JointCellResponse extends JointCellRecord {
  radialMinMpc: number;
  radialMaxMpc: number;
  volumeMpc3: number;
  densityPerMpc3: number;
}

export interface JointQuery {
  surveyId: string;
  nside: number;
  radialBins: number;
  radialMinMpc?: number;
  radialMaxMpc?: number;
  parentNside?: number;
  parentPixel?: number;
}

export interface RefinementAxis {
  available: boolean;
  nextLevel: number | null;
  childCounts: number[];
  nonEmptyChildren: number;
  conserved: boolean;
  normalizedVariation: number;
  estimatedBytes: number;
  score: number;
}

function arrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

function assertManifest(value: unknown, directoryName: string): SurveyAtlasManifest {
  if (!value || typeof value !== "object") throw new Error(`Invalid atlas manifest: ${directoryName}`);
  const manifest = value as Partial<SurveyAtlasManifest>;
  if (manifest.schemaVersion !== 1 || manifest.id !== directoryName || !ID_PATTERN.test(manifest.id)) {
    throw new Error(`Invalid atlas identity: ${directoryName}`);
  }
  if (!Array.isArray(manifest.surveys) || manifest.surveys.length < 2 || manifest.layerRadiusSemantics !== "visual_offset_only") {
    throw new Error(`Invalid atlas surveys: ${directoryName}`);
  }
  if (manifest.angularBinary?.format !== "astro-atlas-angular-v1" || manifest.jointIndex?.format !== "astro-atlas-joint-v1") {
    throw new Error(`Unsupported atlas format: ${directoryName}`);
  }
  for (const file of [manifest.angularBinary.file, manifest.jointIndex.file]) {
    if (path.basename(file) !== file) throw new Error(`Invalid atlas binary file: ${directoryName}`);
  }
  return manifest as SurveyAtlasManifest;
}

function levelKey(surveyIndex: number, nside: number, radialBins: number): string {
  return `${surveyIndex}:${nside}:${radialBins}`;
}

function variation(parentCount: number, childCounts: number[]): number {
  if (parentCount <= 0) return 0;
  const expected = parentCount / childCounts.length;
  return childCounts.reduce((sum, count) => sum + Math.abs(count - expected), 0) / (2 * parentCount);
}

function axisResult(parentCount: number, nextLevel: number | null, childCounts: number[]): RefinementAxis {
  const nonEmptyChildren = childCounts.filter((count) => count > 0).length;
  const estimatedBytes = nonEmptyChildren * 20;
  const normalizedVariation = variation(parentCount, childCounts);
  return {
    available: nextLevel != null,
    nextLevel,
    childCounts,
    nonEmptyChildren,
    conserved: childCounts.reduce((sum, count) => sum + count, 0) === parentCount,
    normalizedVariation,
    estimatedBytes,
    score: nextLevel == null ? 0 : normalizedVariation / Math.max(estimatedBytes, 20),
  };
}

export class AtlasCatalog {
  readonly #root: string;
  readonly #cache = new Map<string, LoadedAtlas>();

  constructor(root: string) {
    this.#root = path.resolve(root);
  }

  async list(): Promise<SurveyAtlasManifest[]> {
    let entries;
    try {
      entries = await readdir(this.#root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const manifests: SurveyAtlasManifest[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) continue;
      try {
        const text = await readFile(path.join(this.#root, entry.name, "manifest.json"), "utf8");
        if (!text.includes('"astro-atlas-angular-v1"')) continue;
        const value = parseJson(text) as Partial<SurveyAtlasManifest>;
        if (value.angularBinary?.format === "astro-atlas-angular-v1") manifests.push((await this.#load(entry.name)).manifest);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return manifests.sort((left, right) => left.name.localeCompare(right.name));
  }

  async get(id: string): Promise<SurveyAtlasManifest> {
    return (await this.#load(id)).manifest;
  }

  async angularPath(id: string): Promise<{ manifest: SurveyAtlasManifest; filePath: string }> {
    const manifest = await this.get(id);
    const filePath = path.join(this.#root, id, manifest.angularBinary.file);
    const fileStat = await stat(filePath);
    if (!fileStat.isFile() || fileStat.size !== manifest.angularBinary.byteLength) {
      throw new Error(`Atlas angular binary does not match its manifest: ${id}`);
    }
    return { manifest, filePath };
  }

  async jointPath(id: string): Promise<{ manifest: SurveyAtlasManifest; filePath: string }> {
    const manifest = await this.get(id);
    const filePath = path.join(this.#root, id, manifest.jointIndex.file);
    const fileStat = await stat(filePath);
    if (!fileStat.isFile() || fileStat.size !== manifest.jointIndex.byteLength) {
      throw new Error(`Atlas joint binary does not match its manifest: ${id}`);
    }
    return { manifest, filePath };
  }

  async queryJoint(id: string, query: JointQuery): Promise<{
    nside: number;
    radialBins: number;
    cells: JointCellResponse[];
    representedObjects: number;
    metrics: { levelCellCount: number; examinedCellCount: number; returnedCellCount: number; queryMs: number };
  }> {
    const started = performance.now();
    const loaded = await this.#load(id);
    const surveyIndex = loaded.manifest.surveys.findIndex((survey) => survey.id === query.surveyId);
    if (surveyIndex < 0) throw new RangeError(`Unknown atlas survey: ${query.surveyId}`);
    const survey = loaded.manifest.surveys[surveyIndex]!;
    if (!survey.radialCoordinate) throw new RangeError(`Survey has no radial coordinate: ${query.surveyId}`);
    if (!loaded.manifest.jointIndex.angularLevels.includes(query.nside)) throw new RangeError("Unsupported joint nside");
    if (!loaded.manifest.jointIndex.radialLevels.includes(query.radialBins)) throw new RangeError("Unsupported radial level");
    const level = loaded.jointLevels.get(levelKey(surveyIndex, query.nside, query.radialBins));
    if (!level) throw new Error("Joint level is missing from the atlas");

    let candidates: JointCellRecord[];
    if (query.parentNside != null || query.parentPixel != null) {
      if (query.parentNside == null || query.parentPixel == null) throw new RangeError("parentNside and parentPixel must be supplied together");
      if (query.parentNside > query.nside) throw new RangeError("Parent HEALPix level is finer than the query level");
      const ratio = query.nside / query.parentNside;
      if (!Number.isInteger(ratio) || (ratio & (ratio - 1)) !== 0) throw new RangeError("Invalid parent HEALPix level");
      const firstPixel = query.parentPixel * ratio * ratio;
      candidates = [];
      for (let pixel = firstPixel; pixel < firstPixel + ratio * ratio; pixel += 1) {
        candidates.push(...(level.byPixel.get(pixel) ?? []));
      }
    } else {
      candidates = level.records;
    }

    const domainMaxMpc = survey.radialCoordinate.domainMaxMpc;
    const radialMinMpc = Math.max(0, query.radialMinMpc ?? 0);
    const radialMaxMpc = Math.min(domainMaxMpc, query.radialMaxMpc ?? domainMaxMpc);
    if (radialMaxMpc <= radialMinMpc) throw new RangeError("Invalid radial query range");
    const cells = candidates.flatMap((record): JointCellResponse[] => {
      const [cellMin, cellMax] = radialBinBounds(record.radialBin, query.radialBins, domainMaxMpc);
      if (cellMax <= radialMinMpc || cellMin >= radialMaxMpc) return [];
      const volumeMpc3 = sphericalCellVolumeMpc3(query.nside, cellMin, cellMax);
      return [{ ...record, radialMinMpc: cellMin, radialMaxMpc: cellMax, volumeMpc3, densityPerMpc3: record.count / volumeMpc3 }];
    });
    return {
      nside: query.nside,
      radialBins: query.radialBins,
      representedObjects: cells.reduce((sum, cell) => sum + cell.count, 0),
      cells,
      metrics: {
        levelCellCount: level.records.length,
        examinedCellCount: candidates.length,
        returnedCellCount: cells.length,
        queryMs: performance.now() - started,
      },
    };
  }

  async refinement(id: string, surveyId: string, nside: number, radialBins: number, pixel: number, radialBin: number): Promise<{
    parentCount: number;
    angular: RefinementAxis;
    radial: RefinementAxis;
    recommendedAxis: "angular" | "radial" | "none";
  }> {
    const loaded = await this.#load(id);
    const surveyIndex = loaded.manifest.surveys.findIndex((survey) => survey.id === surveyId);
    if (surveyIndex < 0) throw new RangeError(`Unknown atlas survey: ${surveyId}`);
    const current = loaded.jointLevels.get(levelKey(surveyIndex, nside, radialBins));
    const parentCount = current?.byPixel.get(pixel)?.find((record) => record.radialBin === radialBin)?.count ?? 0;
    const nextNside = loaded.manifest.jointIndex.angularLevels.find((level) => level > nside) ?? null;
    const nextRadialBins = loaded.manifest.jointIndex.radialLevels.find((level) => level > radialBins) ?? null;

    const angularCounts = nextNside == null ? [] : Array.from({ length: (nextNside / nside) ** 2 }, (_, offset) => {
      const childPixel = pixel * (nextNside / nside) ** 2 + offset;
      return loaded.jointLevels.get(levelKey(surveyIndex, nextNside, radialBins))?.byPixel
        .get(childPixel)?.find((record) => record.radialBin === radialBin)?.count ?? 0;
    });
    const radialCounts = nextRadialBins == null ? [] : Array.from({ length: nextRadialBins / radialBins }, (_, offset) => {
      const childRadialBin = radialBin * (nextRadialBins / radialBins) + offset;
      return loaded.jointLevels.get(levelKey(surveyIndex, nside, nextRadialBins))?.byPixel
        .get(pixel)?.find((record) => record.radialBin === childRadialBin)?.count ?? 0;
    });
    const angular = axisResult(parentCount, nextNside, angularCounts);
    const radial = axisResult(parentCount, nextRadialBins, radialCounts);
    const recommendedAxis = !angular.available && !radial.available
      ? "none"
      : angular.score >= radial.score ? "angular" : "radial";
    return { parentCount, angular, radial, recommendedAxis };
  }

  async #load(id: string): Promise<LoadedAtlas> {
    if (!ID_PATTERN.test(id)) throw new RangeError("Invalid atlas id");
    const cached = this.#cache.get(id);
    if (cached) return cached;
    let manifest: SurveyAtlasManifest;
    try {
      manifest = assertManifest(parseJson(await readFile(path.join(this.#root, id, "manifest.json"), "utf8")), id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Atlas not found: ${id}`);
      throw error;
    }
    const angularBuffer = await readFile(path.join(this.#root, id, manifest.angularBinary.file));
    const jointBuffer = await readFile(path.join(this.#root, id, manifest.jointIndex.file));
    const angular = decodeAtlasAngularCells(arrayBuffer(angularBuffer));
    const joint = decodeAtlasJointCells(arrayBuffer(jointBuffer));
    if (angular.count !== manifest.angularBinary.recordCount || joint.count !== manifest.jointIndex.recordCount) {
      throw new Error(`Atlas record count does not match its manifest: ${id}`);
    }
    const jointLevels = new Map<string, JointLevelIndex>();
    for (let index = 0; index < joint.count; index += 1) {
      const key = levelKey(joint.surveyIndex[index]!, joint.nside[index]!, joint.radialBins[index]!);
      let level = jointLevels.get(key);
      if (!level) {
        level = { records: [], byPixel: new Map() };
        jointLevels.set(key, level);
      }
      const record = { pixel: joint.pixel[index]!, radialBin: joint.radialBin[index]!, count: joint.objectCount[index]! };
      level.records.push(record);
      const pixelRecords = level.byPixel.get(record.pixel) ?? [];
      pixelRecords.push(record);
      level.byPixel.set(record.pixel, pixelRecords);
    }
    const loaded = { manifest, joint, jointLevels };
    this.#cache.set(id, loaded);
    return loaded;
  }
}

export function publicAtlasManifest(manifest: SurveyAtlasManifest): SurveyAtlasManifest {
  return {
    ...manifest,
    angularBinary: { ...manifest.angularBinary, url: `/api/atlases/${encodeURIComponent(manifest.id)}/angular-cells.bin` },
    jointIndex: { ...manifest.jointIndex, url: `/api/atlases/${encodeURIComponent(manifest.id)}/joint-cells.bin` },
  };
}
