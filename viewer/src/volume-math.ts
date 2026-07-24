import { raDecToCartesian } from "./coordinates.js";

export interface VolumeCartesianCoordinate {
  x: number;
  y: number;
  z: number;
}

export function volumePosition(
  raDeg: number,
  decDeg: number,
  distanceMpc: number,
  domainMaxMpc: number,
  outerRadius = 1,
): VolumeCartesianCoordinate {
  if (!Number.isFinite(distanceMpc) || distanceMpc < 0 || domainMaxMpc <= 0) {
    throw new RangeError("Volume distances must be finite and non-negative");
  }
  return raDecToCartesian(raDeg, decDeg, (distanceMpc / domainMaxMpc) * outerRadius);
}

export function radialShellIndex(distanceMpc: number, domainMaxMpc: number, shellCount: number): number {
  if (!Number.isInteger(shellCount) || shellCount < 1 || domainMaxMpc <= 0) {
    throw new RangeError("Invalid radial shell configuration");
  }
  return Math.min(shellCount - 1, Math.max(0, Math.floor((distanceMpc / domainMaxMpc) * shellCount)));
}

export function radialShellBoundaries(domainMaxMpc: number, shellCount: number): number[] {
  if (!Number.isInteger(shellCount) || shellCount < 1 || domainMaxMpc <= 0) {
    throw new RangeError("Invalid radial shell configuration");
  }
  return Array.from({ length: shellCount }, (_, index) => ((index + 1) / shellCount) * domainMaxMpc);
}
