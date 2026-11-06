import { expect, test, type Page, type Route } from "@playwright/test";
import { Healpix, Pointing } from "healpixjs";

const assetId = "user-cosmos-initial-navigation";
const layerColor = "#38c8b5";
const allPixels = Array.from({ length: 12 * 16 ** 2 }, (_, pixel) => pixel);
const healpix = new Healpix(16);

async function prepareAladinFixture(page: Page, queryOverride?: (route: Route) => Promise<void>, densityOverride?: (route: Route) => Promise<void>) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("astro-workspace:theme:v1", "dark");
  });

  let anchorPoint: { raDeg: number; decDeg: number } | null = null;
  let anchorRequests = 0;
  let densityRequests = 0;
  const pointQueryCenters: Array<{ raDeg: number; decDeg: number; fovDeg: number }> = [];

  await page.route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const fulfill = (body: unknown) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });

    if (request.method() === "GET") {
      if (url.pathname === "/api/surveys" || url.pathname === "/api/public-surveys") return fulfill({ surveys: [], records: [] });
      if (url.pathname === "/api/survey-footprints") return fulfill({
        schemaVersion: 1, generatedAt: "2026-10-30T00:00:00Z", coordinateFrame: "ICRS", nside: 16, footprints: [],
      });
      if (url.pathname === "/api/data-assets") return fulfill({ assets: [{
        id: assetId, name: "COSMOS catalog", description: "Sparse coarse cells with a concentrated point field",
        kind: "catalog", modalities: ["catalog"], origin: "user", status: "ready", projectState: "acquired",
        projectStates: ["acquired"], footprintIds: [], createdAt: "2026-10-30T00:00:00Z", updatedAt: "2026-10-30T00:00:00Z",
      }] });
      if (url.pathname === "/api/data-assets/status") return fulfill({ statuses: [{
        assetId, assetName: "COSMOS catalog", coverage: "ready", dataPointCount: 5, dataPointStatus: "succeeded",
        dataPointAnchor: { raDeg: 149.0582, decDeg: 2.3852 }, nextAction: "explore_points",
      }] });
      if (url.pathname === "/api/sky/coverage") {
        const nside = Number(url.searchParams.get("nside") ?? 16);
        const pixels = nside === 16 ? allPixels : Array.from({ length: 12 * nside ** 2 }, (_, pixel) => pixel);
        const layer = {
          key: `asset:${assetId}`, layerId: `workspace-${assetId}`, assetId, assetIds: [assetId], pixels,
          byAsset: [{ key: assetId, label: "COSMOS catalog", files: 1, bytes: 1, objects: 5, objectCount: 5 }],
          status: "ready", source: "asset", nside, availableOrders: [Math.log2(nside)],
          nativeOrders: [Math.log2(nside)], precision: "exact", coverageRole: "object_presence",
        };
        return fulfill({ status: "ready", index: "fixture", nside, pixels, byAsset: [], layers: [layer] });
      }
      if (url.pathname === "/api/user-mocs") return fulfill({ artifacts: [] });
      if (url.pathname === "/api/connectors") return fulfill({ connectors: [] });
      if (url.pathname === "/api/resource-packages/config") return fulfill({ config: { available: true, catalogUrl: "https://fixture.invalid/catalog.json" } });
      if (url.pathname === "/api/production-pipelines") return fulfill({ pipelines: [] });
      if (url.pathname === "/api/production-runs") return fulfill({ runs: [] });
      if (url.pathname === "/api/agent/workspace-sessions") return fulfill({ sessions: [] });
      if (url.pathname === "/api/coverage-downloads") return fulfill({ jobs: [] });
      if (url.pathname === "/api/capabilities") return fulfill({});
      return fulfill({});
    }

    if (request.method() === "POST" && url.pathname === "/api/sky/points/query") {
      if (queryOverride) return queryOverride(route);
      const body = request.postDataJSON() as { bbox?: { raMin: number; raMax: number; decMin: number; decMax: number } };
      const bbox = body.bbox;
      if (bbox) pointQueryCenters.push({
        raDeg: (bbox.raMin + bbox.raMax) / 2,
        decDeg: (bbox.decMin + bbox.decMax) / 2,
        fovDeg: bbox.raMax - bbox.raMin,
      });
      const objects = anchorPoint && bbox
        && anchorPoint.raDeg >= bbox.raMin && anchorPoint.raDeg <= bbox.raMax
        && anchorPoint.decDeg >= bbox.decMin && anchorPoint.decDeg <= bbox.decMax
        ? [{ object_id: "cosmos-anchor", ra_deg: anchorPoint.raDeg, dec_deg: anchorPoint.decDeg,
            survey: "cosmos", release: "fixture-v1", product: "COSMOS", modality: "catalog", asset_id: assetId }]
        : [];
      return fulfill({ status: "ready", index: "fixture", objects, total: objects.length, limit: 2_000, indexing: false });
    }

    if (request.method() === "POST" && url.pathname === "/api/sky/points/anchor") {
      const body = request.postDataJSON() as { region?: { nside: number; pixels: number[] } };
      const pixel = body.region?.pixels?.[0] ?? 0;
      const vector = healpix.pix2vec(pixel);
      anchorPoint = {
        raDeg: ((Math.atan2(vector.y, vector.x) * 180 / Math.PI) % 360 + 360) % 360,
        decDeg: Math.asin(vector.z) * 180 / Math.PI,
      };
      anchorRequests += 1;
      return fulfill({ status: "ready", point: { objectId: "cosmos-anchor", ...anchorPoint }, indexing: false });
    }

    if (request.method() === "POST" && url.pathname === "/api/sky/points/density") {
      densityRequests += 1;
      if (densityOverride) return densityOverride(route);
      return fulfill({
        status: "ready", index: "fixture", coordinateFrame: "ICRS", ordering: "NESTED",
        nside: 32, total: 0, layers: [{ id: assetId, count: 0 }], cells: [], truncated: false, indexing: false,
      });
    }
    if (url.pathname === "/api/sky/points/scopes") return fulfill({ scopes: [] });
    if (url.pathname === "/api/sky/points/inspect") return fulfill({ matches: [], images: [], truncated: false, indexing: false });
    return fulfill({});
  });
  return {
    get anchorPoint() { return anchorPoint; },
    get anchorRequests() { return anchorRequests; },
    get densityRequests() { return densityRequests; },
    pointQueryCenters,
  };
}

