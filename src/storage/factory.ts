import { PostgresMetadataStore } from "./postgres.js";
import { SqliteMetadataStore } from "./sqlite.js";
import type { MetadataStore } from "./types.js";

export interface MetadataStoreEnvironment {
  ASTRO_METADATA_STORE?: string;
  ASTRO_SQLITE_PATH?: string;
  ASTRO_DATABASE_URL?: string;
  ASTRO_DATABASE_SCHEMA?: string;
}

export function createMetadataStore(environment: MetadataStoreEnvironment = process.env): MetadataStore {
  const backend = environment.ASTRO_METADATA_STORE || "sqlite";
  if (backend === "sqlite") {
    return new SqliteMetadataStore(environment.ASTRO_SQLITE_PATH || "/state/workspace.sqlite");
  }
  if (backend === "postgres") {
    if (!environment.ASTRO_DATABASE_URL) {
      throw new Error("ASTRO_DATABASE_URL is required when ASTRO_METADATA_STORE=postgres");
    }
    return new PostgresMetadataStore(environment.ASTRO_DATABASE_URL, environment.ASTRO_DATABASE_SCHEMA || "astro_workspace");
  }
  throw new RangeError(`Unsupported ASTRO_METADATA_STORE: ${backend}`);
}
