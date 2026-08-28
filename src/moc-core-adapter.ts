import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { CoverageDataOrigin, CoverageRole, CoverageSourceTier } from "./assets-core.js";

const execFileAsync = promisify(execFile);

export const MOC_CORE_DEFAULT_MAX_ORDER = 10;
export const MOC_CORE_QUERY_ORDER = 8;
export const MOC_CORE_PREVIEW_ORDER = 4;

export interface MocCoreCatalogInput {
  inputPath: string;
  layerId: string;
  raColumn: string;
  decColumn: string;
  coverageRole: CoverageRole;
  dataOrigin: CoverageDataOrigin;
  sourceTier: CoverageSourceTier;
  maxOrder?: number;
  queryOrder?: number;
  previewOrder?: number;
}

export interface MocCoreCatalogResult {
  layerId: string;
  maxOrder: number;
  queryOrder: number;
  previewOrder: number;
  queryPixels: number[];
  previewPixels: number[];
  mocSha256?: string;
  /** Files emitted by MOC Core before its temporary work directory is removed. */
  artifacts?: {
    moc?: Uint8Array;
    query?: Uint8Array;
    preview?: Uint8Array;
    statistics?: Uint8Array;
    provenance?: Uint8Array;
  };
}

export interface MocCoreNestedHealpixInput {
  layerId: string;
  cells: readonly { order: number; ipix: number }[];
  coverageRole: "image_extent" | "object_presence" | "footprint_extent";
  dataOrigin: CoverageDataOrigin;
  sourceTier: CoverageSourceTier;
  maxOrder?: number;
  queryOrder?: number;
  previewOrder?: number;
}

export interface MocCoreAdapter {
  buildCatalog(input: MocCoreCatalogInput): Promise<MocCoreCatalogResult>;
  /** Build an authoritative MOC from already validated NESTED cells. */
  buildNestedHealpix?(input: MocCoreNestedHealpixInput): Promise<MocCoreCatalogResult>;
}

export class MocCoreUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MocCoreUnavailableError";
  }
}

function stableLayerId(value: string): string {
  const result = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!result) throw new RangeError("MOC Core layerId must contain at least one ASCII identifier character");
  return result.slice(0, 180);
}

function positiveOrder(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 0 || result > 29) throw new RangeError(`${name} must be an integer between 0 and 29`);
  return result;
}

function pixels(value: unknown, order: number, label: string): number[] {
  if (!Array.isArray(value) || value.some((entry) => !Number.isSafeInteger(entry) || (entry as number) < 0 || (entry as number) >= 12 * 4 ** order)) {
    throw new MocCoreUnavailableError(`MOC Core returned an invalid ${label} projection`);
  }
  return [...new Set(value as number[])].sort((left, right) => left - right);
}

function jsonResult(stdout: string): Record<string, unknown> {
  const line = stdout.trim().split("\n").filter(Boolean).at(-1);
  if (!line) throw new MocCoreUnavailableError("MOC Core returned no JSON result");
  try {
    const value = JSON.parse(line) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new MocCoreUnavailableError("MOC Core returned invalid JSON");
  }
}

/** Invoke the pinned Assets Core CLI. No geometry implementation lives in Atlas. */
export class MocCoreCliAdapter implements MocCoreAdapter {
  readonly #command: string;
  readonly #timeoutMs: number;

  constructor(command = process.env.ASTRO_MOC_CORE_CLI ?? "astro-survey-moc-core", timeoutMs = 120_000) {
    this.#command = command.trim() || "astro-survey-moc-core";
    this.#timeoutMs = timeoutMs;
  }

