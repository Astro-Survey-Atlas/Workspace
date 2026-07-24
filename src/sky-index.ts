import { readFile, stat } from "node:fs/promises";

import { parse } from "csv-parse/sync";
import { Healpix, Pointing } from "healpixjs";

import type {
  CatalogSkyIndex,
  DatasetRecord,
  DatasetSkySummary,
  SkyDensityCell,
  SkyPoint,
} from "./types.js";

export const SKY_NSIDE_LEVELS = [8, 32, 128, 512] as const;
const ID_ALIASES = new Set(["id", "object_id", "obj_id", "source_id", "classic_id"]);

function normalizedColumnName(name: string): string {
  return name.trim().toLowerCase().replaceAll(/[^a-z0-9]+/g, "_");
}

function findIdColumn(headers: string[]): string | null {
  return headers.find((header) => ID_ALIASES.has(normalizedColumnName(header))) ?? null;
}

function pointingFor(raDeg: number, decDeg: number): Pointing {
  return new Pointing(null, false, ((90 - decDeg) * Math.PI) / 180, (raDeg * Math.PI) / 180);
}

function isValidCoordinate(raDeg: number, decDeg: number): boolean {
  return Number.isFinite(raDeg) && Number.isFinite(decDeg) && raDeg >= 0 && raDeg <= 360 && decDeg >= -90 && decDeg <= 90;
}

export async function buildCatalogSkyIndex(record: DatasetRecord): Promise<CatalogSkyIndex> {
  const coverage = record.profile.skyCoverage;
  if (!coverage) throw new Error(`Dataset has no recognized RA/Dec coordinates: ${record.id}`);

  let headers: string[] = [];
  const rows = parse(await readFile(record.profile.path, "utf8"), {
    bom: true,
    columns: (columns: string[]) => {
      headers = columns.map((column) => column.trim());
      return headers;
    },
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];

  const idColumn = findIdColumn(headers);
  const finestNside = SKY_NSIDE_LEVELS.at(-1)!;
  const finestHealpix = new Healpix(finestNside);
  const countsByNside = new Map<number, Map<number, number>>(
    SKY_NSIDE_LEVELS.map((nside) => [nside, new Map<number, number>()]),
  );
  const points: SkyPoint[] = [];
  let invalidRowCount = 0;

  rows.forEach((row, rowIndex) => {
    let raDeg = Number(row[coverage.raColumn]);
    const decDeg = Number(row[coverage.decColumn]);
    if (!isValidCoordinate(raDeg, decDeg)) {
      invalidRowCount += 1;
      return;
    }
    if (raDeg === 360) raDeg = 0;

    const finestPixel = finestHealpix.ang2pix(pointingFor(raDeg, decDeg));
    for (const nside of SKY_NSIDE_LEVELS) {
      const divisor = (finestNside / nside) ** 2;
      const pixel = Math.floor(finestPixel / divisor);
      const counts = countsByNside.get(nside)!;
      counts.set(pixel, (counts.get(pixel) ?? 0) + 1);
    }

    const attributes = Object.fromEntries(
      headers
        .filter((header) => header !== coverage.raColumn && header !== coverage.decColumn)
        .map((header) => [header, row[header] ?? ""]),
    );
    points.push({
      id: idColumn ? row[idColumn] || String(rowIndex + 1) : String(rowIndex + 1),
      rowIndex,
      raDeg,
      decDeg,
      attributes,
    });
  });

  return {
    summary: {
      coordinateFrame: "ICRS",
      objectCount: points.length,
      invalidRowCount,
      idColumn,
      levels: SKY_NSIDE_LEVELS.map((nside) => {
        const counts = countsByNside.get(nside)!;
        return {
          nside,
          occupiedCellCount: counts.size,
          maxCellCount: Math.max(0, ...counts.values()),
        };
      }),
    },
    points,
    countsByNside,
  };
}

function geometryForPixel(healpix: Healpix, nside: number, pixel: number): SkyDensityCell {
  const center = healpix.pix2ang(pixel);
  return {
    nside,
    pixel,
    count: 0,
    centerRaDeg: (center.phi * 180) / Math.PI,
    centerDecDeg: 90 - (center.theta * 180) / Math.PI,
    vertices: healpix.getBoundaries(pixel).map((vertex) => ({
      raDeg: ((Math.atan2(vertex.y, vertex.x) * 180) / Math.PI + 360) % 360,
      decDeg: (Math.asin(Math.max(-1, Math.min(1, vertex.z))) * 180) / Math.PI,
    })),
  };
}

interface CacheEntry {
  mtimeMs: number;
  byteSize: number;
  index: CatalogSkyIndex;
}

export class CatalogSkyIndexService {
  readonly #cache = new Map<string, CacheEntry>();

  async getIndex(record: DatasetRecord): Promise<CatalogSkyIndex> {
    const fileStat = await stat(record.profile.path);
    const cached = this.#cache.get(record.id);
    if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.byteSize === fileStat.size) return cached.index;

    const index = await buildCatalogSkyIndex(record);
    this.#cache.set(record.id, { mtimeMs: fileStat.mtimeMs, byteSize: fileStat.size, index });
    return index;
  }

  async getSummary(record: DatasetRecord): Promise<DatasetSkySummary> {
    return (await this.getIndex(record)).summary;
  }

  async getCells(record: DatasetRecord, nside: number): Promise<SkyDensityCell[]> {
    if (!SKY_NSIDE_LEVELS.includes(nside as (typeof SKY_NSIDE_LEVELS)[number])) {
      throw new RangeError(`Unsupported nside: ${nside}`);
    }
    const counts = (await this.getIndex(record)).countsByNside.get(nside)!;
    const healpix = new Healpix(nside);
    return [...counts.entries()]
      .sort(([left], [right]) => left - right)
      .map(([pixel, count]) => ({ ...geometryForPixel(healpix, nside, pixel), count }));
  }

  async getPoints(record: DatasetRecord, offset: number, limit: number): Promise<{ points: SkyPoint[]; total: number }> {
    const index = await this.getIndex(record);
    return { points: index.points.slice(offset, offset + limit), total: index.points.length };
  }
}
