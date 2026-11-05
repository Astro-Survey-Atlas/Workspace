import type { CatalogQueryBackend, CatalogQueryClient } from "./catalog-mcp-client.js";
import {
  applyResultFilter,
  availableFilterFields,
  catalogQueryBody,
  DESI_CATALOG,
  EUCLID_CATALOG,
  extractCatalogHits,
  nearestNeighborCrossmatch,
  normalizeCatalogRows,
  parseCrossmatchInput,
  parseFilterSpec,
  rowsToCsv,
  sha256Json,
  workflowCatalogSourceForSide,
  type CrossmatchInput,
  type CrossmatchRecord,
  type FilterSpec,
} from "./scientific-tools.js";
import type { WorkflowInputCatalogReader } from "./workflow-input-catalog.js";
import type { WorkflowStore } from "./workflow-store.js";
import type { WorkflowMcpClient } from "./workflow-mcp-client.js";
import type { McpToolSummary } from "./system-config.js";
import { executeWorkflowCutouts, type WorkflowCutoutSummary } from "./workflow-cutout.js";
import type { WorkspaceFitsCutoutService } from "./workflow-fits-cutout.js";
import { activeTraceparent, changeHitlPending, changeTaskRunning, classifyError, recordHitlWait, recordTaskDuration, traceContextFromTraceparent, withContinuedSpan, withRootSpan, withSpan } from "./telemetry.js";
import {
  ToolRegistry,
  WorkflowRegistry,
  type WorkflowDefinition,
  type WorkflowLineage,
  type WorkflowRun,
  type WorkflowStepRun,
} from "./workflow.js";

function catalogSourceInputSchema(includeSide: boolean): Record<string, unknown> {
  return {
    type: "object",
    required: includeSide ? ["assetId", "side"] : ["assetId"],
    additionalProperties: false,
    properties: {
      assetId: { type: "string", maxLength: 120 },
      ...(includeSide ? { side: { type: "string", enum: ["euclid", "desi"] } } : {}),
      format: { type: "string", enum: ["csv", "fits"] },
      accessIndex: { type: "integer", minimum: 0, maximum: 31 },
      tableHdu: { oneOf: [{ type: "integer", minimum: 0, maximum: 2048 }, { type: "string", maxLength: 80 }] },
      columns: {
        type: "object",
        additionalProperties: false,
        properties: {
          ra: { type: "string", maxLength: 128 }, dec: { type: "string", maxLength: 128 },
          id: { type: "string", maxLength: 128 }, magnitude: { type: "string", maxLength: 128 },
          classLabel: { type: "string", maxLength: 128 }, tileIndex: { type: "string", maxLength: 128 },
          brickname: { type: "string", maxLength: 128 }, fitsPath: { type: "string", maxLength: 128 },
          imageG: { type: "string", maxLength: 128 }, imageR: { type: "string", maxLength: 128 },
          imageI: { type: "string", maxLength: 128 }, imageZ: { type: "string", maxLength: 128 },
        },
      },
    },
  };
}

export const EUCLID_DESI_WORKFLOW_KEY = "euclid-desi-crossmatch@1";

export const EUCLID_DESI_WORKFLOW: WorkflowDefinition = {
  id: "euclid-desi-crossmatch",
  version: 1,
  key: EUCLID_DESI_WORKFLOW_KEY,
  title: "Euclid × DESI 球面交叉匹配",
  description: "对真实 Euclid Q1 MER 与 DESI DR10 Tractor 目录执行可追溯的最近邻球面匹配。",
  inputSchema: {
    type: "object",
    required: ["raDeg", "decDeg"],
    properties: {
      raDeg: { type: "number", minimum: 0, exclusiveMaximum: 360 },
      decDeg: { type: "number", minimum: -90, maximum: 90 },
      queryRadiusArcsec: { type: "number", minimum: 1, maximum: 3600, default: 250 },
      matchRadiusArcsec: { type: "number", minimum: 0.1, maximum: 10, default: 1.5 },
      limit: { type: "integer", minimum: 1, maximum: 1000, default: 500 },
      cutoutEnabled: { type: "boolean", default: true },
      cutoutSizeDeg: { type: "number", minimum: 0.001, maximum: 1, default: 0.008 },
      desiBands: { type: "array", items: { type: "string", enum: ["g", "r", "i", "z"] }, minItems: 1, maxItems: 4, default: ["g", "r", "i", "z"] },
      catalogSource: catalogSourceInputSchema(true),
      catalogSources: {
        type: "object",
        additionalProperties: false,
        properties: {
          euclid: catalogSourceInputSchema(false),
          desi: catalogSourceInputSchema(false),
        },
      },
      catalogFields: {
        type: "object",
        additionalProperties: false,
        properties: {
          euclid: { type: "object", maxProperties: 16, propertyNames: { pattern: "^[A-Za-z][A-Za-z0-9_]{0,63}$" }, additionalProperties: { type: "string", minLength: 1, maxLength: 128 } },
          desi: { type: "object", maxProperties: 16, propertyNames: { pattern: "^[A-Za-z][A-Za-z0-9_]{0,63}$" }, additionalProperties: { type: "string", minLength: 1, maxLength: 128 } },
        },
      },
    },
  },
  steps: [
    { id: "parse_input", title: "解析输入", kind: "tool", toolId: "input.parse_coordinates", dependsOn: [] },
    { id: "query_euclid", title: "查询 Euclid Q1 MER", kind: "tool", toolId: "catalog.query_euclid", dependsOn: ["parse_input"] },
    { id: "query_desi", title: "查询 DESI DR10 Tractor", kind: "tool", toolId: "catalog.query_desi", dependsOn: ["query_euclid"] },
    { id: "normalize", title: "规范化天球坐标", kind: "tool", toolId: "coordinates.normalize_catalogs", dependsOn: ["query_euclid", "query_desi"] },
    { id: "crossmatch", title: "最近邻球面匹配", kind: "tool", toolId: "crossmatch.nearest_spherical", dependsOn: ["normalize"] },
    { id: "human_filter", title: "人工筛选", kind: "human_gate", dependsOn: ["crossmatch"] },
    { id: "cutout", title: "FITS 图像裁切", kind: "tool", toolId: "cutout.execute_grouped", dependsOn: ["human_filter"] },
    { id: "export", title: "导出与血缘登记", kind: "export", toolId: "results.export", dependsOn: ["cutout"] },
  ],
  outputs: [
    { name: "crossmatch.csv", mediaType: "text/csv", maxRows: 1000 },
    { name: "filtered.csv", mediaType: "text/csv", maxRows: 1000 },
    { name: "cutouts.json", mediaType: "application/json", maxRows: 5000 },
    { name: "result.json", mediaType: "application/json", maxRows: 20 },
  ],
};