  async buildCatalog(input: MocCoreCatalogInput): Promise<MocCoreCatalogResult> {
    const maxOrder = positiveOrder(input.maxOrder, MOC_CORE_DEFAULT_MAX_ORDER, "maxOrder");
    const queryOrder = positiveOrder(input.queryOrder, MOC_CORE_QUERY_ORDER, "queryOrder");
    const previewOrder = positiveOrder(input.previewOrder, MOC_CORE_PREVIEW_ORDER, "previewOrder");
    if (queryOrder !== MOC_CORE_QUERY_ORDER || previewOrder !== MOC_CORE_PREVIEW_ORDER) {
      throw new RangeError("MOC Core queryOrder is fixed at 8 and previewOrder is fixed at 4");
    }
    const work = await mkdtemp(path.join(os.tmpdir(), "astro-atlas-moc-core-"));
    const specPath = path.join(work, "spec.json");
    const outputPath = path.join(work, "build");
    const layerId = stableLayerId(input.layerId);
    await writeFile(specPath, JSON.stringify({
      layerId,
      mode: "catalog-radec",
      input: path.resolve(input.inputPath),
      coverageRole: input.coverageRole,
      dataOrigin: input.dataOrigin,
      sourceTier: input.sourceTier,
      maxOrder,
      queryOrder,
      previewOrder,
      coordinateFrame: "ICRS",
      ordering: "NESTED",
      recipe: { raColumn: input.raColumn, decColumn: input.decColumn },
    }), "utf8");
    try {
      const stdout = await this.#runBuild(specPath, outputPath);
      const result = jsonResult(stdout);
      const queryPath = path.join(outputPath, "query-order8.json");
      const previewPath = path.join(outputPath, "preview-order4.json");
      const query = JSON.parse(await readFile(queryPath, "utf8")) as Record<string, unknown>;
      const preview = JSON.parse(await readFile(previewPath, "utf8")) as Record<string, unknown>;
      if (query.order !== queryOrder || query.ordering !== "NESTED" || preview.order !== previewOrder || preview.ordering !== "NESTED") {
        throw new MocCoreUnavailableError("MOC Core returned projections with an invalid order or ordering");
      }
      const mocPath = path.join(outputPath, `${layerId}.moc.fits`);
      const fallbackMocPath = path.join(outputPath, "moc.fits");
      const readOptional = async (...paths: string[]): Promise<Uint8Array | undefined> => {
        for (const candidate of paths) {
          try { return await readFile(candidate); } catch { /* output is optional for compatibility diagnostics */ }
        }
        return undefined;
      };
      const mocBytes = await readOptional(mocPath, fallbackMocPath);
      const statisticsBytes = await readOptional(path.join(outputPath, "statistics.json"));
      const provenanceBytes = await readOptional(path.join(outputPath, "provenance.json"));
      return {
        layerId,
        maxOrder,
        queryOrder,
        previewOrder,
        queryPixels: pixels(query.pixels, queryOrder, "query"),
        previewPixels: pixels(preview.pixels, previewOrder, "preview"),
        ...(typeof result.sha256 === "string" && /^[a-f0-9]{64}$/.test(result.sha256) ? { mocSha256: result.sha256 } : {}),
        artifacts: {
          ...(mocBytes ? { moc: mocBytes } : {}),
          query: await readFile(queryPath),
          preview: await readFile(previewPath),
          ...(statisticsBytes ? { statistics: statisticsBytes } : {}),
          ...(provenanceBytes ? { provenance: provenanceBytes } : {}),
        },
      };
    } catch (error) {
      if (error instanceof MocCoreUnavailableError) throw error;
      throw new MocCoreUnavailableError(error instanceof Error ? error.message : String(error));
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  async buildNestedHealpix(input: MocCoreNestedHealpixInput): Promise<MocCoreCatalogResult> {
    const maxOrder = positiveOrder(input.maxOrder, MOC_CORE_DEFAULT_MAX_ORDER, "maxOrder");
    const queryOrder = positiveOrder(input.queryOrder, MOC_CORE_QUERY_ORDER, "queryOrder");
    const previewOrder = positiveOrder(input.previewOrder, MOC_CORE_PREVIEW_ORDER, "previewOrder");
    if (queryOrder !== MOC_CORE_QUERY_ORDER || previewOrder !== MOC_CORE_PREVIEW_ORDER) {
      throw new RangeError("MOC Core queryOrder is fixed at 8 and previewOrder is fixed at 4");
    }
    if (!Array.isArray(input.cells) || input.cells.some((cell) => !cell || !Number.isSafeInteger(cell.order) || !Number.isSafeInteger(cell.ipix) || cell.order < 0 || cell.order > maxOrder || cell.ipix < 0 || cell.ipix >= 12 * 4 ** cell.order)) {
      throw new RangeError("nested HEALPix cells are invalid");
    }
    const work = await mkdtemp(path.join(os.tmpdir(), "astro-atlas-moc-core-nested-"));
    const inputPath = path.join(work, "cells.json");
    const specPath = path.join(work, "spec.json");
    const outputPath = path.join(work, "build");
    const layerId = stableLayerId(input.layerId);
    await writeFile(inputPath, JSON.stringify({ cells: input.cells.map((cell) => ({ order: cell.order, ipix: cell.ipix })) }), "utf8");
    await writeFile(specPath, JSON.stringify({
      layerId,
      mode: "nested-healpix",
      input: inputPath,
      coverageRole: input.coverageRole,
      dataOrigin: input.dataOrigin,
      sourceTier: input.sourceTier,
      maxOrder,
      queryOrder,
      previewOrder,
      coordinateFrame: "ICRS",
      ordering: "NESTED",
      recipe: { values: "ipix" },
    }), "utf8");
    try {
      const result = jsonResult(await this.#runBuild(specPath, outputPath));
      const queryPath = path.join(outputPath, "query-order8.json");
      const previewPath = path.join(outputPath, "preview-order4.json");
      const query = JSON.parse(await readFile(queryPath, "utf8")) as Record<string, unknown>;
      const preview = JSON.parse(await readFile(previewPath, "utf8")) as Record<string, unknown>;
      if (query.order !== queryOrder || query.ordering !== "NESTED" || preview.order !== previewOrder || preview.ordering !== "NESTED") {
        throw new MocCoreUnavailableError("MOC Core returned projections with an invalid order or ordering");
      }
      const readOptional = async (...paths: string[]): Promise<Uint8Array | undefined> => {
        for (const candidate of paths) {
          try { return await readFile(candidate); } catch { /* optional output */ }
        }
        return undefined;
      };
      const mocBytes = await readOptional(path.join(outputPath, `${layerId}.moc.fits`), path.join(outputPath, "moc.fits"));
      const statistics = await readOptional(path.join(outputPath, "statistics.json"));
      const provenance = await readOptional(path.join(outputPath, "provenance.json"));
      return {
        layerId, maxOrder, queryOrder, previewOrder,
        queryPixels: pixels(query.pixels, queryOrder, "query"),
        previewPixels: pixels(preview.pixels, previewOrder, "preview"),
        ...(typeof result.sha256 === "string" && /^[a-f0-9]{64}$/.test(result.sha256) ? { mocSha256: result.sha256 } : {}),
        artifacts: {
          ...(mocBytes ? { moc: mocBytes } : {}),
          query: await readFile(queryPath),
          preview: await readFile(previewPath),
          ...(statistics ? { statistics } : {}),
          ...(provenance ? { provenance } : {}),
        },
      };
    } catch (error) {
      if (error instanceof MocCoreUnavailableError) throw error;
      throw new MocCoreUnavailableError(error instanceof Error ? error.message : String(error));
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  async #runBuild(specPath: string, outputPath: string): Promise<string> {
    try {
      const [program, ...prefixArgs] = this.#command.split(/\s+/);
      const { stdout } = await execFileAsync(program!, [...prefixArgs, "build", "--spec", specPath, "--output", outputPath, "--base-dir", "/"], {
        timeout: this.#timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
      });
      return stdout;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new MocCoreUnavailableError(`MOC Core build failed: ${detail.slice(0, 500)}`);
    }
  }
}

export const defaultMocCoreAdapter: MocCoreAdapter = new MocCoreCliAdapter();
