import { readFile, realpath, stat } from "node:fs/promises";
import { parse } from "csv-parse/sync";

import type {
  ColumnProfile,
  DatasetProfile,
  RightAscensionInterval,
  ScalarType,
  SkyCoverage,
} from "./types.js";

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const RA_ALIASES = new Set(["ra", "ra_deg", "raj2000", "alpha_j2000"]);
const DEC_ALIASES = new Set(["dec", "dec_deg", "dej2000", "delta_j2000"]);

function normalizedColumnName(name: string): string {
  return name.trim().toLowerCase().replaceAll(/[^a-z0-9]+/g, "_");
}

function inferType(values: string[]): ScalarType {
  const nonNull = values.filter((value) => value.trim() !== "");
  if (nonNull.length === 0) return "string";

  const lower = nonNull.map((value) => value.trim().toLowerCase());
  if (lower.every((value) => value === "true" || value === "false")) return "boolean";
  if (nonNull.every((value) => /^[+-]?\d+$/.test(value.trim()))) return "integer";
  if (nonNull.every((value) => Number.isFinite(Number(value)))) return "number";
  return "string";
}

function profileColumn(name: string, rows: Record<string, string>[]): ColumnProfile {
  const values = rows.map((row) => row[name] ?? "");
  return {
    name,
    type: inferType(values),
    nullCount: values.filter((value) => value.trim() === "").length,
  };
}

export function minimalRightAscensionInterval(values: number[]): RightAscensionInterval {
  if (values.length === 0) throw new Error("At least one right ascension value is required");

  const sorted = values.map((value) => ((value % 360) + 360) % 360).sort((a, b) => a - b);
  if (sorted.length === 1) {
    const value = sorted[0]!;
    return { startDeg: value, endDeg: value, wraps: false, spanDeg: 0 };
  }

  let largestGap = -1;
  let largestGapIndex = 0;
  for (let index = 0; index < sorted.length; index += 1) {
    const current = sorted[index]!;
    const next = index === sorted.length - 1 ? sorted[0]! + 360 : sorted[index + 1]!;
    const gap = next - current;
    if (gap > largestGap) {
      largestGap = gap;
      largestGapIndex = index;
    }
  }

  const startDeg = sorted[(largestGapIndex + 1) % sorted.length]!;
  const endDeg = sorted[largestGapIndex]!;
  return {
    startDeg,
    endDeg,
    wraps: startDeg > endDeg,
    spanDeg: 360 - largestGap,
  };
}

function findCoordinateColumn(headers: string[], aliases: Set<string>): string | undefined {
  return headers.find((header) => aliases.has(normalizedColumnName(header)));
}

function calculateSkyCoverage(headers: string[], rows: Record<string, string>[]): SkyCoverage | null {
  const raColumn = findCoordinateColumn(headers, RA_ALIASES);
  const decColumn = findCoordinateColumn(headers, DEC_ALIASES);
  if (!raColumn || !decColumn) return null;

  const valid: Array<{ ra: number; dec: number }> = [];
  let invalidRows = 0;

  for (const row of rows) {
    const ra = Number(row[raColumn]);
    const dec = Number(row[decColumn]);
    if (!Number.isFinite(ra) || !Number.isFinite(dec) || ra < 0 || ra > 360 || dec < -90 || dec > 90) {
      invalidRows += 1;
      continue;
    }
    valid.push({ ra: ra === 360 ? 0 : ra, dec });
  }

  if (valid.length === 0) return null;
  const decValues = valid.map(({ dec }) => dec);
  return {
    raColumn,
    decColumn,
    rightAscension: minimalRightAscensionInterval(valid.map(({ ra }) => ra)),
    decMinDeg: Math.min(...decValues),
    decMaxDeg: Math.max(...decValues),
    validRows: valid.length,
    invalidRows,
  };
}

export async function profileCatalogCsv(
  inputPath: string,
  maxBytes = DEFAULT_MAX_BYTES,
): Promise<DatasetProfile> {
  const canonicalPath = await realpath(inputPath);
  const fileStat = await stat(canonicalPath);
  if (!fileStat.isFile()) throw new Error(`Not a regular file: ${canonicalPath}`);
  if (fileStat.size > maxBytes) {
    throw new Error(`CSV exceeds the ${maxBytes}-byte profiling limit`);
  }

  let headers: string[] = [];
  const text = await readFile(canonicalPath, "utf8");
  const rows = parse(text, {
    bom: true,
    columns: (columns: string[]) => {
      headers = columns.map((column) => column.trim());
      return headers;
    },
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];

  if (headers.length === 0) throw new Error("CSV must contain a header row");
  if (new Set(headers).size !== headers.length) throw new Error("CSV contains duplicate column names");

  return {
    format: "csv",
    path: canonicalPath,
    byteSize: fileStat.size,
    rowCount: rows.length,
    columns: headers.map((header) => profileColumn(header, rows)),
    skyCoverage: calculateSkyCoverage(headers, rows),
  };
}
