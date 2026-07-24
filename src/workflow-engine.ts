import type { CatalogQueryClient } from "./catalog-mcp-client.js";
import {
  applyResultFilter,
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
  type CrossmatchInput,
  type CrossmatchRecord,
  type FilterSpec,
} from "./scientific-tools.js";
import type { WorkflowStore } from "./workflow-store.js";
import {
  ToolRegistry,
  WorkflowRegistry,
  type WorkflowDefinition,
  type WorkflowRun,
  type WorkflowStepRun,
} from "./workflow.js";

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
      queryRadiusArcsec: { type: "number", minimum: 1, maximum: 3600, default: 600 },
      matchRadiusArcsec: { type: "number", minimum: 0.1, maximum: 10, default: 1.5 },
      limit: { type: "integer", minimum: 1, maximum: 1000, default: 500 },
    },
  },
  steps: [
    { id: "parse_input", title: "解析输入", kind: "tool", toolId: "input.parse_coordinates", dependsOn: [] },
    { id: "query_euclid", title: "查询 Euclid Q1 MER", kind: "tool", toolId: "catalog.query_euclid", dependsOn: ["parse_input"] },
    { id: "query_desi", title: "查询 DESI DR10 Tractor", kind: "tool", toolId: "catalog.query_desi", dependsOn: ["query_euclid"] },
    { id: "normalize", title: "规范化天球坐标", kind: "tool", toolId: "coordinates.normalize_catalogs", dependsOn: ["query_euclid", "query_desi"] },
    { id: "crossmatch", title: "最近邻球面匹配", kind: "tool", toolId: "crossmatch.nearest_spherical", dependsOn: ["normalize"] },
    { id: "human_filter", title: "人工筛选", kind: "human_gate", dependsOn: ["crossmatch"] },
    { id: "export", title: "导出与血缘登记", kind: "export", toolId: "results.export", dependsOn: ["human_filter"] },
  ],
  outputs: [
    { name: "crossmatch.csv", mediaType: "text/csv", maxRows: 1000 },
    { name: "filtered.csv", mediaType: "text/csv", maxRows: 1000 },
    { name: "result.json", mediaType: "application/json", maxRows: 20 },
  ],
};

interface CatalogQueryOutput {
  catalog: string;
  request: Record<string, unknown>;
  hits: Array<Record<string, unknown>>;
}

interface NormalizedOutput {
  euclid: ReturnType<typeof normalizeCatalogRows>;
  desi: ReturnType<typeof normalizeCatalogRows>;
}

