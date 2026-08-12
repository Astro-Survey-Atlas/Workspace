import { Pool, type PoolClient, type QueryResultRow } from "pg";

import type { ConnectorIngestRun } from "../connector-history.js";
import type { ConnectorRecord } from "../connectors.js";
import type { DataAssetRecord } from "../data-catalog.js";
import { assertPersistableDataAsset, type MetadataStore, type MetadataTransaction } from "./types.js";

const SCHEMA_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function quoteSchema(schema: string): string {
  if (!SCHEMA_IDENTIFIER.test(schema)) {
    throw new RangeError("PostgreSQL metadata schema must be a valid unqualified identifier");
  }
  return `"${schema}"`;
}

class PostgresTransaction implements MetadataTransaction {
  constructor(private readonly client: Pool | PoolClient, private readonly schema: string) {}

  async listConnectors(): Promise<ConnectorRecord[]> {
    return this.records<ConnectorRecord>(`SELECT record FROM ${this.schema}.connectors ORDER BY id`);
  }

  async getConnector(id: string): Promise<ConnectorRecord | undefined> {
    return this.record<ConnectorRecord>(`SELECT record FROM ${this.schema}.connectors WHERE id = $1`, [id]);
  }

  async getConnectorByLocationKey(locationKey: string): Promise<ConnectorRecord | undefined> {
    return this.record<ConnectorRecord>(`SELECT record FROM ${this.schema}.connectors WHERE location_key = $1`, [locationKey]);
  }

  async putConnector(record: ConnectorRecord): Promise<void> {
    await this.client.query(`INSERT INTO ${this.schema}.connectors (id, location_key, kind, status, updated_at, record)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (id) DO UPDATE SET location_key = excluded.location_key, kind = excluded.kind,
        status = excluded.status, updated_at = excluded.updated_at, record = excluded.record`,
    [record.id, record.locationKey, record.kind, record.status, record.updatedAt, record]);
  }

  async deleteConnector(id: string): Promise<boolean> {
    return (await this.client.query(`DELETE FROM ${this.schema}.connectors WHERE id = $1`, [id])).rowCount === 1;
  }

  async listDataAssets(): Promise<DataAssetRecord[]> {
    return this.records<DataAssetRecord>(`SELECT record FROM ${this.schema}.data_assets ORDER BY id`);
  }

  async getDataAsset(id: string): Promise<DataAssetRecord | undefined> {
    return this.record<DataAssetRecord>(`SELECT record FROM ${this.schema}.data_assets WHERE id = $1`, [id]);
  }

  async putDataAsset(record: DataAssetRecord): Promise<void> {
    assertPersistableDataAsset(record);
    await this.client.query(`INSERT INTO ${this.schema}.data_assets (id, origin, survey_id, kind, status, updated_at, record)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (id) DO UPDATE SET origin = excluded.origin, survey_id = excluded.survey_id,
        kind = excluded.kind, status = excluded.status, updated_at = excluded.updated_at, record = excluded.record`,
    [record.id, record.origin, record.surveyId ?? null, record.kind, record.status, record.updatedAt, record]);
  }

  async deleteDataAsset(id: string): Promise<boolean> {
    return (await this.client.query(`DELETE FROM ${this.schema}.data_assets WHERE id = $1`, [id])).rowCount === 1;
  }

  async listConnectorIngestRuns(locationKey?: string): Promise<ConnectorIngestRun[]> {
    return locationKey === undefined
      ? this.records<ConnectorIngestRun>(`SELECT record FROM ${this.schema}.connector_ingest_runs ORDER BY created_at DESC, id DESC`)
      : this.records<ConnectorIngestRun>(`SELECT record FROM ${this.schema}.connector_ingest_runs WHERE location_key = $1 ORDER BY created_at DESC, id DESC`, [locationKey]);
  }

  async getConnectorIngestRun(id: string): Promise<ConnectorIngestRun | undefined> {
    return this.record<ConnectorIngestRun>(`SELECT record FROM ${this.schema}.connector_ingest_runs WHERE id = $1`, [id]);
  }

  async putConnectorIngestRun(record: ConnectorIngestRun): Promise<void> {
    await this.client.query(`INSERT INTO ${this.schema}.connector_ingest_runs (id, location_key, status, created_at, record)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (id) DO UPDATE SET location_key = excluded.location_key, status = excluded.status,
        created_at = excluded.created_at, record = excluded.record`,
    [record.id, record.locationKey, record.status, record.createdAt, record]);
  }

  async deleteConnectorIngestRun(id: string): Promise<boolean> {
    return (await this.client.query(`DELETE FROM ${this.schema}.connector_ingest_runs WHERE id = $1`, [id])).rowCount === 1;
  }

  async getImportMarker(name: string): Promise<string | undefined> {
    const result = await this.client.query<{ value: string }>(`SELECT value FROM ${this.schema}.import_markers WHERE name = $1`, [name]);
    return result.rows[0]?.value;
  }

  async setImportMarker(name: string, value: string): Promise<void> {
    await this.client.query(`INSERT INTO ${this.schema}.import_markers (name, value, imported_at) VALUES ($1, $2, $3)
      ON CONFLICT (name) DO UPDATE SET value = excluded.value, imported_at = excluded.imported_at`,
    [name, value, new Date().toISOString()]);
  }

  private async record<T>(sql: string, values: unknown[]): Promise<T | undefined> {
    const result = await this.client.query<{ record: T }>(sql, values);
    return result.rows[0]?.record;
  }

