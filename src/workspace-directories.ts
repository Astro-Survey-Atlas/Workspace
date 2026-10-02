import path from "node:path";

export interface WorkspaceFileLocation {
  layerId: string; surveyId?: string; releaseId?: string; product?: string; modality?: string;
  sourceUri: string; order: number; matchingCells: number[];
  precision: "exact" | "estimated" | "entrypoint-only"; scanRunId?: string;
  matchingCellsTruncated?: boolean;
}

export interface WorkspaceDirectory {
  sourceId: string; layerId: string; surveyId?: string; releaseId?: string; product?: string; modality?: string;
  directoryUri: string; order: number; matchingCells: number[];
  precision: "exact" | "estimated" | "entrypoint-only";
  /** The listed native cells are representative matches, not the full footprint. */
  matchingCellsTruncated?: boolean;
}

/** Derive only the immediate parent of an indexed file, never the scan entrypoint. */
export function immediateParentDirectory(value: string): string | undefined {
  if (!value || /[\0\r\n]/.test(value) || /[\\/]$/.test(value)) return undefined;
  if (/^[A-Za-z]:[\\/]/.test(value)) {
    const parent = path.win32.dirname(value);
    return parent !== path.win32.parse(parent).root ? parent : undefined;
  }
  if (value.startsWith("/")) {
    const parent = path.posix.dirname(value);
    return parent !== "/" && parent !== "." ? parent : undefined;
  }
  try {
    const uri = new URL(value);
    if (!["file:", "oss:", "s3:", "http:", "https:"].includes(uri.protocol) || uri.pathname.endsWith("/")) return undefined;
    const parent = path.posix.dirname(uri.pathname);
    if (parent === "/" || parent === ".") return undefined;
    uri.username = ""; uri.password = ""; uri.search = ""; uri.hash = "";
    uri.pathname = `${parent}/`;
    return uri.toString();
  } catch { return undefined; }
}

export function directoryLocations(files: readonly WorkspaceFileLocation[], sourceForLayer: (layerId: string) => string | undefined): WorkspaceDirectory[] {
  const collector = new WorkspaceDirectoryCollector(sourceForLayer);
  files.forEach(file => collector.addFile(file));
  return collector.result();
}

/** Merge incrementally so repeated files do not copy a parent's cell list on every hit. */
export class WorkspaceDirectoryCollector {
  readonly #directories = new Map<string, { directory: WorkspaceDirectory; cells: Set<number> }>();
  truncated = false;
  constructor(readonly sourceForLayer: (layerId: string) => string | undefined, readonly maximumDirectories = Infinity) {}

  addFile(file: WorkspaceFileLocation): boolean {
    const directoryUri = immediateParentDirectory(file.sourceUri);
    const sourceId = this.sourceForLayer(file.layerId);
    if (!directoryUri || !sourceId) return false;
    return this.addDirectory({ sourceId, layerId: file.layerId, surveyId: file.surveyId, releaseId: file.releaseId,
      product: file.product, modality: file.modality, directoryUri, order: file.order, matchingCells: file.matchingCells,
      precision: file.precision, ...(file.matchingCellsTruncated === undefined ? {} : { matchingCellsTruncated: file.matchingCellsTruncated }) });
  }

  addDirectory(directory: WorkspaceDirectory): boolean {
    const key = JSON.stringify([directory.sourceId, directory.layerId, directory.releaseId, directory.modality, directory.directoryUri, directory.order]);
    let retained = this.#directories.get(key);
    if (!retained) {
      if (this.#directories.size >= this.maximumDirectories) { this.truncated = true; return false; }
      retained = { directory: { ...directory, matchingCells: [] }, cells: new Set() };
      this.#directories.set(key, retained);
    }
    for (const cell of directory.matchingCells) {
      if (retained.cells.size < 4096 || retained.cells.has(cell)) retained.cells.add(cell);
      else retained.directory.matchingCellsTruncated = true;
    }
    if (directory.matchingCellsTruncated) retained.directory.matchingCellsTruncated = true;
    retained.directory.precision = [retained.directory.precision, directory.precision].includes("entrypoint-only") ? "entrypoint-only"
      : [retained.directory.precision, directory.precision].includes("estimated") ? "estimated" : "exact";
    return true;
  }

  result(): WorkspaceDirectory[] {
    return [...this.#directories.values()].map(({ directory, cells }) => ({ ...directory, matchingCells: [...cells].sort((a, b) => a - b) }))
      .sort((a, b) => a.layerId.localeCompare(b.layerId) || a.directoryUri.localeCompare(b.directoryUri) || a.order - b.order);
  }
}

/** Project query bounds to the actual index order without creating finer coverage evidence. */
export function regionPixelFilter(field: string, sourceOrder: number, queryOrder: number, cells: readonly number[]): Record<string, unknown> {
  const factor = 4 ** Math.abs(sourceOrder - queryOrder);
  const intervals = [...new Set(cells)].sort((a, b) => a - b).map((cell) => sourceOrder >= queryOrder
    ? { first: cell * factor, last: (cell + 1) * factor - 1 }
    : { first: Math.floor(cell / factor), last: Math.floor(cell / factor) });
  const merged: typeof intervals = [];
  for (const interval of intervals) {
    const previous = merged.at(-1);
    if (previous && interval.first <= previous.last + 1) previous.last = Math.max(previous.last, interval.last);
    else merged.push({ ...interval });
  }
  if (merged.length === 1) return { range: { [field]: { gte: merged[0]!.first, lte: merged[0]!.last } } };
  return { bool: { should: merged.map((interval) => ({ range: { [field]: { gte: interval.first, lte: interval.last } } })), minimum_should_match: 1 } };
}

export function regionContainsCell(sourceOrder: number, pixel: number, queryOrder: number, cells: ReadonlySet<number>): boolean {
  if (sourceOrder >= queryOrder) return cells.has(Math.floor(pixel / 4 ** (sourceOrder - queryOrder)));
  for (const cell of cells) if (Math.floor(cell / 4 ** (queryOrder - sourceOrder)) === pixel) return true;
  return false;
}