interface CatalogQueryOutput {
  catalog: string;
  request: Record<string, unknown>;
  hits: Array<Record<string, unknown>>;
  backend?: CatalogQueryBackend;
  queryLimit?: number;
  truncated?: boolean;
  source?: { assetId: string; format: "csv" | "fits"; sha256: string; sourceBytes: number; rowsScanned: number };
}

interface NormalizedOutput {
  euclid: ReturnType<typeof normalizeCatalogRows>;
  desi: ReturnType<typeof normalizeCatalogRows>;
}

function catalogLineageEntry(
  catalog: string,
  result: CatalogQueryOutput,
  rowCount = result.hits.length,
): WorkflowLineage["sources"][number] {
  return {
    catalog,
    querySha256: sha256Json(result.request),
    rowCount,
    ...(result.backend ? { backend: result.backend } : {}),
    ...(result.queryLimit === undefined ? {} : { queryLimit: result.queryLimit }),
    ...(result.truncated === undefined ? {} : { truncated: result.truncated }),
    ...(result.source ? {
      assetId: result.source.assetId,
      sourceSha256: result.source.sha256,
      sourceFormat: result.source.format,
      sourceBytes: result.source.sourceBytes,
      rowsScanned: result.source.rowsScanned,
    } : {}),
  };
}

function catalogBackendFromPayload(value: unknown): CatalogQueryBackend | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const backend = (value as Record<string, unknown>).backend;
  if (!backend || typeof backend !== "object" || Array.isArray(backend)) return undefined;
  const candidate = backend as Record<string, unknown>;
  const providers = new Set(["workspace-mcp", "catalog-mcp", "esa-tap", "noirlab-datalab"]);
  if (typeof candidate.provider !== "string" || !providers.has(candidate.provider)
    || typeof candidate.release !== "string" || !/^[A-Za-z0-9_.-]{1,80}$/.test(candidate.release)
    || typeof candidate.table !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(candidate.table)) return undefined;
  return {
    provider: candidate.provider as CatalogQueryBackend["provider"],
    release: candidate.release,
    table: candidate.table,
    ...(typeof candidate.tool === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(candidate.tool) ? { tool: candidate.tool } : {}),
  };
}

function catalogQueryLimitFromPayload(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const queryLimit = (value as Record<string, unknown>).queryLimit;
  return typeof queryLimit === "number" && Number.isInteger(queryLimit) && queryLimit > 0 && queryLimit <= 1_000
    ? queryLimit
    : undefined;
}

function catalogTruncationFromPayload(value: unknown): boolean | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const truncated = (value as Record<string, unknown>).truncated;
  return typeof truncated === "boolean" ? truncated : undefined;
}

function catalogQuerySummaries(...results: CatalogQueryOutput[]): Array<Record<string, unknown>> {
  return results.map((result) => ({
    catalog: result.catalog,
    rowsReturned: result.hits.length,
    ...(result.queryLimit === undefined ? {} : { queryLimit: result.queryLimit }),
    ...(result.truncated === undefined ? {} : { truncated: result.truncated }),
    ...(result.backend ? { backend: result.backend } : {}),
  }));
}

function catalogSourceSummaries(euclid: CatalogQueryOutput, desi?: CatalogQueryOutput): Array<Record<string, unknown>> {
  return [
    ...(euclid.source ? [{
      catalog: EUCLID_CATALOG,
      assetId: euclid.source.assetId,
      format: euclid.source.format,
      sha256: euclid.source.sha256,
      sourceBytes: euclid.source.sourceBytes,
      rowsScanned: euclid.source.rowsScanned,
      rowsSelected: euclid.hits.length,
    }] : []),
    ...(desi?.source ? [{
      catalog: DESI_CATALOG,
      assetId: desi.source.assetId,
      format: desi.source.format,
      sha256: desi.source.sha256,
      sourceBytes: desi.source.sourceBytes,
      rowsScanned: desi.source.rowsScanned,
      rowsSelected: desi.hits.length,
    }] : []),
  ];
}

