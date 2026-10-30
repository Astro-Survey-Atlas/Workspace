/** Half-open NESTED intervals at one fixed HEALPix order. */
export interface HealpixRange { start: number; end: number }

export const MAX_OVERLAP_ORDER = 13;

export function unionHealpixRanges(ranges: readonly HealpixRange[]): HealpixRange[] {
  const result: HealpixRange[] = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = result.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else if (range.start < range.end) result.push({ ...range });
  }
  return result;
}

export function healpixRangesForPixels(pixels: readonly number[]): HealpixRange[] {
  return unionHealpixRanges(pixels.map(pixel => ({ start: pixel, end: pixel + 1 })));
}

export function intersectHealpixRanges(left: readonly HealpixRange[], right: readonly HealpixRange[]): HealpixRange[] {
  const result: HealpixRange[] = [];
  let a = 0, b = 0;
  while (a < left.length && b < right.length) {
    const first = left[a]!, second = right[b]!;
    const start = Math.max(first.start, second.start), end = Math.min(first.end, second.end);
    if (start < end) result.push({ start, end });
    if (first.end <= second.end) a += 1;
    else b += 1;
  }
  return result;
}

export function healpixRangeContains(ranges: readonly HealpixRange[], pixel: number): boolean {
  let low = 0, high = ranges.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (ranges[middle]!.end <= pixel) low = middle + 1;
    else high = middle;
  }
  return Boolean(ranges[low] && ranges[low]!.start <= pixel);
}

export function expandHealpixRanges(ranges: readonly HealpixRange[], limit: number): number[] {
  const count = ranges.reduce((sum, range) => sum + range.end - range.start, 0);
  if (count > limit) throw new RangeError(`重合区域包含 ${count.toLocaleString("en-US")} 个 HEALPix 单元，超过 ${limit.toLocaleString("en-US")} 个显示上限；请降低层级或减少所选产品。`);
  const result: number[] = [];
  for (const range of ranges) for (let pixel = range.start; pixel < range.end; pixel += 1) result.push(pixel);
  return result;
}

