import { Healpix } from "healpixjs";
import { expandHealpixRanges, healpixRangesForPixels, intersectHealpixRanges, MAX_OVERLAP_ORDER, unionHealpixRanges, type HealpixRange } from "./healpix-ranges.js";
import type { PublicSourceIdentity } from "./public-source-identity.js";

export type SkyOverlapAvailability = "geometry-only" | "entrypoint-only" | "candidate" | "incomplete" | "tile-resolved" | "unavailable";

export interface SkyOverlapSource {
  id: string;
  label: string;
  kind: "public" | "workspace";
  nside: number;
  pixels: readonly number[];
  /** Server-side native projection, kept compressed until after intersection. */
  ranges?: readonly HealpixRange[];
  surveyId?: string;
  releaseId?: string;
  assetId?: string;
  product?: string;
  modality?: string;
  sourceUrl?: string;
  sourceIdentity?: PublicSourceIdentity;
  executable?: boolean;
  availability?: SkyOverlapAvailability;
  availableOrders?: number[];
  layerIds?: string[];
}

export interface SkyOverlapComponent {
  id: string;
  order: number;
  nside: number;
  cells: number[];
  sourceIds: string[];
  areaDeg2: number;
  bounds: { raMin: number; raMax: number; decMin: number; decMax: number };
}

export interface SkyOverlapResult {
  status: "ready" | "empty";
  order: number;
  nside: number;
  sourceIds: string[];
  pixels: number[];
  components: SkyOverlapComponent[];
}

function validNside(nside: number): boolean {
  return Number.isInteger(nside) && nside > 0 && (nside & (nside - 1)) === 0 && nside <= 2 ** MAX_OVERLAP_ORDER;
}

function sourceRanges(source: SkyOverlapSource, nside: number): HealpixRange[] {
  if (!validNside(source.nside) || source.nside !== nside) return [];
  if (source.ranges) return unionHealpixRanges(source.ranges.filter(range => Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end)
    && range.start >= 0 && range.start < range.end && range.end <= 12 * nside ** 2));
  return healpixRangesForPixels(source.pixels.filter((pixel) => Number.isInteger(pixel) && pixel >= 0 && pixel < 12 * nside ** 2));
}

interface OverlapSourceGroup {
  sourceIds: string[];
  ranges: HealpixRange[];
}

function groupSources(sources: readonly SkyOverlapSource[], nside: number): OverlapSourceGroup[] {
  const groups = new Map<string, OverlapSourceGroup>();
  sources.forEach((source) => {
    const ranges = sourceRanges(source, nside);
    // A survey can publish several releases/products covering complementary
    // regions. Treat those products as one logical survey for G-mode overlap.
    // Sources without a survey identity retain the previous source-level
    // behavior so unassigned workspace layers remain independently selectable.
    const surveyId = source.surveyId?.trim();
    const key = surveyId ? `survey:${surveyId}` : `source:${source.id}`;
    const group = groups.get(key) ?? { sourceIds: [], ranges: [] };
    group.sourceIds.push(source.id);
    for (const range of ranges) group.ranges.push(range);
    groups.set(key, group);
  });
  return [...groups.values()].map(group => ({ ...group, ranges: unionHealpixRanges(group.ranges) }));
}

function bounds(cells: readonly number[], nside: number): SkyOverlapComponent["bounds"] {
  const healpix = new Healpix(nside);
  let raMin = Infinity, raMax = -Infinity, decMin = Infinity, decMax = -Infinity;
  for (const pixel of cells) {
    for (const point of healpix.getBoundaries(pixel)) {
      const radius = Math.hypot(point.x, point.y, point.z) || 1;
      const ra = ((Math.atan2(point.y, point.x) * 180 / Math.PI) + 360) % 360;
      const dec = Math.asin(point.z / radius) * 180 / Math.PI;
      raMin = Math.min(raMin, ra); raMax = Math.max(raMax, ra);
      decMin = Math.min(decMin, dec); decMax = Math.max(decMax, dec);
    }
  }
  return {
    raMin: Number.isFinite(raMin) ? raMin : 0,
    raMax: Number.isFinite(raMax) ? raMax : 0,
    decMin: Number.isFinite(decMin) ? decMin : 0,
    decMax: Number.isFinite(decMax) ? decMax : 0,
  };
}

