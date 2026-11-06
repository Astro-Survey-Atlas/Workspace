import { mkdir } from "node:fs/promises";
import path from "node:path";
import { backup, DatabaseSync, type StatementSync } from "node:sqlite";

import type { ConnectorIngestRunFilter, ConnectorIngestRunRecord } from "../connector-history.js";
import type { ConnectorRecord } from "../connectors.js";
import type { DataAssetRecord } from "../data-catalog.js";
import { assertPersistableDataAsset, type MetadataStore, type MetadataTransaction, type SurveyIdentityRecord } from "./types.js";

const MIGRATIONS = [{
  version: 1,
  sql: `
    CREATE TABLE connectors (
      id TEXT PRIMARY KEY,
      location_key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('s3', 'local', 'jdbc')),
      status TEXT NOT NULL CHECK (status IN ('draft', 'ready', 'disabled')),
      updated_at TEXT NOT NULL,
      record TEXT NOT NULL CHECK (json_valid(record)),
      CHECK (json_extract(record, '$.id') = id),
      CHECK (json_extract(record, '$.locationKey') = location_key)
    ) STRICT;
    CREATE INDEX connectors_kind_idx ON connectors(kind);
    CREATE INDEX connectors_status_idx ON connectors(status);

    CREATE TABLE data_assets (
      id TEXT PRIMARY KEY,
      origin TEXT NOT NULL CHECK (origin IN ('user', 'override')),
      survey_id TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('catalog', 'image', 'spectra', 'cube', 'timeseries', 'other')),
      status TEXT NOT NULL CHECK (status IN ('ready', 'metadata_only', 'unavailable')),
      updated_at TEXT NOT NULL,
      record TEXT NOT NULL CHECK (json_valid(record)),
      CHECK (json_extract(record, '$.id') = id),
      CHECK (json_extract(record, '$.origin') = origin)
    ) STRICT;
    CREATE INDEX data_assets_survey_id_idx ON data_assets(survey_id);
    CREATE INDEX data_assets_kind_idx ON data_assets(kind);
    CREATE INDEX data_assets_status_idx ON data_assets(status);

    CREATE TABLE connector_ingest_runs (
      id TEXT PRIMARY KEY,
      location_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
      created_at TEXT NOT NULL,
      record TEXT NOT NULL CHECK (json_valid(record)),
      CHECK (json_extract(record, '$.id') = id),
      CHECK (json_extract(record, '$.locationKey') = location_key)
    ) STRICT;
    CREATE INDEX connector_ingest_runs_location_created_idx
      ON connector_ingest_runs(location_key, created_at DESC);
  `,
}, {
  version: 2,
  sql: `
    ALTER TABLE connector_ingest_runs ADD COLUMN connector_id TEXT;
    ALTER TABLE connector_ingest_runs ADD COLUMN connector_kind TEXT
      CHECK (connector_kind IS NULL OR connector_kind IN ('s3', 'local', 'jdbc'));
    ALTER TABLE connector_ingest_runs ADD COLUMN idempotency_key_hash TEXT;
    UPDATE connector_ingest_runs SET
      connector_id = json_extract(record, '$.connectorId'),
      connector_kind = json_extract(record, '$.connectorKind'),
      idempotency_key_hash = json_extract(record, '$.idempotencyKeyHash');
    CREATE INDEX connector_ingest_runs_connector_created_idx
      ON connector_ingest_runs(connector_id, created_at DESC);
    CREATE INDEX connector_ingest_runs_kind_created_idx
      ON connector_ingest_runs(connector_kind, created_at DESC);
    CREATE UNIQUE INDEX connector_ingest_runs_idempotency_idx
      ON connector_ingest_runs(connector_id, idempotency_key_hash)
      WHERE connector_id IS NOT NULL AND idempotency_key_hash IS NOT NULL;
  `,
}, {
  version: 3,
  sql: `CREATE TABLE survey_identities (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL CHECK (source IN ('user', 'assets')),
    source_id TEXT NOT NULL,
    record TEXT NOT NULL CHECK (json_valid(record)),
    UNIQUE (source, source_id),
    CHECK (json_extract(record, '$.id') = id)
  ) STRICT;`,
}, {
  version: 4,
  sql: `CREATE TABLE statistics_snapshots (
    id TEXT PRIMARY KEY, slot TEXT NOT NULL, updated_at TEXT NOT NULL, record TEXT NOT NULL CHECK(json_valid(record))
  ) STRICT;
  CREATE INDEX statistics_snapshots_slot_idx ON statistics_snapshots(slot);
  CREATE TABLE statistics_entries (
    snapshot_id TEXT NOT NULL, file_key TEXT NOT NULL, size_bytes REAL,
    PRIMARY KEY(snapshot_id, file_key)
  ) STRICT;`,
}, {
  version: 5,
  sql: `
    ALTER TABLE connector_ingest_runs RENAME TO old_connector_ingest_runs;
    CREATE TABLE connector_ingest_runs (
      id TEXT PRIMARY KEY, location_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued','running','paused','cancelled','succeeded','failed')),
      created_at TEXT NOT NULL, record TEXT NOT NULL CHECK(json_valid(record)),
      connector_id TEXT, connector_kind TEXT, idempotency_key_hash TEXT,
      CHECK(json_extract(record,'$.id')=id), CHECK(json_extract(record,'$.locationKey')=location_key)
    ) STRICT;
    INSERT INTO connector_ingest_runs SELECT id,location_key,status,created_at,record,connector_id,connector_kind,idempotency_key_hash FROM old_connector_ingest_runs;
    DROP TABLE old_connector_ingest_runs;
    CREATE INDEX connector_ingest_runs_location_idx ON connector_ingest_runs(location_key,created_at DESC);
    CREATE INDEX connector_ingest_runs_connector_idx ON connector_ingest_runs(connector_id,created_at DESC);
    CREATE INDEX connector_ingest_runs_status_idx ON connector_ingest_runs(status);
    CREATE UNIQUE INDEX connector_ingest_runs_idempotency_idx ON connector_ingest_runs(connector_id,idempotency_key_hash) WHERE idempotency_key_hash IS NOT NULL;
  `,
}];