async function enterFixtureAladin(page: Page) {
  await page.goto("/?mode=layers");
  await expect(page.locator("#service-status")).toHaveText("SERVICE ONLINE");
  const canvas = page.locator("#scene-canvas");
  await expect(canvas).toBeVisible();
  const assetCard = page.locator(`#sky-layer-list [data-layer-key="asset:${assetId}"]`);
  await expect(assetCard).toBeVisible();
  const layerToggle = assetCard.locator("input[type=checkbox]");
  if (!await layerToggle.isChecked()) await layerToggle.check();

  const point = await canvas.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const x = rect.width / 2;
    const y = rect.height / 2;
    element.dispatchEvent(new PointerEvent("pointermove", {
      bubbles: true, clientX: rect.left + x, clientY: rect.top + y, pointerId: 1, pointerType: "mouse",
    }));
    return { x, y, pixel: element.dataset.hoveredPixel };
  });
  expect(point.pixel).toMatch(/^\d+$/);
  await canvas.click({ button: "right", position: { x: point.x, y: point.y } });
  await page.locator("#coverage-enter-flat").click();

  const aladin = page.locator("#aladin-explorer");
  await expect(aladin).toBeVisible();
  return aladin;
}

test("empty viewport waits for region navigation before declaring there are no points", async ({ page }) => {
  await prepareAladinFixture(page);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/sky/points/anchor", async route => {
    await pending;
    await route.fallback();
  });
  try {
    const aladin = await enterFixtureAladin(page);
    await expect(aladin).toHaveAttribute("data-region-point-state", "loading");
    await expect(page.locator("#aladin-region-status")).toContainText("正在查找选区内的数据点");
    await expect(page.getByText("所选图层在当前天区和视野内没有数据点", { exact: true })).toHaveCount(0);
    release();
    await expect.poll(async () => Number(await aladin.getAttribute("data-object-returned"))).toBe(1);
    await expect(page.locator("#aladin-region-status")).toBeHidden();
  } finally { release(); }
});

