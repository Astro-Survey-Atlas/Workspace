import { expect, test, type Page, type Route } from "@playwright/test";
import { createServer, type ServerResponse } from "node:http";

const sourceId = "public:euclid:ero:imaging:layerId=layer-ero-imaging";
const layerId = "layer-ero-imaging";
const baseSelection = {
  layerIds: [layerId],
  order: 4,
  cells: [176],
  querySnapshotId: "synthetic-query-snapshot",
  nativeUnitIndexRevision: "synthetic-native-revision",
  units: [{ layerId, unitKind: "target", unitId: "ERO-C01-042" }],
};

type PreviewFile = {
  name: string;
  sizeBytes: number;
};

type ApiMock = {
  previewRequests: Array<Record<string, unknown>>;
  runSubmissions: Array<Record<string, unknown>>;
  unmatchedApiPaths: string[];
  runReads: number;
  releaseRunSubmission: () => void;
  releaseProductionLoad: () => void;
};

function makePreview(files: PreviewFile[], limits: { maxFiles: number }) {
  const now = Date.now();
  return {
    selection: baseSelection,
    inventory: {
      schemaVersion: 1,
      inventorySha256: "a".repeat(64),
      files: files.map((file, index) => ({
        sourceId,
        unitId: `synthetic-unit-${index + 1}`,
        resolver: "http-directory@1",
        layerId,
        nativeUnitKind: "target",
        nativeUnitId: `ERO-${String(index + 42).padStart(3, "0")}`,
        relativePath: `euclid/ero/${file.name}`,
        url: `https://synthetic.example/public/${file.name}`,
        sizeBytes: file.sizeBytes,
        metadataState: "verified",
      })),
      units: [],
      truncated: false,
    },
    unavailable: [],
    notes: ["Synthetic e2e inventory"],
    limits: { maxFiles: limits.maxFiles },
    querySnapshotId: "synthetic-query-snapshot",
    nativeUnitIndexRevision: "synthetic-native-revision",
    expiresAt: new Date(now + 60 * 60 * 1000).toISOString(),
    selectionTruncated: false,
    planSha256: "b".repeat(64),
  };
}

function pipelineFixture(): Record<string, unknown> {
  return {
    id: "synthetic-overlap-download",
    version: 1,
    key: "overlap-download@1",
    title: "重合区域数据下载",
    description: "Synthetic e2e pipeline",
    availability: "available",
    inputRequirements: ["RegionSnapshot"],
    outputs: ["download-plan.json"],
    dag: [{ id: "region", title: "固定区域快照", description: "Synthetic region" }],
    parameters: [
      { key: "exportFormat", label: "区域导出格式", type: "select", defaultValue: "json", options: ["json", "csv"] },
      { key: "crawlerId", label: "爬虫执行器", type: "select", defaultValue: "builtin-http", options: ["builtin-http"] },
      { key: "concurrency", label: "并发数", type: "number", defaultValue: 4 },
    ],
  };
}

function emptyFootprintManifest() {
  return {
    schemaVersion: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    coordinateFrame: "ICRS",
    nside: 16,
    footprints: [],
  };
}

async function installApiMock(
  page: Page,
  preview: ReturnType<typeof makePreview>,
  options: { holdRunSubmission?: boolean; holdProductionLoad?: boolean; runs?: Array<Record<string, unknown>>; pipeline?: Record<string, unknown> } = {},
): Promise<ApiMock> {
  let releaseRunSubmission = () => {};
  const runSubmissionGate = new Promise<void>((resolve) => { releaseRunSubmission = resolve; });
  let releaseProductionLoad = () => {};
  const productionLoadGate = new Promise<void>((resolve) => { releaseProductionLoad = resolve; });
  const mock: ApiMock = { previewRequests: [], runSubmissions: [], unmatchedApiPaths: [], runReads: 0, releaseRunSubmission, releaseProductionLoad };
  let submittedRun: Record<string, unknown> | undefined;
  const emptyResponse = (key: string, value: unknown) => ({ [key]: value });
  const fulfill = async (route: Route, body: unknown, status = 200) => route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const method = request.method();

    if (method === "GET" && pathname === "/api/surveys") return fulfill(route, emptyResponse("surveys", []));
    if (method === "GET" && pathname === "/api/public-surveys") return fulfill(route, emptyResponse("surveys", []));
    if (method === "GET" && pathname === "/api/survey-footprints") return fulfill(route, emptyFootprintManifest());
    if (method === "GET" && pathname === "/api/data-assets") return fulfill(route, emptyResponse("assets", []));
    if (method === "GET" && pathname === "/api/resource-packages/config") {
      return fulfill(route, emptyResponse("config", { catalogUrl: "https://synthetic.example/catalog.json", available: true }));
    }
    if (method === "GET" && pathname === "/api/capabilities") return fulfill(route, {});
    if (method === "GET" && pathname === "/api/connectors") return fulfill(route, emptyResponse("connectors", []));
    if (method === "GET" && pathname === "/api/agent/workspace-sessions") {
      return fulfill(route, emptyResponse("sessions", [{
        id: "synthetic-agent-session",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        messages: [],
      }]));
    }
    if (method === "GET" && pathname === "/api/coverage-downloads") return fulfill(route, emptyResponse("jobs", []));
    if (method === "GET" && pathname === "/api/production-pipelines") {
      if (options.holdProductionLoad) await productionLoadGate;
      return fulfill(route, emptyResponse("pipelines", [options.pipeline ?? pipelineFixture()]));
    }
    if (method === "GET" && pathname === "/api/production-runs") {
      mock.runReads += 1;
      return fulfill(route, emptyResponse("runs", [...(submittedRun ? [submittedRun] : []), ...(options.runs ?? [])]));
    }
    if (method === "POST" && pathname === "/api/sky/download-plan/preview") {
      const selection = JSON.parse(request.postData() ?? "{}") as Record<string, unknown>;
      mock.previewRequests.push(selection);
      return fulfill(route, { preview: { ...preview, selection } });
    }
    if (method === "POST" && pathname === "/api/production-runs") {
      const body = JSON.parse(request.postData() ?? "{}") as Record<string, unknown>;
      mock.runSubmissions.push(body);
      if (options.holdRunSubmission) await runSubmissionGate;
      submittedRun = {
        id: "synthetic-run-1",
        pipelineKey: "overlap-download@1",
        status: "queued",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        input: body,
        steps: [],
        artifacts: [],
        summary: {},
      };
      return fulfill(route, { run: submittedRun }, 202);
    }

    mock.unmatchedApiPaths.push(`${method} ${pathname}`);
    return fulfill(route, { error: "Unmocked synthetic API route" }, 404);
  });
  return mock;
}

