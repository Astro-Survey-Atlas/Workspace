export type ScalarType = "boolean" | "integer" | "number" | "string";

export interface ColumnProfile {
  name: string;
  type: ScalarType;
  nullCount: number;
}

export interface RightAscensionInterval {
  startDeg: number;
  endDeg: number;
  wraps: boolean;
  spanDeg: number;
}

export interface SkyCoverage {
  raColumn: string;
  decColumn: string;
  rightAscension: RightAscensionInterval;
  decMinDeg: number;
  decMaxDeg: number;
  validRows: number;
  invalidRows: number;
}

export interface DatasetProfile {
  format: "csv";
  path: string;
  byteSize: number;
  rowCount: number;
  columns: ColumnProfile[];
  skyCoverage: SkyCoverage | null;
}

export interface SkyPoint {
  id: string;
  rowIndex: number;
  raDeg: number;
  decDeg: number;
  attributes: Record<string, string>;
}

export interface SkyCellVertex {
  raDeg: number;
  decDeg: number;
}

export interface SkyDensityCell {
  nside: number;
  pixel: number;
  count: number;
  centerRaDeg: number;
  centerDecDeg: number;
  vertices: SkyCellVertex[];
}

export interface SkyLevelSummary {
  nside: number;
  occupiedCellCount: number;
  maxCellCount: number;
}

export interface DatasetSkySummary {
  coordinateFrame: "ICRS";
  objectCount: number;
  invalidRowCount: number;
  idColumn: string | null;
  levels: SkyLevelSummary[];
}

export interface CatalogSkyIndex {
  summary: DatasetSkySummary;
  points: SkyPoint[];
  countsByNside: Map<number, Map<number, number>>;
}

export interface DatasetRecord {
  id: string;
  name: string;
  uri: string;
  profile: DatasetProfile;
  createdAt: string;
  updatedAt: string;
}

export interface RegistryState {
  version: 1;
  datasets: DatasetRecord[];
}
