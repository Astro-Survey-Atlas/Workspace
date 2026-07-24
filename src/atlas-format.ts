export const ATLAS_ANGULAR_MAGIC = "ASTATLS1";
export const ATLAS_JOINT_MAGIC = "ASTJNT01";
export const ATLAS_FORMAT_VERSION = 1;
export const ATLAS_HEADER_BYTES = 32;
export const ATLAS_ANGULAR_RECORD_BYTES = 16;
export const ATLAS_JOINT_RECORD_BYTES = 20;

export interface AtlasCoverage {
  raMinDeg: number;
  raMaxDeg: number;
  decMinDeg: number;
  decMaxDeg: number;
  centerRaDeg: number;
  centerDecDeg: number;
}

export interface AtlasSurvey {
  id: string;
  name: string;
  modality: "spectroscopy" | "optical" | "ultraviolet";
  color: string;
  objectCount: number;
  coverage: AtlasCoverage;
  radialCoordinate: null | {
    kind: "comoving_distance";
    unit: "Mpc";
    sourceVolumeId: string;
    cosmology: "Planck18";
    domainMinMpc: 0;
    domainMaxMpc: number;
    semantics: "redshift_inferred";
  };
}

export interface AtlasLevelSummary {
  nside: number;
  surveyId: string;
  occupiedCellCount: number;
  maxCellCount: number;
}

export interface JointLevelSummary {
  nside: number;
  radialBins: number;
  occupiedCellCount: number;
  maxCellCount: number;
}

export interface SurveyAtlasManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  coordinateFrame: "ICRS";
  layerRadiusSemantics: "visual_offset_only";
  surveys: AtlasSurvey[];
  angularLevels: number[];
  angularLevelSummaries: AtlasLevelSummary[];
  angularBinary: {
    file: string;
    format: "astro-atlas-angular-v1";
    byteLength: number;
    recordCount: number;
    recordBytes: typeof ATLAS_ANGULAR_RECORD_BYTES;
    url?: string;
    sha256?: string;
  };
  jointIndex: {
    file: string;
    format: "astro-atlas-joint-v1";
    byteLength: number;
    recordCount: number;
    recordBytes: typeof ATLAS_JOINT_RECORD_BYTES;
    surveyId: string;
    angularLevels: number[];
    radialLevels: number[];
    radialCoordinate: NonNullable<AtlasSurvey["radialCoordinate"]>;
    levelSummaries: JointLevelSummary[];
    url?: string;
    sha256?: string;
  };
  sources: Array<{
    surveyIds: string[];
    fileName: string;
    filter: string;
    uri?: string;
    byteLength?: number;
    modifiedAt?: string;
    sha256?: string;
  }>;
  provenance?: {
    scanRunId: string;
    configSha256: string;
  };
  generatedAt: string;
}

export interface AtlasAngularCellData {
  count: number;
  surveyIndex: Uint16Array;
  nside: Uint16Array;
  pixel: Uint32Array;
  objectCount: Uint32Array;
}

export interface AtlasJointCellData {
  count: number;
  surveyIndex: Uint16Array;
  nside: Uint16Array;
  radialBins: Uint16Array;
  radialBin: Uint16Array;
  pixel: Uint32Array;
  objectCount: Uint32Array;
}

export interface AtlasJointCellView {
  pixel: number;
  radialBin: number;
  count: number;
  radialMinMpc: number;
  radialMaxMpc: number;
  volumeMpc3: number;
  densityPerMpc3: number;
}

export interface AtlasJointQueryResponse {
  nside: number;
  radialBins: number;
  cells: AtlasJointCellView[];
  representedObjects: number;
  metrics: {
    levelCellCount: number;
    examinedCellCount: number;
    returnedCellCount: number;
    queryMs: number;
  };
}

export interface AtlasRefinementAxis {
  available: boolean;
  nextLevel: number | null;
  childCounts: number[];
  nonEmptyChildren: number;
  conserved: boolean;
  normalizedVariation: number;
  estimatedBytes: number;
  score: number;
}

export interface AtlasRefinementResponse {
  parentCount: number;
  angular: AtlasRefinementAxis;
  radial: AtlasRefinementAxis;
  recommendedAxis: "angular" | "radial" | "none";
}

function readHeader(buffer: ArrayBuffer, magic: string, recordBytes: number): number {
  if (buffer.byteLength < ATLAS_HEADER_BYTES) throw new Error("Atlas binary is shorter than its header");
  const actualMagic = String.fromCharCode(...new Uint8Array(buffer, 0, magic.length));
  if (actualMagic !== magic) throw new Error(`Unsupported atlas magic: ${actualMagic}`);
  const view = new DataView(buffer);
  const version = view.getUint32(8, true);
  const count = view.getUint32(12, true);
  if (version !== ATLAS_FORMAT_VERSION || view.getUint32(16, true) !== recordBytes || view.getUint32(20, true) !== ATLAS_HEADER_BYTES) {
    throw new Error("Atlas binary header does not match its declared format");
  }
  if (buffer.byteLength !== ATLAS_HEADER_BYTES + count * recordBytes) {
    throw new Error("Atlas binary byte length does not match its record count");
  }
  return count;
}

export function decodeAtlasAngularCells(buffer: ArrayBuffer): AtlasAngularCellData {
  const count = readHeader(buffer, ATLAS_ANGULAR_MAGIC, ATLAS_ANGULAR_RECORD_BYTES);
  const surveyIndex = new Uint16Array(count);
  const nside = new Uint16Array(count);
  const pixel = new Uint32Array(count);
  const objectCount = new Uint32Array(count);
  const view = new DataView(buffer);
  for (let index = 0; index < count; index += 1) {
    const offset = ATLAS_HEADER_BYTES + index * ATLAS_ANGULAR_RECORD_BYTES;
    surveyIndex[index] = view.getUint16(offset, true);
    nside[index] = view.getUint16(offset + 2, true);
    pixel[index] = view.getUint32(offset + 4, true);
    objectCount[index] = view.getUint32(offset + 8, true);
  }
  return { count, surveyIndex, nside, pixel, objectCount };
}

export function decodeAtlasJointCells(buffer: ArrayBuffer): AtlasJointCellData {
  const count = readHeader(buffer, ATLAS_JOINT_MAGIC, ATLAS_JOINT_RECORD_BYTES);
  const surveyIndex = new Uint16Array(count);
  const nside = new Uint16Array(count);
  const radialBins = new Uint16Array(count);
  const radialBin = new Uint16Array(count);
  const pixel = new Uint32Array(count);
  const objectCount = new Uint32Array(count);
  const view = new DataView(buffer);
  for (let index = 0; index < count; index += 1) {
    const offset = ATLAS_HEADER_BYTES + index * ATLAS_JOINT_RECORD_BYTES;
    surveyIndex[index] = view.getUint16(offset, true);
    nside[index] = view.getUint16(offset + 2, true);
    radialBins[index] = view.getUint16(offset + 4, true);
    radialBin[index] = view.getUint16(offset + 6, true);
    pixel[index] = view.getUint32(offset + 8, true);
    objectCount[index] = view.getUint32(offset + 12, true);
  }
  return { count, surveyIndex, nside, radialBins, radialBin, pixel, objectCount };
}

export function atlasAngularByteLength(recordCount: number): number {
  return ATLAS_HEADER_BYTES + recordCount * ATLAS_ANGULAR_RECORD_BYTES;
}

export function atlasJointByteLength(recordCount: number): number {
  return ATLAS_HEADER_BYTES + recordCount * ATLAS_JOINT_RECORD_BYTES;
}
