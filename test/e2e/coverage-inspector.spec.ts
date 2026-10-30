import { expect, test, type Page, type Route } from "@playwright/test";
import { createServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { Healpix } from "healpixjs";
import type { SkyOverlapSource } from "../../src/sky-overlap.js";

const fileName = "SYNTHETIC_EUC_MER_BGSUB-MOSAIC-CFIS-U_TILE102157301-CFF8C7_20241024T172119.513029Z_00.00.fits";
const fileUri = `https://synthetic.example/data?RELEASE=q1&FILE_NAME=${fileName}&RETRIEVAL_TYPE=FILE`;
const secondUri = `https://mirror.synthetic.example/data?FILE_NAME=${fileName}`;
const localUri = "workspace://synthetic-csst/simulation/W1/";

function source(surveyId: string, releaseId: string, product: string, label: string, suffix = product): SkyOverlapSource {
  return { id: `public:${surveyId}:${releaseId}:${product}:layerId=${suffix}`, kind: "public", surveyId, releaseId, product, label, nside: 16, pixels: [0] };
}

const sources: SkyOverlapSource[] = [
  source("desi", "dr1", "redrock", "DR1 bright-program redrock files"),
  source("desi", "edr", "spectra", "Early Data Release spectra"),
  source("euclid", "ero", "vis", "ERO VIS"),
  source("euclid", "q1", "vis", "Euclid Q1 VIS"),
  source("euclid", "q1", "h", "Euclid Q1 NISP.H"),
  source("euclid", "q1", "vis", "Euclid Q1 VIS", "another-vis-source"),
  { id: "workspace:asset:synthetic-csst", kind: "workspace", assetId: "synthetic-csst", surveyId: "csst", releaseId: "simulation", product: "W1", label: "CSST Simulation W1", nside: 16, pixels: [0] },
  { id: "public:legacy-source", kind: "public", label: "Legacy DR9 view", nside: 16, pixels: [0] },
];
const outsideSource = source("desi", "dr2", "spectra", "DR2 spectra");

function survey(id: string, name: string, releases: Array<[string, string]>, origin = "public") {
  return { id, name, mission: name, description: "Synthetic survey", origin, color: id === "euclid" ? "#c09cff" : "#52c9b2", modalities: ["imaging"],
    releaseCount: releases.length, availableReleaseCount: releases.length, verifiedFootprintReleaseCount: releases.length, coverageStatus: "verified",
    releases: releases.map(([id, label]) => ({ id, label, kind: "public_release", availability: "available", modalities: ["imaging"], products: [], coverage: { status: "verified", summary: "Synthetic coverage", sourceUrl: "https://synthetic.example/" } })) };
}
const publicSurveys = [survey("desi", "DESI", [["dr1", "DR1"], ["edr", "Early Data Release"], ["dr2", "DR2"]]), survey("euclid", "Euclid", [["ero", "Early Release Observations"], ["q1", "Q1"]])];
const localSurvey = survey("csst", "CSST", [["simulation", "Simulation"]], "user");

function publicResult(pixel: number, page = 1, empty = false) {
  const unit = { layerId: "vis", productId: "vis", surveyId: "euclid", releaseId: "q1", product: "VIS", modality: "imaging",
    unitKind: "tile", unitId: `SYNTHETIC-TILE-${page}`, order: 6, nside: 64, matchingCells: [pixel], precision: "exact", accessAvailability: "source-policy",
    note: "Synthetic source policy", accessUris: page === 1 ? [{ uri: fileUri, fileName }, { uri: secondUri, fileName }, { uri: "https://archive.synthetic.example/entry?release=q1" }, { uri: "s3://synthetic-evidence/native-unit" }] : [{ uri: "https://synthetic.example/second.fits", fileName: "second.fits" }] };
  return { requested: { layerIds: ["vis"], order: 4, cells: [pixel] }, files: [], spatialUnits: empty ? [] : [unit], entrypoints: [{ kind: "archive", purpose: "source-access", surveyId: "euclid", releaseId: "q1", precision: "entrypoint-only", url: "https://archive.synthetic.example/release/q1", note: "Synthetic entrypoint" }],
    notes: ["Synthetic coverage note"], truncated: false, querySnapshot: { id: "synthetic-coverage-query", queryExhausted: true }, nativeUnitIndexRevision: "synthetic-revision",
    page: { pageSize: 1, shown: empty ? 0 : 1, omitted: 0, hasMore: !empty && page === 1, ...(page === 1 ? { nextCursor: "synthetic-page-2" } : {}) } };
}

type Mock = { pixel: number; overlapRequests: Array<Record<string, unknown>>; lookupRequests: Array<Record<string, unknown>>; unmatched: string[]; empty?: boolean; fail?: boolean; overlapFail?: boolean; overlapDelayMs?: number; overlapGate?: Promise<void>; noOverlap?: boolean; secondComponent?: boolean; maximumOrder?: number };

async function installMock(page: Page, options: Partial<Mock> = {}): Promise<Mock> {
  const mock: Mock = { pixel: 0, overlapRequests: [], lookupRequests: [], unmatched: [], ...options };
  const fulfill = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === "GET") {
      if (path === "/api/surveys") return fulfill(route, { surveys: [localSurvey] });
      if (path === "/api/public-surveys") return fulfill(route, { surveys: publicSurveys });
      if (path === "/api/surveys/csst") return fulfill(route, { survey: localSurvey });
      const record = publicSurveys.find(s => path === `/api/public-surveys/${s.id}`);
      if (record) return fulfill(route, { survey: record });
      if (path === "/api/survey-footprints") return fulfill(route, { schemaVersion: 1, generatedAt: "2026-01-01T00:00:00Z", coordinateFrame: "ICRS", nside: 16,
        footprints: ["desi", "euclid"].map(surveyId => ({ surveyId, releaseId: surveyId === "desi" ? "dr1" : "q1", product: "vis", label: surveyId, nside: 16, pixels: Array.from({ length: 3072 }, (_, i) => i) })) });
      if (path === "/api/data-assets") return fulfill(route, { assets: [] });
      if (path === "/api/data-assets/status") return fulfill(route, { statuses: [] });
      if (path === "/api/user-mocs") return fulfill(route, { artifacts: [] });
      if (path === "/api/resource-packages/config") return fulfill(route, { config: { available: true, catalogUrl: "https://synthetic.example/catalog.json" } });
      if (path === "/api/capabilities") return fulfill(route, {});
      if (path === "/api/connectors") return fulfill(route, { connectors: [] });
      if (path === "/api/production-pipelines") return fulfill(route, { pipelines: [{ id: "overlap-download", version: 1, key: "overlap-download@1",
        title: "重合区域数据下载", description: "Synthetic download workflow", availability: "available", inputRequirements: ["RegionSnapshot"], outputs: [],
        dag: [{ id: "region", title: "固定区域快照", description: "Synthetic region" }], parameters: [] }] });
      if (path === "/api/production-runs") return fulfill(route, { runs: [] });
      if (path === "/api/agent/workspace-sessions") return fulfill(route, { sessions: [{ id: "synthetic-coverage-session", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", messages: [] }] });
      if (path === "/api/coverage-downloads") return fulfill(route, { jobs: [] });
      if (path === "/api/sky/coverage") return fulfill(route, { status: "ready", nside: 16, pixels: [], layers: [], byAsset: [] });
    }
    if (request.method() === "POST" && path === "/api/sky/overlap") {
      const input = request.postDataJSON() as Record<string, unknown>;
      mock.overlapRequests.push(input);
      if (mock.overlapGate) await mock.overlapGate;
      if (mock.overlapDelayMs) await new Promise(resolve => setTimeout(resolve, mock.overlapDelayMs));
      if (mock.overlapFail) return fulfill(route, { error: "Synthetic overlap display budget exceeded" }, 400);
      const nside = Number(input.nside ?? 16), order = Math.log2(nside);
      const coverageOrder = Math.min(order, mock.maximumOrder ?? 8), coverageNside = 2 ** coverageOrder;
      const pixel = coverageNside >= 16 ? mock.pixel * (coverageNside / 16) ** 2 : Math.floor(mock.pixel / (16 / coverageNside) ** 2);
      const factor = (nside / coverageNside) ** 2;
      const components = [pixel, ...(mock.secondComponent ? [(pixel + 6 * coverageNside ** 2) % (12 * coverageNside ** 2)] : [])]
        .map((cell, index) => ({ id: `C0${index + 1}`, order, nside, cells: Array.from({ length: factor }, (_, child) => cell * factor + child), sourceIds: sources.map(s => s.id),
          areaDeg2: 41252.96124941927 / (12 * coverageNside ** 2), bounds: { raMin: 0, raMax: 360, decMin: -90, decMax: 90 } }));
      const availableOrders = Array.from({ length: (mock.maximumOrder ?? 8) + 1 }, (_, order) => order);
      const responseSources = [...sources, sources[3]!, outsideSource].map(s => ({ ...s, nside: coverageNside, pixels: [pixel],
        availableOrders: s.id === "public:legacy-source" ? availableOrders : Array.from({ length: Math.max(8, mock.maximumOrder ?? 8) + 1 }, (_, order) => order) }));
      if (mock.noOverlap) return fulfill(route, { status: "empty", order, nside, coverageOrder, availableOrders, pixels: [], sourceIds: sources.map(s => s.id), sources: responseSources, components: [] });
      return fulfill(route, { status: "ready", order, nside, coverageOrder, availableOrders,
        sourceIds: [...sources, outsideSource].map(s => s.id), sources: responseSources,
        pixels: components.flatMap(component => component.cells), components });
    }
    if (request.method() === "POST" && path === "/api/sky/reverse-lookup") {
      const input = request.postDataJSON() as Record<string, unknown>;
      mock.lookupRequests.push(input);
      if (mock.fail) return fulfill(route, { error: "Synthetic lookup unavailable" }, 503);
      return fulfill(route, { files: [], unavailable: [], warnings: [], sources: sources.map(s => ({ ...s, label: s.product ?? s.label })),
        assetsResult: publicResult(mock.pixel, input.cursor ? 2 : 1, mock.empty),
        workspaceDirectories: mock.empty ? [] : [{ sourceId: sources[6]!.id, layerId: "synthetic-csst", surveyId: "csst", releaseId: "simulation", modality: "imaging", directoryUri: localUri, order: 4, matchingCells: [mock.pixel], precision: "estimated", matchingCellsTruncated: true }] });
    }
    mock.unmatched.push(`${request.method()} ${path}`);
    return fulfill(route, { error: "Unmocked synthetic route" }, 404);
  });
  return mock;
}

async function openOverlap(page: Page, mock: Mock, theme = "dark", width = 1440, wait = true) {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(theme => { localStorage.clear(); localStorage.setItem("astro-workspace:theme:v1", theme); }, theme);
  await page.goto("/?mode=layers");
  await expect(page.locator("#service-status")).toHaveText("SERVICE ONLINE");
  const canvas = page.locator("#scene-canvas");
  await expect(canvas).toHaveAttribute("data-camera-distance", /.+/);
  const point = await canvas.evaluate(canvas => {
    const rect = canvas.getBoundingClientRect(), x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    canvas.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: x, clientY: y, pointerId: 1, pointerType: "mouse" }));
    return { x, y, pixel: Number(canvas.dataset.hoveredPixel), raw: canvas.dataset.hoveredPixel };
  });
  expect(point.raw).toBeTruthy();
  mock.pixel = point.pixel;
  await page.keyboard.press("g");
  if (wait) await expect(page.locator("#inspector-content h2")).toHaveText(mock.noOverlap ? "G · 天区重合" : "重合区块 C01");
  return point;
}

