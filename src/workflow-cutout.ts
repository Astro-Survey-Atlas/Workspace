import { createHash } from "node:crypto";
import type { CrossmatchRecord } from "./scientific-tools.js";
import type { WorkflowMcpClient } from "./workflow-mcp-client.js";
import type { WorkspaceFitsCutoutService } from "./workflow-fits-cutout.js";
import type { WorkflowCutoutGroupCheckpoint, WorkflowRun } from "./workflow.js";

const EUCLID_MER_S3_BASE = "s3://data-and-computing/projects/CSST/shared-data/euclid/aws-mirrors/q1/MER";
const DESI_SOUTH_S3_BASE = "s3://data-and-computing/projects/CSST/shared-data/desi/dr10/south";

type Telescope = "euclid" | "desi";
type Band = "vis" | "g" | "r" | "i" | "z";

interface CutoutTarget {
  obj_id: string;
  row_index: number;
  tile_index?: string;
  brickname?: string;
  ra_deg: number;
  dec_deg: number;
}

interface CutoutGroup {
  telescope: Telescope;
  band: Band;
  sourceUri: string;
  sourceResolution: string;
  targets: CutoutTarget[];
}

export interface WorkflowCutoutRecord {
  status: string;
  telescope: Telescope;
  band: Band;
  sourceUri: string;
  resolvedSourceUri?: string;
  sourceResolution: string;
  rowIndex: number;
  objectId: string;
  raDeg: number;
  decDeg: number;
  outputUri?: string;
  error?: string;
  hasOverlap?: boolean;
  stampSizePx?: number;
}

export interface WorkflowCutoutSummary {
  groupsTotal: number;
  groupsSucceeded: number;
  groupsFailed: number;
  targetsTotal: number;
  targetsSucceeded: number;
  targetsFailed: number;
  unresolvedTargets: number;
  records: WorkflowCutoutRecord[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim() || undefined;
}

function finite(value: unknown): number | undefined {
  const result = typeof value === "number" ? value : Number(value);
  return Number.isFinite(result) ? result : undefined;
}

function normalizeTileId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return /^\d{6,12}$/.test(value) ? value : value.match(/(\d{6,12})/)?.[1];
}

function normalizeBrickname(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const brick = value.trim().toLowerCase();
  return /^\d{4}[pm]\d{3}$/.test(brick) ? brick : undefined;
}

function desiImagePath(brickname: string, band: Exclude<Band, "vis">): string {
  const prefix = brickname.slice(0, 3);
  return `${DESI_SOUTH_S3_BASE}/coadd/${prefix}/${brickname}/legacysurvey-${brickname}-image-${band}.fits.fz`;
}

function nestedCatalogs(value: unknown): Array<Record<string, unknown>> {
  const root = asRecord(value);
  const candidates = [root?.catalogs, asRecord(root?.data)?.catalogs, asRecord(root?.result)?.catalogs];
  const entries = candidates.find(Array.isArray) as unknown[] | undefined;
  return entries?.map(asRecord).filter((entry): entry is Record<string, unknown> => Boolean(entry)) ?? [];
}

function resolveCatalogEntry(entries: Array<Record<string, unknown>>, tileId: string): string | undefined {
  const tileToken = `TILE${tileId}`;
  const label = (entry: Record<string, unknown>): string => String(entry.name ?? entry.path ?? "");
  const selected = entries.find((entry) => label(entry).includes("BGSUB-MOSAIC-VIS") && label(entry).includes(tileToken))
    ?? entries.find((entry) => label(entry).includes("BGSUB-MOSAIC-VIS"))
    ?? entries.find((entry) => label(entry).includes("MOSAIC-VIS"));
  if (!selected) return undefined;
  for (const candidate of [selected.path, selected.uri, selected.s3_path]) {
    const uri = text(candidate);
    if (uri?.startsWith("s3://") || uri?.startsWith("https://") || uri?.startsWith("http://")) return uri;
    if (uri?.startsWith("projects/")) return `s3://data-and-computing/${uri}`;
    if (uri?.startsWith("/projects/")) return `s3://data-and-computing${uri}`;
  }
  const name = text(selected.name);
  return name ? `${EUCLID_MER_S3_BASE}/${tileId}/VIS/${name}` : undefined;
}

