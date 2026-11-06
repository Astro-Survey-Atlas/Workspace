import { readFile } from "node:fs/promises";
import path from "node:path";

/** Published O8 point cells. Reads stay bounded and never perform a full-sky ES query. */
export class PointPresence {
  readonly #cache = new Map<string, readonly number[]>();
  constructor(readonly root: string) {}
  async pixels(reference: string, order: number): Promise<ReadonlySet<number>> {
    if (!Number.isInteger(order) || order < 0 || order > 8) throw new RangeError("Point coverage supports HEALPix orders 0–8");
    if (!reference || !/^[a-zA-Z0-9_./-]+$/.test(reference) || reference.split("/").includes("..") || path.isAbsolute(reference)) throw new Error("Invalid point coverage reference");
    let cells = this.#cache.get(reference);
    if (!cells) {
      const bytes = await readFile(path.join(this.root, reference));
      if (bytes.length > 8 * 1024 * 1024) throw new Error("Point coverage exceeds 8 MiB");
      const parsed: unknown = JSON.parse(bytes.toString("utf8"));
      if (!Array.isArray(parsed) || parsed.length > 12 * 256 ** 2 || parsed.some(pixel => !Number.isSafeInteger(pixel) || pixel < 0 || pixel >= 12 * 256 ** 2)) throw new Error("Invalid point coverage cells");
      cells = parsed as number[];
      if (this.#cache.size >= 32) this.#cache.delete(this.#cache.keys().next().value!);
      this.#cache.set(reference, cells);
    }
    const factor = 4 ** (8 - order);
    return new Set(cells.map(pixel => Math.floor(pixel / factor)));
  }
}