async function inspectComponent(page: Page, _point: { x: number; y: number }) {
  await expect(page.locator("#inspector-content h2")).toHaveText("重合区块 C01");
  await expect(page.locator('[data-overlap-component-id="C01"]')).toHaveAttribute("aria-pressed", "true");
}

async function setOverlapOrder(page: Page, order: number) {
  const slider = page.getByRole("slider", { name: "重合区域 HEALPix 粒度" });
  await slider.focus();
  await slider.press("Home");
  for (let step = 0; step < order; step += 1) await slider.press("ArrowRight");
  return slider;
}

test("G coverage sources preserve survey, release and distinct source identities", async ({ page }) => {
  const mock = await installMock(page);
  const point = await openOverlap(page, mock);
  const groups = page.locator(".coverage-source-groups");
  await expect(groups).toBeVisible();
  await expect(groups.locator(".coverage-source-survey")).toHaveCount(4);
  await expect(groups.locator('[data-survey-id="desi"]')).toContainText("DR1");
  await expect(groups.locator('[data-survey-id="desi"]')).toContainText("Early Data Release");
  await expect(groups.locator('[data-survey-id="desi"]')).not.toContainText("DR2");
  await expect(groups.locator('[data-survey-id="euclid"] [data-release-id="q1"] .coverage-source-product')).toHaveCount(3);
  await expect(groups.locator('[data-survey-id="csst"]')).toContainText("本地资产");
  await expect(groups.locator('[data-source-kind="public"]')).toContainText("公开覆盖");
  await expect(groups.locator('[data-source-kind="public"]')).not.toContainText("覆盖证据不代表文件已下载");
  await expect(groups.locator('[data-source-kind="workspace"]')).toContainText("Workspace 数据");
  await expect(groups).not.toContainText("未标注发布");
  await expect(groups).toContainText("Legacy DR9 view");
  await inspectComponent(page, point);
  await expect(groups.locator('[data-survey-id="desi"]')).not.toContainText("DR2");
  await expect(page.locator(".native-unit-results").first().locator("li")).toHaveCount(1);
  await page.getByRole("button", { name: "继续浏览", exact: true }).click();
  await expect(page.locator(".native-unit-results").first().locator("li")).toHaveCount(2);
  await expect(groups).toContainText("Euclid Q1 NISP.H");
  expect(mock.lookupRequests[1]?.cursor).toBe("synthetic-page-2");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 CSV", exact: true }).click();
  const exported = await download;
  const csv = await readFile((await exported.path())!, "utf8");
  expect(csv).toContain(fileUri);
  expect(csv).toContain(secondUri);
  expect(csv).toContain(localUri);
  expect(csv).toContain("matchingCellsTruncated");
  await page.keyboard.press("g");
  await expect(page.locator("#inspector-content")).not.toHaveClass(/coverage-inspector-content/);
  expect(mock.unmatched).toEqual([]);
});