function timestamp(): string {
  return new Date().toISOString();
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new RangeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function rowsFromArtifact(value: string): CrossmatchRecord[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error("Persisted crossmatch artifact is invalid");
  return parsed as CrossmatchRecord[];
}

function publicPreview(rows: CrossmatchRecord[]): Array<Record<string, unknown>> {
  return rows.slice(0, 20).map((row) => ({ ...row }));
}

export class WorkflowEngine {
  readonly tools = new ToolRegistry();
  readonly workflows = new WorkflowRegistry(this.tools);
  readonly #activeRuns = new Set<string>();

  constructor(
    readonly store: WorkflowStore,
    private readonly catalogClient: CatalogQueryClient,
  ) {
    this.registerTools();
    this.workflows.register(EUCLID_DESI_WORKFLOW);
  }

  async createRun(workflowKey: string, inputValue: unknown): Promise<WorkflowRun> {
    const definition = this.workflows.get(workflowKey);
    const input = parseCrossmatchInput(inputValue);
    const run = await this.store.create(definition, input as unknown as Record<string, unknown>);
    this.schedule(run.id);
    return run;
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
      this.resetRun(run, updatedInput);
      run.events.push({ at: timestamp(), type: "decision", message: "用户调整了查询区域" });
      await this.store.save(run);
      this.schedule(run.id);
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
        description: `通过受限 MCP 查询 ${catalog}，不生成合成结果。`,
        kind: "mcp",
        version: "1.0.0",
        inputSchema: { type: "object", required: ["raDeg", "decDeg"] },
        health: { status: "unknown", detail: "尚未执行目录请求" },
      }, async (value) => {
        const input = parseCrossmatchInput(value);
        const request = catalogQueryBody(catalog, input);
        try {
          const payload = await this.catalogClient.query(request);
          const hits = extractCatalogHits(payload);
          this.tools.updateHealth(id, { status: "healthy", detail: `最近请求返回 ${hits.length} 行`, checkedAt: timestamp() });
          return { catalog, request, hits } satisfies CatalogQueryOutput;
        } catch (error) {
          this.tools.updateHealth(id, { status: "unavailable", detail: error instanceof Error ? error.message : String(error), checkedAt: timestamp() });
          throw error;
        }
      });
    };
    registerCatalogTool("catalog.query_euclid", "Euclid 目录查询", EUCLID_CATALOG);
    registerCatalogTool("catalog.query_desi", "DESI 目录查询", DESI_CATALOG);

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
      run.status = "running";
      run.startedAt ??= timestamp();
      run.completedAt = undefined;
      run.error = undefined;
      run.events.push({ at: timestamp(), type: "status", message: "运行已开始" });

      const input = await this.callStep<CrossmatchInput>(run, "parse_input", run.input, (value) => ({
        raDeg: value.raDeg, decDeg: value.decDeg, queryRadiusArcsec: value.queryRadiusArcsec,
        matchRadiusArcsec: value.matchRadiusArcsec, limit: value.limit,
      }));
      const euclid = await this.callStep<CatalogQueryOutput>(run, "query_euclid", input, (value) => ({ rows: value.hits.length, catalog: value.catalog }));
      if (euclid.hits.length === 0) {
        await this.waitForRegion(run, "Euclid 目录在当前区域没有返回结果，请调整中心或检索半径");
        return;
      }
      const desi = await this.callStep<CatalogQueryOutput>(run, "query_desi", input, (value) => ({ rows: value.hits.length, catalog: value.catalog }));
      if (desi.hits.length === 0) {
        await this.waitForRegion(run, "DESI 目录在当前区域没有返回结果，请调整中心或检索半径");
        return;
      }
      const normalized = await this.callStep<NormalizedOutput>(run, "normalize", { workflowInput: input, euclid, desi }, (value) => ({
        euclidRows: value.euclid.length, desiRows: value.desi.length,
      }));
      if (normalized.euclid.length === 0 || normalized.desi.length === 0) {
        throw new Error("目录返回行缺少有效对象标识或坐标字段");
      }
      const matches = await this.callStep<CrossmatchRecord[]>(run, "crossmatch", { rows: normalized, radiusArcsec: input.matchRadiusArcsec }, (value) => ({ matches: value.length, radiusArcsec: input.matchRadiusArcsec }));
      run.summary = {
        raDeg: input.raDeg,
        decDeg: input.decDeg,
        queryRadiusArcsec: input.queryRadiusArcsec,
        matchRadiusArcsec: input.matchRadiusArcsec,
        euclidRows: normalized.euclid.length,
        desiRows: normalized.desi.length,
        matchRows: matches.length,
        filteredRows: null,
      };
      run.preview = publicPreview(matches);
      run.lineage.sources = [
        { catalog: EUCLID_CATALOG, querySha256: sha256Json(euclid.request), rowCount: normalized.euclid.length },
        { catalog: DESI_CATALOG, querySha256: sha256Json(desi.request), rowCount: normalized.desi.length },
      ];
      await this.store.writeArtifact(run, "crossmatch.json", "application/json", matches.length, `${JSON.stringify(matches)}\n`, false);
      await this.store.writeArtifact(run, "crossmatch.csv", "text/csv; charset=utf-8", matches.length, rowsToCsv(matches), false);
      if (matches.length === 0) {
        await this.waitForRegion(run, `两个真实目录均返回数据，但在 ${input.matchRadiusArcsec} 角秒内没有匹配，请调整区域或匹配半径`);
        return;
      }
      const gate = this.step(run, "human_filter");
      gate.status = "waiting_for_input";
      gate.attempts += 1;
      gate.startedAt = timestamp();
      run.status = "waiting_for_input";
      run.waiting = {
        reason: "filter",
        stepId: gate.id,
        message: "匹配结果已就绪，请确认全部保留或提交筛选条件",
        availableFields: Object.keys(matches[0] ?? {}),
      };
      run.events.push({ at: timestamp(), type: "status", stepId: gate.id, message: "等待人工筛选" });
      void this.store.save(run).catch((error) => console.error(`Failed to persist waiting workflow run ${runId}`, error));
    } catch (error) {
      if (run) await this.failRun(run, error);
      else console.error("Workflow execution failed before loading the run", error);
    } finally {
      this.#activeRuns.delete(runId);
    }
  }

  private async finishWithFilter(run: WorkflowRun, filter?: FilterSpec): Promise<void> {
    if (this.#activeRuns.has(run.id)) throw new RangeError("Workflow run is already executing");
    this.#activeRuns.add(run.id);
    try {
      run.status = "running";
      run.waiting = undefined;
      const gate = this.step(run, "human_filter");
      gate.status = "succeeded";
      gate.completedAt = timestamp();
      gate.durationMs = Date.parse(gate.completedAt) - Date.parse(gate.startedAt ?? gate.completedAt);
      gate.outputSummary = { decision: filter ? "apply_filter" : "accept_all", conditions: filter?.conditions.length ?? 0 };
      run.events.push({ at: timestamp(), type: "decision", stepId: gate.id, message: filter ? "用户提交筛选条件" : "用户确认保留全部匹配" });
      const matches = rowsFromArtifact(await this.store.readArtifact(run.id, "crossmatch.json"));
      const filtered = await this.invokeUntracked<CrossmatchRecord[]>(run, "human_filter", "results.filter", { rows: matches, filter });
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
      run.events.push({ at: run.completedAt, type: "status", message: "工作流执行成功" });
      await this.store.save(run);
    } catch (error) {
      await this.failRun(run, error);
      throw error;
    } finally {
      this.#activeRuns.delete(run.id);
    }
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
    const started = performance.now();
    try {
      const result = await this.tools.invoke(step.toolId, input, { runId: run.id, stepId }) as T;
      step.status = "succeeded";
      step.completedAt = timestamp();
      step.durationMs = Number((performance.now() - started).toFixed(3));
      step.outputSummary = summarize(result);
      run.events.push({ at: step.completedAt, type: "tool", stepId, message: `${step.toolId} 执行成功`, durationMs: step.durationMs });
      void this.store.save(run).catch((error) => console.error(`Failed to persist workflow step ${run.id}/${stepId}`, error));
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
    const result = await this.tools.invoke(toolId, input, { runId: run.id, stepId }) as T;
    run.events.push({ at: timestamp(), type: "tool", stepId, message: `${toolId} 执行成功`, durationMs: Number((performance.now() - started).toFixed(3)) });
    return result;
  }

  private async waitForRegion(run: WorkflowRun, message: string): Promise<void> {
    const gate = this.step(run, "human_filter");
    gate.status = "waiting_for_input";
    gate.attempts += 1;
    gate.startedAt = timestamp();
    run.status = "waiting_for_input";
    run.waiting = { reason: "region_adjust", stepId: gate.id, message, availableFields: [] };
    run.events.push({ at: timestamp(), type: "status", stepId: gate.id, message: "等待调整查询区域" });
    void this.store.save(run).catch((error) => console.error(`Failed to persist waiting workflow run ${run.id}`, error));
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
    void this.store.save(run).catch((saveError) => console.error(`Failed to persist failed workflow run ${run.id}`, saveError));
  }

  private resetRun(run: WorkflowRun, input: CrossmatchInput): void {
    run.input = input as unknown as Record<string, unknown>;
    run.status = "queued";
    run.startedAt = undefined;
    run.completedAt = undefined;
    run.waiting = undefined;
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
