import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { Pool, type PoolClient } from "pg";

import { PostgresMetadataStore } from "../src/storage/postgres.js";

const BATCH_SIZE = 2_000;
const MIGRATION_MARKER = "sqlite-to-postgres-metadata-v1";
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

type ColumnType = "text" | "jsonb" | "double precision" | "timestamptz";
interface Column { name: string; type: ColumnType }
interface TableSpec { name: string; cursor: string[]; columns: Column[] }
type SqliteValue = string | number | bigint | null | Uint8Array;
type SqliteRow = Record<string, SqliteValue>;

const TABLES: TableSpec[] = [
  { name: "connectors", cursor: ["id"], columns: [
    { name: "id", type: "text" }, { name: "location_key", type: "text" }, { name: "kind", type: "text" },
    { name: "status", type: "text" }, { name: "updated_at", type: "timestamptz" }, { name: "record", type: "jsonb" },
  ] },
  { name: "data_assets", cursor: ["id"], columns: [
    { name: "id", type: "text" }, { name: "origin", type: "text" }, { name: "survey_id", type: "text" },
    { name: "kind", type: "text" }, { name: "status", type: "text" }, { name: "updated_at", type: "timestamptz" },
    { name: "record", type: "jsonb" },
  ] },
  { name: "connector_ingest_runs", cursor: ["id"], columns: [
    { name: "id", type: "text" }, { name: "location_key", type: "text" }, { name: "connector_id", type: "text" },
    { name: "connector_kind", type: "text" }, { name: "idempotency_key_hash", type: "text" }, { name: "status", type: "text" },
    { name: "created_at", type: "timestamptz" }, { name: "record", type: "jsonb" },
  ] },
  { name: "survey_identities", cursor: ["id"], columns: [
    { name: "id", type: "text" }, { name: "source", type: "text" }, { name: "source_id", type: "text" },
    { name: "record", type: "jsonb" },
  ] },
  { name: "statistics_snapshots", cursor: ["id"], columns: [
    { name: "id", type: "text" }, { name: "slot", type: "text" }, { name: "updated_at", type: "text" },
    { name: "record", type: "jsonb" },
  ] },
  { name: "statistics_entries", cursor: ["snapshot_id", "file_key"], columns: [
    { name: "snapshot_id", type: "text" }, { name: "file_key", type: "text" }, { name: "size_bytes", type: "double precision" },
  ] },
  { name: "import_markers", cursor: ["name"], columns: [
    { name: "name", type: "text" }, { name: "value", type: "text" }, { name: "imported_at", type: "timestamptz" },
  ] },
];

class MigrationError extends Error {}

function quoteIdentifier(value: string): string {
  if (!IDENTIFIER.test(value)) throw new MigrationError("Database schema contains an invalid identifier");
  return `"${value}"`;
}

function tableName(schema: string, name: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
}