test("image coverage without image centers explains the region and offers coordinate inspection", async ({ page }, testInfo) => {
  await prepareAladinFixture(page);
  await page.route("**/api/data-assets", route => route.fulfill({ json: { assets: [{
    id: assetId, name: "W1 image coverage", kind: "image", modalities: ["image"], origin: "user",
    status: "ready", footprintIds: [], createdAt: "2026-10-30T00:00:00Z", updatedAt: "2026-10-30T00:00:00Z",
  }] } }));
  let anchorRequests = 0;
  await page.route("**/api/sky/points/anchor", route => {
    anchorRequests += 1;
    return route.fulfill({ json: { status: "ready", point: null, indexing: false } });
  });
  let inspected = false;
  let inspectionCoordinate: { raDeg: number; decDeg: number } | undefined;
  await page.route("**/api/sky/points/inspect", route => {
    const body = route.request().postDataJSON();
    expect(body.region.pixels).toHaveLength(1);
    expect(body.layerScopes).toEqual([{ assetId }]);
    inspectionCoordinate = body;
    inspected = true;
    return route.fulfill({ json: { matches: [], images: [], truncated: false, indexing: false } });
  });
  const aladin = await enterFixtureAladin(page);
  await expect(aladin).toHaveAttribute("data-region-point-state", "empty");
  await expect(page.locator("#aladin-region-status")).toContainText("影像覆盖");
  await expect(page.locator("#aladin-region-status")).toContainText("没有已索引的影像中心点");
  await expect(page.locator(".aladin-direction-guide")).toHaveCount(0);
  await expect(page.getByText("所选图层在当前天区和视野内没有数据点", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("image-coverage-region-status.png") });
  await page.locator("#aladin-fullscreen").click();
  await expect(page.locator("#scene-stage")).toHaveJSProperty("clientWidth", 1280);
  await expect(page.locator("#aladin-region-status")).toBeVisible();
  await page.locator("#aladin-inspect-coverage").click();
  await expect.poll(() => inspected).toBe(true);
  expect(inspectionCoordinate!.raDeg).toBeCloseTo(Number(await aladin.getAttribute("data-center-ra-deg")), 5);
  expect(inspectionCoordinate!.decDeg).toBeCloseTo(Number(await aladin.getAttribute("data-center-dec-deg")), 5);
  await expect(page.locator(".aladin-inspector-selected")).toHaveText("入口坐标 · 所选图层的影像覆盖");
  await expect(page.locator(".aladin-fullscreen-drawer")).toBeVisible();
  await page.locator("#inspector-close").click();
  await page.locator("#aladin-fullscreen").click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#aladin-fullscreen").click();
  await expect(page.locator("#aladin-region-status")).toBeVisible();
  await expect.poll(async () => {
    const notice = await page.locator("#aladin-region-status").boundingBox();
    return Boolean(notice && notice.width > 0 && notice.x >= 0 && notice.x + notice.width <= 390);
  }).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("image-coverage-mobile-status.png") });
  expect(anchorRequests).toBe(1);
});

test("failed region navigation can be retried without declaring the region empty", async ({ page }) => {
  await prepareAladinFixture(page);
  let attempts = 0;
  await page.route("**/api/sky/points/anchor", route => ++attempts === 1
    ? route.fulfill({ json: { status: "error", message: "temporary anchor failure", point: null, indexing: false } })
    : route.fallback());
  const aladin = await enterFixtureAladin(page);
  await expect(aladin).toHaveAttribute("data-region-point-state", "error");
  await expect(page.locator("#aladin-region-status")).toContainText("暂时无法判断选区是否为空");
  await page.locator("#aladin-retry-navigation").click();
  await expect.poll(async () => Number(await aladin.getAttribute("data-object-returned"))).toBe(1);
  await expect(page.locator("#aladin-region-status")).toBeHidden();
});