test("the real overlap preview action opens the production handoff dialog", async ({ page }) => {
  const mock = await installMock(page);
  const point = await openOverlap(page, mock);
  await inspectComponent(page, point);
  await page.getByRole("button", { name: /^预览下载文件/ }).click();
  await expect(page.locator("#production-stage")).toBeVisible();
  await expect(page.locator("#production-handoff-dialog")).toBeVisible();
  await expect(page.locator("#production-handoff-dialog")).toContainText("选择文件并确认后才会创建下载任务");
  expect(mock.unmatched).toEqual([]);
});

for (const theme of ["light", "dark"]) for (const width of [1440, 1024]) {
  test(`G coverage files fit ${theme} ${width} with full names on hover and focus`, async ({ page }, testInfo) => {
    const mock = await installMock(page);
    const point = await openOverlap(page, mock, theme, width);
    await inspectComponent(page, point);
    await expect(page.getByRole("button", { name: "导出 JSON", exact: true })).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath(`coverage-sources-${theme}-${width}.png`) });
    const list = page.locator(".native-unit-results").first();
    const links = list.getByRole("link", { name: fileName, exact: true });
    await expect(links).toHaveCount(2);
    await expect(links.nth(0)).toHaveAttribute("href", fileUri);
    await expect(links.nth(1)).toHaveAttribute("href", secondUri);
    await expect(list).not.toContainText(fileUri);
    await expect(list.getByRole("link", { name: /访问来源.*archive.synthetic.example/ })).toHaveCount(1);
    await expect(list.locator("code")).toContainText("s3://synthetic-evidence/native-unit");
    await expect(list.getByRole("link")).toHaveCount(3);
    await links.first().hover();
    await expect(page.getByRole("tooltip")).toHaveText(fileName);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("tooltip")).toBeHidden();
    await links.first().focus();
    await expect(page.getByRole("tooltip")).toHaveText(fileName);
    const geometry = await list.evaluate(list => {
      const link = list.querySelector<HTMLAnchorElement>("a")!, title = list.querySelector("strong")!, meta = list.querySelector("small")!;
      const panel = document.querySelector<HTMLElement>("#inspector-content")!;
      const tooltip = document.querySelector<HTMLElement>('[role="tooltip"]')!.getBoundingClientRect();
      return { font: getComputedStyle(title).fontSize, metaFont: getComputedStyle(meta).fontSize, ellipsis: getComputedStyle(link).textOverflow, whiteSpace: getComputedStyle(link).whiteSpace,
        clipped: link.scrollWidth > link.clientWidth, width: panel.clientWidth, scrollWidth: panel.scrollWidth, pageWidth: document.documentElement.scrollWidth,
        tooltipLeft: tooltip.left, tooltipRight: tooltip.right, tooltipTop: tooltip.top, tooltipBottom: tooltip.bottom };
    });
    expect(geometry.font).toBe("11px");
    expect(geometry.metaFont).toBe("10px");
    expect(geometry.ellipsis).toBe("ellipsis");
    expect(geometry.whiteSpace).toBe("nowrap");
    expect(geometry.clipped).toBe(true);
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + 1);
    expect(geometry.pageWidth).toBeLessThanOrEqual(width);
    expect(geometry.tooltipLeft).toBeGreaterThanOrEqual(0);
    expect(geometry.tooltipRight).toBeLessThanOrEqual(width);
    expect(geometry.tooltipTop).toBeGreaterThanOrEqual(0);
    expect(geometry.tooltipBottom).toBeLessThanOrEqual(900);
    await page.screenshot({ path: testInfo.outputPath(`coverage-${theme}-${width}.png`) });
    await page.locator("#inspector-content details").evaluate(el => { (el as HTMLDetailsElement).open = true; });
    await expect(page.locator("#inspector-content details")).toContainText("Synthetic entrypoint");
    await page.locator("#inspector-content details").evaluate(el => { (el as HTMLDetailsElement).open = false; });
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出 JSON", exact: true }).click();
    const exported = await download;
    const manifest = JSON.parse(await readFile((await exported.path())!, "utf8"));
    expect(manifest.public.spatialUnits).toHaveLength(2);
    expect(manifest.public.spatialUnits[0].accessUris).toContainEqual({ uri: fileUri, fileName });
    expect(manifest.workspaceDirectories[0].directoryUri).toBe(localUri);
    await expect(page.getByRole("tooltip")).toBeHidden();
    expect(mock.unmatched).toEqual([]);
  });
}

