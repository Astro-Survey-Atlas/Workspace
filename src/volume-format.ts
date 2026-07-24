export const VOLUME_MAGIC = "ASTRVOL1";
export const VOLUME_FORMAT_VERSION = 1;
export const VOLUME_HEADER_BYTES = 32;
export const VOLUME_FIELD_COUNT = 6;

export interface VolumeCoverage {
  raMinDeg: number;
  raMaxDeg: number;
  decMinDeg: number;
  decMaxDeg: number;
  centerRaDeg: number;
  centerDecDeg: number;
}

export interface VolumeShellLevel {
  shellCount: number;
  counts: number[];
}

export interface VolumeManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  source: {
    fileName: string;
    hdu: "SPECZ";
    sourceRowCount: number;
    filter: string;
    uri?: string;
    byteLength?: number;
    modifiedAt?: string;
    sha256?: string;
  };
  coordinateFrame: "ICRS";
  radialCoordinate: {
    kind: "comoving_distance";
    unit: "Mpc";
    cosmology: "Planck18";
    domainMinMpc: 0;
    domainMaxMpc: number;
    dataMinMpc: number;
    dataMaxMpc: number;
  };
  pointCount: number;
  coverage: VolumeCoverage;
  redshift: {
    min: number;
    max: number;
    median: number;
  };
  shellLevels: VolumeShellLevel[];
  binary: {
    file: string;
    format: "astro-volume-v1";
    byteLength: number;
    endianness: "little";
    fields: readonly ["raDeg", "decDeg", "bestZ", "zErr", "comovingDistanceMpc", "targetId"];
    url?: string;
    sha256?: string;
  };
  provenance?: {
    scanRunId: string;
    configSha256: string;
  };
  generatedAt: string;
}

export interface VolumePointData {
  count: number;
  raDeg: Float32Array;
  decDeg: Float32Array;
  bestZ: Float32Array;
  zErr: Float32Array;
  comovingDistanceMpc: Float32Array;
  targetId: BigUint64Array;
}

function alignedTargetIdOffset(count: number): number {
  const floatArraysEnd = VOLUME_HEADER_BYTES + count * Float32Array.BYTES_PER_ELEMENT * 5;
  return Math.ceil(floatArraysEnd / BigUint64Array.BYTES_PER_ELEMENT) * BigUint64Array.BYTES_PER_ELEMENT;
}

export function expectedVolumeByteLength(count: number): number {
  return alignedTargetIdOffset(count) + count * BigUint64Array.BYTES_PER_ELEMENT;
}

export function decodeVolumePoints(buffer: ArrayBuffer, expectedCount?: number): VolumePointData {
  if (buffer.byteLength < VOLUME_HEADER_BYTES) throw new Error("Volume binary is shorter than its header");
  const bytes = new Uint8Array(buffer, 0, VOLUME_MAGIC.length);
  const magic = String.fromCharCode(...bytes);
  if (magic !== VOLUME_MAGIC) throw new Error(`Unsupported volume magic: ${magic}`);

  const view = new DataView(buffer);
  const version = view.getUint32(8, true);
  const count = view.getUint32(12, true);
  const fieldCount = view.getUint32(16, true);
  const headerBytes = view.getUint32(20, true);
  if (version !== VOLUME_FORMAT_VERSION) throw new Error(`Unsupported volume format version: ${version}`);
  if (fieldCount !== VOLUME_FIELD_COUNT || headerBytes !== VOLUME_HEADER_BYTES) {
    throw new Error("Volume binary header does not match astro-volume-v1");
  }
  if (expectedCount != null && count !== expectedCount) {
    throw new Error(`Volume point count mismatch: expected ${expectedCount}, received ${count}`);
  }
  if (buffer.byteLength !== expectedVolumeByteLength(count)) {
    throw new Error(`Volume byte length mismatch: expected ${expectedVolumeByteLength(count)}, received ${buffer.byteLength}`);
  }

  const floatBytes = count * Float32Array.BYTES_PER_ELEMENT;
  let offset = VOLUME_HEADER_BYTES;
  const readFloatArray = (): Float32Array => {
    const result = new Float32Array(buffer, offset, count);
    offset += floatBytes;
    return result;
  };

  const raDeg = readFloatArray();
  const decDeg = readFloatArray();
  const bestZ = readFloatArray();
  const zErr = readFloatArray();
  const comovingDistanceMpc = readFloatArray();
  const targetId = new BigUint64Array(buffer, alignedTargetIdOffset(count), count);
  return { count, raDeg, decDeg, bestZ, zErr, comovingDistanceMpc, targetId };
}