test("user movement cancels automatic entry navigation and keeps manual direction guides", async ({ page }) => {
  await prepareAladinFixture(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/sky/points/anchor", async route => { await gate; await route.fallback(); });
  try {
    const aladin = await enterFixtureAladin(page);
    await expect(page.locator("#aladin-region-status")).toContainText("正在查找选区内的数据点");
    await page.locator("#aladin-asset-drawer-toggle").click();
    const bounds = (await aladin.boundingBox())!;
    await page.mouse.move(bounds.x + bounds.width * 0.12, bounds.y + bounds.height * 0.2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * 0.9, bounds.y + bounds.height * 0.8, { steps: 8 });
    await page.mouse.up();
    const moved = { raDeg: Number(await aladin.getAttribute("data-ra-deg")), decDeg: Number(await aladin.getAttribute("data-dec-deg")) };
    release();
    await expect(aladin).toHaveAttribute("data-region-point-state", "available");
    await expect(page.locator(".aladin-direction-guide")).toBeVisible();
    expect(Number(await aladin.getAttribute("data-ra-deg"))).toBeCloseTo(moved.raDeg, 3);
    expect(Number(await aladin.getAttribute("data-dec-deg"))).toBeCloseTo(moved.decDeg, 3);
    await page.locator(".aladin-direction-guide").click();
    await expect.poll(async () => Number(await aladin.getAttribute("data-object-returned"))).toBe(1);
  } finally { release(); }
});

async function prepareCoverageLoadingFixture(page: Page, onCoverage?: (route: Route, ids: string[]) => Promise<boolean>) {
  await prepareAladinFixture(page);
  const ids = [assetId, "user-preview-cosmos", "user-preview-euclid"];
  await page.addInitScript(id => localStorage.setItem("astro-workspace:survey-layer-preferences:v4", JSON.stringify({
    schemaVersion: 5, visibleSurveyIds: [], visibleAssetIds: [id], visibleWorkspaceLayerKeys: [], layerOrder: [],
  })), assetId);
  await page.route("**/api/data-assets", route => route.fulfill({ json: { assets: ids.map((id, index) => ({
    id, name: ["W1 selected", "COSMOS preview", "Euclid preview"][index], kind: "image", modalities: ["image"],
    origin: "user", status: "ready", footprintIds: [], createdAt: "2026-10-30T00:00:00Z", updatedAt: "2026-10-30T00:00:00Z",
  })) } }));
  await page.route("**/api/sky/coverage?**", async route => {
    const requested = new URL(route.request().url()).searchParams.get("assetIds")?.split(",") ?? [];
    if (await onCoverage?.(route, requested)) return;
    const layers = (requested.length ? requested : ids).map(id => ({
      key: `asset:${id}`, assetId: id, assetIds: [id], pixels: allPixels, byAsset: [], status: "ready", source: "asset",
      nside: 16, availableOrders: [4], coverageRole: "image_extent", preview: id !== assetId,
    }));
    await route.fulfill({ json: { status: "ready", index: "fixture", nside: 16, pixels: allPixels, layers, byAsset: [] } });
  });
  return ids;
}

test("preview coverage never changes the selection when entering and leaving Aladin", async ({ page }) => {
  await prepareCoverageLoadingFixture(page);
  const aladin = await enterFixtureAladin(page);
  await expect(aladin).toHaveAttribute("data-source-keys", assetId);
  await page.locator("#drill-back-button").click();
  await expect(page.locator("#scene-canvas")).toBeVisible();
  await expect(page.locator("#sky-layer-list input[type=checkbox]:checked")).toHaveCount(1);
  await expect(page.locator(`#sky-layer-list [data-layer-key="asset:${assetId}"] input`)).toBeChecked();
  await expect(page.locator('#sky-layer-list [data-layer-key="asset:user-preview-euclid"] input')).not.toBeChecked();
  await expect(page.locator('#sky-layer-list [data-layer-key="asset:user-preview-cosmos"] input')).not.toBeChecked();
});

test("selected coverage shows loading and preempts pending background coverage", async ({ page }) => {
  let releaseSelected!: () => void, releaseBackground!: () => void;
  const selectedGate = new Promise<void>(resolve => { releaseSelected = resolve; });
  const backgroundGate = new Promise<void>(resolve => { releaseBackground = resolve; });
  const requests: string[][] = [];
  let backgroundAborted = false;
  let selectedReleased = false;
  await prepareCoverageLoadingFixture(page, async (_route, ids) => {
    requests.push(ids);
    if (ids[0] === assetId && !selectedReleased) await selectedGate;
    if (ids[0] === "user-preview-cosmos") await backgroundGate;
    return false;
  });
  page.on("requestfailed", request => {
    if (new URL(request.url()).searchParams.get("assetIds") === "user-preview-cosmos") backgroundAborted = true;
  });
  try {
    await page.goto("/?mode=layers");
    await expect.poll(() => requests.length).toBeGreaterThan(0);
    expect(requests[0]).toEqual([assetId]);
    await expect(page.locator("#coverage-load-status")).toBeVisible();
    await expect(page.locator("#coverage-load-status")).toContainText("正在加载所选图层覆盖");
    expect(requests).toEqual([[assetId]]);
    selectedReleased = true;
    releaseSelected();
    await expect(page.locator("#coverage-load-status")).toBeHidden();
    await expect.poll(() => requests.some(ids => ids[0] === "user-preview-cosmos")).toBe(true);
    await page.locator('#sky-layer-list [data-layer-key="asset:user-preview-euclid"] input').check();
    await expect.poll(() => backgroundAborted).toBe(true);
    await expect.poll(() => requests.some(ids => ids[0] === "user-preview-euclid")).toBe(true);
    await expect(page.locator('#sky-layer-list [data-layer-key="asset:user-preview-euclid"]')).toHaveAttribute("data-coverage-load-state", "ready");
    await expect(page.locator("#sky-layer-list input[type=checkbox]:checked")).toHaveCount(2);
  } finally { releaseSelected(); releaseBackground(); }
});

test("a failed selected coverage request offers retry and preserves the checkbox", async ({ page }) => {
  let attempts = 0;
  await prepareCoverageLoadingFixture(page, async (route, ids) => {
    if (ids[0] === assetId && ++attempts === 1) {
      await route.fulfill({ json: { status: "error", nside: 16, pixels: [], layers: [], byAsset: [], message: "temporary coverage failure" } });
      return true;
    }
    return false;
  });
  await page.goto("/?mode=layers");
  await expect(page.locator("#coverage-load-status")).toContainText("覆盖加载失败");
  const card = page.locator(`#sky-layer-list [data-layer-key="asset:${assetId}"]`);
  await expect(card).toHaveAttribute("data-coverage-load-state", "error");
  await expect(card.locator("input")).toBeChecked();
  await page.locator("#coverage-load-retry").click();
  await expect(card).toHaveAttribute("data-coverage-load-state", "ready");
  await expect(page.locator("#coverage-load-status")).toBeHidden();
  await expect(page.locator("#sky-layer-list input:checked")).toHaveCount(1);
});

test("empty Aladin entry viewport anchors to data inside the selected COSMOS cell", async ({ page }, testInfo) => {
  const state = await prepareAladinFixture(page);
  const aladin = await enterFixtureAladin(page);
  await expect(aladin).toHaveAttribute("data-initial-fov-deg", "0.5000");
  await expect.poll(async () => Number(await aladin.getAttribute("data-fov-deg"))).toBeGreaterThan(0);
  const initialFov = Number(await aladin.getAttribute("data-fov-deg"));
  await expect.poll(() => state.anchorRequests, { timeout: 2_000 }).toBe(1);
  expect(initialFov).toBeCloseTo(0.5, 1);
  expect(Number(await aladin.getAttribute("data-fov-x-deg"))).toBeGreaterThan(0.4);
  expect(Number(await aladin.getAttribute("data-fov-y-deg"))).toBeCloseTo(0.5, 1);
  await expect.poll(async () => Number(await aladin.getAttribute("data-object-returned"))).toBe(1);
  const markerPixels = await page.locator(".aladin-catalogCanvas").evaluate(element => {
    const canvas = element as HTMLCanvasElement;
    const context = canvas.getContext("2d");
    if (!context) return 0;
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let pixels = 0;
    for (let offset = 0; offset < data.length; offset += 4) {
      if (Math.max(data[offset]!, data[offset + 1]!, data[offset + 2]!) > 80) pixels += 1;
    }
    return pixels;
  });
  expect(markerPixels).toBeGreaterThan(0);
  expect(state.pointQueryCenters.length).toBeGreaterThan(0);

  const bounds = await aladin.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
  await page.mouse.wheel(0, 900);
  await expect.poll(async () => Number(await aladin.getAttribute("data-fov-deg"))).toBeGreaterThan(1.5);
  await expect(aladin).toHaveAttribute("data-display-mode", "density");
  await expect.poll(() => state.densityRequests).toBeGreaterThan(0);

  await page.locator("#aladin-asset-drawer-toggle").click();
  await page.mouse.move(bounds!.x + 70, bounds!.y + bounds!.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + bounds!.width - 20, bounds!.y + bounds!.height / 2, { steps: 8 });
  await page.mouse.up();
  const guide = page.locator(".aladin-direction-guide");
  await expect(guide).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("aladin-direction-guide.png") });
  await guide.click();
  await expect.poll(async () => Number(await aladin.getAttribute("data-ra-deg"))).toBeCloseTo(state.anchorPoint!.raDeg, 3);
  await expect.poll(async () => Number(await aladin.getAttribute("data-dec-deg"))).toBeCloseTo(state.anchorPoint!.decDeg, 3);
  await expect.poll(async () => Number(await aladin.getAttribute("data-fov-deg"))).toBeCloseTo(0.5, 1);
  await expect.poll(async () => Number(await aladin.getAttribute("data-object-returned"))).toBe(1);
});