  private async records<T>(sql: string, values: unknown[] = []): Promise<T[]> {
    const result = await this.client.query<{ record: T } & QueryResultRow>(sql, values);
    return result.rows.map((row) => row.record);
  }
}

export class PostgresMetadataStore implements MetadataStore {
  readonly schema: string;
  private readonly quotedSchema: string;
  private readonly pool: Pool;
  private initialized = false;

  constructor(connectionString: string, schema = "astro_workspace") {
    if (!connectionString) throw new RangeError("PostgreSQL connection string is required");
    this.schema = schema;
    this.quotedSchema = quoteSchema(schema);
    this.pool = new Pool({ connectionString });
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`astro-data-workspace:${this.schema}:migrations`]);
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${this.quotedSchema}`);
      await client.query(`CREATE TABLE IF NOT EXISTS ${this.quotedSchema}.schema_migrations (
        version integer PRIMARY KEY, applied_at timestamptz NOT NULL
      )`);
      await client.query(`CREATE TABLE IF NOT EXISTS ${this.quotedSchema}.import_markers (
        name text PRIMARY KEY, value text NOT NULL, imported_at timestamptz NOT NULL
      )`);
      const applied = await client.query<{ version: number }>(`SELECT version FROM ${this.quotedSchema}.schema_migrations WHERE version = 1`);
      if (applied.rowCount === 0) {
        await client.query(`CREATE TABLE ${this.quotedSchema}.connectors (
          id text PRIMARY KEY,
          location_key text NOT NULL UNIQUE,
          kind text NOT NULL CHECK (kind IN ('s3', 'local', 'jdbc')),
          status text NOT NULL CHECK (status IN ('draft', 'ready', 'disabled')),
          updated_at timestamptz NOT NULL,
          record jsonb NOT NULL,
          CHECK (record->>'id' = id),
          CHECK (record->>'locationKey' = location_key)
        );
        CREATE INDEX connectors_kind_idx ON ${this.quotedSchema}.connectors(kind);
        CREATE INDEX connectors_status_idx ON ${this.quotedSchema}.connectors(status);

        CREATE TABLE ${this.quotedSchema}.data_assets (
          id text PRIMARY KEY,
          origin text NOT NULL CHECK (origin IN ('user', 'override')),
          survey_id text,
          kind text NOT NULL CHECK (kind IN ('catalog', 'image', 'spectra', 'cube', 'timeseries', 'other')),
          status text NOT NULL CHECK (status IN ('ready', 'metadata_only', 'unavailable')),
          updated_at timestamptz NOT NULL,
          record jsonb NOT NULL,
          CHECK (record->>'id' = id),
          CHECK (record->>'origin' = origin)
        );
        CREATE INDEX data_assets_survey_id_idx ON ${this.quotedSchema}.data_assets(survey_id);
        CREATE INDEX data_assets_kind_idx ON ${this.quotedSchema}.data_assets(kind);
        CREATE INDEX data_assets_status_idx ON ${this.quotedSchema}.data_assets(status);

        CREATE TABLE ${this.quotedSchema}.connector_ingest_runs (
          id text PRIMARY KEY,
          location_key text NOT NULL,
          status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
          created_at timestamptz NOT NULL,
          record jsonb NOT NULL,
          CHECK (record->>'id' = id),
          CHECK (record->>'locationKey' = location_key)
        );
        CREATE INDEX connector_ingest_runs_location_created_idx
          ON ${this.quotedSchema}.connector_ingest_runs(location_key, created_at DESC)`);
        await client.query(`INSERT INTO ${this.quotedSchema}.schema_migrations (version, applied_at) VALUES (1, now())`);
      }
      await client.query("COMMIT");
      this.initialized = true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async transaction<T>(operation: (transaction: MetadataTransaction) => Promise<T>): Promise<T> {
    this.requireInitialized();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(new PostgresTransaction(client, this.quotedSchema));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
    this.initialized = false;
  }

  listConnectors = () => this.direct().listConnectors();
  getConnector = (id: string) => this.direct().getConnector(id);
  getConnectorByLocationKey = (locationKey: string) => this.direct().getConnectorByLocationKey(locationKey);
  putConnector = (record: ConnectorRecord) => this.transaction((transaction) => transaction.putConnector(record));
  deleteConnector = (id: string) => this.transaction((transaction) => transaction.deleteConnector(id));
  listDataAssets = () => this.direct().listDataAssets();
  getDataAsset = (id: string) => this.direct().getDataAsset(id);
  putDataAsset = (record: DataAssetRecord) => this.transaction((transaction) => transaction.putDataAsset(record));
  deleteDataAsset = (id: string) => this.transaction((transaction) => transaction.deleteDataAsset(id));
  listConnectorIngestRuns = (locationKey?: string) => this.direct().listConnectorIngestRuns(locationKey);
  getConnectorIngestRun = (id: string) => this.direct().getConnectorIngestRun(id);
  putConnectorIngestRun = (record: ConnectorIngestRun) => this.transaction((transaction) => transaction.putConnectorIngestRun(record));
  deleteConnectorIngestRun = (id: string) => this.transaction((transaction) => transaction.deleteConnectorIngestRun(id));
  getImportMarker = (name: string) => this.direct().getImportMarker(name);
  setImportMarker = (name: string, value: string) => this.transaction((transaction) => transaction.setImportMarker(name, value));

  private direct(): PostgresTransaction {
    this.requireInitialized();
    return new PostgresTransaction(this.pool, this.quotedSchema);
  }

  private requireInitialized(): void {
    if (!this.initialized) throw new Error("PostgreSQL metadata store is not initialized");
  }
}
