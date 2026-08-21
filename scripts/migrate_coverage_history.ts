import { createHash } from "node:crypto";
import { chmod, cp, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_ARCHIVE_NAME = "coverage-cutover-archive";

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`Missing required option: ${name}`);
  return path.resolve(value);
}

function optionalOption(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? path.resolve(value) : undefined;
}

function hasOption(name: string): boolean {
  return process.argv.includes(name);
}

function transform(value: unknown): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const result = value.map((entry) => {
      const transformed = transform(entry);
      changed ||= transformed.changed;
      return transformed.value;
    });
    return { value: result, changed };
  }
  if (!value || typeof value !== "object") return { value, changed: false };

  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  let changed = false;
  for (const [key, entry] of Object.entries(source)) {
    if (key === "evidenceRole") {
      if (result.coverageRole === undefined) result.coverageRole = entry;
      changed = true;
      continue;
    }
    if (key === "evidence_role") {
      if (result.coverage_role === undefined) result.coverage_role = entry;
      changed = true;
      continue;
    }
    const transformed = transform(entry);
    result[key] = transformed.value;
    changed ||= transformed.changed;
  }

  // Coverage snapshots predating Assets Core did not carry its provenance
  // contract. Fill only absent values; existing artifacts and hashes remain
  // untouched because this utility changes JSON metadata only.
  if (result.coverageRole !== undefined || result.coverage_role !== undefined || result.mode === "catalog-radec" || result.mode === "nested-healpix" || result.mode === "fits-wcs") {
    if (result.coverageRole === undefined && result.coverage_role !== undefined) {
      result.coverageRole = result.coverage_role;
      delete result.coverage_role;
      changed = true;
    }
    if (result.coverageRole === undefined && (result.mode === "fits-wcs")) {
      result.coverageRole = "image_extent";
      changed = true;
    }
    if (result.coverageRole === undefined) {
      result.coverageRole = "object_presence";
      changed = true;
    }
    if (result.dataOrigin === undefined) { result.dataOrigin = "observed"; changed = true; }
    if (result.sourceTier === undefined) { result.sourceTier = "user_file_derived"; changed = true; }
    if (result.maxOrder === undefined) { result.maxOrder = 10; changed = true; }
    if (result.queryOrder === undefined) { result.queryOrder = 8; changed = true; }
    if (result.previewOrder === undefined) { result.previewOrder = 4; changed = true; }
  }
  return { value: result, changed };
}

async function jsonFiles(root: string, excludedPrefix: string, current = ""): Promise<string[]> {
  const directory = path.join(root, current);
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = current ? path.join(current, entry.name) : entry.name;
    if (excludedPrefix && (relative === excludedPrefix || relative.startsWith(`${excludedPrefix}${path.sep}`))) continue;
    if (entry.isDirectory()) result.push(...await jsonFiles(root, excludedPrefix, relative));
    else if (entry.isFile() && entry.name.endsWith(".json")) result.push(relative);
  }
  return result;
}

async function makeReadOnly(root: string, current = ""): Promise<void> {
  const directory = path.join(root, current);
  await chmod(directory, 0o555);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = current ? path.join(current, entry.name) : entry.name;
    const target = path.join(root, relative);
    if (entry.isDirectory()) await makeReadOnly(root, relative);
    else if (entry.isFile()) await chmod(target, 0o444);
  }
}

function migrateSqlite(sqlitePath: string, archiveRoot: string, manifest: { path: string; sha256: string; changed: boolean }[]): number {
  const database = new DatabaseSync(sqlitePath);
  const rows = database.prepare("SELECT id, record FROM connector_ingest_runs").all() as Array<{ id: string; record: string }>;
  let changed = 0;
  database.exec("BEGIN IMMEDIATE");
  try {
    const update = database.prepare("UPDATE connector_ingest_runs SET record = ? WHERE id = ?");
    for (const row of rows) {
      const digest = createHash("sha256").update(row.record).digest("hex");
      const transformed = transform(JSON.parse(row.record) as unknown);
      manifest.push({ path: `sqlite/connector_ingest_runs/${row.id}`, sha256: digest, changed: transformed.changed });
      if (!transformed.changed) continue;
      update.run(JSON.stringify(transformed.value), row.id);
      changed += 1;
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
  return changed;
}

async function migrate(): Promise<void> {
  const stateRoot = option("--root");
  const sqlitePath = optionalOption("--sqlite");
  if (hasOption("--sqlite") && !sqlitePath) throw new Error("Missing required option: --sqlite");
  const requestedArchive = optionalOption("--archive");
  const archiveRoot = requestedArchive ?? path.join(stateRoot, "archive", DEFAULT_ARCHIVE_NAME);
  const resolvedState = await stat(stateRoot);
  if (!resolvedState.isDirectory()) throw new Error("--root must be a directory");
  await mkdir(path.join(archiveRoot, "original"), { recursive: true });

  const archiveRelative = path.relative(stateRoot, archiveRoot);
  const excludedPrefix = archiveRelative && !archiveRelative.startsWith("..") && !path.isAbsolute(archiveRelative)
    ? archiveRelative
    : "";
  const files = await jsonFiles(stateRoot, excludedPrefix);
  const manifest: { schemaVersion: 1; generatedAt: string; files: Array<{ path: string; sha256: string; changed: boolean }> } = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    files: [],
  };
  if (sqlitePath) {
    const databaseBytes = await readFile(sqlitePath);
    const databaseArchive = path.join(archiveRoot, "original", "sqlite", path.basename(sqlitePath));
    await mkdir(path.dirname(databaseArchive), { recursive: true });
    await writeFile(databaseArchive, databaseBytes, { flag: "wx", mode: 0o444 });
    manifest.files.push({ path: `sqlite/${path.basename(sqlitePath)}`, sha256: createHash("sha256").update(databaseBytes).digest("hex"), changed: true });
  }
  for (const relative of files) {
    const sourcePath = path.join(stateRoot, relative);
    const bytes = await readFile(sourcePath);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const archivePath = path.join(archiveRoot, "original", relative);
    await mkdir(path.dirname(archivePath), { recursive: true });
    await writeFile(archivePath, bytes, { flag: "wx", mode: 0o444 });
    const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    const transformed = transform(parsed);
    manifest.files.push({ path: relative.split(path.sep).join("/"), sha256: digest, changed: transformed.changed });
    if (!transformed.changed) continue;
    const temporary = `${sourcePath}.${process.pid}.coverage-cutover.tmp`;
    await writeFile(temporary, `${JSON.stringify(transformed.value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, sourcePath);
  }

  if (sqlitePath) migrateSqlite(sqlitePath, archiveRoot, manifest.files);

  // Keep an explicit rollback tree containing the exact pre-migration bytes.
  await cp(path.join(archiveRoot, "original"), path.join(archiveRoot, "rollback"), { recursive: true, force: false });
  await writeFile(path.join(archiveRoot, "sha256-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o444 });
  await makeReadOnly(archiveRoot);
  console.log(JSON.stringify({ archive: archiveRoot, files: manifest.files.length, changed: manifest.files.filter((file) => file.changed).length }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void migrate().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