function countSqliteRows(source: DatabaseSync, name: string): number {
  const row = source.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(name)}`).get() as { count: number | bigint } | undefined;
  const count = Number(row?.count ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) throw new MigrationError(`Invalid source row count for ${name}`);
  return count;
}

function readSourceBatch(source: DatabaseSync, spec: TableSpec, cursor: SqliteValue[]): SqliteRow[] {
  const columns = spec.columns.map((column) => quoteIdentifier(column.name)).join(", ");
  const keys = spec.cursor.map(quoteIdentifier);
  const after = cursor.length === 0 ? "" : `WHERE (${keys.join(", ")}) > (${keys.map(() => "?").join(", ")})`;
  const order = keys.join(", ");
  return source.prepare(`SELECT ${columns} FROM ${quoteIdentifier(spec.name)} ${after} ORDER BY ${order} LIMIT ?`)
    .all(...cursor, BATCH_SIZE) as SqliteRow[];
}

function normalizedBatch(rows: SqliteRow[], spec: TableSpec): Array<Record<string, unknown>> {
  return rows.map((row) => Object.fromEntries(spec.columns.map((column) => {
    const value = row[column.name];
    if (column.type === "jsonb" && typeof value === "string") return [column.name, JSON.parse(value) as unknown];
    if (value instanceof Uint8Array) throw new MigrationError(`Unexpected binary value in ${spec.name}.${column.name}`);
    return [column.name, value];
  })));
}

function insertSql(schema: string, spec: TableSpec): string {
  const columns = spec.columns.map((column) => quoteIdentifier(column.name));
  const inputTypes = spec.columns.map((column) => `${quoteIdentifier(column.name)} ${column.type === "timestamptz" ? "text" : column.type}`);
  const projection = spec.columns.map((column) => column.type === "timestamptz"
    ? `row.${quoteIdentifier(column.name)}::timestamptz`
    : `row.${quoteIdentifier(column.name)}`);
  return `INSERT INTO ${tableName(schema, spec.name)} (${columns.join(", ")})
    SELECT ${projection.join(", ")} FROM jsonb_to_recordset($1::jsonb) AS row(${inputTypes.join(", ")})`;
}

async function copyTable(source: DatabaseSync, client: PoolClient, schema: string, spec: TableSpec): Promise<number> {
  let cursor: SqliteValue[] = [];
  let copied = 0;
  const statement = insertSql(schema, spec);
  for (;;) {
    const rows = readSourceBatch(source, spec, cursor);
    if (!rows.length) return copied;
    await client.query(statement, [JSON.stringify(normalizedBatch(rows, spec))]);
    const last = rows.at(-1);
    if (!last) return copied;
    cursor = spec.cursor.map((key) => {
      const value = last[key];
      if (value === undefined) throw new MigrationError(`Missing cursor value in ${spec.name}.${key}`);
      return value;
    });
    copied += rows.length;
  }
}

async function hashFile(filename: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function verifySqliteSource(source: DatabaseSync, filename: string): void {
  if (existsSync(`${filename}-wal`) || existsSync(`${filename}-shm`)) {
    throw new MigrationError("SQLite WAL sidecars exist; stop all writers and checkpoint the source before migration");
  }
  const integrity = source.prepare("PRAGMA quick_check").get();
  if (!integrity || Object.values(integrity as Record<string, unknown>)[0] !== "ok") {
    throw new MigrationError("SQLite quick_check did not return ok");
  }
  const versions = source.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>;
  if (versions.at(-1)?.version !== 4) throw new MigrationError("Source SQLite schema must be at migration version 4");
}

async function targetTableCounts(client: PoolClient, schema: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const spec of TABLES) {
    const result = await client.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${tableName(schema, spec.name)}`);
    counts[spec.name] = Number(result.rows[0]?.count ?? "0");
  }
  return counts;
}

async function targetSchemaReady(pool: Pool, schema: string): Promise<boolean> {
  for (const name of ["schema_migrations", ...TABLES.map((spec) => spec.name)]) {
    const relation = `${schema}.${name}`;
    const result = await pool.query<{ relation: string | null }>("SELECT to_regclass($1) AS relation", [relation]);
    if (!result.rows[0]?.relation) return false;
  }
  return true;
}

