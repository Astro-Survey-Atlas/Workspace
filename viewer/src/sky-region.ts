export const SKY_COORDINATE_FRAME = "ICRS" as const;
export const SKY_ORDERING = "NESTED" as const;

export interface NestedSkyRegion {
  nside: number;
  pixels: number[];
  coordinateFrame: typeof SKY_COORDINATE_FRAME;
  ordering: typeof SKY_ORDERING;
}

function isPowerOfTwo(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && (value & (value - 1)) === 0;
}

/** Build the one sky-region shape shared by the sphere and Aladin queries. */
export function nestedSkyRegion(nside: number, pixels: readonly number[]): NestedSkyRegion {
  if (!isPowerOfTwo(nside) || nside > 256) throw new RangeError("nside must be a power of two between 1 and 256");
  if (!Array.isArray(pixels) || !pixels.length) throw new RangeError("at least one NESTED HEALPix pixel is required");
  const maximum = 12 * nside ** 2;
  const normalized = [...new Set(pixels)];
  if (normalized.some((pixel) => !Number.isSafeInteger(pixel) || pixel < 0 || pixel >= maximum)) {
    throw new RangeError(`pixels must be NESTED HEALPix cells for NSIDE ${nside}`);
  }
  normalized.sort((left, right) => left - right);
  return { nside, pixels: normalized, coordinateFrame: SKY_COORDINATE_FRAME, ordering: SKY_ORDERING };
}