test("panning interrupts old pagination and loads the current viewport first", async ({ page }) => {
  const requests: Array<{ bbox: { raMin: number; raMax: number; decMin: number; decMax: number }; cursor?: unknown[] }> = [];
  let oldPageAborted = false;
  let releaseOldPage: () => void = () => {};
  const oldPage = new Promise<void>(resolve => { releaseOldPage = resolve; });
  page.on("requestfailed", request => {
    if (request.url().endsWith("/api/sky/points/query") && request.postDataJSON()?.cursor) oldPageAborted = true;
  });
  await prepareAladinFixture(page, async route => {
    const input = route.request().postDataJSON();
    requests.push(input);
    if (input.cursor) await oldPage;
    const bbox = input.bbox;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      status: "ready", index: "fixture", total: 2, limit: 2000, indexing: false,
      objects: [{ object_id: `viewport-${requests.length}`, ra_deg: (bbox.raMin + bbox.raMax) / 2,
        dec_deg: (bbox.decMin + bbox.decMax) / 2, survey: "cosmos", release: "fixture-v1",
        product: "catalog", modality: "catalog", asset_id: assetId }],
      ...(!input.cursor && requests.length === 1 ? { nextCursor: ["old-slow-page"] } : {}),
    }) });
  });
  // Keep entry navigation stationary so this test isolates pagination cancellation.
  await page.route("**/api/sky/points/anchor", route => route.fulfill({
    json: { status: "ready", point: null, indexing: false },
  }));
  try {
    const aladin = await enterFixtureAladin(page);
    await expect.poll(() => requests.some(request => request.cursor?.[0] === "old-slow-page")).toBe(true);
    const bounds = (await aladin.boundingBox())!;
    const before = requests.length;
    await page.mouse.move(bounds.x + bounds.width * 0.7, bounds.y + bounds.height * 0.55);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * 0.7, bounds.y + bounds.height * 0.8, { steps: 8 });
    await page.mouse.up();
    await expect.poll(() => requests.length, { timeout: 3_000 }).toBeGreaterThan(before);
    expect(requests.at(-1)?.cursor).toBeUndefined();
    await expect.poll(() => oldPageAborted, { timeout: 2_000 }).toBe(true);
    await expect(aladin).toHaveAttribute("data-object-complete", "true");
  } finally {
    releaseOldPage();
  }
});