function euclidPattern(tileId: string): string {
  return `${EUCLID_MER_S3_BASE}/${tileId}/VIS/EUC_MER_BGSUB-MOSAIC-VIS_TILE${tileId}-*.fits`;
}

async function resolveEuclidSource(
  row: CrossmatchRecord,
  mcp: WorkflowMcpClient | undefined,
  cache: Map<string, Promise<{ uri: string; resolution: string } | undefined>>,
): Promise<{ uri: string; resolution: string } | undefined> {
  const explicitPath = text(row.euclidFitsPath);
  if (explicitPath) return { uri: explicitPath, resolution: "catalog_row_path" };
  const tileId = normalizeTileId(text(row.euclidTileIndex));
  if (!tileId) return undefined;
  let resolved = cache.get(tileId);
  if (!resolved) {
    resolved = (async () => {
      if (mcp && await mcp.hasTool("euclid", "list_catalogs")) {
        try {
          const payload = await mcp.callTool("euclid", "list_catalogs", { path: `${EUCLID_MER_S3_BASE}/${tileId}/VIS/` });
          const uri = resolveCatalogEntry(nestedCatalogs(payload), tileId);
          if (uri) return { uri, resolution: "euclid_list_catalogs" };
        } catch {
          // Use the same explicitly marked tile wildcard fallback as astro-code.
        }
      }
      return { uri: euclidPattern(tileId), resolution: "euclid_tile_pattern" };
    })();
    cache.set(tileId, resolved);
  }
  return resolved;
}

function addGroup(groups: Map<string, CutoutGroup>, group: Omit<CutoutGroup, "targets">, target: CutoutTarget): void {
  const key = `${group.telescope}\u0000${group.band}\u0000${group.sourceUri}`;
  const existing = groups.get(key);
  if (existing) existing.targets.push(target);
  else groups.set(key, { ...group, targets: [target] });
}

function cutoutGroupCheckpointKey(runId: string, sizeDeg: number, group: CutoutGroup, targets: CutoutTarget[]): string {
  return createHash("sha256").update(JSON.stringify({
    runId,
    sizeDeg,
    telescope: group.telescope,
    band: group.band,
    sourceUri: group.sourceUri,
    targets,
  })).digest("hex");
}

async function buildGroups(
  rows: CrossmatchRecord[],
  bands: Array<"g" | "r" | "i" | "z">,
  mcp: WorkflowMcpClient | undefined,
): Promise<{ groups: CutoutGroup[]; unresolvedTargets: number }> {
  const groups = new Map<string, CutoutGroup>();
  const euclidSources = new Map<string, Promise<{ uri: string; resolution: string } | undefined>>();
  let unresolvedTargets = 0;

  for (const [rowIndex, row] of rows.entries()) {
    const raDeg = finite(row.euclidRaDeg);
    const decDeg = finite(row.euclidDecDeg);
    if (raDeg === undefined || decDeg === undefined) {
      unresolvedTargets += 1;
      continue;
    }
    const targetBase = {
      obj_id: row.euclidObjectId,
      row_index: rowIndex,
      ra_deg: raDeg,
      dec_deg: decDeg,
    };
    let sourcesAdded = 0;
    const tileIndex = normalizeTileId(text(row.euclidTileIndex));
    const brickname = normalizeBrickname(text(row.desiBrickname));

    const euclidSource = await resolveEuclidSource(row, mcp, euclidSources);
    if (euclidSource) {
      addGroup(groups, { telescope: "euclid", band: "vis", sourceUri: euclidSource.uri, sourceResolution: euclidSource.resolution }, {
        ...targetBase,
        ...(tileIndex ? { tile_index: tileIndex } : {}),
        ...(brickname ? { brickname } : {}),
      });
      sourcesAdded += 1;
    }

    for (const band of bands) {
      const explicitPath = text(row[`desiImage${band.toUpperCase()}Path` as keyof CrossmatchRecord]);
      const sourceUri = explicitPath ?? (brickname ? desiImagePath(brickname, band) : undefined);
      if (!sourceUri) continue;
      addGroup(groups, {
        telescope: "desi",
        band,
        sourceUri,
        sourceResolution: explicitPath ? "catalog_row_path" : "desi_brickname_pattern",
      }, {
        ...targetBase,
        ...(tileIndex ? { tile_index: tileIndex } : {}),
        ...(brickname ? { brickname } : {}),
      });
      sourcesAdded += 1;
    }
    if (sourcesAdded === 0) unresolvedTargets += 1;
  }
  return { groups: [...groups.values()], unresolvedTargets };
}

