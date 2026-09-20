export type LayerOrderLayout = "overlap" | "layers";

export interface LayerDepth {
  key: string;
  radius: number;
  renderOrder: number;
}

const OVERLAP_DEPTH_STEP = 0;
const LAYER_RADIUS_INNER = 0.88;
const LAYER_RADIUS_OUTER = 1.12;

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
  // Only add all known keys if defaultKeys was provided and non-empty
  const defaults = Array.isArray(defaultKeys) ? defaultKeys : [...defaultKeys];
  if (defaults.length > 0) {
    for (const key of known) add(key);
  }
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
  const layerSpan = Math.max(0, LAYER_RADIUS_OUTER - LAYER_RADIUS_INNER);
  return keys.map((key, index) => ({
    key,
    // The first list item is the front-most layer.
    radius: layout === "layers"
      ? keys.length <= 1
        ? 1
        : LAYER_RADIUS_OUTER - (index / (keys.length - 1)) * layerSpan
      : 1 + (midpoint - index) * OVERLAP_DEPTH_STEP,
    renderOrder: 2 + (keys.length - 1 - index) * 2,
  }));
}
