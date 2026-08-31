import type { DataAssetRecord, DataConnectorKind } from "./data-catalog.js";

/** Operational state is derived from evidence and execution history. It is not
 * persisted on the asset because an asset can outlive an index, connector, or
 * scan executor. */
export type DataAssetCoverageState = "not_started" | "pending" | "failed" | "ready" | "empty" | "unavailable";
export type DataAssetObjectState = "queryable" | "not_indexed" | "unavailable";
export type DataAssetNextAction = "scan_local" | "scan_remote" | "retry" | "configure_connector" | "configure_index" | "none";

export interface DataAssetCoverageEvidence {
  status?: string;
  /** Status reported by the object/coverage index independently of footprint evidence. */
  objectStatus?: string;
  pixels?: readonly number[];
  objectCount?: number;
  message?: string;
  latestMocStatus?: string;
}

export interface DataAssetRunEvidence {
  status?: string;
  taskKind?: string;
  error?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface DataAssetOperationalStatus {
  assetId: string;
  coverage: DataAssetCoverageState;
  objects: DataAssetObjectState;
  nextAction: DataAssetNextAction;
  message?: string;
}

export interface DataAssetStatusInput {
  asset: Pick<DataAssetRecord, "id" | "access" | "accesses" | "connectorIds" | "connectorLocationKeys">;
  connectorKinds?: readonly DataConnectorKind[];
  coverage?: DataAssetCoverageEvidence;
  latestRun?: DataAssetRunEvidence;
  objectIndexConfigured: boolean;
  localScanConfigured: boolean;
  warehouseConfigured: boolean;
}

function hasPixelEvidence(coverage: DataAssetCoverageEvidence | undefined): boolean {
  return (coverage?.pixels?.length ?? 0) > 0;
}

function hasConnector(input: DataAssetStatusInput): boolean {
  // Connector ids and location keys are historical references, not proof that
  // the referenced Connector still exists. The HTTP read model resolves those
  // references first and supplies the surviving kinds here; counting the raw
  // ids would strand old assets in a false "acquired" state with no action.
  return Boolean(input.connectorKinds?.length);
}

function latestRunIs(input: DataAssetStatusInput, status: string): boolean {
  return input.latestRun?.status === status;
}

/** Derive user-facing workflow state from the strongest available evidence. */
export function deriveDataAssetOperationalStatus(input: DataAssetStatusInput): DataAssetOperationalStatus {
  const coverage = input.coverage;
  const run = input.latestRun;
  const connectorAvailable = hasConnector(input);
  const coverageStatus = coverage?.status;
  const failed = coverageStatus === "error" || coverageStatus === "failed" || coverage?.latestMocStatus === "failed"
    || latestRunIs(input, "failed");
  const pending = coverageStatus === "pending" || coverageStatus === "queued" || coverageStatus === "running"
    || coverage?.latestMocStatus === "pending" || latestRunIs(input, "queued") || latestRunIs(input, "running");
  // A reachable index with zero facts is not the same thing as an indexed
  // asset. A successful empty scan is still queryable, so retain that explicit
  // terminal run as evidence; otherwise require at least one indexed object.
  const indexed = input.objectIndexConfigured
    && coverage?.objectStatus === "ready"
    && ((coverage.objectCount === undefined && latestRunIs(input, "succeeded"))
      || (coverage.objectCount !== undefined && (coverage.objectCount > 0 || latestRunIs(input, "succeeded"))));
  let state: DataAssetCoverageState;
  if (failed) state = "failed";
  else if (pending) state = "pending";
  else if (hasPixelEvidence(coverage)) state = "ready";
  else if (coverageStatus === "unavailable") state = "unavailable";
  // A healthy index query returning no rows is not proof that this asset was
  // scanned. Empty coverage is only terminal when a successful run or a ready
  // MOC artifact explicitly records that outcome.
  else if (latestRunIs(input, "succeeded") || coverage?.latestMocStatus === "ready") state = "empty";
  else if (!connectorAvailable && coverageStatus === "unavailable") state = "unavailable";
  else if (coverageStatus === "unavailable" && !input.objectIndexConfigured) state = "unavailable";
  else if (coverageStatus === "unavailable") state = "not_started";
  else state = "not_started";

  const objects: DataAssetObjectState = !input.objectIndexConfigured
    ? "unavailable"
    : indexed ? "queryable" : "not_indexed";

  const kinds = new Set(input.connectorKinds ?? []);
  const hasLocal = kinds.has("local");
  const hasRemote = kinds.has("s3");
  let nextAction: DataAssetNextAction = "none";
  if (state === "failed") nextAction = "retry";
  else if (state === "not_started") {
    if (hasLocal && input.localScanConfigured) nextAction = "scan_local";
    else if (hasRemote && input.warehouseConfigured) nextAction = "scan_remote";
    else if (!connectorAvailable) nextAction = "configure_connector";
    else if (hasLocal || hasRemote) nextAction = "configure_index";
    else nextAction = "configure_connector";
  } else if (state === "unavailable") {
    if (!connectorAvailable) nextAction = "configure_connector";
    else if (!input.objectIndexConfigured) nextAction = "configure_index";
    else if (hasLocal || hasRemote) nextAction = "configure_index";
    else nextAction = "configure_connector";
  }

  const message = coverage?.message ?? run?.error;
  return {
    assetId: input.asset.id,
    coverage: state,
    objects,
    nextAction,
    ...(message ? { message } : {}),
  };
}