function productionContext(pixel = 176) {
  return {
    nside: 16,
    pixels: [pixel],
    sourceIds: [sourceId],
    componentId: `synthetic-component-${pixel}`,
    downloadSelection: { ...baseSelection, cells: [pixel] },
  };
}

async function openWorkflow(page: Page, context = productionContext(), showDownloadGuide = false): Promise<void> {
  await page.goto("/?mode=workflow");
  await expect(page.locator("#service-status")).toHaveText("SERVICE ONLINE");
  await expect(page.locator("#production-preview-download")).toBeVisible();
  await page.evaluate(({ productionContext, showDownloadGuide }) => {
    window.dispatchEvent(new CustomEvent("astro:navigate", {
      detail: { mode: "workflow", productionContext, productionPipeline: "overlap-download@1", showDownloadGuide },
    }));
  }, { productionContext: context, showDownloadGuide });
  await expect(page.locator("#production-region-summary")).toContainText(`NSIDE 16 · 1 cells · synthetic-component-${context.pixels[0]}`);
  await expect(page.locator("#production-preview-download")).toBeEnabled();
  if (showDownloadGuide) await expect(page.locator("#production-handoff-dialog")).toBeVisible();
}

async function expectInspectorFits(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  if (!await page.locator("#inspector-panel").isVisible()) await page.getByRole("button", { name: "任务参数", exact: true }).click();
  await expect(page.locator("#inspector-panel")).toBeVisible();
  const layout = await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>("#inspector-panel")!;
    const content = document.querySelector<HTMLElement>("#inspector-content")!;
    const rect = panel.getBoundingClientRect();
    return {
      panelLeft: rect.left,
      panelRight: rect.right,
      panelWidth: rect.width,
      contentWidth: content.clientWidth,
      contentScrollWidth: content.scrollWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    };
  });
  expect(layout.panelWidth).toBeGreaterThan(0);
  expect(layout.panelLeft).toBeGreaterThanOrEqual(0);
  expect(layout.panelRight).toBeLessThanOrEqual(layout.viewportWidth + 1);
  expect(layout.contentScrollWidth).toBeLessThanOrEqual(layout.contentWidth + 1);
  expect(layout.documentScrollWidth).toBeLessThanOrEqual(width + 1);
}

test("coverage handoff guides users to file preview without creating a download run", async ({ page }) => {
  const mock = await installApiMock(page, makePreview([{ name: "guided.fits", sizeBytes: 1024 }], { maxFiles: 128 }));
  await openWorkflow(page, productionContext(), true);
  await expect(page.locator("#production-handoff-dialog")).toContainText("选择文件并确认后才会创建下载任务");
  await expect(page.locator("#production-handoff-dialog")).toContainText("部分成功显示黄色，全部成功显示绿色，全部失败才显示红色");
  expect(mock.previewRequests).toHaveLength(0);
  await page.locator("#production-handoff-later").click();
  await expect(page.locator("#production-handoff-dialog")).toBeHidden();
  expect(mock.previewRequests).toHaveLength(0);

  await page.evaluate((context) => window.dispatchEvent(new CustomEvent("astro:navigate", {
    detail: { mode: "workflow", productionContext: context, productionPipeline: "overlap-download@1", showDownloadGuide: true },
  })), productionContext());
  await expect(page.locator("#production-handoff-dialog")).toBeVisible();
  await page.locator("#production-handoff-preview").click();
  await expect(page.locator("#production-handoff-dialog")).toBeHidden();
  await expect(page.locator(".production-download-summary")).toContainText("1 / 1");
  expect(mock.previewRequests).toHaveLength(1);
  expect(mock.runSubmissions).toHaveLength(0);
});

test("coverage handoff appears while production data is still loading", async ({ page }) => {
  const mock = await installApiMock(page, makePreview([{ name: "guided.fits", sizeBytes: 1024 }], { maxFiles: 128 }), { holdProductionLoad: true });
  await page.goto("/?mode=layers");
  await expect(page.locator("#service-status")).toHaveText("SERVICE ONLINE");
  await page.evaluate((context) => window.dispatchEvent(new CustomEvent("astro:navigate", {
    detail: { mode: "workflow", productionContext: context, productionPipeline: "overlap-download@1", showDownloadGuide: true },
  })), productionContext());
  try {
    await expect(page.locator("#production-handoff-dialog")).toBeVisible();
    expect(mock.previewRequests).toHaveLength(0);
  } finally {
    mock.releaseProductionLoad();
  }
  await expect(page.locator("#production-preview-download")).toBeVisible();
  await page.locator("#production-handoff-later").click();
});