async function copyAll(source: DatabaseSync, client: PoolClient, schema: string, expected: Record<string, number>): Promise<Record<string, number>> {
  for (const spec of TABLES) {
    const copied = await copyTable(source, client, schema, spec);
    if (copied !== expected[spec.name]) throw new MigrationError(`Source row count changed while copying ${spec.name}`);
  }
  const actual = await targetTableCounts(client, schema);
  for (const spec of TABLES) {
    if (actual[spec.name] !== expected[spec.name]) throw new MigrationError(`PostgreSQL row count mismatch for ${spec.name}`);
  }
  return actual;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== "--apply" && arg !== "--prepare-target" && arg !== "--help");
  if (unknown.length) throw new MigrationError("Supported arguments are --prepare-target, --apply, and --help");
  if (args.includes("--apply") && args.includes("--prepare-target")) {
    throw new MigrationError("--apply and --prepare-target cannot be combined");
  }
  if (args.includes("--help")) {
    process.stdout.write("Use --prepare-target to create the PostgreSQL schema, run without arguments to preview the copy, and pass --apply to copy into an empty schema.\n");
    return;
  }

  const databaseUrl = process.env.ASTRO_DATABASE_URL ?? "";
  const schema = process.env.ASTRO_DATABASE_SCHEMA ?? "astro_workspace";
  const apply = args.includes("--apply");
  const prepareTarget = args.includes("--prepare-target");
  quoteIdentifier(schema);
  if (!databaseUrl) throw new MigrationError("ASTRO_DATABASE_URL is required; it is read from the environment and never printed");

  if (prepareTarget) {
    const initializer = new PostgresMetadataStore(databaseUrl, schema);
    try {
      await initializer.initialize();
    } finally {
      await initializer.close();
    }
    process.stdout.write(`${JSON.stringify({ mode: "prepare-target", targetSchema: schema, targetSchemaReady: true }, null, 2)}\n`);
    return;
  }

  const sqlitePath = path.resolve(process.env.ASTRO_SQLITE_PATH ?? "");
  if (!sqlitePath || sqlitePath === path.resolve(".")) throw new MigrationError("ASTRO_SQLITE_PATH must point to the stopped Workspace SQLite database");
  if (!existsSync(sqlitePath)) throw new MigrationError("ASTRO_SQLITE_PATH does not exist");

  const source = new DatabaseSync(sqlitePath, { readOnly: true });
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    verifySqliteSource(source, sqlitePath);
    const sourceCounts = Object.fromEntries(TABLES.map((spec) => [spec.name, countSqliteRows(source, spec.name)]));
    const sourceSha256 = await hashFile(sqlitePath);
    if (apply) {
      const initializer = new PostgresMetadataStore(databaseUrl, schema);
      try { await initializer.initialize(); } finally { await initializer.close(); }
    }

    const ready = await targetSchemaReady(pool, schema);
    if (!ready) {
      process.stdout.write(`${JSON.stringify({ mode: apply ? "apply" : "dry-run", targetSchema: schema, targetSchemaReady: false, sourceSha256, sourceCounts }, null, 2)}\n`);
      if (apply) throw new MigrationError("PostgreSQL schema initialization did not create all required tables");
      return;
    }

    const client = await pool.connect();
    try {
      await client.query(apply ? "BEGIN" : "BEGIN READ ONLY");
      if (apply) {
        const lockNames = [...TABLES.map((spec) => tableName(schema, spec.name)), tableName(schema, "schema_migrations")];
        await client.query(`LOCK TABLE ${lockNames.join(", ")} IN ACCESS EXCLUSIVE MODE`);
      }
      const markerTable = tableName(schema, "import_markers");
      const existing = await client.query<{ value: string }>(`SELECT value FROM ${markerTable} WHERE name = $1`, [MIGRATION_MARKER]);
      const markerValue = JSON.stringify({ sourceSha256, sourceCounts });
      if (existing.rows[0]) {
        if (existing.rows[0].value !== markerValue) throw new MigrationError("A different SQLite source was already migrated to this PostgreSQL schema");
        await client.query("COMMIT");
        process.stdout.write(`${JSON.stringify({ mode: apply ? "apply" : "dry-run", state: "already-applied", targetSchema: schema, sourceSha256, sourceCounts }, null, 2)}\n`);
        return;
      }

      const targetCountsBefore = await targetTableCounts(client, schema);
      const markerCount = await client.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${markerTable}`);
      const empty = Object.values(targetCountsBefore).every((count) => count === 0) && Number(markerCount.rows[0]?.count ?? "0") === 0;
      if (apply && !empty) throw new MigrationError("Target PostgreSQL metadata schema is not empty; refusing to merge two live metadata stores");
      let targetCounts = targetCountsBefore;
      if (apply) {
        targetCounts = await copyAll(source, client, schema, sourceCounts);
        await client.query(`INSERT INTO ${markerTable} (name, value, imported_at) VALUES ($1, $2, now())`, [MIGRATION_MARKER, markerValue]);
        await client.query("COMMIT");
      } else {
        await client.query("COMMIT");
      }
      process.stdout.write(`${JSON.stringify({
        mode: apply ? "apply" : "dry-run",
        targetSchema: schema,
        targetSchemaReady: true,
        targetEmpty: empty,
        readyToApply: empty,
        sourceSha256,
        sourceCounts,
        targetCounts,
      }, null, 2)}\n`);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } finally {
    source.close();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  if (error instanceof MigrationError) {
    process.stderr.write(`${error.name}: ${error.message}\n`);
  } else {
    const candidate = error as { name?: unknown; code?: unknown };
    process.stderr.write(`${typeof candidate?.name === "string" ? candidate.name : "Error"}${typeof candidate?.code === "string" ? ` code=${candidate.code}` : ""}\n`);
  }
  process.exitCode = 1;
});
