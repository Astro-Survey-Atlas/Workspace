export function parentNestedPixel(pixel: number, nside: number, parentNside: number): number {
  if (!Number.isInteger(pixel) || pixel < 0 || !Number.isInteger(nside) || !Number.isInteger(parentNside)) {
    throw new RangeError("HEALPix identifiers must be non-negative integers");
  }
  if (nside < parentNside || nside % parentNside !== 0) throw new RangeError("Invalid HEALPix parent level");
  const ratio = nside / parentNside;
  if ((ratio & (ratio - 1)) !== 0) throw new RangeError("HEALPix levels must differ by a power of two");
  return Math.floor(pixel / (ratio * ratio));
}

export function radialBinBounds(radialBin: number, radialBins: number, domainMaxMpc: number): [number, number] {
  if (!Number.isInteger(radialBin) || !Number.isInteger(radialBins) || radialBins < 1 || radialBin < 0 || radialBin >= radialBins) {
    throw new RangeError("Invalid radial bin");
  }
  if (!Number.isFinite(domainMaxMpc) || domainMaxMpc <= 0) throw new RangeError("Invalid radial domain");
  return [(radialBin / radialBins) * domainMaxMpc, ((radialBin + 1) / radialBins) * domainMaxMpc];
}

export function healpixSolidAngleSteradian(nside: number): number {
  if (!Number.isInteger(nside) || nside < 1) throw new RangeError("Invalid HEALPix nside");
  return (4 * Math.PI) / (12 * nside * nside);
}

export function sphericalCellVolumeMpc3(nside: number, radialMinMpc: number, radialMaxMpc: number): number {
  if (radialMinMpc < 0 || radialMaxMpc <= radialMinMpc) throw new RangeError("Invalid radial cell bounds");
  return (healpixSolidAngleSteradian(nside) / 3) * (radialMaxMpc ** 3 - radialMinMpc ** 3);
}