test("G coverage keeps grouped sources for empty results and lookup failures", async ({ page }) => {
  const mock = await installMock(page, { empty: true });
  const point = await openOverlap(page, mock);
  await inspectComponent(page, point);
  await expect(page.getByRole("button", { name: "导出 JSON", exact: true })).toBeEnabled();
  await expect(page.locator(".native-unit-results").first().locator("li")).toHaveCount(0);
  await expect(page.locator(".coverage-source-groups")).toContainText("Euclid Q1 VIS");
  await page.keyboard.press("g");
  mock.fail = true;
  await page.keyboard.press("g");
  await expect(page.locator("#inspector-content h2")).toHaveText("重合区块 C01");
  await inspectComponent(page, point);
  await expect(page.locator("#inspector-content")).toContainText("反查失败");
  await expect(page.locator(".coverage-source-groups")).toContainText("Euclid Q1 VIS");
  expect(mock.unmatched).toEqual([]);
});

test("G coverage streaming progress uses the same compact records before completion", async ({ page }) => {
  let stream: ServerResponse | undefined;
  const server = createServer((request, response) => {
    if (request.method === "OPTIONS") {
      response.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Accept", "Access-Control-Allow-Methods": "POST, OPTIONS" });
      response.end();
      return;
    }
    stream = response;
    request.resume();
    response.writeHead(200, { "Content-Type": "text/event-stream", "Access-Control-Allow-Origin": "*" });
    response.write(": connected\n\n");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing synthetic stream port");
  // A direct browser route preserves streaming; route.fetch buffers SSE until completion.
  const mock = await installMock(page);
  await page.route("**/api/sky/reverse-lookup", async route => {
    mock.lookupRequests.push(route.request().postDataJSON());
    await route.continue({ url: `http://127.0.0.1:${address.port}` });
  });
  try {
    const point = await openOverlap(page, mock);
    await inspectComponent(page, point);
    await expect.poll(() => Boolean(stream)).toBe(true);
    const result = { files: [], unavailable: [], warnings: [], sources, assetsResult: publicResult(mock.pixel), workspaceDirectories: [] };
    stream!.write(`event: progress\ndata: ${JSON.stringify({ stage: "assets", state: "running", total: 1 })}\n\n`);
    stream!.write(`event: batch\ndata: ${JSON.stringify({ kind: "public-native", provisional: true, result: result.assetsResult })}\n\n`);
    await expect(page.locator(".native-unit-result strong")).toHaveText("TILE SYNTHETIC-TILE-1");
    await expect(page.locator("#inspector-content")).toContainText("完整清单仍在准备");
    await expect(page.locator(".coverage-lookup-progress")).toHaveAttribute("aria-busy", "true");
    await expect(page.locator(".coverage-lookup-spinner")).toBeVisible();
    await expect.poll(() => page.locator(".coverage-lookup-spinner").evaluate(element => getComputedStyle(element).animationName))
      .toBe("coverage-lookup-spin");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(() => page.locator(".coverage-lookup-spinner").evaluate(element => getComputedStyle(element).animationName))
      .toBe("none");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(page.locator(".coverage-source-groups")).toContainText("Euclid Q1 VIS");
    await expect(page.getByRole("button", { name: "导出 JSON", exact: true })).toBeDisabled();
    stream!.end(`event: complete\ndata: ${JSON.stringify(result)}\n\n`);
    await expect(page.getByRole("button", { name: "导出 JSON", exact: true })).toBeEnabled();
    await expect(page.locator("#inspector-content")).not.toContainText("完整清单仍在准备");
    await expect(page.locator(".coverage-lookup-spinner")).toHaveCount(0);
    expect(mock.unmatched).toEqual([]);
  } finally {
    stream?.end();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("slow overlap shows pending state and automatically selects C01", async ({ page }) => {
  const mock = await installMock(page, { overlapDelayMs: 1500 });
  await openOverlap(page, mock, "dark", 1440, false);
  await expect(page.locator('.coverage-lookup-progress[aria-busy="true"]')).toContainText("正在计算重合区域");
  await expect(page.locator(".coverage-lookup-spinner")).toBeVisible();
  await inspectComponent(page, { x: 0, y: 0 });
  await expect.poll(() => mock.lookupRequests.length).toBe(1);
});

test("overlap HEALPix granularity recomputes geometry and reverse lookup at the selected order", async ({ page }) => {
  const mock = await installMock(page);
  await openOverlap(page, mock);
  const granularity = page.getByRole("slider", { name: "重合区域 HEALPix 粒度" });
  await expect(granularity).toBeVisible();
  await setOverlapOrder(page, 6);
  await expect.poll(() => mock.overlapRequests.at(-1)?.nside).toBe(64);
  await expect(page.locator("#inspector-content")).toContainText("O6");
  await expect.poll(() => mock.lookupRequests.at(-1)?.nside).toBe(64);
  expect(mock.lookupRequests.at(-1)?.pixels).toEqual([mock.pixel * 16]);
  await setOverlapOrder(page, 3);
  await expect.poll(() => mock.overlapRequests.at(-1)?.nside).toBe(8);
  await expect(page.locator("#inspector-content")).toContainText("O3");
  await expect.poll(() => mock.lookupRequests.at(-1)?.nside).toBe(8);
  await granularity.press("End");
  await expect.poll(() => mock.overlapRequests.at(-1)?.nside).toBe(256);
  await expect(page.locator("#inspector-content")).toContainText("O8");
});

test("overlap slider supports the actual high precision order of selected surveys", async ({ page }, testInfo) => {
  const mock = await installMock(page, { maximumOrder: 10 });
  await openOverlap(page, mock);
  const slider = page.getByRole("slider", { name: "重合区域 HEALPix 粒度" });
  await expect(slider).toBeVisible();
  await expect(slider).toHaveAttribute("max", "10");
  await slider.press("End");
  await expect.poll(() => mock.overlapRequests.at(-1)?.nside).toBe(1024);
  await expect.poll(() => mock.lookupRequests.at(-1)?.nside).toBe(1024);
  await expect(slider).toHaveAttribute("aria-valuetext", "O10 · NSIDE 1024");
  await page.locator('[data-overlap-component-id="C01"]').click();
  await expect.poll(async () => Number(await page.locator("#scene-canvas").getAttribute("data-camera-distance"))).toBeLessThan(1.1);
  await page.screenshot({ path: testInfo.outputPath("overlap-o10-slider-focused.png") });
});

test("dragging the overlap slider previews locally and submits only the released order", async ({ page }) => {
  const mock = await installMock(page);
  await openOverlap(page, mock);
  const slider = page.getByRole("slider", { name: "重合区域 HEALPix 粒度" });
  const box = (await slider.boundingBox())!;
  const y = box.y + box.height / 2;
  const x = (order: number) => box.x + 8 + (box.width - 16) * order / 8;
  const requests = mock.overlapRequests.length;
  await page.mouse.move(x(4), y);
  await page.mouse.down();
  await page.mouse.move(x(7), y, { steps: 4 });
  await page.mouse.move(x(6), y, { steps: 3 });
  await expect(slider).toHaveValue("6");
  await expect(slider).toHaveAttribute("aria-valuetext", "O6 · NSIDE 64");
  await page.waitForTimeout(350);
  expect(mock.overlapRequests.length).toBe(requests);
  await expect(page.locator(".overlap-granularity-status")).toContainText("当前显示 O4");
  await page.mouse.up();
  await expect.poll(() => mock.overlapRequests.length).toBe(requests + 1);
  expect(mock.overlapRequests.at(-1)?.nside).toBe(64);
  await expect.poll(() => mock.lookupRequests.at(-1)?.nside).toBe(64);
});

test("changing visible surveys refreshes the slider limits and drops the previous request", async ({ page }) => {
  const mock = await installMock(page, { maximumOrder: 10 });
  await openOverlap(page, mock);
  const slider = page.getByRole("slider", { name: "重合区域 HEALPix 粒度" });
  await expect(slider).toHaveAttribute("max", "10");
  let release = () => {};
  mock.overlapGate = new Promise<void>(resolve => { release = resolve; });
  await slider.press("End");
  await expect.poll(() => mock.overlapRequests.at(-1)?.nside).toBe(1024);
  mock.overlapGate = undefined; mock.maximumOrder = 4;
  await page.getByRole("checkbox", { name: "显示 Euclid", exact: true }).check();
  await expect(slider).toHaveAttribute("max", "4");
  await expect(slider).toHaveValue("4");
  await expect(page.locator("#scene-canvas")).toHaveAttribute("data-layout-mode", "overlap");
  const request = mock.overlapRequests.at(-1)!;
  expect(request.nside).toBeUndefined();
  expect((request.sourceIds as string[]).some(id => id.includes("euclid"))).toBe(true);
  release();
  mock.maximumOrder = 11;
  await page.getByRole("checkbox", { name: "显示 DESI", exact: true }).uncheck();
  await expect(slider).toHaveAttribute("max", "11");
  await expect(slider).toHaveValue("4");
  expect(mock.lookupRequests.some(request => request.nside === 1024)).toBe(false);
});

test("loading and failed order changes preserve the successful geometry, camera and export", async ({ page }) => {
  const mock = await installMock(page);
  await openOverlap(page, mock);
  const canvas = page.locator("#scene-canvas");
  const camera = await canvas.getAttribute("data-camera-position");
  mock.overlapDelayMs = 1000; mock.overlapFail = true;
  await setOverlapOrder(page, 7);
  await expect.poll(() => mock.overlapRequests.at(-1)?.nside).toBe(128);
  await expect(page.locator(".overlap-granularity-status")).toContainText("当前显示 O4");
  await expect(canvas).toHaveAttribute("data-overlap-order", "4");
  await expect(page.locator('[data-overlap-component-id="C01"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".overlap-granularity-status")).toContainText("当前保留 O4 的结果");
  await expect(canvas).toHaveAttribute("data-overlap-mode", "true");
  await expect(canvas).toHaveAttribute("data-overlap-order", "4");
  await expect(canvas).toHaveAttribute("data-camera-position", camera!);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 JSON", exact: true }).click();
  const manifest = JSON.parse(await readFile((await (await download).path())!, "utf8"));
  expect(manifest.order).toBe(4);
  mock.overlapDelayMs = 0; mock.overlapFail = false;
  await setOverlapOrder(page, 6);
  await expect(canvas).toHaveAttribute("data-overlap-order", "6");
  await expect(page.getByRole("slider")).toBeFocused();
});

test("clicking an overlap component moves the sky camera to that region", async ({ page }) => {
  const mock = await installMock(page, { secondComponent: true, maximumOrder: 4 });
  await openOverlap(page, mock);
  const canvas = page.locator("#scene-canvas");
  const before = await canvas.getAttribute("data-camera-position");
  await page.locator('[data-overlap-component-id="C02"]').click();
  await expect(page.locator('[data-overlap-component-id="C02"]')).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => canvas.getAttribute("data-camera-position"), { timeout: 3000 }).not.toBe(before);
  const direction = new Healpix(16).getBoundaries((mock.pixel + 6 * 16 ** 2) % (12 * 16 ** 2))
    .reduce((sum, point) => [sum[0]! - point.y, sum[1]! + point.z, sum[2]! - point.x], [0, 0, 0]);
  const length = Math.hypot(...direction);
  await expect.poll(async () => {
    const camera = (await canvas.getAttribute("data-camera-position"))!.split(",").map(Number);
    const radius = Math.hypot(...camera);
    return camera.reduce((dot, value, i) => dot + value * direction[i]! / (radius * length), 0);
  }, { timeout: 3000 }).toBeGreaterThan(0.999);
  const second = await canvas.getAttribute("data-camera-position");
  await page.locator('[data-overlap-component-id="C01"]').click();
  await expect.poll(() => canvas.getAttribute("data-camera-position"), { timeout: 3000 }).not.toBe(second);
});

test("the slider respects a selected coarse source and exports the actual order", async ({ page }, testInfo) => {
  const mock = await installMock(page, { maximumOrder: 4 });
  await openOverlap(page, mock);
  const granularity = page.getByRole("slider", { name: "重合区域 HEALPix 粒度" });
  await expect(granularity).toHaveAttribute("min", "0");
  await expect(granularity).toHaveAttribute("max", "4");
  await expect(page.locator(".overlap-granularity-note")).toContainText("所选来源共同支持 O0–O4");
  await expect(page.locator(".overlap-granularity-note")).toContainText("Legacy DR9 view");
  await setOverlapOrder(page, 3);
  await expect.poll(() => mock.lookupRequests.at(-1)?.nside).toBe(8);
  await granularity.press("End");
  await expect.poll(() => mock.lookupRequests.at(-1)?.nside).toBe(16);
  expect(mock.overlapRequests.some(request => Number(request.nside) > 16)).toBe(false);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 JSON", exact: true }).click();
  const file = await download;
  const manifest = JSON.parse(await readFile((await file.path())!, "utf8"));
  expect(manifest.order).toBe(4);
  expect(manifest.coverageOrder).toBe(4);
  const canvas = page.locator("#scene-canvas");
  const before = await canvas.getAttribute("data-camera-position");
  await page.locator('[data-overlap-component-id="C01"]').click();
  await expect.poll(() => canvas.getAttribute("data-camera-position")).not.toBe(before);
  await page.screenshot({ path: testInfo.outputPath("overlap-order-slider-focused.png") });
});

test("a delayed overlap resolution cannot overwrite a newer selection", async ({ page }) => {
  const mock = await installMock(page);
  await openOverlap(page, mock);
  const granularity = page.getByRole("slider", { name: "重合区域 HEALPix 粒度" });
  let release = () => {};
  mock.overlapGate = new Promise<void>(resolve => { release = resolve; });
  await setOverlapOrder(page, 6);
  await expect.poll(() => mock.overlapRequests.at(-1)?.nside).toBe(64);
  mock.overlapGate = undefined;
  await granularity.press("ArrowRight");
  release();
  await expect(page.locator("#scene-canvas")).toHaveAttribute("data-overlap-order", "7");
  await expect(granularity).toHaveValue("7");
  await expect(page.locator("#inspector-content")).toContainText("O7");
  expect(mock.lookupRequests.some(request => request.nside === 64)).toBe(false);
});

test("empty overlap stays unselected and late responses cannot restore an exited mode", async ({ page }) => {
  const mock = await installMock(page, { noOverlap: true });
  await openOverlap(page, mock);
  await expect(page.locator("#inspector-content")).toContainText("没有共同覆盖");
  await expect(page.locator(".overlap-component-button")).toHaveCount(0);
  expect(mock.lookupRequests).toHaveLength(0);
  await page.keyboard.press("g");
  mock.noOverlap = false; mock.overlapDelayMs = 1000;
  await page.keyboard.press("g");
  await expect(page.locator(".coverage-lookup-spinner")).toBeVisible();
  await page.keyboard.press("g");
  await expect(page.locator("#scene-canvas")).toHaveAttribute("data-overlap-mode", "false");
  await page.waitForTimeout(1200);
  await expect(page.locator("#scene-canvas")).toHaveAttribute("data-overlap-mode", "false");
  expect(mock.lookupRequests).toHaveLength(0);
});

test("download settings preserve edits during heartbeat refresh and show route failures", async ({ page }, testInfo) => {
  await installMock(page);
  let settings = { proxyEnabled: false, proxyUrl: "", proxyUsername: "", passwordConfigured: false, revision: "fixture-0" };
  let health = { status: "unknown", checkedAt: "", revision: settings.revision, detail: "尚未检测", engineAvailable: true, proxyConnectMs: 0, sourceResponseMs: 0 };
  let fail = false;
  const reply = (route: Route, body: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/api/**", async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (path === "/api/system-config/ai-providers") return reply(route, { providers: [] });
    if (path === "/api/system-config/mcp-servers") return reply(route, { servers: [] });
    if (path === "/api/system-config/runtime") return reply(route, { catalog: { available: false }, workspaceSearch: { configured: false, indices: {} }, warehouse: { enabled: false } });
    if (path === "/api/installation/warehouse") return reply(route, { installation: null });
    if (path.startsWith("/api/system-config/downloads")) {
      if (req.method() === "PUT") {
        const body = req.postDataJSON();
        settings = { proxyEnabled: body.proxyEnabled, proxyUrl: body.proxyUrl, proxyUsername: body.proxyUsername,
          passwordConfigured: Boolean(body.proxyPassword) || settings.passwordConfigured, revision: `fixture-${Date.now()}` };
      }
      if (path.endsWith("/test")) health = { status: fail ? "failed" : "ok", checkedAt: new Date().toISOString(), revision: settings.revision,
        detail: fail ? "代理连接失败 ECONNREFUSED" : "代理和下载源站可用", engineAvailable: true, proxyConnectMs: 4, sourceResponseMs: 240 };
      return reply(route, { settings, health, downloaderEnabled: true });
    }
    return route.fallback();
  });
  await page.goto("/?mode=layers");
  await page.locator('[data-mode="system"]').click();
  await page.locator('[data-settings-tab="downloads"]').click();
  await page.locator("#download-proxy-enabled").check();
  await page.locator("#download-proxy-url").fill("http://10.15.49.212:7890");
  await page.locator(".download-proxy-auth summary").click();
  await page.locator("#download-proxy-username").fill("fixture-user");
  await page.locator("#download-proxy-password").fill("fixture-password");
  await page.locator("#download-proxy-test").click();
  await expect(page.locator("#download-route-health")).toContainText("240 ms");
  await expect(page.locator("#download-proxy-password")).toHaveValue("");
  await page.locator("#download-proxy-url").fill("http://10.15.49.212:7891");
  await page.waitForTimeout(5500);
  await expect(page.locator("#download-proxy-url")).toHaveValue("http://10.15.49.212:7891");
  fail = true; await page.locator("#download-proxy-test").click();
  await expect(page.locator("#download-route-health")).toContainText("ECONNREFUSED");
  await page.screenshot({ path: testInfo.outputPath("download-settings.png") });
});