test("fullscreen zoom and pan keep point loading aligned with the visible sky", async ({ page }) => {
  const requests: Array<{ bbox: { raMin: number; raMax: number; decMin: number; decMax: number } }> = [];
  await prepareAladinFixture(page, async route => {
    const input = route.request().postDataJSON();
    requests.push(input);
    const bbox = input.bbox;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      status: "ready", index: "fixture", total: 1, limit: 2000, indexing: false,
      objects: [{ object_id: `pan-${requests.length}`, ra_deg: (bbox.raMin + bbox.raMax) / 2,
        dec_deg: (bbox.decMin + bbox.decMax) / 2, survey: "cosmos", release: "fixture-v1",
        product: "catalog", modality: "catalog", asset_id: assetId }],
    }) });
  });
  const aladin = await enterFixtureAladin(page);
  await expect(aladin).toHaveAttribute("data-object-complete", "true");
  await page.locator("#aladin-fullscreen").click();
  await expect(page.locator("#scene-stage")).toHaveAttribute("data-fullscreen", "true");
  await expect(page.locator(".aladin-catalogCanvas")).toHaveAttribute("width", "1280");
  const bounds = (await aladin.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width * 0.7, bounds.y + bounds.height * 0.15);
  await page.locator(".aladin-catalogCanvas").dispatchEvent("wheel", { deltaY: -500, deltaMode: 0 });
  await expect.poll(async () => Number(await aladin.getAttribute("data-fov-deg"))).toBeLessThan(0.5);
  await expect(aladin).toHaveAttribute("data-display-mode", "points");
  const before = requests.length;
  const cachedDecMax = Math.max(...requests.map(request => request.bbox.decMax));
  const northEdge = async () => Number(await aladin.getAttribute("data-dec-deg")) + Number(await aladin.getAttribute("data-fov-y-deg")) / 2;
  // Fullscreen can now finish loading its wider point viewport before zoom.
  // Pan far enough to expose sky outside that complete cache.
  for (let attempt = 0; attempt < 4 && await northEdge() <= cachedDecMax + 0.02; attempt += 1) {
    const decBefore = await aladin.getAttribute("data-dec-deg");
    await page.mouse.move(bounds.x + bounds.width * 0.7, bounds.y + bounds.height * 0.15);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * 0.7, bounds.y + bounds.height * 0.9, { steps: 8 });
    await page.mouse.up();
    await expect.poll(() => aladin.getAttribute("data-dec-deg")).not.toBe(decBefore);
  }
  expect(await northEdge()).toBeGreaterThan(cachedDecMax + 0.02);
  await expect.poll(() => requests.length).toBeGreaterThan(before);
  await expect(aladin).toHaveAttribute("data-object-complete", "true");
});

