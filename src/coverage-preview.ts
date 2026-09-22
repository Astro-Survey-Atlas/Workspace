import { open } from "node:fs/promises";
import path from "node:path";

export interface CoveragePreviewLayer {
  pixels: number[];
  cellCount: number;
  preview: true;
  precision: "estimated";
}

interface CoveragePreviewState {
  evidencePath: string;
  offset: number;
  incomplete: string;
  cells: Map<string, { healpixOrder: number; healpixCell: number }>;
}

const MAX_PREVIEW_READ_BYTES = 8 * 1024 * 1024;

function containedEvidenceDirectory(value: string | undefined, mountPath: string): string | undefined {
  const candidate = value?.trim();
  if (!candidate || !path.isAbsolute(candidate)) return undefined;
  const root = path.resolve(mountPath);
  const resolved = path.resolve(candidate);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return undefined;
  return resolved;
}

function projectPixel(ipix: number, sourceOrder: number, targetOrder: number): number[] {
  if (sourceOrder === targetOrder) return [ipix];
  if (sourceOrder > targetOrder) return [Math.floor(ipix / 4 ** (sourceOrder - targetOrder))];
  return [];
}

function parseCoverageLine(line: string): { healpixOrder: number; healpixCell: number } | undefined {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return undefined; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.coordinate_frame !== "ICRS" || record.nesting !== "NESTED") return undefined;
  const healpixOrder = record.healpix_order;
  const healpixCell = record.healpix_cell;
  if (typeof healpixOrder !== "number" || !Number.isInteger(healpixOrder) || healpixOrder < 0 || healpixOrder > 29) return undefined;
  if (typeof healpixCell !== "number" || !Number.isInteger(healpixCell) || healpixCell < 0) return undefined;
  return { healpixOrder, healpixCell };
}

export class CoveragePreviewCache {
  readonly #mountPath: string;
  readonly #states = new Map<string, CoveragePreviewState>();

  constructor(mountPath: string) {
    this.#mountPath = mountPath;
  }

  async preview(runId: string, evidencePath: string | undefined, nside: number): Promise<CoveragePreviewLayer | undefined> {
    if (!Number.isInteger(nside) || nside < 1 || (nside & (nside - 1)) !== 0 || nside > 256) return undefined;
    const directory = containedEvidenceDirectory(evidencePath, this.#mountPath);
    if (!directory) return undefined;
    const filePath = path.join(directory, ".coverage.ndjson");
    const current = this.#states.get(runId);
    const state: CoveragePreviewState = current?.evidencePath === directory
      ? current
      : { evidencePath: directory, offset: 0, incomplete: "", cells: new Map() };
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(filePath, "r");
      const stat = await handle.stat();
      if (stat.size < state.offset) {
        state.offset = 0;
        state.incomplete = "";
        state.cells.clear();
      }
      const remaining = stat.size - state.offset;
      if (remaining > 0) {
        const length = Math.min(remaining, MAX_PREVIEW_READ_BYTES);
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, state.offset);
        const chunk = `${state.incomplete}${buffer.subarray(0, bytesRead).toString("utf8")}`;
        const lines = chunk.split("\n");
        state.incomplete = lines.pop() ?? "";
        state.offset += bytesRead;
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const cell = parseCoverageLine(trimmed);
          if (!cell) continue;
          state.cells.set(`${cell.healpixOrder}:${cell.healpixCell}`, cell);
        }
      }
      this.#states.set(runId, state);
    } catch {
      return current && current.cells.size
        ? this.#layer(current, nside)
        : undefined;
    } finally {
      await handle?.close().catch(() => undefined);
    }
    return this.#layer(state, nside);
  }

  #layer(state: CoveragePreviewState, nside: number): CoveragePreviewLayer | undefined {
    if (!state.cells.size) return undefined;
    const targetOrder = Math.log2(nside);
    const pixels = new Set<number>();
    for (const cell of state.cells.values()) {
      for (const pixel of projectPixel(cell.healpixCell, cell.healpixOrder, targetOrder)) pixels.add(pixel);
    }
    if (!pixels.size) return undefined;
    return {
      pixels: [...pixels].sort((left, right) => left - right),
      cellCount: state.cells.size,
      preview: true,
      precision: "estimated",
    };
  }
}