test("execution history colors full success, partial success, and full failure distinctly", async ({ page }) => {
  const partialRun = {
    id: "synthetic-partial-run",
    pipelineKey: "overlap-download@1",
    status: "partial",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    input: {},
    steps: [],
    artifacts: [],
    summary: { downloadedFiles: 2, files: 3, downloadedBytes: 2048 },
  };
  const runWithStatus = (id: string, status: string) => ({
    ...partialRun,
    id,
    status,
    summary: status === "succeeded"
      ? { downloadedFiles: 3, files: 3, downloadedBytes: 3072 }
      : status === "failed" ? { downloadedFiles: 0, files: 3, downloadedBytes: 0, failedFiles: 3 } : partialRun.summary,
  });
  await installApiMock(page, makePreview([], { maxFiles: 4 }), {
    runs: [partialRun, runWithStatus("synthetic-success-run", "succeeded"), runWithStatus("synthetic-failed-run", "failed")],
  });
  await openWorkflow(page);
  const row = page.locator('.production-run-chip[data-run-id="synthetic-partial-run"]');
  await expect(row).toContainText("部分成功");
  await expect(row).toContainText("2/3");
  await expect(row).toHaveAttribute("data-status", "partial");
  await expect(row.locator('.item-progress[data-mode="waiting"]')).toHaveCount(1);
  await expect(page.locator('.production-run-chip[data-run-id="synthetic-success-run"] .item-progress[data-mode="complete"]')).toHaveCount(1);
  await expect(page.locator('.production-run-chip[data-run-id="synthetic-failed-run"] .item-progress[data-mode="failed"]')).toHaveCount(1);
});

for (const theme of ["light", "dark"]) test(`download workspace fills the DAG width with a scrolling file list in ${theme}`, async ({ page }, testInfo) => {
  const files = Array.from({ length: 48 }, (_, index) => ({ name: `synthetic-tile-${index}-${"long-source-name-".repeat(10)}.fits`, sizeBytes: 1024 }));
  await installApiMock(page, makePreview(files, { maxFiles: 128 }));
  await page.addInitScript(theme => { localStorage.clear(); localStorage.setItem("astro-workspace:theme:v1", theme); }, theme);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWorkflow(page);
  await page.locator("#production-preview-download").click();
  await expect(page.locator(".production-download-summary")).toContainText("48 / 48");
  for (const width of [1440, 1024, 760]) {
    await page.setViewportSize({ width, height: 900 });
    const layout = await page.evaluate(() => {
      const dag = document.querySelector(".production-dag-section")!.getBoundingClientRect();
      const preview = document.querySelector<HTMLElement>("#production-download-workspace > .production-download-preview")!;
      const confirm = document.querySelector("#production-confirm-download")!.getBoundingClientRect();
      return {
        edges: ["#production-download-workspace", ".production-preview-toolbar", "#production-download-workspace > .production-download-preview", ".production-preview-actions"].map(selector => {
          const rect = document.querySelector(selector)!.getBoundingClientRect();
          return { left: rect.left - dag.left, right: rect.right - dag.right };
        }),
        headingLeft: preview.querySelector("h3")!.getBoundingClientRect().left - dag.left,
        scrolling: preview.scrollHeight > preview.clientHeight,
        pageWidth: document.documentElement.scrollWidth,
        confirmBottom: confirm.bottom,
      };
    });
    for (const edge of layout.edges) {
      expect(Math.abs(edge.left)).toBeLessThanOrEqual(1);
      expect(Math.abs(edge.right)).toBeLessThanOrEqual(1);
    }
    expect(Math.abs(layout.headingLeft)).toBeLessThanOrEqual(1);
    expect(layout.scrolling).toBe(true);
    expect(layout.pageWidth).toBeLessThanOrEqual(width + 1);
    expect(layout.confirmBottom).toBeLessThanOrEqual(900);
    await page.screenshot({ path: testInfo.outputPath(`download-width-${theme}-${width}.png`) });
  }
});

test("compact inspector can close and reopen without losing the region", async ({ page }) => {
  await installApiMock(page, makePreview([], { maxFiles: 4 }));
  await page.setViewportSize({ width: 1024, height: 768 });
  await openWorkflow(page);
  const inspector = page.locator("#inspector-panel");
  await expect(inspector).toBeVisible();
  await page.getByRole("button", { name: "关闭详情面板" }).click({ timeout: 3000 });
  await expect(inspector).toBeHidden();
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("astro:navigate", { detail: { mode: "workflow", productionContext: {
      nside: 16, pixels: [176], sourceIds: ["public:euclid:ero:imaging:layerId=layer-ero-imaging"],
      componentId: "synthetic-component-176",
    }, productionPipeline: "overlap-download@1" } }));
  });
  await expect(inspector).toBeVisible();
  await expect(page.locator("#production-region-summary")).toContainText("NSIDE 16 · 1 cells · synthetic-component-176");
});

