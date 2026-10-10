import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { streamWarehouseEvidence } from "./warehouse-evidence-stream.js";

export interface InventoryIdentity { layerId: string; scanRunId: string; sourceSnapshotSha256: string }
export interface WarehouseInventory extends InventoryIdentity { path: string; sha256: string; fileCount: number }
export async function hashFile(filePath: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return digest.digest("hex");
}
export function validateInventoryMetadata(metadata: Record<string, unknown>, identity: InventoryIdentity): void {
  const snapshot = metadata.sourceSnapshot as Record<string, unknown> | undefined;
  if (metadata.phase !== "COMPLETED" || metadata.layerId !== identity.layerId || metadata.scanRunId !== identity.scanRunId
    || snapshot?.sha256 !== identity.sourceSnapshotSha256) throw new Error("Completed Warehouse evidence identity mismatch");
}
/** Derived finite inventory; original coverage evidence remains immutable. */
export async function stageWarehouseInventory(evidencePath: string, outputPath: string, identity: InventoryIdentity): Promise<WarehouseInventory> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const metadataPath = `${outputPath}.json`;
  const cached = await readFile(metadataPath, "utf8").then((text) => JSON.parse(text) as WarehouseInventory).catch(() => undefined);
  if (cached && cached.layerId === identity.layerId && cached.scanRunId === identity.scanRunId
    && cached.sourceSnapshotSha256 === identity.sourceSnapshotSha256 && await hashFile(outputPath) === cached.sha256) return cached;
  const temporary = `${outputPath}.tmp`;
  const file = await open(temporary, "w");
  let pending = "", count = 0;
  try {
    const metadata = await streamWarehouseEvidence(path.join(evidencePath, "normalized-scan.json"), (kind, row) => {
      if (kind !== "files") return;
      if (row.layer_id !== undefined && row.layer_id !== identity.layerId || typeof row.file_id !== "string" || typeof row.source_uri !== "string"
        || typeof row.file_name !== "string") throw new Error("Warehouse file inventory identity is invalid");
      pending += `${JSON.stringify(row)}\n`; count++;
    }, async () => { if (pending) { await file.write(pending); pending = ""; } });
    validateInventoryMetadata(metadata, identity);
    await file.sync(); await file.close();
    await rename(temporary, outputPath);
    const inventory = { ...identity, path: outputPath, sha256: await hashFile(outputPath), fileCount: count };
    await writeFile(`${metadataPath}.tmp`, `${JSON.stringify(inventory)}\n`);
    await rename(`${metadataPath}.tmp`, metadataPath);
    return inventory;
  } catch (error) { await file.close().catch(() => undefined); await rm(temporary, { force: true }); throw error; }
}
