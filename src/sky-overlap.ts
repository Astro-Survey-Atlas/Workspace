import { Healpix } from "healpixjs";

export interface SkyOverlapSource {
  id: string;
  label: string;
  kind: "public" | "workspace";
  nside: number;
  pixels: readonly number[];
  surveyId?: string;
  releaseId?: string;
  assetId?: string;
  product?: string;
  modality?: string;
  sourceUrl?: string;
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
  return Number.isInteger(nside) && nside > 0 && (nside & (nside - 1)) === 0 && nside <= 256;
}

function sourcePixels(source: SkyOverlapSource, nside: number): Set<number> {
  if (!validNside(source.nside) || source.nside !== nside) return new Set();
  return new Set(source.pixels.filter((pixel) => Number.isInteger(pixel) && pixel >= 0 && pixel < 12 * nside ** 2));
}

interface OverlapSourceGroup {
  sourceIds: string[];
  pixels: Set<number>;
}

function groupSources(sources: readonly SkyOverlapSource[], nside: number): OverlapSourceGroup[] {
  const groups = new Map<string, OverlapSourceGroup>();
  sources.forEach((source) => {
    const pixels = sourcePixels(source, nside);
    if (!pixels.size) return;
    // A survey can publish several releases/products covering complementary
    // regions. Treat those products as one logical survey for G-mode overlap.
    // Sources without a survey identity retain the previous source-level
    // behavior so unassigned workspace layers remain independently selectable.
    const surveyId = source.surveyId?.trim();
    const key = surveyId ? `survey:${surveyId}` : `source:${source.id}`;
    const group = groups.get(key) ?? { sourceIds: [], pixels: new Set<number>() };
    group.sourceIds.push(source.id);
    pixels.forEach((pixel) => group.pixels.add(pixel));
    groups.set(key, group);
  });
  return [...groups.values()];
}

function bounds(cells: readonly number[], nside: number): SkyOverlapComponent["bounds"] {
  const healpix = new Healpix(nside);
  const values: Array<{ ra: number; dec: number }> = [];
  cells.forEach((pixel) => {
    for (const point of healpix.getBoundaries(pixel)) {
      const radius = Math.hypot(point.x, point.y, point.z) || 1;
      values.push({
        ra: ((Math.atan2(point.y, point.x) * 180 / Math.PI) + 360) % 360,
        dec: Math.asin(point.z / radius) * 180 / Math.PI,
      });
    }
  });
  return {
    raMin: values.length ? Math.min(...values.map((value) => value.ra)) : 0,
    raMax: values.length ? Math.max(...values.map((value) => value.ra)) : 0,
    decMin: values.length ? Math.min(...values.map((value) => value.dec)) : 0,
    decMax: values.length ? Math.max(...values.map((value) => value.dec)) : 0,
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
  const validSources = sources.filter((source) => validNside(source.nside) && source.pixels.length > 0);
  const nside = requestedNside ?? validSources[0]?.nside ?? 16;
  if (!validNside(nside)) throw new RangeError("nside must be a power of two between 1 and 256");
  const selected = validSources.filter((source) => source.nside === nside);
  const sourceIds = selected.map((source) => source.id).sort();
  const groups = groupSources(selected, nside);
  if (groups.length < 2) return { status: "empty", order: Math.log2(nside), nside, sourceIds, pixels: [], components: [] };
  let overlap = new Set(groups[0]!.pixels);
  for (const group of groups.slice(1)) {
    const next = group.pixels;
    overlap = new Set([...overlap].filter((pixel) => next.has(pixel)));
    if (!overlap.size) break;
  }
  const pixels = [...overlap].sort((left, right) => left - right);
  return {
    status: pixels.length ? "ready" : "empty",
    order: Math.log2(nside),
    nside,
    sourceIds,
    pixels,
    components: pixels.length ? components(pixels, nside, sourceIds) : [],
  };
}