test("public file preview defaults eligible files on and submits the checked subset", async ({ page }) => {
  const preview = makePreview([
    { name: "tile-042.fits", sizeBytes: 6 },
    { name: "tile-043.fits", sizeBytes: 5 },
    { name: "tile-044.fits", sizeBytes: 2 },
  ], { maxFiles: 4 });
  const api = await installApiMock(page, preview, { holdRunSubmission: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWorkflow(page);

  await expect(page.locator("#production-warehouse-handoff")).toHaveCount(0);
  await page.locator("#production-preview-download").click();
  await expect.poll(() => api.previewRequests.length).toBe(1);
  await expect(page.locator(".production-download-summary")).toContainText("3 / 3 个文件");
  await expect(page.locator(".production-download-source li input:checked")).toHaveCount(3);
  expect(api.previewRequests[0]).toMatchObject(baseSelection);
  expect(api.runSubmissions).toHaveLength(0);
  expect(api.runReads).toBeGreaterThan(0);
  await expect(page.getByRole("checkbox", { name: "选择 tile-042.fits" })).toBeVisible();
  await expect(page.locator(".production-download-file-copy").first()).toContainText("target ERO-042");
  await expectInspectorFits(page, 1440);
  const workspaceLayout = await page.locator("#production-download-workspace").evaluate((element) => {
    const dag = document.querySelector(".production-dag-section")!.getBoundingClientRect();
    return [element, ...element.querySelectorAll(".production-preview-toolbar, .production-download-preview, .production-download-preview h3, .production-preview-actions")]
      .map(item => ({ left: item.getBoundingClientRect().left - dag.left, right: item.getBoundingClientRect().right - dag.right }));
  });
  for (const item of workspaceLayout) {
    expect(Math.abs(item.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(item.right)).toBeLessThanOrEqual(1);
  }

  await page.getByRole("checkbox", { name: "选择 tile-043.fits" }).uncheck();
  const confirm = page.locator("#production-confirm-download");
  await confirm.click();
  await expect.poll(() => api.runSubmissions.length).toBe(1);
  await expect(confirm).toBeDisabled();
  await expect(confirm).toContainText("正在创建任务");
  expect(api.runSubmissions).toHaveLength(1);
  expect(api.runSubmissions[0]!.warehouseHandoff).toBe("none");
  api.releaseRunSubmission();
  await expect(page.locator('[data-run-id="synthetic-run-1"]')).toHaveClass(/active/);
  await expect(page.locator("#inspector-kicker")).toHaveText("EXECUTION OVERVIEW");
  await expect(page.locator("#production-confirm-download")).toBeDisabled();
  await expect(page.locator(".production-download-empty")).toHaveText("尚未生成文件清单预览。");

  const submission = api.runSubmissions[0]!;
  expect(submission).not.toHaveProperty("files");
  expect(submission.publicDownload).toMatchObject({
    selection: preview.selection,
    previewSha256: preview.planSha256,
    selectedFileUrls: [
      "https://synthetic.example/public/tile-042.fits",
      "https://synthetic.example/public/tile-044.fits",
    ],
  });
  expect(api.unmatchedApiPaths).toEqual([]);
});

test("preview allows any file size, defaults files up to the count limit, and changing context clears selection", async ({ page }) => {
  const preview = makePreview([
    { name: "tile-042.fits", sizeBytes: 3 * 1024 * 1024 * 1024 },
    { name: "tile-043.fits", sizeBytes: 4 * 1024 * 1024 * 1024 },
    { name: "tile-044.fits", sizeBytes: 5 * 1024 * 1024 * 1024 },
  ], { maxFiles: 2 });
  const api = await installApiMock(page, preview);
  await page.setViewportSize({ width: 1024, height: 900 });
  await openWorkflow(page);

  await page.locator("#production-preview-download").click();
  await expect.poll(() => api.previewRequests.length).toBe(1);
  const first = page.getByRole("checkbox", { name: "选择 tile-042.fits" });
  const second = page.getByRole("checkbox", { name: "选择 tile-043.fits" });
  const third = page.getByRole("checkbox", { name: "选择 tile-044.fits" });
  await expect(first).toBeChecked();
  await expect(second).toBeChecked();
  await expect(third).toBeDisabled();
  await expect(page.locator(".production-download-limits")).toContainText("单文件大小不限");
  await expect(page.locator(".production-download-limits")).toContainText("任务总量不限");

  await first.uncheck();
  await third.check();
  await expect(page.locator("#production-confirm-download")).toBeEnabled();
  await expectInspectorFits(page, 1024);

  await page.evaluate((nextContext) => {
    window.dispatchEvent(new CustomEvent("astro:navigate", {
      detail: { mode: "workflow", productionContext: nextContext, productionPipeline: "overlap-download@1" },
    }));
  }, productionContext(177));
  await expect(page.locator("#production-region-summary")).toContainText("synthetic-component-177");
  await expect(page.locator(".production-download-empty")).toHaveText("尚未生成文件清单预览。");
  await expect(page.locator("#production-confirm-download")).toBeDisabled();
  await expect.poll(() => page.evaluate(() => (window as Window & {
    __ASTRO_WORKSPACE_DEBUG__?: () => Record<string, unknown>;
  }).__ASTRO_WORKSPACE_DEBUG__?.())).toMatchObject({
    downloadPreviewFiles: 0,
    downloadPreviewSelectedFiles: 0,
  });
  expect(api.previewRequests).toHaveLength(1);
  expect(api.runSubmissions).toHaveLength(0);
  expect(api.unmatchedApiPaths).toEqual([]);
});

test("native selection bounds the preview and changing it invalidates selected files", async ({ page }) => {
  const preview = makePreview([{ name: "tile-042.fits", sizeBytes: 6 }], {
    maxFiles: 128,
  });
  const api = await installApiMock(page, preview);
  await page.setViewportSize({ width: 1024, height: 768 });
  const units = [
    { layerId, unitKind: "target", unitId: "ERO-C01-042" },
    { layerId, unitKind: "target", unitId: "ERO-C01-043" },
    { layerId: "synthetic-desi", unitKind: "tile", unitId: "DESI-001" },
    { layerId: "synthetic-desi", unitKind: "tile", unitId: "DESI-002" },
    { layerId: "synthetic-legacy", unitKind: "brick", unitId: "LEGACY-001" },
    { layerId: "synthetic-hst", unitKind: "observation", unitId: "HST-001" },
  ];
  const context = {
    ...productionContext(),
    sourceIds: [
      sourceId,
      "public:desi:dr1:spectroscopy:layerId=synthetic-desi",
      "public:legacy-surveys:dr9:imaging:layerId=synthetic-legacy",
      "public:hst:public:imaging:layerId=synthetic-hst",
    ],
    downloadSelection: {
      ...baseSelection,
      layerIds: [layerId, "synthetic-desi", "synthetic-legacy", "synthetic-hst"],
      units,
    },
  };
  await openWorkflow(page, context);
  const native = page.locator(".production-native-selection");
  await expect(native.locator("summary")).toHaveText("原生分块：已选 4 / 6");
  await native.locator("summary").click();
  await expect(native.locator("input:checked")).toHaveCount(4);
  await expect(page.getByRole("checkbox", { name: /^选择原生 target ERO-C01-043/ })).not.toBeChecked();
  await page.locator("#production-preview-download").click();
  await expect.poll(() => api.previewRequests.length).toBe(1);
  expect(api.previewRequests[0]).toMatchObject({
    order: baseSelection.order,
    cells: baseSelection.cells,
    querySnapshotId: baseSelection.querySnapshotId,
    nativeUnitIndexRevision: baseSelection.nativeUnitIndexRevision,
    units: [units[0], units[2], units[4], units[5]],
  });
  await expect(page.locator(".production-download-source li input:checked")).toHaveCount(1);
  await expect(page.locator("#production-confirm-download")).toBeEnabled();

  await page.getByRole("button", { name: "任务参数", exact: true }).click();
  await page.getByRole("checkbox", { name: /^选择原生 target ERO-C01-043/ }).check();
  await expect(native.locator("summary")).toHaveText("原生分块：已选 5 / 6");
  await expect(page.locator(".production-download-empty")).toHaveText("尚未生成文件清单预览。");
  await expect(page.locator("#production-confirm-download")).toBeDisabled();
  await page.locator("#production-preview-download").click();
  await expect.poll(() => api.previewRequests.length).toBe(2);
  expect(api.previewRequests[1]).toMatchObject({ units: [units[0], units[1], units[2], units[4], units[5]] });
  await expect(page.locator(".production-download-source li input:checked")).toHaveCount(1);
  await expect(page.locator("#production-confirm-download")).toBeEnabled();
  await expectInspectorFits(page, 1024);

  for (let index = 0; index < units.length; index += 1) {
    await native.locator("input").nth(index).uncheck();
  }
  await expect(native.locator("summary")).toHaveText("原生分块：已选 0 / 6");
  await expect(page.locator("#production-preview-download")).toBeDisabled();
  await expect(page.locator("#production-confirm-download")).toBeDisabled();
  expect(api.previewRequests).toHaveLength(2);
  expect(api.runSubmissions).toHaveLength(0);
  expect(api.unmatchedApiPaths).toEqual([]);
});

async function streamPreview(page: Page, preview: ReturnType<typeof makePreview>) {
  let current: ServerResponse | undefined, cancelled = 0, requests = 0;
  const emit = (event: string, value: unknown) => current?.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
  const server = createServer((request, response) => {
    if (request.method === "OPTIONS") {
      response.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Accept", "Access-Control-Allow-Methods": "POST, OPTIONS" });
      response.end();
      return;
    }
    current = response;
    requests++;
    request.resume();
    response.writeHead(200, { "Content-Type": "text/event-stream", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
    emit("progress", { stage: "metadata", completed: 1, total: 2, files: 1, unavailable: 0 });
    emit("batch", { files: preview.inventory.files.slice(0, 1), unavailable: [] });
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 50);
    response.once("close", () => { clearInterval(heartbeat); if (!response.writableEnded) cancelled++; });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("stream fixture did not listen");
  await page.route("**/api/sky/download-plan/preview", (route) => route.continue({ url: `http://127.0.0.1:${address.port}/preview` }));
  return {
    counts: () => ({ cancelled, requests }),
    complete: () => { emit("complete", { preview }); current?.end(); },
    fail: () => { emit("error", { error: "合成来源连接中断" }); current?.end(); },
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

test("streamed files remain read-only until complete and stopping aborts the request", async ({ page }) => {
  const preview = makePreview([{ name: "early.fits", sizeBytes: 6 }, { name: "later.fits", sizeBytes: 5 }], { maxFiles: 4 });
  const api = await installApiMock(page, preview);
  const stream = await streamPreview(page, preview);
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openWorkflow(page);
    await page.locator("#production-preview-download").click();
    await expect(page.locator("#production-preview-progress")).toContainText("已处理 1 / 2 项");
    await expect(page.getByRole("checkbox", { name: "选择 early.fits" })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "选择 early.fits" })).toBeDisabled();
    await expect(page.locator("#production-confirm-download")).toBeDisabled();
    await page.screenshot({ path: "/tmp/workspace-production-preview-streaming.png" });
    await page.locator("#production-stop-preview").click();
    await expect.poll(() => stream.counts().cancelled).toBe(1);
    await expect(page.locator("#production-preview-progress")).toContainText("预览已停止");
    await expect(page.getByRole("checkbox", { name: "选择 early.fits" })).toBeDisabled();
    expect(api.runSubmissions).toHaveLength(0);
    await page.locator("#production-retry-preview").click();
    await expect.poll(() => stream.counts().requests).toBe(2);
    stream.complete();
    await expect(page.getByRole("checkbox", { name: "选择 later.fits" })).toBeEnabled();
    await expect(page.locator(".production-download-source li input:checked")).toHaveCount(2);
    await expect(page.locator("#production-confirm-download")).toBeEnabled();
    expect(api.runSubmissions).toHaveLength(0);
  } finally { await stream.close(); }
});

for (const action of ["close", "navigate"] as const) {
  test(`${action} aborts the active file preview without creating a run`, async ({ page }) => {
    const preview = makePreview([{ name: "partial.fits", sizeBytes: 6 }], { maxFiles: 4 });
    const api = await installApiMock(page, preview), stream = await streamPreview(page, preview);
    try {
      await openWorkflow(page);
      await page.locator("#production-preview-download").click();
      await expect(page.getByRole("checkbox", { name: "选择 partial.fits" })).toBeVisible();
      if (action === "close") {
        await page.locator("#production-preview-close").click();
        await expect(page.locator("#production-download-workspace")).toBeHidden();
        await expect(page.locator(".production-log-section")).toBeVisible();
      } else {
        await page.locator('[data-mode="catalog"]').click();
        await expect(page.locator("#production-stage")).toBeHidden();
      }
      await expect.poll(() => stream.counts().cancelled).toBe(1);
      stream.complete();
      if (action === "navigate") {
        await page.locator('[data-mode="workflow"]').click();
        await expect(page.locator("#production-preview-progress")).toContainText("预览已停止");
        await expect(page.getByRole("checkbox", { name: "选择 partial.fits" })).toBeDisabled();
      }
      await expect(page.locator("#production-confirm-download")).toBeDisabled();
      expect(api.runSubmissions).toHaveLength(0);
    } finally { await stream.close(); }
  });
}

test("changing region aborts streamed previews and stale results cannot restore old files", async ({ page }) => {
  const preview = makePreview([{ name: "old-region.fits", sizeBytes: 6 }], { maxFiles: 4 });
  const api = await installApiMock(page, preview), stream = await streamPreview(page, preview);
  try {
    await openWorkflow(page);
    await page.locator("#production-preview-download").click();
    await expect(page.getByRole("checkbox", { name: "选择 old-region.fits" })).toBeVisible();
    await page.evaluate((context) => window.dispatchEvent(new CustomEvent("astro:navigate", { detail: { mode: "workflow", productionContext: context, productionPipeline: "overlap-download@1" } })), productionContext(177));
    await expect.poll(() => stream.counts().cancelled).toBe(1);
    stream.complete();
    await expect(page.locator("#production-download-workspace")).toBeHidden();
    await expect(page.locator(".production-download-file-copy")).toHaveCount(0);
    await expect(page.locator("#production-region-summary")).toContainText("synthetic-component-177");
    expect(api.runSubmissions).toHaveLength(0);
  } finally { await stream.close(); }
});

test("stream failures retain discovered files for inspection and block confirmation", async ({ page }) => {
  const preview = makePreview([{ name: "retained.fits", sizeBytes: 6 }], { maxFiles: 4 });
  const api = await installApiMock(page, preview), stream = await streamPreview(page, preview);
  try {
    await openWorkflow(page);
    await page.locator("#production-preview-download").click();
    await expect(page.getByRole("checkbox", { name: "选择 retained.fits" })).toBeVisible();
    stream.fail();
    await expect(page.locator(".production-download-preview .production-run-error")).toHaveText("合成来源连接中断");
    await expect(page.getByRole("checkbox", { name: "选择 retained.fits" })).toBeDisabled();
    await expect(page.locator("#production-confirm-download")).toBeDisabled();
    await expect(page.locator("#production-retry-preview")).toBeEnabled();
    expect(api.runSubmissions).toHaveLength(0);
  } finally { await stream.close(); }
});

for (const theme of ["light", "dark"] as const) for (const width of [1440, 1024]) {
  test(`execution history fills the main area and retains scroll and focus: ${theme} ${width}`, async ({ page }) => {
    const dag = ["region", "resolve", "approval", "download", "connector", "warehouse"].map((id) => ({ id, title: `步骤 ${id}`, description: "Synthetic step" }));
    const runs = Array.from({ length: 24 }, (_, index) => ({
      id: `synthetic-run-${index}`, pipelineKey: "overlap-download@1", status: index === 0 ? "running" : index === 1 ? "failed" : "succeeded",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", input: {}, artifacts: [], summary: { downloadedFiles: 1, files: 2, downloadedBytes: 1024 },
      steps: dag.map((node) => ({ id: node.id, title: node.title,
        status: index === 1 ? node.id === "resolve" ? "failed" : node.id === "region" ? "succeeded" : "skipped" : index === 0 && node.id === "download" ? "running" : "succeeded",
        logs: Array.from({ length: 100 }, (_, log) => ({ timestamp: "2026-01-01T00:00:00.000Z", level: "info", message: `Run ${index}, node ${node.id}: synthetic log entry ${log} with enough text to verify reading and scrolling.` })) })),
    }));
    const api = await installApiMock(page, makePreview([], { maxFiles: 4 }), { runs, pipeline: { ...pipelineFixture(), dag } });
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 768 });
    await page.emulateMedia({ colorScheme: theme });
    await openWorkflow(page);
    if (width === 1024) await page.getByRole("button", { name: "关闭详情面板" }).click();
    await expect(page.locator("#production-run-list .production-run-chip")).toHaveCount(24);
    await expect(page.locator("#production-run-list .active")).toHaveCount(0);
    await expect(page.locator('.production-dag-node[data-status="idle"]')).toHaveCount(dag.length);
    await expect(page.locator("#production-stage #production-log-detail")).toHaveCount(0);
    const geometry = await page.evaluate(() => ({
      dag: document.querySelector(".production-dag-section")!.getBoundingClientRect().height,
      history: document.querySelector("#production-run-list")!.getBoundingClientRect().height,
      row: document.querySelector(".production-run-chip")!.getBoundingClientRect().height,
      width: document.documentElement.scrollWidth,
    }));
    expect(geometry.dag).toBeLessThanOrEqual(144);
    expect(geometry.history).toBeGreaterThanOrEqual(geometry.row * (width === 1440 ? 8 : 6));
    expect(geometry.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `/tmp/workspace-production-after-${theme}-${width}.png` });
    await page.locator("[data-run-id='synthetic-run-1']").click();
    await expect(page.locator("#inspector-kicker")).toHaveText("EXECUTION OVERVIEW");
    await expect(page.locator("#inspector-content")).toContainText("synthetic-run-1");
    expect(await page.locator("#production-dag-count").evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(12);
    await expect(page.locator('.production-dag-node[data-node-id="resolve"]')).toHaveAttribute("data-status", "failed");
    await expect(page.locator('.production-dag-node[data-node-id="download"]')).toHaveAttribute("data-status", "skipped");
    await expect(page.locator('.production-dag-node[data-node-id="resolve"] .item-progress')).toHaveAttribute("data-mode", "failed");
    if (width === 1024) await page.getByRole("button", { name: "关闭详情面板" }).click();
    await page.locator("[data-run-id='synthetic-run-0']").click();
    await expect(page.locator("#inspector-kicker")).toHaveText("EXECUTION OVERVIEW");
    await expect(page.locator('.production-dag-node[data-node-id="resolve"]')).toHaveAttribute("data-status", "succeeded");
    await expect(page.locator('.production-dag-node[data-node-id="download"]')).toHaveAttribute("data-status", "running");
    if (width === 1024) await page.getByRole("button", { name: "关闭详情面板" }).click();
    await page.locator('.production-dag-node[data-node-id="download"]').click();
    const logs = page.locator("#inspector-panel #production-log-detail");
    await expect(logs).toBeVisible();
    await expect(logs).toContainText("Run 0, node download:");
    expect(await logs.evaluate((element) => element.clientHeight)).toBeGreaterThan(300);
    expect(await page.locator("#production-run-list").evaluate((element) => element.getBoundingClientRect().height)).toBe(geometry.history);
    await page.screenshot({ path: `/tmp/workspace-production-logs-after-${theme}-${width}.png` });
    await page.locator("#production-run-list").evaluate((element) => { element.scrollTop = 280; });
    await page.locator("#production-log-detail").evaluate((element) => { element.scrollTop = 240; });
    await page.locator("[data-run-id='synthetic-run-0']").evaluate((element: HTMLElement) => element.focus({ preventScroll: true }));
    const before = api.runReads;
    await expect.poll(() => api.runReads).toBeGreaterThan(before);
    await expect(page.locator("[data-run-id='synthetic-run-0']")).toBeFocused();
    expect(await page.locator("#production-run-list").evaluate((element) => element.scrollTop)).toBe(280);
    expect(await page.locator("#production-log-detail").evaluate((element) => element.scrollTop)).toBe(240);
    await logs.focus();
    await logs.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    const liveLogs = runs[0]?.steps.find((step) => step.id === "download")?.logs;
    if (!liveLogs) throw new Error("Missing synthetic download logs");
    liveLogs.push({ timestamp: "2026-01-01T00:00:01.000Z", level: "info", message: "Synthetic appended log entry" });
    await expect(logs).toContainText("Synthetic appended log entry");
    await expect(logs).toBeFocused();
    expect(await logs.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(8);
    if (width === 1024) {
      await page.getByRole("button", { name: "关闭详情面板" }).click();
      const beforeClose = api.runReads;
      await expect.poll(() => api.runReads).toBeGreaterThan(beforeClose);
      await expect(page.locator("#inspector-panel")).not.toHaveClass(/mobile-open/);
      await page.locator('.production-dag-node[data-node-id="download"]').click();
    }
    await page.locator("#production-run-overview-back").click();
    await expect(page.locator("#inspector-kicker")).toHaveText("EXECUTION OVERVIEW");
    await expect(page.locator("#production-log-detail")).toHaveCount(0);
    if (width === 1024) await page.getByRole("button", { name: "关闭详情面板" }).click();
    await page.locator("#production-return-template").click();
    await expect(page.locator('.production-dag-node[data-status="idle"]')).toHaveCount(dag.length);
    await expect(page.locator("#production-run-list .active")).toHaveCount(0);
    await expect(page.locator("#inspector-kicker")).toHaveText("PIPELINE TEMPLATE");
    const beforeClear = api.runReads;
    await expect.poll(() => api.runReads).toBeGreaterThan(beforeClear);
    await expect(page.locator('.production-dag-node[data-status="idle"]')).toHaveCount(dag.length);
  });
}

test("history selection survives new records, preserves drafts, and handles historical nodes and removal", async ({ page }) => {
  const timestamp = "2026-01-01T00:00:00.000Z";
  const legacy = {
    id: "synthetic-legacy-run", pipelineKey: "overlap-download@1", status: "failed",
    createdAt: timestamp, updatedAt: timestamp, input: {}, artifacts: [], summary: {},
    steps: [
      { id: "region", title: "历史区域节点", status: "succeeded", logs: [] },
      { id: "retired", title: "历史独有节点", status: "failed", logs: [{ timestamp, level: "error", message: "Historical node log" }] },
    ],
  };
  const active = { ...legacy, id: "synthetic-active-run", status: "running", steps: [
    { id: "region", title: "区域节点", status: "running", logs: [] },
  ] };
  const runs = [active, legacy, { ...legacy, id: "synthetic-other-pipeline-run", pipelineKey: "object-crossmatch@1" }];
  const dag = [
    { id: "region", title: "区域节点", description: "Synthetic region" },
    { id: "new-node", title: "后来加入的节点", description: "Synthetic added node" },
  ];
  const api = await installApiMock(page, makePreview([], { maxFiles: 4 }), { runs, pipeline: { ...pipelineFixture(), dag } });
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWorkflow(page);
  await page.locator("#production-concurrency").fill("7");
  await page.locator("#production-concurrency").dispatchEvent("change");
  await expect(page.locator(".production-run-chip")).toHaveCount(2);
  await expect(page.locator('.production-dag-node[data-status="idle"]')).toHaveCount(2);
  await page.locator('.production-dag-node[data-node-id="region"]').click();
  await expect(page.locator("#inspector-content")).toContainText("选择一条历史执行记录");
  await expect(page.locator("#production-log-detail")).toHaveCount(0);
  await page.locator('[data-run-id="synthetic-legacy-run"]').click();
  await expect(page.locator('.production-dag-node[data-node-id="new-node"]')).toHaveAttribute("data-status", "skipped");
  await page.locator("#production-history-node-retired").click();
  await expect(page.locator("#production-log-detail")).toContainText("Historical node log");
  await expect(page.locator("#inspector-content h2")).toHaveText("历史独有节点");
  runs.unshift({ ...active, id: "synthetic-newest-run", createdAt: "2026-01-02T00:00:00.000Z" });
  await expect(page.locator('[data-run-id="synthetic-newest-run"]')).toBeVisible();
  await expect(page.locator('[data-run-id="synthetic-legacy-run"]')).toHaveClass(/active/);
  await expect(page.locator("#production-log-detail")).toContainText("Historical node log");
  await page.locator("#production-run-overview-back").click();
  await page.locator("#production-history-node-new-node").click();
  await expect(page.locator("#production-log-detail")).toContainText("该节点不属于此次历史执行");
  await expect(page.locator("#production-log-detail")).toContainText("该节点尚未产生日志");
  await page.locator("#production-return-template").click();
  await expect(page.locator("#production-concurrency")).toHaveValue("7");
  await page.locator('[data-run-id="synthetic-legacy-run"]').click();
  runs.splice(runs.indexOf(legacy), 1);
  await expect(page.locator('[data-run-id="synthetic-legacy-run"]')).toHaveCount(0);
  await expect(page.locator('.production-dag-node[data-status="idle"]')).toHaveCount(2);
  await expect(page.locator(".production-run-chip.active")).toHaveCount(0);
  await expect(page.locator("#inspector-kicker")).toHaveText("PIPELINE TEMPLATE");
  await expect(page.locator("#production-concurrency")).toHaveValue("7");
  runs.splice(0);
  await expect(page.locator("#production-run-empty")).toBeVisible();
  await expect(page.locator(".production-run-chip")).toHaveCount(0);
  expect(api.unmatchedApiPaths).toEqual([]);
});

test("retry selects the new historical record and returns to its overview", async ({ page }) => {
  const timestamp = "2026-01-01T00:00:00.000Z";
  const failed = {
    id: "synthetic-failed-run", pipelineKey: "overlap-download@1", status: "failed",
    createdAt: timestamp, updatedAt: timestamp, input: {}, artifacts: [], summary: {},
    steps: [{ id: "region", title: "区域节点", status: "failed", logs: [] }],
  };
  const retried = { ...failed, id: "synthetic-retry-run", retryOfRunId: failed.id, status: "queued", steps: [
    { id: "region", title: "区域节点", status: "pending", logs: [] },
  ] };
  const runs = [failed];
  const api = await installApiMock(page, makePreview([], { maxFiles: 4 }), { runs });
  await page.route("**/api/production-runs/synthetic-failed-run/retry", async (route) => {
    runs.unshift(retried);
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ run: retried }) });
  });
  await openWorkflow(page);
  await page.locator('[data-run-id="synthetic-failed-run"]').click();
  await page.locator("#production-inspector-run-detail").click();
  await page.getByRole("button", { name: "重试并新建记录" }).click();
  await expect(page.locator("#production-run-dialog")).not.toBeVisible();
  await expect(page.locator('[data-run-id="synthetic-retry-run"]')).toHaveClass(/active/);
  await expect(page.locator('[data-run-id="synthetic-failed-run"]')).not.toHaveClass(/active/);
  await expect(page.locator("#inspector-kicker")).toHaveText("EXECUTION OVERVIEW");
  await expect(page.locator("#inspector-content")).toContainText("synthetic-retry-run");
  await expect(page.locator('.production-dag-node[data-node-id="region"]')).toHaveAttribute("data-status", "pending");
  expect(api.unmatchedApiPaths).toEqual([]);
});