function timestamp(): string {
  return new Date().toISOString();
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new RangeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function specializedCatalogArguments(
  tool: McpToolSummary,
  catalog: typeof EUCLID_CATALOG | typeof DESI_CATALOG,
  input: CrossmatchInput,
  genericRequest: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const properties = tool.inputSchema?.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return undefined;

  const args: Record<string, unknown> = {};
  let hasRa = false;
  let hasDec = false;
  let hasRadius = false;
  let hasQuery = false;
  for (const [name, definitionValue] of Object.entries(properties)) {
    const definition = definitionValue && typeof definitionValue === "object" && !Array.isArray(definitionValue)
      ? definitionValue as Record<string, unknown>
      : {};
    const key = name.toLowerCase().replace(/[^a-z0-9]/g, "");
    const description = typeof definition.description === "string" ? definition.description.toLowerCase() : "";
    let value: unknown;
    if (["catalog", "catalogid", "catalogname", "dataset", "index", "indexname"].includes(key)) value = catalog;
    else if (["ra", "radeg", "rightascension", "rightascensiondeg"].includes(key)) { value = input.raDeg; hasRa = true; }
    else if (["dec", "decdeg", "declination", "declinationdeg"].includes(key)) { value = input.decDeg; hasDec = true; }
    else if (["queryradiusarcsec", "searchradiusarcsec", "radiusarcsec", "radiusinarcsec"].includes(key)) { value = input.queryRadiusArcsec; hasRadius = true; }
    else if (["queryradiusdeg", "searchradiusdeg", "radiusdeg", "radiusindegrees"].includes(key)) { value = input.queryRadiusArcsec / 3600; hasRadius = true; }
    else if (["radius", "queryradius", "searchradius"].includes(key)) {
      if (/arcsec|arcsecond/.test(description)) { value = input.queryRadiusArcsec; hasRadius = true; }
      else if (/degree|degrees|\bdeg\b/.test(description)) { value = input.queryRadiusArcsec / 3600; hasRadius = true; }
    } else if (["limit", "size", "maxresults", "maxrows", "topk"].includes(key)) value = input.limit;
    else if (key === "mode") value = "search";
    else if (["query", "querybody", "body"].includes(key) && definition.type === "object") { value = genericRequest.body; hasQuery = true; }
    else if (key === "request" && definition.type === "object") { value = genericRequest; hasQuery = true; }

    if (value !== undefined) args[name] = value;
  }

  const required = Array.isArray(tool.inputSchema?.required) ? tool.inputSchema.required : [];
  if (required.some((name) => typeof name !== "string" || !(name in args))) return undefined;
  if (!Object.keys(args).length || (!hasQuery && !(hasRa && hasDec && hasRadius))) return undefined;
  return args;
}

function rowsFromArtifact(value: string): CrossmatchRecord[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error("Persisted crossmatch artifact is invalid");
  return parsed as CrossmatchRecord[];
}

function publicPreview(rows: CrossmatchRecord[]): Array<Record<string, unknown>> {
  return rows.slice(0, 20).map((row) => ({
    euclidObjectId: row.euclidObjectId,
    desiObjectId: row.desiObjectId,
    euclidRaDeg: row.euclidRaDeg,
    euclidDecDeg: row.euclidDecDeg,
    desiRaDeg: row.desiRaDeg,
    desiDecDeg: row.desiDecDeg,
    euclidMagnitude: row.euclidMagnitude,
    desiMagnitude: row.desiMagnitude,
    separationArcsec: row.separationArcsec,
    classLabel: row.classLabel,
    ...(row.euclidTileIndex ? { euclidTileIndex: row.euclidTileIndex } : {}),
    ...(row.desiBrickname ? { desiBrickname: row.desiBrickname } : {}),
    ...(row.desiRelease ? { desiRelease: row.desiRelease } : {}),
    ...(row.desiBrickId ? { desiBrickId: row.desiBrickId } : {}),
    ...(row.desiBrickObjectId ? { desiBrickObjectId: row.desiBrickObjectId } : {}),
    ...(row.euclidFields ? { euclidFields: row.euclidFields } : {}),
    ...(row.desiFields ? { desiFields: row.desiFields } : {}),
  }));
}

export class WorkflowEngine {
  readonly tools = new ToolRegistry();
  readonly workflows = new WorkflowRegistry(this.tools);
  readonly #activeRuns = new Set<string>();
  readonly #activeRunWaiters = new Map<string, Set<() => void>>();
  #pendingGatesRestored = false;

  constructor(
    readonly store: WorkflowStore,
    private readonly catalogClient: CatalogQueryClient,
    private readonly workflowMcp?: WorkflowMcpClient,
    private readonly inputCatalogs?: WorkflowInputCatalogReader,
    private readonly cutoutService?: WorkspaceFitsCutoutService,
  ) {
    this.registerTools();
    this.workflows.register(EUCLID_DESI_WORKFLOW);
  }

  async restorePendingGates(): Promise<void> {
    if (this.#pendingGatesRestored) return;
    const runs = await this.store.list();
    for (const run of runs) {
      if (run.status === "waiting_for_input") {
        changeHitlPending("human_filter", 1);
      } else if (run.status === "queued") {
        this.schedule(run.id);
      } else if (run.status === "running" && run.resume?.kind === "human_filter") {
        queueMicrotask(() => void this.resumeCommittedRun(run.id));
      }
    }
    this.#pendingGatesRestored = true;
  }

  async createRun(workflowKey: string, inputValue: unknown, agentInitiated = false): Promise<WorkflowRun> {
    const definition = this.workflows.get(workflowKey);
    const input = parseCrossmatchInput(inputValue);
    const run = await this.store.create(definition, input as unknown as Record<string, unknown>, activeTraceparent(), agentInitiated);
    this.schedule(run.id);
    return run;
  }

  async queryCatalogForMcp(side: "euclid" | "desi", inputValue: unknown): Promise<unknown> {
    const stepId = side === "euclid" ? "query_euclid" : "query_desi";
    const toolName = `${side}_catalog_query`;
    return withRootSpan(`mcp.server.tool ${toolName}`, {
      "asa.component": "workflow",
      "asa.step.id": stepId,
      "gen_ai.tool.name": toolName,
      "mcp.method.name": "tools/call",
    }, async () => {
      const input = parseCrossmatchInput(inputValue);
      return this.tools.invoke(`catalog.query_${side}`, input, { runId: "mcp", stepId });
    });
  }

  schedule(runId: string): void {
    queueMicrotask(() => void this.execute(runId));
  }

  async decide(runId: string, decisionValue: unknown): Promise<WorkflowRun> {
    const decision = asRecord(decisionValue, "Decision");
    const action = String(decision.action ?? "");
    const run = await this.store.get(runId);

    if (action === "retry") {
      if (run.status !== "failed") throw new RangeError("Only failed workflow runs can be retried");
      this.resetRun(run, parseCrossmatchInput(run.input));
      run.events.push({ at: timestamp(), type: "decision", message: "用户请求重试" });
      await this.store.save(run);
      this.schedule(run.id);
      return run;
    }

    if (action === "adjust_region") {
      if (run.status !== "waiting_for_input") throw new RangeError("Region adjustment requires a waiting workflow run");
      const updatedInput = parseCrossmatchInput({ ...run.input, ...asRecord(decision.input, "Adjusted input") });
      const gate = this.step(run, "human_filter");
      const startedAt = Date.parse(gate.startedAt ?? timestamp());
      const waitSeconds = Number.isFinite(startedAt) ? Math.max(0, (Date.now() - startedAt) / 1000) : 0;
      await withContinuedSpan("workflow.resume", {
        "asa.component": "workflow",
        "asa.workflow.key": run.workflowKey,
        "asa.workflow.run_id": run.id,
      }, async (span) => {
        await withSpan("hitl.human_filter", {
          "asa.component": "hitl",
          "asa.hitl.gate": "human_filter",
          "asa.hitl.decision": "approved",
          "asa.hitl.action": "adjust_region",
          "asa.hitl.wait_seconds": waitSeconds,
          "asa.hitl.state": "resolved",
          "asa.workflow.run_id": run.id,
        }, async () => {
          changeHitlPending("human_filter", -1);
          recordHitlWait("human_filter", "approved", waitSeconds);
          this.resetRun(run, updatedInput);
          run.traceparent = activeTraceparent() ?? run.traceparent;
          run.events.push({ at: timestamp(), type: "decision", message: "用户调整了查询区域" });
          await this.store.save(run);
          this.schedule(run.id);
        }, { startTime: Number.isFinite(startedAt) ? new Date(startedAt) : undefined });
        span.setAttribute("asa.workflow.outcome", "ok");
      }, run.traceparent);
      return run;
    }

    if (run.status !== "waiting_for_input" || run.waiting?.reason !== "filter") {
      throw new RangeError("Workflow run is not waiting for a filter decision");
    }
    let filter: FilterSpec | undefined;
    if (action === "apply_filter") filter = parseFilterSpec(decision.filter);
    else if (action !== "accept_all") throw new RangeError(`Unsupported workflow decision: ${action}`);
    await this.finishWithFilter(run, filter);
    return this.store.get(run.id);
  }

  private registerTools(): void {
    this.tools.register({
      id: "input.parse_coordinates",
      title: "坐标与参数解析",
      description: "验证 ICRS 坐标、检索半径、匹配半径和结果上限。",
      kind: "local",
      version: "1.0.0",
      inputSchema: EUCLID_DESI_WORKFLOW.inputSchema,
      health: { status: "healthy", detail: "确定性本地函数" },
    }, async (input) => parseCrossmatchInput(input));

    const registerCatalogTool = (id: string, title: string, catalog: typeof EUCLID_CATALOG | typeof DESI_CATALOG): void => {
      this.tools.register({
        id,
        title,
        description: `通过已配置 MCP 或官方 TAP 查询 ${catalog}，不生成合成结果。`,
        kind: "mcp",
        version: "1.0.0",
        inputSchema: { type: "object", required: ["raDeg", "decDeg"] },
        health: { status: "unknown", detail: "尚未执行目录请求" },
      }, async (value) => {
        const input = parseCrossmatchInput(value);
        try {
          const role = catalog === EUCLID_CATALOG ? "euclid" : "desi";
          const catalogSource = workflowCatalogSourceForSide(input, role);
          if (catalogSource) {
            if (!this.inputCatalogs) throw new Error("Workspace catalog file input is unavailable");
            const loaded = await withSpan("catalog.source.read", {
              "asa.component": "workflow",
              "asa.catalog.side": role,
              "asa.catalog.asset_id": catalogSource.assetId,
            }, async (span) => {
              const result = await this.inputCatalogs!.load(catalogSource, {
                raDeg: input.raDeg,
                decDeg: input.decDeg,
                radiusArcsec: input.queryRadiusArcsec,
                limit: input.limit,
              }, input.catalogFields?.[role]);
              span.setAttributes({
                "asa.catalog.format": result.format,
                "asa.catalog.rows_scanned": result.rowsScanned,
                "asa.catalog.rows_selected": result.hits.length,
                "asa.catalog.source_bytes": result.sourceBytes,
              });
              return result;
            });
            const request = {
              assetId: loaded.assetId,
              side: role,
              format: loaded.format,
              sourceSha256: loaded.sourceSha256,
              sourceBytes: loaded.sourceBytes,
              rowsScanned: loaded.rowsScanned,
            };
            this.tools.updateHealth(id, {
              status: "healthy",
              detail: `本地星表返回 ${loaded.hits.length} 行 (${loaded.format.toUpperCase()})`,
              checkedAt: timestamp(),
            });
            return {
              catalog,
              request,
              hits: loaded.hits,
              source: {
                assetId: loaded.assetId,
                format: loaded.format,
                sha256: loaded.sourceSha256,
                sourceBytes: loaded.sourceBytes,
                rowsScanned: loaded.rowsScanned,
              },
            } satisfies CatalogQueryOutput;
          }

          const request = catalogQueryBody(catalog, input);
          const specializedName = `${role}_catalog_query`;
          const queryContext = {
            catalog,
            raDeg: input.raDeg,
            decDeg: input.decDeg,
            radiusArcsec: input.queryRadiusArcsec,
            limit: input.limit,
            ...(input.catalogFields?.[role] ? { fields: input.catalogFields[role] } : {}),
          };
          let payload: unknown;
          let actualRequest = request;
          let calledConfiguredMcp = false;
          let configuredMcpError: unknown;
          let backend: CatalogQueryBackend | undefined;
          const specialized = await this.workflowMcp?.getTool(role, specializedName);
          const specializedArguments = specialized
            ? specializedCatalogArguments(specialized, catalog, input, request)
            : undefined;
          if (specializedArguments && this.workflowMcp) {
            try {
              payload = await this.workflowMcp.callTool(role, specializedName, specializedArguments);
              actualRequest = { tool: specializedName, arguments: specializedArguments };
              backend = {
                provider: "workspace-mcp",
                release: role === "euclid" ? "euclid-q1-mer" : "desi-dr10",
                table: catalog,
                tool: specializedName,
              };
              calledConfiguredMcp = true;
            } catch (error) {
              configuredMcpError = error;
            }
          }
          if (!calledConfiguredMcp && this.workflowMcp && await this.workflowMcp.hasTool(role, "es_query")) {
            try {
              payload = await this.workflowMcp.callTool(role, "es_query", request);
              backend = {
                provider: "workspace-mcp",
                release: role === "euclid" ? "euclid-q1-mer" : "desi-dr10",
                table: catalog,
                tool: "es_query",
              };
              calledConfiguredMcp = true;
            } catch (error) {
              configuredMcpError = configuredMcpError
                ? new AggregateError([configuredMcpError, error], "Configured catalog MCP tools failed")
                : error;
            }
          }
          if (!calledConfiguredMcp) {
            try {
              payload = await this.catalogClient.query(request, queryContext);
            } catch (error) {
              if (configuredMcpError) throw new AggregateError([configuredMcpError, error], "Configured catalog MCP and fallback query failed");
              throw error;
            }
          }
          const hits = extractCatalogHits(payload);
          backend ??= catalogBackendFromPayload(payload);
          const queryLimit = catalogQueryLimitFromPayload(payload) ?? input.limit;
          const truncated = catalogTruncationFromPayload(payload);
          actualRequest = {
            ...actualRequest,
            ...(backend ? { backend } : {}),
            queryLimit,
            ...(truncated === undefined ? {} : { truncated }),
          };
          this.tools.updateHealth(id, { status: "healthy", detail: `最近请求返回 ${hits.length} 行`, checkedAt: timestamp() });
          return {
            catalog,
            request: actualRequest,
            hits,
            ...(backend ? { backend } : {}),
            queryLimit,
            ...(truncated === undefined ? {} : { truncated }),
          } satisfies CatalogQueryOutput;
        } catch (error) {
          this.tools.updateHealth(id, { status: "unavailable", detail: error instanceof Error ? error.message : String(error), checkedAt: timestamp() });
          throw error;
        }
      });
    };
    registerCatalogTool("catalog.query_euclid", "Euclid 目录查询", EUCLID_CATALOG);
    registerCatalogTool("catalog.query_desi", "DESI 目录查询", DESI_CATALOG);

    this.tools.register({
      id: "cutout.execute_grouped",
      title: "FITS 图像裁切",
      description: "按源图像分组执行 FITS cutout；ready 的本地 Connector 使用 Workspace Astropy 执行器，其他来源调用已配置且支持产物读取的 FITS cutout MCP，所有成功 FITS 均登记为 Workspace artifact。",
      kind: "mcp",
      version: "1.0.0",
      inputSchema: { type: "object", required: ["rows", "sizeDeg", "desiBands"] },
      health: { status: "unknown", detail: "尚未执行 cutout 请求" },
    }, async (value, context) => {
      const input = asRecord(value, "Cutout input");
      if (!this.workflowMcp && !this.cutoutService) throw new Error("Workspace MCP tools are unavailable for FITS cutout");
      try {
        const result = await withSpan("fits.cutout", {
          "asa.component": "workflow",
          "asa.workflow.run_id": context.runId,
          "gen_ai.tool.name": "execute_cutout_group",
        }, async (span) => {
          const summary = await executeWorkflowCutouts({
            runId: context.runId,
            rows: input.rows as CrossmatchRecord[],
            sizeDeg: Number(input.sizeDeg),
            desiBands: input.desiBands as Array<"g" | "r" | "i" | "z">,
            ...(this.workflowMcp ? { mcp: this.workflowMcp } : {}),
            ...(this.cutoutService ? { executor: this.cutoutService } : {}),
            ...(context.workflowRun ? {
              run: context.workflowRun,
              onGroupComplete: async () => this.store.save(context.workflowRun!),
            } : {}),
          });
          span.setAttributes({
            "asa.cutout.groups": summary.groupsTotal,
            "asa.cutout.targets": summary.targetsTotal,
            "asa.cutout.succeeded": summary.targetsSucceeded,
            "asa.cutout.failed": summary.targetsFailed,
          });
          return summary;
        });
        this.tools.updateHealth("cutout.execute_grouped", {
          status: result.groupsFailed > 0 || result.unresolvedTargets > 0 ? "degraded" : "healthy",
          detail: `${result.targetsSucceeded} 个 cutout 目标成功，${result.targetsFailed} 个失败`,
          checkedAt: timestamp(),
        });
        return result satisfies WorkflowCutoutSummary;
      } catch (error) {
        this.tools.updateHealth("cutout.execute_grouped", {
          status: "unavailable",
          detail: error instanceof Error ? error.message : String(error),
          checkedAt: timestamp(),
        });
        throw error;
      }
    });

    this.tools.register({
      id: "coordinates.normalize_catalogs",
      title: "坐标规范化",
      description: "识别目录字段、规范化 RA，并剔除字段不完整或检索圆外的行。",
      kind: "local",
      version: "1.0.0",
      inputSchema: { type: "object" },
      health: { status: "healthy", detail: "确定性本地函数" },
    }, async (value) => {
      const input = asRecord(value, "Coordinate normalization input");
      const workflowInput = parseCrossmatchInput(input.workflowInput);
      const euclid = asRecord(input.euclid, "Euclid query") as unknown as CatalogQueryOutput;
      const desi = asRecord(input.desi, "DESI query") as unknown as CatalogQueryOutput;
      return {
        euclid: normalizeCatalogRows("euclid", euclid.hits, workflowInput),
        desi: normalizeCatalogRows("desi", desi.hits, workflowInput),
      } satisfies NormalizedOutput;
    });

    this.tools.register({
      id: "crossmatch.nearest_spherical",
      title: "最近邻球面匹配",
      description: "使用球面角距离为每个 Euclid 对象选择半径内最近的 DESI 对象。",
      kind: "local",
      version: "1.0.0",
      inputSchema: { type: "object" },
      health: { status: "healthy", detail: "确定性本地函数" },
    }, async (value) => {
      const input = asRecord(value, "Crossmatch input");
      const rows = asRecord(input.rows, "Normalized rows") as unknown as NormalizedOutput;
      const radiusArcsec = Number(input.radiusArcsec);
      if (!Number.isFinite(radiusArcsec)) throw new RangeError("Crossmatch radius is required");
      return nearestNeighborCrossmatch(rows.euclid, rows.desi, radiusArcsec);
    });

    this.tools.register({
      id: "results.filter",
      title: "结果筛选",
      description: "按显式人工决策筛选匹配结果。",
      kind: "local",
      version: "1.0.0",
      inputSchema: { type: "object" },
      health: { status: "healthy", detail: "确定性本地函数" },
    }, async (value) => {
      const input = asRecord(value, "Filter input");
      return applyResultFilter(input.rows as CrossmatchRecord[], input.filter as FilterSpec | undefined);
    });

    this.tools.register({
      id: "results.export",
      title: "受限结果导出",
      description: "输出至多 1,000 行 CSV 和至多 20 行 JSON 预览。",
      kind: "local",
      version: "1.0.0",
      inputSchema: { type: "object" },
      health: { status: "healthy", detail: "确定性本地函数" },
    }, async (value) => {
      const input = asRecord(value, "Export input");
      const rows = input.rows as CrossmatchRecord[];
      return { csv: rowsToCsv(rows), preview: publicPreview(rows) };
    });
  }

  private async execute(runId: string): Promise<void> {
    if (this.#activeRuns.has(runId)) return;
    this.#activeRuns.add(runId);
    let run: WorkflowRun | undefined;
    try {
      run = await this.store.get(runId);
      if (run.status !== "queued") return;
      const started = performance.now();
      changeTaskRunning(run.workflowKey, 1);
      const spanAttributes = {
        "asa.component": "workflow",
        "asa.workflow.key": run.workflowKey,
        "asa.workflow.run_id": run.id,
      };
      const runWorkflow = async (span: import("@opentelemetry/api").Span): Promise<void> => {
        try {
          run!.status = "running";
          run!.startedAt ??= timestamp();
          run!.completedAt = undefined;
          run!.error = undefined;
          run!.events.push({ at: timestamp(), type: "status", message: "运行已开始" });

          const input = await this.callStep<CrossmatchInput>(run!, "parse_input", run!.input, (value) => ({
            raDeg: value.raDeg, decDeg: value.decDeg, queryRadiusArcsec: value.queryRadiusArcsec,
            matchRadiusArcsec: value.matchRadiusArcsec, limit: value.limit,
          }));
          const euclid = await this.callStep<CatalogQueryOutput>(run!, "query_euclid", input, (value) => ({
            rows: value.hits.length,
            catalog: value.catalog,
            ...(value.backend ? { backend: value.backend } : {}),
            ...(value.queryLimit === undefined ? {} : { queryLimit: value.queryLimit }),
            ...(value.truncated === undefined ? {} : { truncated: value.truncated }),
            ...(value.source ? {
              assetId: value.source.assetId,
              sourceFormat: value.source.format,
              sourceSha256: value.source.sha256,
              sourceBytes: value.source.sourceBytes,
              rowsScanned: value.source.rowsScanned,
            } : {}),
          }));
          run!.lineage.sources = [catalogLineageEntry(EUCLID_CATALOG, euclid)];
          run!.summary = { ...run!.summary, catalogQueries: catalogQuerySummaries(euclid) };
          const euclidSourceSummary = catalogSourceSummaries(euclid);
          if (euclidSourceSummary.length) run!.summary = { ...run!.summary, catalogSources: euclidSourceSummary };
          if (euclid.hits.length === 0) {
            await this.waitForRegion(run!, "Euclid 目录在当前区域没有返回结果，请调整中心或检索半径", span);
            return;
          }
          const desi = await this.callStep<CatalogQueryOutput>(run!, "query_desi", input, (value) => ({
            rows: value.hits.length,
            catalog: value.catalog,
            ...(value.backend ? { backend: value.backend } : {}),
            ...(value.queryLimit === undefined ? {} : { queryLimit: value.queryLimit }),
            ...(value.truncated === undefined ? {} : { truncated: value.truncated }),
            ...(value.source ? {
              assetId: value.source.assetId,
              sourceFormat: value.source.format,
              sourceSha256: value.source.sha256,
              sourceBytes: value.source.sourceBytes,
              rowsScanned: value.source.rowsScanned,
            } : {}),
          }));
          run!.lineage.sources.push(catalogLineageEntry(DESI_CATALOG, desi));
          const sourceSummaries = catalogSourceSummaries(euclid, desi);
          run!.summary = {
            ...run!.summary,
            catalogQueries: catalogQuerySummaries(euclid, desi),
            ...(sourceSummaries.length ? { catalogSources: sourceSummaries } : {}),
          };
          if (desi.hits.length === 0) {
            await this.waitForRegion(run!, "DESI 目录在当前区域没有返回结果，请调整中心或检索半径", span);
            return;
          }
          const normalized = await this.callStep<NormalizedOutput>(run!, "normalize", { workflowInput: input, euclid, desi }, (value) => ({
            euclidRows: value.euclid.length, desiRows: value.desi.length,
          }));
          run!.lineage.sources = [
            catalogLineageEntry(EUCLID_CATALOG, euclid, normalized.euclid.length),
            catalogLineageEntry(DESI_CATALOG, desi, normalized.desi.length),
          ];
          if (normalized.euclid.length === 0 || normalized.desi.length === 0) {
            throw new Error("目录返回行缺少有效对象标识或坐标字段");
          }
          const matches = await this.callStep<CrossmatchRecord[]>(run!, "crossmatch", { rows: normalized, radiusArcsec: input.matchRadiusArcsec }, (value) => ({ matches: value.length, radiusArcsec: input.matchRadiusArcsec }));
          run!.summary = {
            raDeg: input.raDeg,
            decDeg: input.decDeg,
            queryRadiusArcsec: input.queryRadiusArcsec,
            matchRadiusArcsec: input.matchRadiusArcsec,
            euclidRows: normalized.euclid.length,
            desiRows: normalized.desi.length,
            matchRows: matches.length,
            filteredRows: null,
            catalogQueries: catalogQuerySummaries(euclid, desi),
            ...(sourceSummaries.length ? { catalogSources: sourceSummaries } : {}),
          };
          run!.preview = publicPreview(matches);
          await this.store.writeArtifact(run!, "crossmatch.json", "application/json", matches.length, `${JSON.stringify(matches)}\n`, false);
          await this.store.writeArtifact(run!, "crossmatch.csv", "text/csv; charset=utf-8", matches.length, rowsToCsv(matches), false);
          if (matches.length === 0) {
            await this.waitForRegion(run!, `两个真实目录均返回数据，但在 ${input.matchRadiusArcsec} 角秒内没有匹配，请调整区域或匹配半径`, span);
            return;
          }
          const gate = this.step(run!, "human_filter");
          gate.status = "waiting_for_input";
          gate.attempts += 1;
          gate.startedAt = timestamp();
          run!.status = "waiting_for_input";
          run!.waiting = {
            reason: "filter",
            stepId: gate.id,
            message: "匹配结果已就绪，请确认全部保留或提交筛选条件",
            availableFields: matches[0] ? availableFilterFields(matches[0]) : [],
          };
          run!.traceparent = activeTraceparent() ?? run!.traceparent;
          span.setAttribute("asa.hitl.state", "waiting");
          run!.events.push({ at: timestamp(), type: "status", stepId: gate.id, message: "等待人工筛选" });
          changeHitlPending("human_filter", 1);
          await this.store.save(run!);
        } catch (error) {
          if (run) await this.failRun(run, error);
          throw error;
        } finally {
          const outcome = run!.status === "succeeded" ? "ok" : run!.status === "failed" ? "error" : run!.status === "waiting_for_input" ? "waiting" : "error";
          span.setAttribute("asa.workflow.outcome", outcome);
          recordTaskDuration(run!.workflowKey, (performance.now() - started) / 1000, outcome);
          changeTaskRunning(run!.workflowKey, -1);
        }
      };
      if (run.agentInitiated && run.traceparent) {
        await withContinuedSpan("workflow.run", spanAttributes, runWorkflow, run.traceparent);
      } else {
        await withRootSpan("workflow.run", spanAttributes, runWorkflow, traceContextFromTraceparent(run.traceparent));
      }
    } catch (error) {
      if (!run) console.error("Workflow execution failed before loading the run", classifyError(error));
    } finally {
      this.#releaseActiveRun(runId);
    }
  }

  private async resumeCommittedRun(runId: string): Promise<void> {
    let run: WorkflowRun | undefined;
    try {
      run = await this.store.get(runId);
      if (run.status !== "running" || run.resume?.kind !== "human_filter") return;
      const filter = run.resume.action === "apply_filter" ? parseFilterSpec(run.resume.filter) : undefined;
      await this.finishWithFilter(run, filter);
    } catch (error) {
      if (run?.status === "running") await this.failRun(run, error);
      console.error("Failed to resume interrupted workflow", classifyError(error));
    }
  }

  private async finishWithFilter(run: WorkflowRun, filter?: FilterSpec): Promise<void> {
    if (this.#activeRuns.has(run.id)) {
      if (run.status !== "waiting_for_input") throw new RangeError("Workflow run is already executing");
      await this.waitForActiveRun(run.id);
      if (this.#activeRuns.has(run.id)) throw new RangeError("Workflow run is already executing");
    }
    this.#activeRuns.add(run.id);
    const gate = this.step(run, "human_filter");
    const resumeCheckpoint = run.resume?.kind === "human_filter" ? run.resume : undefined;
    const recovering = resumeCheckpoint !== undefined;
    if (resumeCheckpoint) {
      filter = resumeCheckpoint.action === "apply_filter" ? parseFilterSpec(resumeCheckpoint.filter) : undefined;
    }
    const startedAt = Date.parse(gate.startedAt ?? timestamp());
    const waitSeconds = !recovering && Number.isFinite(startedAt) ? Math.max(0, (Date.now() - startedAt) / 1000) : 0;
    const resumedAt = performance.now();
    let decisionRecorded = recovering;
    changeTaskRunning(run.workflowKey, 1);
    try {
      await withContinuedSpan("workflow.resume", {
        "asa.component": "workflow",
        "asa.workflow.key": run.workflowKey,
        "asa.workflow.run_id": run.id,
      }, async (span) => {
        if (!recovering) {
          await withSpan("hitl.human_filter", {
            "asa.component": "hitl",
            "asa.hitl.gate": "human_filter",
            "asa.hitl.decision": "approved",
            "asa.hitl.wait_seconds": waitSeconds,
            "asa.hitl.state": "resolved",
            "asa.workflow.run_id": run.id,
          }, async () => {
            run.status = "running";
            run.waiting = undefined;
            gate.status = "succeeded";
            gate.completedAt = timestamp();
            gate.durationMs = Date.parse(gate.completedAt) - Date.parse(gate.startedAt ?? gate.completedAt);
            gate.outputSummary = { decision: filter ? "apply_filter" : "accept_all", conditions: filter?.conditions.length ?? 0 };
            run.resume = {
              kind: "human_filter",
              action: filter ? "apply_filter" : "accept_all",
              ...(filter ? { filter: filter as unknown as Record<string, unknown> } : {}),
              decidedAt: timestamp(),
            };
            run.events.push({ at: timestamp(), type: "decision", stepId: gate.id, message: filter ? "用户提交筛选条件" : "用户确认保留全部匹配" });
            await this.store.save(run);
            changeHitlPending("human_filter", -1);
            recordHitlWait("human_filter", "approved", waitSeconds);
            decisionRecorded = true;
          }, { startTime: Number.isFinite(startedAt) ? new Date(startedAt) : undefined });
        }

        const matches = rowsFromArtifact(await this.store.readArtifact(run.id, "crossmatch.json"));
        const filtered = await this.invokeUntracked<CrossmatchRecord[]>(run, "human_filter", "results.filter", { rows: matches, filter });
        const cutoutStep = this.step(run, "cutout");
        if (run.input.cutoutEnabled === true) {
          const cutouts = await this.callStep<WorkflowCutoutSummary>(run, "cutout", {
            rows: filtered,
            sizeDeg: Number(run.input.cutoutSizeDeg ?? 0.008),
            desiBands: run.input.desiBands ?? ["g", "r", "i", "z"],
          }, (value) => ({
            groups: value.groupsTotal,
            groupsSucceeded: value.groupsSucceeded,
            groupsFailed: value.groupsFailed,
            targetsSucceeded: value.targetsSucceeded,
            targetsFailed: value.targetsFailed,
          }));
          await this.store.writeArtifact(run, "cutouts.json", "application/json", cutouts.records.length,
            `${JSON.stringify(cutouts)}\n`, false);
          run.summary = {
            ...run.summary,
            cutoutGroups: cutouts.groupsTotal,
            cutoutGroupsSucceeded: cutouts.groupsSucceeded,
            cutoutGroupsFailed: cutouts.groupsFailed,
            cutoutTargetsSucceeded: cutouts.targetsSucceeded,
            cutoutTargetsFailed: cutouts.targetsFailed,
            cutoutUnresolvedTargets: cutouts.unresolvedTargets,
          };
          if (cutouts.groupsFailed > 0 || cutouts.unresolvedTargets > 0) {
            const message = `FITS cutout 部分失败：${cutouts.groupsFailed} 组失败，${cutouts.unresolvedTargets} 个目标没有图像来源`;
            cutoutStep.status = "failed";
            cutoutStep.error = message;
            cutoutStep.completedAt = timestamp();
            run.events.push({ at: cutoutStep.completedAt, type: "status", stepId: cutoutStep.id, message });
            await this.store.save(run);
            throw new Error(message);
          }
        } else {
          cutoutStep.status = "skipped";
          cutoutStep.startedAt = timestamp();
          cutoutStep.completedAt = cutoutStep.startedAt;
          cutoutStep.outputSummary = { reason: "cutoutEnabled=false" };
          run.events.push({ at: cutoutStep.completedAt, type: "status", stepId: cutoutStep.id, message: "未请求 FITS cutout" });
        }
        const exported = await this.callStep<{ csv: string; preview: Array<Record<string, unknown>> }>(run, "export", { rows: filtered }, () => ({ rows: filtered.length, limited: filtered.length >= 1000 }));
        run.preview = exported.preview.slice(0, 20);
        run.summary = { ...run.summary, filteredRows: filtered.length, filter: filter ?? null };
        await this.store.writeArtifact(run, "filtered.csv", "text/csv; charset=utf-8", filtered.length, exported.csv, false);
        const resultDocument = {
          runId: run.id,
          workflow: run.workflowKey,
          status: "succeeded",
          summary: run.summary,
          preview: run.preview,
          lineage: run.lineage,
        };
        await this.store.writeArtifact(run, "result.json", "application/json", run.preview.length, `${JSON.stringify(resultDocument, null, 2)}\n`, false);
        run.status = "succeeded";
        run.completedAt = timestamp();
        delete run.resume;
        run.events.push({ at: run.completedAt, type: "status", message: "工作流执行成功" });
        await this.store.save(run);
        span.setAttribute("asa.workflow.outcome", "ok");
      }, run.traceparent);
      recordTaskDuration(run.workflowKey, (performance.now() - resumedAt) / 1000, "ok");
    } catch (error) {
      await this.failRun(run, error);
      if (!decisionRecorded) {
        changeHitlPending("human_filter", -1);
        recordHitlWait("human_filter", "approved", waitSeconds);
      }
      recordTaskDuration(run.workflowKey, (performance.now() - resumedAt) / 1000, "error");
      throw error;
    } finally {
      changeTaskRunning(run.workflowKey, -1);
      this.#releaseActiveRun(run.id);
    }
  }

  private async waitForActiveRun(runId: string): Promise<void> {
    if (!this.#activeRuns.has(runId)) return;
    await new Promise<void>((resolve) => {
      const waiters = this.#activeRunWaiters.get(runId) ?? new Set<() => void>();
      waiters.add(resolve);
      this.#activeRunWaiters.set(runId, waiters);
    });
  }

  #releaseActiveRun(runId: string): void {
    this.#activeRuns.delete(runId);
    const waiters = this.#activeRunWaiters.get(runId);
    this.#activeRunWaiters.delete(runId);
    waiters?.forEach((resolve) => resolve());
  }

  private async callStep<T>(run: WorkflowRun, stepId: string, input: unknown, summarize: (value: T) => Record<string, unknown>): Promise<T> {
    const step = this.step(run, stepId);
    if (!step.toolId) throw new Error(`Workflow step has no tool: ${step.id}`);
    step.status = "running";
    step.attempts += 1;
    step.startedAt = timestamp();
    step.completedAt = undefined;
    step.error = undefined;
    run.events.push({ at: step.startedAt, type: "step", stepId, message: `${step.title}已开始` });
    await this.store.save(run);
    const started = performance.now();
    try {
      const result = await withSpan(`workflow.step ${stepId}`, {
        "asa.component": "workflow",
        "asa.step.id": stepId,
      }, () => this.tools.invoke(step.toolId!, input, { runId: run.id, stepId, workflowRun: run })) as T;
      step.status = "succeeded";
      step.completedAt = timestamp();
      step.durationMs = Number((performance.now() - started).toFixed(3));
      step.outputSummary = summarize(result);
      run.events.push({ at: step.completedAt, type: "tool", stepId, message: `${step.toolId} 执行成功`, durationMs: step.durationMs });
      await this.store.save(run);
      return result;
    } catch (error) {
      step.status = "failed";
      step.completedAt = timestamp();
      step.durationMs = Number((performance.now() - started).toFixed(3));
      step.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  private async invokeUntracked<T>(run: WorkflowRun, stepId: string, toolId: string, input: unknown): Promise<T> {
    const started = performance.now();
    const result = await withSpan(`workflow.step ${stepId}`, {
      "asa.component": "workflow",
      "asa.step.id": stepId,
    }, () => this.tools.invoke(toolId, input, { runId: run.id, stepId, workflowRun: run })) as T;
    run.events.push({ at: timestamp(), type: "tool", stepId, message: `${toolId} 执行成功`, durationMs: Number((performance.now() - started).toFixed(3)) });
    return result;
  }

  private async waitForRegion(run: WorkflowRun, message: string, span: import("@opentelemetry/api").Span): Promise<void> {
    const gate = this.step(run, "human_filter");
    gate.status = "waiting_for_input";
    gate.attempts += 1;
    gate.startedAt = timestamp();
    run.status = "waiting_for_input";
    run.waiting = { reason: "region_adjust", stepId: gate.id, message, availableFields: [] };
    run.traceparent = activeTraceparent() ?? run.traceparent;
    span.setAttribute("asa.hitl.state", "waiting");
    run.events.push({ at: timestamp(), type: "status", stepId: gate.id, message: "等待调整查询区域" });
    changeHitlPending("human_filter", 1);
    await this.store.save(run);
  }

  private async failRun(run: WorkflowRun, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    run.status = "failed";
    run.waiting = undefined;
    run.error = message;
    run.completedAt = timestamp();
    const running = run.steps.find((step) => step.status === "running");
    if (running) {
      running.status = "failed";
      running.error = message;
      running.completedAt = run.completedAt;
    }
    run.events.push({ at: run.completedAt, type: "status", stepId: running?.id, message: `运行失败：${message}` });
    await this.store.save(run);
  }

  private resetRun(run: WorkflowRun, input: CrossmatchInput): void {
    run.input = input as unknown as Record<string, unknown>;
    run.status = "queued";
    run.startedAt = undefined;
    run.completedAt = undefined;
    run.waiting = undefined;
    delete run.resume;
    run.error = undefined;
    run.summary = {};
    run.preview = [];
    run.artifacts = [];
    run.lineage = { sources: [], artifacts: [], relatedScanRunIds: [] };
    for (const step of run.steps) {
      step.status = "pending";
      step.startedAt = undefined;
      step.completedAt = undefined;
      step.durationMs = undefined;
      step.outputSummary = undefined;
      step.error = undefined;
    }
  }

  private step(run: WorkflowRun, id: string): WorkflowStepRun {
    const step = run.steps.find((candidate) => candidate.id === id);
    if (!step) throw new Error(`Workflow run step not found: ${id}`);
    return step;
  }
}
