import { copyFile, mkdir, mkdtemp, open, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SqliteMetadataStore } from "./storage/sqlite.js";

/** Random SQLite I/O stays local; only consistent sequential snapshots reach shared storage. */
export async function openStatisticsDatabase(root: string): Promise<{
  store: SqliteMetadataStore;
  checkpoint: (force?: boolean) => Promise<void>;
  close: () => Promise<void>;
}> {
  await mkdir(root, { recursive: true });
  const temporary = await mkdtemp(path.join(os.tmpdir(), "workspace-statistics-"));
  const filename = path.join(temporary, "statistics.sqlite");
  const durable = path.join(root, "statistics-checkpoint.sqlite");
  const copyIfPresent = async (source: string, target: string): Promise<boolean> => {
    try { await copyFile(source, target); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  };
  const store = new SqliteMetadataStore(filename, { cacheSizeKiB: 65536 });
  try {
    if (!await copyIfPresent(durable, filename)) {
      // One-time recovery of the earlier NFS database, including a possible hot journal.
      const legacy = path.join(root, "statistics.sqlite");
      if (await copyIfPresent(legacy, filename)) await copyIfPresent(`${legacy}-journal`, `${filename}-journal`);
    }
    await store.initialize();
    await store.removeUnpublishedStatisticsEntries();
  } catch (error) { await store.close().catch(() => undefined); await rm(temporary, { recursive: true, force: true }); throw error; }
  let savedAt = 0;
  let saving: Promise<void> | undefined;
  const checkpoint = async (force = false): Promise<void> => {
    if (saving) { await saving; if (!force) return; }
    if (!force && Date.now() - savedAt < 30000) return;
    saving = (async () => {
      const next = `${durable}.next`;
      const local = path.join(temporary, "checkpoint.sqlite");
      await rm(local, { force: true });
      await store.exportDatabase(local);
      await rm(next, { force: true });
      await copyFile(local, next);
      const handle = await open(next, "r");
      try { await handle.sync(); } finally { await handle.close(); }
      await rename(next, durable);
      await rm(local, { force: true });
      savedAt = Date.now();
    })();
    try { await saving; } finally { saving = undefined; }
  };
  return { store, checkpoint, close: async () => {
    await checkpoint(true);
    await store.close();
    await rm(temporary, { recursive: true, force: true });
  } };
}