function successfulStatus(value: unknown): boolean {
  return ["ok", "success", "succeeded", "completed"].includes(String(value ?? "").toLowerCase());
}

function cutoutRecord(group: CutoutGroup, result: Record<string, unknown>, resolvedSourceUri?: string): WorkflowCutoutRecord | undefined {
  const rowIndex = finite(result.row_index);
  const raDeg = finite(result.ra_deg);
  const decDeg = finite(result.dec_deg);
  const objectId = text(result.obj_id);
  if (rowIndex === undefined || raDeg === undefined || decDeg === undefined || !objectId) return undefined;
  const meta = asRecord(result.meta) ?? {};
  return {
    status: String(result.status ?? "unknown").toLowerCase(),
    telescope: group.telescope,
    band: group.band,
    sourceUri: group.sourceUri,
    ...(resolvedSourceUri ? { resolvedSourceUri } : {}),
    sourceResolution: group.sourceResolution,
    rowIndex,
    objectId,
    raDeg,
    decDeg,
    ...(text(result.output_uri) ? { outputUri: text(result.output_uri) } : {}),
    ...(text(result.error) ? { error: text(result.error) } : {}),
    ...(meta.has_overlap === undefined ? {} : { hasOverlap: Boolean(meta.has_overlap) }),
    ...(finite(meta.stamp_size_px) === undefined ? {} : { stampSizePx: finite(meta.stamp_size_px) }),
  };
}

async function executeGroup(
  runId: string,
  sizeDeg: number,
  group: CutoutGroup,
  mcp: WorkflowMcpClient | undefined,
  executor?: WorkspaceFitsCutoutService,
  run?: WorkflowRun,
  onGroupComplete?: (checkpoint: WorkflowCutoutGroupCheckpoint) => Promise<void>,
): Promise<{ records: WorkflowCutoutRecord[]; failed: boolean }> {
  const records: WorkflowCutoutRecord[] = [];
  let failed = false;
  for (let offset = 0; offset < group.targets.length; offset += 100) {
    const targets = group.targets.slice(offset, offset + 100);
    const key = cutoutGroupCheckpointKey(runId, sizeDeg, group, targets);
    const cached = run?.cutoutGroups?.find((checkpoint) => checkpoint.key === key);
    if (cached) {
      records.push(...cached.records as unknown as WorkflowCutoutRecord[]);
      continue;
    }
    try {
      const request = {
        run_id: runId,
        telescope: group.telescope,
        band: group.band,
        source_uri: group.sourceUri,
        targets,
        size_deg: sizeDeg,
        resolve_wildcard: true,
      };
      const rawResponse = executor
        ? await executor.executeGroup(request, run)
        : mcp
          ? await mcp.callTool("cutout", "execute_cutout_group", request)
          : (() => { throw new Error("FITS cutout executor is unavailable"); })();
      const response = asRecord(rawResponse);
      const report = asRecord(response?.result) ?? asRecord(asRecord(response?.data)?.result) ?? response;
      const resolvedSourceUri = text(report?.resolved_source_uri);
      const rawResults = Array.isArray(report?.results)
        ? report.results.map(asRecord).filter((entry): entry is Record<string, unknown> => Boolean(entry))
        : [];
      const batchRecords = rawResults.map((result) => cutoutRecord(group, result, resolvedSourceUri))
        .filter((entry): entry is WorkflowCutoutRecord => Boolean(entry));
      const returnedIndexes = new Set(batchRecords.map((entry) => entry.rowIndex));
      const reportError = text(report?.error);
      for (const target of targets) {
        if (returnedIndexes.has(target.row_index)) continue;
        batchRecords.push({
          status: "error",
          telescope: group.telescope,
          band: group.band,
          sourceUri: group.sourceUri,
          ...(resolvedSourceUri ? { resolvedSourceUri } : {}),
          sourceResolution: group.sourceResolution,
          rowIndex: target.row_index,
          objectId: target.obj_id,
          raDeg: target.ra_deg,
          decDeg: target.dec_deg,
          error: reportError ?? "Cutout MCP did not return a result for this target",
        });
      }
      const batchFailed = Boolean(reportError) || batchRecords.some((entry) => !successfulStatus(entry.status));
      failed ||= batchFailed;
      records.push(...batchRecords);
      if (!batchFailed && run) {
        const checkpoint: WorkflowCutoutGroupCheckpoint = {
          key,
          records: batchRecords as unknown as Array<Record<string, unknown>>,
        };
        run.cutoutGroups ??= [];
        run.cutoutGroups = [...run.cutoutGroups.filter((candidate) => candidate.key !== key), checkpoint];
        await onGroupComplete?.(checkpoint);
      }
    } catch (error) {
      failed = true;
      const message = error instanceof Error ? error.message : String(error);
      records.push(...targets.map((target) => ({
        status: "error",
        telescope: group.telescope,
        band: group.band,
        sourceUri: group.sourceUri,
        sourceResolution: group.sourceResolution,
        rowIndex: target.row_index,
        objectId: target.obj_id,
        raDeg: target.ra_deg,
        decDeg: target.dec_deg,
        error: message,
      })));
    }
  }
  return { records, failed };
}