test("density starts above 1.5 degrees, labels survey counts and double-clicks into the cell center", async ({ page }, testInfo) => {
  const state = await prepareAladinFixture(page, undefined, async route => {
    const input = route.request().postDataJSON();
    const box = input.boxes[0];
    const ra = (box.raMin + box.raMax) / 2;
    const dec = (box.decMin + box.decMax) / 2;
    const grid = new Healpix(input.targetNside);
    const pixels = [ra, ra + 0.6].map(lon => grid.ang2pix(new Pointing(null, false, (90 - dec) * Math.PI / 180, lon * Math.PI / 180)));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      status: "ready", index: "fixture", coordinateFrame: "ICRS", ordering: "NESTED", nside: input.targetNside,
      total: 60, layers: [{ id: assetId, count: 60 }], truncated: false, indexing: false,
      cells: [
        { pixel: pixels[0], count: 50, layers: [{ id: assetId, count: 50 }], surveys: [{ id: "cosmos", count: 32 }, { id: "euclid", count: 10 }, { id: "", assetId, count: 8 }] },
        { pixel: pixels[1], count: 10, layers: [{ id: assetId, count: 10 }], surveys: [{ id: "cosmos", count: 7 }, { id: "euclid", count: 3 }] },
      ],
    }) });
  });
  const aladin = await enterFixtureAladin(page);
  await expect.poll(async () => Number(await aladin.getAttribute("data-object-returned"))).toBe(1);
  const bounds = (await aladin.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.wheel(0, 300);
  await expect.poll(async () => Number(await aladin.getAttribute("data-fov-deg"))).toBeGreaterThan(0.75);
  await expect(aladin).toHaveAttribute("data-object-complete", "true");
  expect(Number(await aladin.getAttribute("data-fov-deg"))).toBeLessThan(1.5);
  expect(state.densityRequests).toBe(0);
  await expect(aladin).toHaveAttribute("data-display-mode", "points");

  await page.mouse.wheel(0, 450);
  await expect.poll(async () => Number(await aladin.getAttribute("data-fov-deg"))).toBeGreaterThan(1.5);
  await expect(aladin).toHaveAttribute("data-display-mode", "density");
  await expect(aladin).toHaveAttribute("data-object-complete", "true");
  await expect(page.locator("#aladin-asset-nav .aladin-asset-button small")).toHaveText("60 个数据点 · 密度场");
  const labels = page.locator(".aladin-density-label");
  await expect(labels).toHaveCount(2);
  const label = labels.first();
  await expect(label.locator(".aladin-density-label-total")).toHaveText("50 个数据点");
  await expect(label.locator('[data-survey-id="cosmos"] output')).toHaveText("32");
  await expect(label.locator('[data-survey-id="euclid"] output')).toHaveText("10");
  await expect(label.locator(`[data-asset-id="${assetId}"] output`)).toHaveText("8");
  await expect(label.locator(`[data-asset-id="${assetId}"] span`)).toHaveText("COSMOS catalog（未标注巡天）");
  await expect(labels.nth(1).locator('[data-survey-id="cosmos"] output')).toHaveText("7");
  await expect(labels.nth(1).locator('[data-survey-id="euclid"] output')).toHaveText("3");
  const center = new Healpix(Number(await label.getAttribute("data-nside"))).pix2ang(Number(await label.getAttribute("data-pixel")));
  const expectedRa = center.phi * 180 / Math.PI;
  const expectedDec = 90 - center.theta * 180 / Math.PI;
  const labelBox = (await label.boundingBox())!;
  const x = labelBox.x + labelBox.width / 2 + 10;
  const y = labelBox.y + labelBox.height / 2 + 4;
  await page.mouse.move(x, y);
  await expect(page.locator("#aladin-density-hover li")).toHaveCount(3);
  await expect(page.locator("#aladin-density-hover")).toContainText("cosmos");
  await expect(page.locator("#aladin-density-hover")).toContainText("未标注巡天按来源资产列出");
  await page.screenshot({ path: testInfo.outputPath("aladin-density-survey-counts.png") });
  const pointQueries = state.pointQueryCenters.length;
  await page.mouse.dblclick(x, y);
  await expect.poll(async () => Number(await aladin.getAttribute("data-fov-deg"))).toBeCloseTo(0.5, 2);
  await expect.poll(async () => Number(await aladin.getAttribute("data-ra-deg"))).toBeCloseTo(expectedRa, 4);
  await expect.poll(async () => Number(await aladin.getAttribute("data-dec-deg"))).toBeCloseTo(expectedDec, 4);
  await expect(aladin).toHaveAttribute("data-display-mode", "points");
  await expect(page.locator(".aladin-density-labels")).toBeHidden();
  await expect.poll(() => state.pointQueryCenters.length).toBeGreaterThan(pointQueries);
});
