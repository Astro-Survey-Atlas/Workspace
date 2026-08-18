export type LayerOrderLayout = "overlap" | "layers";

export interface LayerDepth {
  key: string;
  radius: number;
  renderOrder: number;
}

const OVERLAP_DEPTH_STEP = 0.0015;
const RADIAL_DEPTH_STEP = 0.075;

export function normalizeLayerOrder(
  knownKeys: Iterable<string>,
  storedKeys: Iterable<string> = [],
  defaultKeys: Iterable<string> = [],
): string[] {
  const known = new Set(knownKeys);
  const ordered: string[] = [];
  const add = (key: string): void => {
    if (known.has(key) && !ordered.includes(key)) ordered.push(key);
  };
  for (const key of storedKeys) add(key);
  for (const key of defaultKeys) add(key);
  for (const key of known) add(key);
  return ordered;
}

export function visibleLayerDepths(
  order: readonly string[],
  visibleKeys: Iterable<string>,
  layout: LayerOrderLayout,
): LayerDepth[] {
  const visible = new Set(visibleKeys);
  const keys = order.filter((key) => visible.has(key));
  const midpoint = (keys.length - 1) / 2;
  const step = layout === "layers" ? RADIAL_DEPTH_STEP : OVERLAP_DEPTH_STEP;
  return keys.map((key, index) => ({
    key,
    // The first list item is the front-most layer.
    radius: 1 + (midpoint - index) * step,
    renderOrder: 2 + (keys.length - 1 - index) * 2,
  }));
}