export async function executeWorkflowCutouts(options: {
  runId: string;
  rows: CrossmatchRecord[];
  sizeDeg: number;
  desiBands: Array<"g" | "r" | "i" | "z">;
  mcp?: WorkflowMcpClient;
  executor?: WorkspaceFitsCutoutService;
  run?: WorkflowRun;
  onGroupComplete?: (checkpoint: WorkflowCutoutGroupCheckpoint) => Promise<void>;
}): Promise<WorkflowCutoutSummary> {
  if (options.rows.length === 0) {
    return {
      groupsTotal: 0,
      groupsSucceeded: 0,
      groupsFailed: 0,
      targetsTotal: 0,
      targetsSucceeded: 0,
      targetsFailed: 0,
      unresolvedTargets: 0,
      records: [],
    };
  }
  if (!options.executor && (!options.mcp || !(await options.mcp.hasTool("cutout", "execute_cutout_group")))) {
    throw new Error("No enabled Workspace MCP server provides execute_cutout_group");
  }
  const { groups, unresolvedTargets } = await buildGroups(options.rows, options.desiBands, options.mcp);
  if (groups.length === 0) {
    return {
      groupsTotal: 0,
      groupsSucceeded: 0,
      groupsFailed: 0,
      targetsTotal: unresolvedTargets,
      targetsSucceeded: 0,
      targetsFailed: unresolvedTargets,
      unresolvedTargets,
      records: [],
    };
  }

  const results: Array<{ records: WorkflowCutoutRecord[]; failed: boolean } | undefined> = new Array(groups.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < groups.length) {
      const index = cursor++;
      const group = groups[index];
      if (!group) continue;
      try {
        const result = await executeGroup(
          options.runId,
          options.sizeDeg,
          group,
          options.mcp,
          options.executor,
          options.run,
          options.onGroupComplete,
        );
        results[index] = result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results[index] = {
          failed: true,
          records: group.targets.map((target) => ({
            status: "error",
            telescope: group.telescope,
            band: group.band,
            sourceUri: group.sourceUri,
            sourceResolution: group.sourceResolution,
            rowIndex: target.row_index,
            objectId: target.obj_id,
            raDeg: target.ra_deg,
            decDeg: target.dec_deg,
            error: message,
          })),
        };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, groups.length) }, () => worker()));

  const records = results.flatMap((result) => result?.records ?? []);
  const groupsFailed = results.filter((result) => result?.failed).length;
  const targetsSucceeded = records.filter((entry) => successfulStatus(entry.status)).length;
  const targetsTotal = groups.reduce((sum, group) => sum + group.targets.length, 0) + unresolvedTargets;
  const targetsFailed = targetsTotal - targetsSucceeded;
  return {
    groupsTotal: groups.length,
    groupsSucceeded: groups.length - groupsFailed,
    groupsFailed,
    targetsTotal,
    targetsSucceeded,
    targetsFailed,
    unresolvedTargets,
    records,
  };
}
