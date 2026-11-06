import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import path from "node:path";

/** Small control records share the local metadata database, never scientific rows. */
export class LocalState {
  #database?: DatabaseSync;
  constructor(readonly filename: string) {}

  async initialize(): Promise<void> {
    if (this.#database) return;
    await mkdir(path.dirname(this.filename), { recursive: true });
    const database = new DatabaseSync(this.filename);
    database.exec(`PRAGMA busy_timeout=100; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS workspace_state (
        namespace TEXT NOT NULL, id TEXT NOT NULL, updated_at TEXT NOT NULL,
        record TEXT NOT NULL CHECK(json_valid(record)), PRIMARY KEY(namespace,id)
      ) STRICT;`);
    this.#database = database;
  }

  get<T>(namespace: string, id: string): T | undefined {
    const row = this.database.prepare("SELECT record FROM workspace_state WHERE namespace=? AND id=?").get(namespace, id);
    return row ? JSON.parse(String(row.record)) as T : undefined;
  }

  list<T>(namespace: string, limit = 100, offset = 0): T[] {
    return this.database.prepare("SELECT record FROM workspace_state WHERE namespace=? ORDER BY updated_at DESC,id LIMIT ? OFFSET ?")
      .all(namespace, limit, offset).map(row => JSON.parse(String(row.record)) as T);
  }

  put(namespace: string, id: string, record: unknown): void {
    this.database.prepare(`INSERT INTO workspace_state(namespace,id,updated_at,record) VALUES(?,?,?,?)
      ON CONFLICT(namespace,id) DO UPDATE SET updated_at=excluded.updated_at,record=excluded.record`)
      .run(namespace, id, new Date().toISOString(), JSON.stringify(record));
  }

  delete(namespace: string, id: string): void {
    this.database.prepare("DELETE FROM workspace_state WHERE namespace=? AND id=?").run(namespace, id);
  }

  close(): void { this.#database?.close(); this.#database = undefined; }
  private get database(): DatabaseSync {
    if (!this.#database) throw new Error("Local state has not been initialized");
    return this.#database;
  }
}
