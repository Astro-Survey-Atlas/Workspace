import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { profileCatalogCsv } from "./profile.js";
import type { DatasetRecord, RegistryState } from "./types.js";

export interface RegistryOptions {
  statePath: string;
  allowedRoots: string[];
  now?: () => Date;
}

function isWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`) && relative !== "..");
}

export class JsonDatasetRegistry {
  readonly #statePath: string;
  readonly #allowedRoots: string[];
  readonly #now: () => Date;

  constructor(options: RegistryOptions) {
    if (options.allowedRoots.length === 0) throw new Error("At least one allowed data root is required");
    this.#statePath = path.resolve(options.statePath);
    this.#allowedRoots = options.allowedRoots.map((root) => path.resolve(root));
    this.#now = options.now ?? (() => new Date());
  }

  async #load(): Promise<RegistryState> {
    try {
      const parsed = JSON.parse(await readFile(this.#statePath, "utf8")) as RegistryState;
      if (parsed.version !== 1 || !Array.isArray(parsed.datasets)) {
        throw new Error("Unsupported registry state format");
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, datasets: [] };
      throw error;
    }
  }

  async #save(state: RegistryState): Promise<void> {
    const directory = path.dirname(this.#statePath);
    await mkdir(directory, { recursive: true });
    const temporaryPath = path.join(directory, `.${path.basename(this.#statePath)}.${process.pid}.tmp`);
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.#statePath);
  }

  async #assertAllowed(inputPath: string): Promise<string> {
    const candidate = await realpath(inputPath);
    const roots = await Promise.all(this.#allowedRoots.map((root) => realpath(root)));
    if (!roots.some((root) => isWithinRoot(candidate, root))) {
      throw new Error(`Path is outside configured data roots: ${candidate}`);
    }
    return candidate;
  }

  async registerLocalCsv(inputPath: string, name?: string): Promise<DatasetRecord> {
    const canonicalPath = await this.#assertAllowed(inputPath);
    const profile = await profileCatalogCsv(canonicalPath);
    const id = createHash("sha256").update(`local-file:${canonicalPath}`).digest("hex").slice(0, 24);
    const state = await this.#load();
    const existing = state.datasets.find((dataset) => dataset.id === id);
    const timestamp = this.#now().toISOString();
    const record: DatasetRecord = {
      id,
      name: name?.trim() || path.basename(canonicalPath),
      uri: `file://${canonicalPath}`,
      profile,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };

    state.datasets = [...state.datasets.filter((dataset) => dataset.id !== id), record];
    await this.#save(state);
    return record;
  }

  async list(): Promise<DatasetRecord[]> {
    const state = await this.#load();
    return state.datasets.sort((left, right) => left.name.localeCompare(right.name));
  }

  async get(id: string): Promise<DatasetRecord> {
    const dataset = (await this.#load()).datasets.find((candidate) => candidate.id === id);
    if (!dataset) throw new Error(`Dataset not found: ${id}`);
    return dataset;
  }
}