type SqliteRow = Record<string, unknown>;

class SqliteTransaction implements MetadataTransaction {
  constructor(private readonly database: DatabaseSync) {}

  async listSurveyIdentities(): Promise<SurveyIdentityRecord[]> {
    return this.records<SurveyIdentityRecord>("SELECT record FROM survey_identities ORDER BY id");
  }

  async putSurveyIdentity(record: SurveyIdentityRecord): Promise<void> {
    this.database.prepare(`INSERT INTO survey_identities (id, source, source_id, record) VALUES (?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET record = excluded.record`)
      .run(record.id, record.source, record.sourceId, JSON.stringify(record));
  }

  async deleteSurveyIdentity(id: string): Promise<boolean> {
    return this.database.prepare("DELETE FROM survey_identities WHERE id = ?").run(id).changes > 0;
  }

  async listConnectors(): Promise<ConnectorRecord[]> {
    return this.records<ConnectorRecord>("SELECT record FROM connectors ORDER BY id");
  }

  async getConnector(id: string): Promise<ConnectorRecord | undefined> {
    return this.record<ConnectorRecord>("SELECT record FROM connectors WHERE id = ?", id);
  }

  async getConnectorByLocationKey(locationKey: string): Promise<ConnectorRecord | undefined> {
    return this.record<ConnectorRecord>("SELECT record FROM connectors WHERE location_key = ?", locationKey);
  }

  async putConnector(record: ConnectorRecord): Promise<void> {
    this.database.prepare(`INSERT INTO connectors (id, location_key, kind, status, updated_at, record)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET location_key = excluded.location_key, kind = excluded.kind,
        status = excluded.status, updated_at = excluded.updated_at, record = excluded.record`)
      .run(record.id, record.locationKey, record.kind, record.status, record.updatedAt, JSON.stringify(record));
  }

  async deleteConnector(id: string): Promise<boolean> {
    return this.database.prepare("DELETE FROM connectors WHERE id = ?").run(id).changes > 0;
  }

  async listDataAssets(): Promise<DataAssetRecord[]> {
    return this.records<DataAssetRecord>("SELECT record FROM data_assets ORDER BY id");
  }

  async getDataAsset(id: string): Promise<DataAssetRecord | undefined> {
    return this.record<DataAssetRecord>("SELECT record FROM data_assets WHERE id = ?", id);
  }

  async putDataAsset(record: DataAssetRecord): Promise<void> {
    assertPersistableDataAsset(record);
    this.database.prepare(`INSERT INTO data_assets (id, origin, survey_id, kind, status, updated_at, record)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET origin = excluded.origin, survey_id = excluded.survey_id,
        kind = excluded.kind, status = excluded.status, updated_at = excluded.updated_at, record = excluded.record`)
      .run(record.id, record.origin, record.surveyId ?? null, record.kind, record.status, record.updatedAt, JSON.stringify(record));
  }

  async deleteDataAsset(id: string): Promise<boolean> {
    return this.database.prepare("DELETE FROM data_assets WHERE id = ?").run(id).changes > 0;
  }

