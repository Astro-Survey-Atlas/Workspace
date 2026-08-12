import { readFile } from "node:fs/promises";

import { normalizeConnectorIngestRuns } from "../connector-history.js";
import { normalizeConnectorRecords } from "../connectors.js";
import { normalizePersistedDataAsset } from "../data-catalog.js";
import type { MetadataStore } from "./types.js";

export const JSON_STATE_IMPORT_MARKER = "json-state-v1";

export interface JsonStatePaths {
  connectorStatePath: string;
  dataCatalogStatePath: string;
  connectorRunStatePath: string;
}

interface JsonFile {
  exists: boolean;
  entries: unknown[];
}

async function readJsonArray(filename: string, label: string): Promise<JsonFile> {
  try {
    const parsed = JSON.parse(await readFile(filename, "utf8")) as unknown;
    if (!Array.isArray(parsed)) throw new Error(`${label} state must be an array`);
    return { exists: true, entries: parsed };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, entries: [] };
    if (error instanceof SyntaxError) throw new Error(`${label} state contains malformed JSON: ${filename}`, { cause: error });
    throw error;
  }
}

export async function importJsonState(store: MetadataStore, paths: JsonStatePaths): Promise<void> {
  if (await store.getImportMarker(JSON_STATE_IMPORT_MARKER)) return;
  const hasRows = (await store.listConnectors()).length > 0
    || (await store.listDataAssets()).length > 0
    || (await store.listConnectorIngestRuns()).length > 0;
  if (hasRows) throw new Error("Metadata store contains rows without json-state-v1 import marker; refusing mixed state");

  const [connectorFile, catalogFile, runFile] = await Promise.all([
    readJsonArray(paths.connectorStatePath, "connector"),
    readJsonArray(paths.dataCatalogStatePath, "data catalog"),
    readJsonArray(paths.connectorRunStatePath, "connector ingest run"),
  ]);
  const connectors = normalizeConnectorRecords(connectorFile.entries);
  const assets = catalogFile.entries.map(normalizePersistedDataAsset).filter((record) => record !== undefined);
  const runs = normalizeConnectorIngestRuns(runFile.entries);
  const marker = JSON.stringify({
    connectorState: connectorFile.exists ? "present" : "missing",
    dataCatalogState: catalogFile.exists ? "present" : "missing",
    connectorRunState: runFile.exists ? "present" : "missing",
  });

  await store.transaction(async (transaction) => {
    if (await transaction.getImportMarker(JSON_STATE_IMPORT_MARKER)) return;
    const transactionHasRows = (await transaction.listConnectors()).length > 0
      || (await transaction.listDataAssets()).length > 0
      || (await transaction.listConnectorIngestRuns()).length > 0;
    if (transactionHasRows) throw new Error("Metadata store contains rows without json-state-v1 import marker; refusing mixed state");
    for (const record of connectors) await transaction.putConnector(record);
    for (const record of assets) await transaction.putDataAsset(record);
    for (const record of runs) await transaction.putConnectorIngestRun(record);
    await transaction.setImportMarker(JSON_STATE_IMPORT_MARKER, marker);
  });
}