function components(pixels: readonly number[], nside: number, sourceIds: readonly string[]): SkyOverlapComponent[] {
  const pending = new Set(pixels);
  const healpix = new Healpix(nside);
  const order = Math.log2(nside);
  const cellArea = 41252.96124941927 / (12 * nside ** 2);
  const result: SkyOverlapComponent[] = [];
  while (pending.size) {
    const start = pending.values().next().value as number;
    const queue = [start];
    const cells: number[] = [];
    pending.delete(start);
    while (queue.length) {
      const pixel = queue.pop()!;
      cells.push(pixel);
      const neighbours = healpix.neighbours(pixel);
      for (const index of [0, 2, 4, 6]) {
        const neighbour = neighbours[index] ?? -1;
        if (neighbour >= 0 && pending.delete(neighbour)) queue.push(neighbour);
      }
    }
    cells.sort((left, right) => left - right);
    result.push({
      id: `C${String(result.length + 1).padStart(2, "0")}`,
      order,
      nside,
      cells,
      sourceIds: [...sourceIds].sort(),
      areaDeg2: cells.length * cellArea,
      bounds: bounds(cells, nside),
    });
  }
  return result;
}

/** Intersect all valid source layers and split the result into side-connected regions. */
export function calculateSkyOverlap(sources: readonly SkyOverlapSource[], requestedNside?: number): SkyOverlapResult {
  const validSources = sources.filter((source) => validNside(source.nside));
  const nside = requestedNside ?? validSources[0]?.nside ?? 16;
  if (!validNside(nside)) throw new RangeError(`nside must be a power of two between 1 and ${2 ** MAX_OVERLAP_ORDER}`);
  const selected = validSources.filter((source) => source.nside === nside);
  const sourceIds = selected.map((source) => source.id).sort();
  const groups = groupSources(selected, nside);
  if (groups.length < 2) return { status: "empty", order: Math.log2(nside), nside, sourceIds, pixels: [], components: [] };
  let overlap = groups[0]!.ranges;
  for (const group of groups.slice(1)) {
    overlap = intersectHealpixRanges(overlap, group.ranges);
    if (!overlap.length) break;
  }
  const order = Math.log2(nside);
  const pixels = expandHealpixRanges(overlap, order > 8 ? 32_768 : order > 5 ? 65_536 : 200_000);
  return {
    status: pixels.length ? "ready" : "empty",
    order: Math.log2(nside),
    nside,
    sourceIds,
    pixels,
    components: pixels.length ? components(pixels, nside, sourceIds) : [],
  };
}

/** Every source can be coarsened, but no selected source may be refined past its authority. */
export function commonOverlapOrders(sources: readonly SkyOverlapSource[]): number[] {
  if (!sources.length) return [];
  const maxima = sources.map((source) => {
    const orders = (source.availableOrders ?? [Math.log2(source.nside)])
      .filter((order) => Number.isInteger(order) && order >= 0 && order <= 29);
    return orders.length ? Math.max(...orders) : -1;
  });
  const maximum = Math.min(MAX_OVERLAP_ORDER, ...maxima);
  return Array.from({ length: maximum + 1 }, (_, order) => order);
}

/** A lower-resolution selected source limits the whole result; never drop it. */
export function commonOverlapNside(sources: readonly SkyOverlapSource[], fallback = 16): number {
  const orders = commonOverlapOrders(sources);
  return orders.length ? 2 ** orders.at(-1)! : fallback;
}

/** Private native cells can supply coarser query projections without changing their evidence order. */
export function privateOverlapOrders(nativeOrders: readonly number[]): number[] {
  const orders = nativeOrders.filter(order => Number.isInteger(order) && order >= 0 && order <= 29);
  const maximum = orders.length ? Math.min(MAX_OVERLAP_ORDER, Math.max(...orders)) : -1;
  return Array.from({ length: maximum + 1 }, (_, order) => order);
}