  async listConnectorIngestRuns(value: ConnectorIngestRunFilter | string = {}): Promise<ConnectorIngestRunRecord[]> {
    const filter = typeof value === "string" ? { locationKey: value } : value;
    const clauses: string[] = [];
    const parameters: string[] = [];
    if (filter.locationKey !== undefined) { clauses.push("location_key = ?"); parameters.push(filter.locationKey); }
    if (filter.connectorId !== undefined) { clauses.push("connector_id = ?"); parameters.push(filter.connectorId); }
    if (filter.connectorKind !== undefined) { clauses.push("connector_kind = ?"); parameters.push(filter.connectorKind); }
    if (filter.status !== undefined) { clauses.push("status = ?"); parameters.push(filter.status); }
    if (filter.assetIds !== undefined) {
      clauses.push("(json_extract(record, '$.assetId') IN (SELECT value FROM json_each(?)) OR EXISTS (SELECT 1 FROM json_each(json_extract(record, '$.assetIds')) WHERE value IN (SELECT value FROM json_each(?))))");
      parameters.push(JSON.stringify(filter.assetIds), JSON.stringify(filter.assetIds));
    }
    if (filter.qualityOnly) clauses.push("json_extract(record, '$.parentRunId') IS NULL AND json_extract(record, '$.fitsQualityProfile') IS NOT NULL");
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    return this.records<ConnectorIngestRunRecord>(`SELECT record FROM connector_ingest_runs${where} ORDER BY created_at DESC, id DESC`, ...parameters);
  }

  async getConnectorIngestRun(id: string): Promise<ConnectorIngestRunRecord | undefined> {
    return this.record<ConnectorIngestRunRecord>("SELECT record FROM connector_ingest_runs WHERE id = ?", id);
  }

  async createConnectorIngestRun(record: ConnectorIngestRunRecord): Promise<{ record: ConnectorIngestRunRecord; created: boolean }> {
    if (record.connectorId && record.idempotencyKeyHash) {
      const current = this.record<ConnectorIngestRunRecord>("SELECT record FROM connector_ingest_runs WHERE connector_id = ? AND idempotency_key_hash = ?", record.connectorId, record.idempotencyKeyHash);
      if (current) return { record: current, created: false };
    }
    await this.putConnectorIngestRun(record);
    return { record, created: true };
  }

  async putConnectorIngestRun(record: ConnectorIngestRunRecord): Promise<void> {
    this.database.prepare(`INSERT INTO connector_ingest_runs (id, location_key, connector_id, connector_kind, idempotency_key_hash, status, created_at, record)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET location_key = excluded.location_key, status = excluded.status,
        connector_id = excluded.connector_id, connector_kind = excluded.connector_kind,
        idempotency_key_hash = excluded.idempotency_key_hash, created_at = excluded.created_at, record = excluded.record`)
      .run(record.id, record.locationKey, record.connectorId ?? null, record.connectorKind ?? null,
        record.idempotencyKeyHash ?? null, record.status, record.createdAt, JSON.stringify(record));
  }

  async deleteConnectorIngestRun(id: string): Promise<boolean> {
    return this.database.prepare("DELETE FROM connector_ingest_runs WHERE id = ?").run(id).changes > 0;
  }

  async getImportMarker(name: string): Promise<string | undefined> {
    const row = this.database.prepare("SELECT value FROM import_markers WHERE name = ?").get(name) as SqliteRow | undefined;
    return row?.value as string | undefined;
  }

  async setImportMarker(name: string, value: string): Promise<void> {
    this.database.prepare(`INSERT INTO import_markers (name, value, imported_at) VALUES (?, ?, ?)
      ON CONFLICT (name) DO UPDATE SET value = excluded.value, imported_at = excluded.imported_at`)
      .run(name, value, new Date().toISOString());
  }

  private record<T>(sql: string, ...parameters: (string | null)[]): T | undefined {
    const row = this.database.prepare(sql).get(...parameters) as SqliteRow | undefined;
    return row ? JSON.parse(row.record as string) as T : undefined;
  }

  private records<T>(sql: string, ...parameters: (string | null)[]): T[] {
    return (this.database.prepare(sql) as StatementSync).all(...parameters)
      .map((row) => JSON.parse((row as SqliteRow).record as string) as T);
  }
}

export class SqliteMetadataStore implements MetadataStore {
  private database?: DatabaseSync;
  private queue: Promise<void> = Promise.resolve();

  constructor(readonly filename: string, readonly options: { cacheSizeKiB?: number } = {}) {}

  /** Export committed pages while excluding writes on this connection. */
  async exportDatabase(filename: string): Promise<void> {
    await this.serialized(async () => { await backup(this.requireDatabase(), filename); });
  }

