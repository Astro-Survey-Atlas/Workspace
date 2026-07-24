import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { Healpix, Pointing } from "healpixjs";

import { decodeVolumePoints, type VolumeManifest, type VolumePointData } from "./volume-format.js";

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

function parseJson(text: string): unknown {
  return JSON.parse(text.replace(/^\uFEFF/, "")) as unknown;
}

function arrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

function pointing(raDeg: number, decDeg: number): Pointing {
  return new Pointing(null, false, ((90 - decDeg) * Math.PI) / 180, (raDeg * Math.PI) / 180);
}

interface CellPointIndex {
  byCell: Map<number, number[]>;
  buildMs: number;
}

interface LoadedPointVolume {
  manifest: VolumeManifest;
  points: VolumePointData;
  indexes: Map<string, CellPointIndex>;
}

export interface CellPointQuery {
  nside: number;
  pixel: number;
  radialBins: number;
  radialBin: number;
  offset: number;
  limit: number;
}

export interface VolumePointView {
  targetId: string;
  raDeg: number;
  decDeg: number;
  bestZ: number;
  zErr: number;
  comovingDistanceMpc: number;
}

function assertManifest(value: unknown, directoryName: string): VolumeManifest {
  if (!value || typeof value !== "object") throw new Error(`Invalid volume manifest: ${directoryName}`);
  const manifest = value as Partial<VolumeManifest>;
  if (manifest.schemaVersion !== 1 || manifest.id !== directoryName || !ID_PATTERN.test(manifest.id)) {
    throw new Error(`Invalid volume identity: ${directoryName}`);
  }
  if (typeof manifest.name !== "string" || manifest.coordinateFrame !== "ICRS") {
    throw new Error(`Invalid volume metadata: ${directoryName}`);
  }
  if (!Number.isInteger(manifest.pointCount) || (manifest.pointCount ?? 0) < 1) {
    throw new Error(`Invalid volume point count: ${directoryName}`);
  }
  if (manifest.binary?.format !== "astro-volume-v1" || manifest.binary.endianness !== "little") {
    throw new Error(`Unsupported volume binary format: ${directoryName}`);
  }
  if (path.basename(manifest.binary.file) !== manifest.binary.file) {
    throw new Error(`Invalid volume binary file: ${directoryName}`);
  }
  return manifest as VolumeManifest;
}

export class VolumeCatalog {
  readonly #root: string;
  readonly #pointCache = new Map<string, Promise<LoadedPointVolume>>();

  constructor(root: string) {
    this.#root = path.resolve(root);
  }

