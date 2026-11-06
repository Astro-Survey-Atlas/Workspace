import "./telemetry-bootstrap.js";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createMetadataStore } from "./storage/index.js";
import { LocalState } from "./local-state.js";
import { ScanControl } from "./scan-control.js";
import { ConnectorRegistry } from "./connectors.js";
import { createConnectorCredentialStore } from "./connector-credentials.js";
import { ConnectorIngestRunCatalog } from "./connector-history.js";
import { DataCatalogRegistry } from "./data-catalog.js";
import { LocalConnectorRootsPolicy } from "./local-connector-roots.js";
import { AstroObjectIndexService } from "./astro-object-index.js";
import { UserMocArtifactStore } from "./user-moc-artifacts.js";
import { WorkspaceScanExecutor, workspaceScanEnabled } from "./workspace-scan-executor.js";
import { shutdownTelemetry } from "./telemetry.js";

const root = path.resolve(process.env.ASTRO_STATE_ROOT ?? "data");
const store = createMetadataStore();
const state = new LocalState(process.env.ASTRO_SQLITE_PATH ?? path.join(root, "workspace.sqlite"));
const control = new ScanControl(state, process.env.ASTRO_SCANS_PAUSED !== "false");
const roots = LocalConnectorRootsPolicy.fromEnvironment();
const worker = new WorkspaceScanExecutor({ enabled: workspaceScanEnabled(), control, root: path.join(root, "workspace-scans"),
  connectors: new ConnectorRegistry(store, roots), credentials: createConnectorCredentialStore(),
  dataCatalog: new DataCatalogRegistry(store), runs: new ConnectorIngestRunCatalog(store), roots,
  objectIndex: new AstroObjectIndexService({ baseUrl: process.env.ASTRO_ES_URL ?? "" }),
  artifacts: new UserMocArtifactStore({ root: path.join(root, "user-mocs") }) });
let stopped = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stopped = true; worker.stop(); });
try {
  await store.initialize(); await state.initialize();
  if (!state.get("scanning", "control")) control.setPaused(process.env.ASTRO_SCANS_PAUSED !== "false");
  const paused = await worker.recoverInterruptedRuns();
  console.info("Workspace scan worker ready", { pausedRuns: paused, scanningPaused: control.view().paused });
  while (!stopped) {
    try { if (await worker.runNext()) continue; }
    catch (error) { console.error("Workspace scan worker tick failed", error); }
    await delay(1000);
  }
} finally { state.close(); await store.close(); await shutdownTelemetry(); }
