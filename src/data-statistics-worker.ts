import { parentPort, workerData } from "node:worker_threads";
import { DataStatisticsModule } from "./data-statistics.js";
import { createMetadataStore } from "./storage/factory.js";
import { openStatisticsDatabase } from "./statistics-database.js";
import { ConnectorRegistry } from "./connectors.js";
import { DataCatalogRegistry } from "./data-catalog.js";
import { createConnectorCredentialStore } from "./connector-credentials.js";
import { LocalConnectorRootsPolicy } from "./local-connector-roots.js";

const store = createMetadataStore();
await store.initialize();
const database = await openStatisticsDatabase(workerData.root as string);
const roots = LocalConnectorRootsPolicy.fromEnvironment();
const statistics = new DataStatisticsModule({ store, statisticsStore: database.store, roots, checkpoint: database.checkpoint,
  connectors: new ConnectorRegistry(store, roots), assets: new DataCatalogRegistry(store), credentials: createConnectorCredentialStore(),
  workspaceScanRoot: workerData.workspaceScanRoot as string, evidenceRoot: workerData.evidenceRoot as string });
await statistics.initialize();
let publishing = false;
async function publish(): Promise<void> {
  if (publishing) return;
  publishing = true;
  try { parentPort!.postMessage({ view: await statistics.view() }); }
  catch (error) { console.error("Statistics publication failed", error instanceof Error ? error.message : "unknown"); }
  finally { publishing = false; }
}
parentPort!.on("message", (message: { id: number; method: "view" | "refresh" | "sync"; connectorIds?: string[] }) => {
  void (async () => {
    try {
      const value = message.method === "view" ? await statistics.view()
        : await statistics.refresh(message.connectorIds, message.method === "sync" ? "history" : "inventory");
      parentPort!.postMessage({ id: message.id, value });
      await publish();
    } catch (error) { parentPort!.postMessage({ id: message.id, error: error instanceof Error ? error.message : "Statistics operation failed" }); }
  })();
});
await publish();
// Recovery and successful-run reconciliation read evidence, never scientific sources.
const successfulRuns = async (): Promise<string> => JSON.stringify((await store.listConnectorIngestRuns({ status: "succeeded" }))
  .map(run => [run.id, run.logicalRunId, run.partitionId, run.assetId, run.assetIds]));
let reconciled = statistics.busy ? await successfulRuns() : undefined;
async function reconcile(): Promise<void> {
  if (statistics.busy) return;
  const signature = await successfulRuns();
  if (signature === reconciled) return;
  await statistics.refresh(undefined, "history");
  reconciled = signature;
}
await reconcile();
setInterval(() => void publish(), 3000).unref();
setInterval(() => void reconcile().catch(() => undefined), 30000).unref();

