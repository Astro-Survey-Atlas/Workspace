import path from "node:path";
import { SqliteMetadataStore } from "./sqlite.js";
export interface MetadataStoreEnvironment { ASTRO_SQLITE_PATH?: string; ASTRO_STATE_ROOT?: string }
export function createMetadataStore(environment: MetadataStoreEnvironment = process.env): SqliteMetadataStore {
  return new SqliteMetadataStore(environment.ASTRO_SQLITE_PATH ?? path.resolve(environment.ASTRO_STATE_ROOT ?? "data", "workspace.sqlite"));
}