  async list(): Promise<VolumeManifest[]> {
    let entries;
    try {
      entries = await readdir(this.#root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const manifests = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && ID_PATTERN.test(entry.name))
        .map(async (entry) => {
          const text = await readFile(path.join(this.#root, entry.name, "manifest.json"), "utf8");
          if (!text.includes('"astro-volume-v1"')) return null;
          const value = parseJson(text) as Partial<VolumeManifest>;
          return value.binary?.format === "astro-volume-v1" ? assertManifest(value, entry.name) : null;
        }),
    );
    return manifests.filter((manifest): manifest is VolumeManifest => manifest != null)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async get(id: string): Promise<VolumeManifest> {
    if (!ID_PATTERN.test(id)) throw new RangeError("Invalid volume id");
    try {
      return await this.#readManifest(id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Volume not found: ${id}`);
      throw error;
    }
  }

  async pointsPath(id: string): Promise<{ manifest: VolumeManifest; filePath: string }> {
    const manifest = await this.get(id);
    const filePath = path.join(this.#root, id, manifest.binary.file);
    const fileStat = await stat(filePath);
    if (!fileStat.isFile() || fileStat.size !== manifest.binary.byteLength) {
      throw new Error(`Volume binary does not match its manifest: ${id}`);
    }
    return { manifest, filePath };
  }

  async queryCellPoints(id: string, query: CellPointQuery): Promise<{
    volumeId: string;
    nside: number;
    pixel: number;
    radialBins: number;
    radialBin: number;
    offset: number;
    limit: number;
    total: number;
    points: VolumePointView[];
    radialSemantics: "redshift_inferred_comoving_distance";
    metrics: { cacheHit: boolean; indexedPointCount: number; indexBuildMs: number; queryMs: number };
  }> {
    const started = performance.now();
    if (!Number.isInteger(query.nside) || query.nside < 1 || (query.nside & (query.nside - 1)) !== 0) {
      throw new RangeError("nside must be a positive power of two");
    }
    const pixelCount = 12 * query.nside * query.nside;
    if (!Number.isInteger(query.pixel) || query.pixel < 0 || query.pixel >= pixelCount) throw new RangeError("pixel is outside the HEALPix level");
    if (!Number.isInteger(query.radialBins) || query.radialBins < 1) throw new RangeError("radialBins must be a positive integer");
    if (!Number.isInteger(query.radialBin) || query.radialBin < 0 || query.radialBin >= query.radialBins) throw new RangeError("radialBin is outside the radial level");
    if (!Number.isInteger(query.offset) || query.offset < 0) throw new RangeError("offset must be a non-negative integer");
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 10_000) throw new RangeError("limit must be an integer between 1 and 10000");

    const loaded = await this.#loadPoints(id);
    const indexKey = `${query.nside}:${query.radialBins}`;
    let cellIndex = loaded.indexes.get(indexKey);
    const cacheHit = cellIndex != null;
    if (!cellIndex) {
      const indexStarted = performance.now();
      const healpix = new Healpix(query.nside);
      const byCell = new Map<number, number[]>();
      const domainMaxMpc = loaded.manifest.radialCoordinate.domainMaxMpc;
      for (let index = 0; index < loaded.points.count; index += 1) {
        const distance = loaded.points.comovingDistanceMpc[index]!;
        if (!Number.isFinite(distance) || distance < 0 || distance > domainMaxMpc) continue;
        const pixel = healpix.ang2pix(pointing(loaded.points.raDeg[index]!, loaded.points.decDeg[index]!));
        const radialBin = Math.min(query.radialBins - 1, Math.floor((distance / domainMaxMpc) * query.radialBins));
        const key = pixel * query.radialBins + radialBin;
        const indices = byCell.get(key) ?? [];
        indices.push(index);
        byCell.set(key, indices);
      }
      cellIndex = { byCell, buildMs: performance.now() - indexStarted };
      loaded.indexes.set(indexKey, cellIndex);
    }

    const indices = cellIndex.byCell.get(query.pixel * query.radialBins + query.radialBin) ?? [];
    const points = indices.slice(query.offset, query.offset + query.limit).map((index): VolumePointView => ({
      targetId: loaded.points.targetId[index]!.toString(),
      raDeg: loaded.points.raDeg[index]!,
      decDeg: loaded.points.decDeg[index]!,
      bestZ: loaded.points.bestZ[index]!,
      zErr: loaded.points.zErr[index]!,
      comovingDistanceMpc: loaded.points.comovingDistanceMpc[index]!,
    }));
    return {
      volumeId: id,
      nside: query.nside,
      pixel: query.pixel,
      radialBins: query.radialBins,
      radialBin: query.radialBin,
      offset: query.offset,
      limit: query.limit,
      total: indices.length,
      points,
      radialSemantics: "redshift_inferred_comoving_distance",
      metrics: { cacheHit, indexedPointCount: loaded.points.count, indexBuildMs: cacheHit ? 0 : cellIndex.buildMs, queryMs: performance.now() - started },
    };
  }

  async #loadPoints(id: string): Promise<LoadedPointVolume> {
    let pending = this.#pointCache.get(id);
    if (!pending) {
      pending = (async () => {
        const { manifest, filePath } = await this.pointsPath(id);
        const points = decodeVolumePoints(arrayBuffer(await readFile(filePath)), manifest.pointCount);
        return { manifest, points, indexes: new Map() };
      })();
      this.#pointCache.set(id, pending);
    }
    try {
      return await pending;
    } catch (error) {
      this.#pointCache.delete(id);
      throw error;
    }
  }

  async #readManifest(id: string): Promise<VolumeManifest> {
    const filePath = path.join(this.#root, id, "manifest.json");
    return assertManifest(parseJson(await readFile(filePath, "utf8")), id);
  }
}

export function publicVolumeManifest(manifest: VolumeManifest): VolumeManifest {
  return {
    ...manifest,
    binary: {
      ...manifest.binary,
      url: `/api/volumes/${encodeURIComponent(manifest.id)}/points.bin`,
    },
  };
}