  async initialize(): Promise<void> {
    await this.serialized(async () => {
      if (this.database) return;
      if (this.filename !== ":memory:") await mkdir(path.dirname(this.filename), { recursive: true });
      const database = new DatabaseSync(this.filename);
      try {
        database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 100;");
        if (this.options.cacheSizeKiB !== undefined) {
          if (!Number.isSafeInteger(this.options.cacheSizeKiB) || this.options.cacheSizeKiB < 1) throw new RangeError("Invalid SQLite cache size");
          database.exec(`PRAGMA cache_size = -${this.options.cacheSizeKiB};`);
        }
        database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS import_markers (
          name TEXT PRIMARY KEY, value TEXT NOT NULL, imported_at TEXT NOT NULL
        ) STRICT;`);
        for (const migration of MIGRATIONS) {
          await this.transactionBoundary(database, "BEGIN IMMEDIATE");
          try {
            const applied = database.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(migration.version);
            if (!applied) {
              database.exec(migration.sql);
              database.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
                .run(migration.version, new Date().toISOString());
            }
            await this.transactionBoundary(database, "COMMIT");
          } catch (error) {
            database.exec("ROLLBACK");
            throw error;
          }
        }
        this.database = database;
      } catch (error) {
        database.close();
        throw error;
      }
    });
  }

  async transaction<T>(operation: (transaction: MetadataTransaction) => Promise<T>): Promise<T> {
    return this.serialized(async () => {
      const database = this.requireDatabase();
      await this.transactionBoundary(database, "BEGIN IMMEDIATE");
      try {
        const result = await operation(new SqliteTransaction(database));
        await this.transactionBoundary(database, "COMMIT");
        return result;
      } catch (error) {
        try { database.exec("ROLLBACK"); } catch { /* Preserve the transaction's original error. */ }
        throw error;
      }
    });
  }

  private async transactionBoundary(database: DatabaseSync, statement: "BEGIN IMMEDIATE" | "COMMIT"): Promise<void> {
    await this.retryLocked(() => database.exec(statement));
  }

  private async retryLocked<T>(operation: () => T | Promise<T>): Promise<T> {
    const deadline = Date.now() + 5000;
    for (let attempt = 0; ; attempt++) {
      try { return await operation(); }
      catch (error) {
        if (!(error instanceof Error) || !/database (?:is )?(?:locked|busy)/i.test(error.message) || Date.now() >= deadline) throw error;
        // Yield so readers/writers on other connections can finish. Retry only
        // the boundary, never a transaction callback with external effects.
        await new Promise(resolve => setTimeout(resolve, Math.min(25 * 2 ** attempt, 250)));
      }
    }
  }

  async close(): Promise<void> {
    await this.serialized(async () => {
      this.database?.close();
      this.database = undefined;
    });
  }

  listSurveyIdentities = () => this.read((transaction) => transaction.listSurveyIdentities());
  putSurveyIdentity = (record: SurveyIdentityRecord) => this.transaction((transaction) => transaction.putSurveyIdentity(record));
  deleteSurveyIdentity = (id: string) => this.transaction(tx => tx.deleteSurveyIdentity(id));
  listConnectors = () => this.read((transaction) => transaction.listConnectors());
  getConnector = (id: string) => this.read((transaction) => transaction.getConnector(id));
  getConnectorByLocationKey = (locationKey: string) => this.read((transaction) => transaction.getConnectorByLocationKey(locationKey));
  putConnector = (record: ConnectorRecord) => this.transaction((transaction) => transaction.putConnector(record));
  deleteConnector = (id: string) => this.transaction((transaction) => transaction.deleteConnector(id));
  listDataAssets = () => this.read((transaction) => transaction.listDataAssets());
  getDataAsset = (id: string) => this.read((transaction) => transaction.getDataAsset(id));
  putDataAsset = (record: DataAssetRecord) => this.transaction((transaction) => transaction.putDataAsset(record));
  deleteDataAsset = (id: string) => this.transaction((transaction) => transaction.deleteDataAsset(id));
  listConnectorIngestRuns = (filter?: ConnectorIngestRunFilter | string) => this.read((transaction) => transaction.listConnectorIngestRuns(filter));
  getConnectorIngestRun = (id: string) => this.read((transaction) => transaction.getConnectorIngestRun(id));
  createConnectorIngestRun = (record: ConnectorIngestRunRecord) => this.transaction((transaction) => transaction.createConnectorIngestRun(record));
  putConnectorIngestRun = (record: ConnectorIngestRunRecord) => this.transaction((transaction) => transaction.putConnectorIngestRun(record));
  deleteConnectorIngestRun = (id: string) => this.transaction((transaction) => transaction.deleteConnectorIngestRun(id));
  getImportMarker = (name: string) => this.read((transaction) => transaction.getImportMarker(name));
  setImportMarker = (name: string, value: string) => this.transaction((transaction) => transaction.setImportMarker(name, value));

  private async read<T>(operation: (transaction: MetadataTransaction) => Promise<T>): Promise<T> {
    return this.serialized(() => this.retryLocked(() => operation(new SqliteTransaction(this.requireDatabase()))));
  }

  private requireDatabase(): DatabaseSync {
    if (!this.database) throw new Error("SQLite metadata store is not initialized");
    return this.database;
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}
