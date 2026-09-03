import { expect, test, type Page } from "@playwright/test";
import { PNG } from "pngjs";
import { Healpix } from "healpixjs";

const apiRoot = process.env.ASTRO_E2E_API ?? "http://astro.workspace.dev.72602.space:32080";
const baselinePackageIds = ["public-legacy-surveys-footprints", "public-sdss-footprints", "public-hst-footprints"];
const TRANSIENT_STATUSES = new Set([502, 503, 504]);
type PackageState = { id: string; activeReleaseIds: string[]; availableReleaseIds: string[] };
let initialLoads: Array<{ packageId: string; releaseIds: string[] }> = [];

async function retryDelay(attempt: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
}

async function fetchWithRetry(url: string, init?: RequestInit): Promise<Response> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, init);
      if (!TRANSIENT_STATUSES.has(response.status) || attempt === 2) return response;
      await response.arrayBuffer().catch(() => undefined);
    } catch (error) {
      if (attempt === 2) throw error;
    }
    await retryDelay(attempt);
  }
  throw new Error("unreachable");
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetchWithRetry(`${apiRoot}${path}`, init);
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path} failed: ${response.status} ${await response.text()}`);
  return await response.json() as T;
}

async function installPackage(id: string): Promise<void> {
  const catalog = await apiJson<{ packages: Array<{ id: string; version: string; installedVersion?: string }> }>("/api/resource-packages");
  const record = catalog.packages.find((candidate) => candidate.id === id);
  if (!record) throw new Error(`Missing E2E resource package: ${id}`);
  if (record.installedVersion !== record.version) {
    let { job } = await apiJson<{ job: { id: string; status: string; error?: string } }>(`/api/resource-packages/${id}/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    while (job.status === "queued" || job.status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 250));
      ({ job } = await apiJson<{ job: typeof job }>(`/api/resource-packages/jobs/${job.id}`));
    }
    if (job.status !== "completed") throw new Error(job.error ?? "Resource package installation failed");
  }
}

test.beforeAll(async () => {
  const catalog = await apiJson<{ packages: PackageState[] }>("/api/resource-packages");
  initialLoads = catalog.packages
    .filter((record) => record.activeReleaseIds.length)
    .map((record) => ({ packageId: record.id, releaseIds: record.activeReleaseIds }));
  const packagesToPrepare = [...new Set([
    ...baselinePackageIds,
    ...initialLoads.map((load) => load.packageId),
  ])];
  // Resource package state is a single-writer JSON/PVC store. Keep setup
  // deterministic so concurrent archive installs cannot overwrite each other.
  for (const id of packagesToPrepare) await installPackage(id);
  const installed = await apiJson<{ packages: PackageState[] }>("/api/resource-packages");
  const loads = initialLoads.filter((load) => load.packageId !== "public-euclid-footprints" && load.packageId !== "public-panstarrs-footprints");
  for (const packageId of baselinePackageIds) {
    const record = installed.packages.find((candidate) => candidate.id === packageId);
    if (!record) throw new Error(`Missing installed E2E resource package: ${packageId}`);
    const existing = loads.find((load) => load.packageId === packageId);
    if (existing) existing.releaseIds = record.availableReleaseIds;
    else loads.push({ packageId, releaseIds: record.availableReleaseIds });
  }
  await apiJson("/api/resource-packages/active", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ loads }),
  });
});

test.afterAll(async () => {
  const catalog = await apiJson<{ packages: Array<PackageState & { installedVersion?: string }> }>("/api/resource-packages");
  const available = new Map(catalog.packages.map((record) => [record.id, record]));
  const restorableLoads = initialLoads.flatMap((load) => {
    const record = available.get(load.packageId);
    if (!record?.installedVersion) return [];
    const releaseIds = load.releaseIds.filter((releaseId) => record.availableReleaseIds.includes(releaseId));
    return releaseIds.length ? [{ packageId: load.packageId, releaseIds }] : [];
  });
  await apiJson("/api/resource-packages/active", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ loads: restorableLoads }),
  });
});

async function proxyApi(page: Page): Promise<void> {
  await page.route("**/api/**", async (route) => {
    const requestUrl = new URL(route.request().url());
    // The UI suite uses the deployed catalog/resource-package APIs, but its
    // interaction tests need a deterministic owned coverage surface. The
    // remote Warehouse ES is intentionally optional and may be unavailable;
    // opt into the live coverage path explicitly when doing a deployment
    // smoke with ASTRO_E2E_REAL_COVERAGE=true.
    if (requestUrl.pathname === "/api/sky/coverage" && process.env.ASTRO_E2E_REAL_COVERAGE !== "true") {
      const nside = Number(requestUrl.searchParams.get("nside") ?? "16");
      const safeNside = Number.isInteger(nside) && nside > 0 ? nside : 16;
      const cellCount = Math.min(12 * safeNside ** 2, 4096);
      const pixels = Array.from({ length: cellCount }, (_, pixel) => pixel);
      const assetIds = (requestUrl.searchParams.get("assetIds") ?? "").split(",").map((value) => value.trim()).filter(Boolean);
      const layers = assetIds.map((assetId) => ({
        key: `asset:${assetId}`,
        layerId: `workspace-${assetId}`,
        assetId,
        assetIds: [assetId],
        pixels,
        byAsset: [{ key: assetId, label: assetId, files: 1, bytes: 1, objects: 1, objectCount: 1 }],
        status: "ready",
        source: "asset",
        nside: safeNside,
        availableOrders: [Math.log2(safeNside)],
        nativeOrders: [Math.log2(safeNside)],
        precision: "exact",
        coverageRole: "object_presence",
      }));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "ready", index: "astro_coverage_index_v1", nside: safeNside, pixels: assetIds.length ? pixels : [], byAsset: [], layers }),
      });
      return;
    }
    if (requestUrl.origin === new URL(apiRoot).origin) {
      await route.continue();
      return;
    }
    if (requestUrl.pathname === "/api/sky/query" && process.env.ASTRO_E2E_REAL_COVERAGE !== "true") {
      const body = (route.request().postDataJSON() ?? {}) as { nside?: number; assetIds?: unknown };
      const nside = Number(body.nside ?? 16);
      const safeNside = Number.isInteger(nside) && nside > 0 ? nside : 16;
      const assetIds = Array.isArray(body.assetIds)
        ? body.assetIds.filter((value): value is string => typeof value === "string" && value.length > 0)
        : [];
      const byAsset = assetIds.map((assetId) => ({
        key: assetId,
        label: assetId,
        files: 1,
        bytes: 1,
        objects: 1,
        objectCount: 1,
      }));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: "ready",
          index: "astro_file_index_v1",
          nside: safeNside,
          matchedFiles: assetIds.length,
          totalBytes: assetIds.length,
          knownFiles: assetIds.length,
          unknownFiles: 0,
          spatialStatus: { known: assetIds.length },
          byAsset,
          bySurveyReleaseModality: [],
        }),
      });
      return;
    }
    try {
      let response = await route.fetch({ url: `${apiRoot}${requestUrl.pathname}${requestUrl.search}`, timeout: 10_000 });
      for (let attempt = 0; TRANSIENT_STATUSES.has(response.status()) && attempt < 2; attempt += 1) {
        await response.body().catch(() => undefined);
        await retryDelay(attempt);
        response = await route.fetch({ url: `${apiRoot}${requestUrl.pathname}${requestUrl.search}`, timeout: 10_000 });
      }
      await route.fulfill({ response });
    } catch {
      await route.abort().catch(() => undefined);
    }
  });
}

test.afterEach(async ({ page }) => page.close());

function fragmentPixelCount(buffer: Buffer): number {
  const image = PNG.sync.read(buffer);
  let count = 0;
  for (let index = 0; index < image.data.length; index += 4) {
    const red = image.data[index]!;
    const green = image.data[index + 1]!;
    const blue = image.data[index + 2]!;
    const maximum = Math.max(red, green, blue);
    const minimum = Math.min(red, green, blue);
    if (maximum > 52 && maximum - minimum > 24) count += 1;
  }
  return count;
}

function averagePixelBrightness(buffer: Buffer): number {
  const image = PNG.sync.read(buffer);
  let total = 0;
  let count = 0;
  for (let y = 8; y < Math.min(40, image.height); y += 1) {
    for (let x = 8; x < Math.min(40, image.width); x += 1) {
      const index = (y * image.width + x) * 4;
      total += (image.data[index]! + image.data[index + 1]! + image.data[index + 2]!) / 3;
      count += 1;
    }
  }
  return count ? total / count : 0;
}

async function catalogMarkerPixelCount(page: Page): Promise<number> {
  return page.locator(".aladin-catalogCanvas").evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const context = canvas.getContext("2d");
    if (!context || !canvas.width || !canvas.height) return 0;
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const red = pixels[index]!;
      const green = pixels[index + 1]!;
      const blue = pixels[index + 2]!;
      if (red >= 180 && green >= 145 && blue <= 145 && red - blue >= 70) count += 1;
    }
    return count;
  });
}

function fragmentPoint(buffer: Buffer): { x: number; y: number } {
  const image = PNG.sync.read(buffer);
  const saturated = (x: number, y: number): boolean => {
    const index = (y * image.width + x) * 4;
    const channels = [image.data[index]!, image.data[index + 1]!, image.data[index + 2]!];
    return Math.max(...channels) > 70 && Math.max(...channels) - Math.min(...channels) > 30;
  };
  for (let y = 40; y < image.height - 40; y += 6) {
    for (let x = 40; x < image.width - 40; x += 6) {
      if (saturated(x, y) && saturated(x - 3, y) && saturated(x + 3, y) && saturated(x, y - 3) && saturated(x, y + 3)) return { x, y };
    }
  }
  throw new Error("No solid footprint fragment found in Canvas screenshot");
}

async function openFresh(page: Page, beforeGoto?: () => Promise<void>): Promise<void> {
  await proxyApi(page);
  await beforeGoto?.();
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("astro-workspace:theme:v1", "dark");
  });
  await page.reload();
  await expect(page.locator("#service-status")).toHaveText("SERVICE ONLINE");
  await expect(page.locator("#loading-indicator")).not.toHaveClass(/visible/);
  const layersMode = page.locator('button[data-mode="layers"]');
  if (!await layersMode.evaluate((button) => button.classList.contains("active"))) await layersMode.click();
  await expect(page.locator('button[data-mode="layers"]')).toHaveClass(/active/);
  await expect(page.locator("#loading-indicator")).not.toHaveClass(/visible/);
  await expect(page.locator("#scene-canvas")).toBeVisible();
  await page.waitForTimeout(900);
}

async function waitForVisibleAssetCoverage(page: Page): Promise<void> {
  const assetCards = page.locator("#sky-layer-list .workspace-asset-card");
  await expect(assetCards.first()).toBeVisible({ timeout: 15_000 });
  // Deployment data can contain acquired assets whose scans have failed or
  // have not run yet. Select a card backed by an actual coverage cell so the
  // Aladin tests exercise the MOC path instead of assuming fixture ordering.
  const candidateIndex = await assetCards.evaluateAll(async (cards) => {
    for (let index = 0; index < cards.length; index += 1) {
      const key = cards[index]?.getAttribute("data-layer-key") ?? "";
      const assetId = key.startsWith("asset:") ? key.slice("asset:".length) : "";
      if (!assetId) continue;
      try {
        const response = await fetch(`/api/sky/coverage?nside=16&assetIds=${encodeURIComponent(assetId)}`);
        if (!response.ok) continue;
        const payload = await response.json() as { pixels?: unknown; layers?: Array<{ pixels?: unknown }> };
        const hasPixels = (Array.isArray(payload.pixels) && payload.pixels.length > 0)
          || (Array.isArray(payload.layers) && payload.layers.some((layer) => Array.isArray(layer.pixels) && layer.pixels.length > 0));
        if (hasPixels) return index;
      } catch {
        // The next asset may still have a usable local or Warehouse MOC.
      }
    }
    return -1;
  });
  if (candidateIndex < 0) throw new Error("No user asset with non-empty coverage was returned by the Workspace API");
  const assetToggle = assetCards.nth(candidateIndex).locator("input[type='checkbox']");
  await expect(assetToggle).toBeVisible({ timeout: 15_000 });
  if (!await assetToggle.isChecked()) await assetToggle.check();
  await expect.poll(async () => page.locator("#scene-canvas").getAttribute("data-visible-asset-ids"), {
    timeout: 15_000,
  }).toMatch(/.+/);
}

async function mockRemoteCoverageApi(page: Page): Promise<{ assetId: string; requestBodies: Record<string, unknown>[] }> {
  const assetId = "user-e2e-remote-catalog";
  const connectorId = "connector-e2e-remote";
  const surveyId = "e2e-survey";
  const releaseId = "e2e-release-v1";
  const runId = "run-e2e-remote-coverage";
  const requestBodies: Record<string, unknown>[] = [];
  let coverageStatus: "ready" | "pending" = "ready";
  const asset = {
    id: assetId,
    name: "Remote E2E Catalog",
    description: "Deterministic remote coverage fixture",
    surveyId,
    releaseId,
    product: "Remote E2E Catalog",
    kind: "catalog",
    modalities: ["catalog"],
    access: { connector: "s3", uri: "s3://e2e/catalog", format: "csv", connectorId },
    accesses: [{ connector: "s3", uri: "s3://e2e/catalog", format: "csv", connectorId }],
    connectorIds: [connectorId],
    connectorLocationKeys: ["s3://e2e/catalog"],
    scanSpec: { format: "csv", objectIdColumn: "id", raColumn: "ra", decColumn: "dec", coordinateFrame: "ICRS", coordinateUnits: "deg", modality: "catalog", product: "Remote E2E Catalog" },
    status: "ready",
    projectState: "acquired",
    projectStates: ["acquired"],
    footprintIds: [],
    origin: "user",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const connector = {
    id: connectorId,
    locationKey: "s3://e2e/catalog",
    displayPath: "https://objects.example/e2e/catalog",
    name: "E2E S3 Connector",
    description: "Deterministic remote coverage fixture",
    kind: "s3",
    config: { bucket: "e2e", prefix: "catalog" },
    surveyId,
    releaseId,
    status: "ready",
    origin: "user",
    credentials: { accessKeyId: "fixture-access-key", secretConfigured: true },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const surveyCard = {
    id: surveyId,
    name: "E2E Survey",
    mission: "E2E",
    color: "#45d7c6",
    description: "Deterministic remote coverage fixture",
    modalities: ["catalog"],
    origin: "user",
    releaseCount: 1,
    availableReleaseCount: 1,
    verifiedFootprintReleaseCount: 0,
    coverageStatus: "pending",
  };
  const surveyRecord = {
    ...surveyCard,
    releases: [{
      id: releaseId,
      label: "E2E Release v1",
      kind: "quick_release",
      availability: "available",
      modalities: ["catalog"],
      products: [{ name: "Remote E2E Catalog", modality: "catalog", description: "Fixture" }],
      coverage: { status: "pending", summary: "Fixture", sourceUrl: "https://example.test/e2e" },
    }],
  };
  const run = {
    id: runId,
    locationKey: connector.locationKey,
    connectorId,
    connectorName: connector.name,
    connectorKind: "s3",
    executor: "warehouse",
    backend: "warehouse",
    taskKind: "user_coverage",
    assetId,
    assetIds: [assetId],
    status: "queued",
    startedAt: "2026-08-27T00:00:00.000Z",
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
    mocStatus: "pending",
  };
  const footprintManifest = { schemaVersion: 1, generatedAt: "2026-01-01T00:00:00.000Z", coordinateFrame: "ICRS", nside: 16, footprints: [] };

  await page.route("**/api/capabilities", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      dataWarehouse: { enabled: true, configured: true, namespace: "e2e", layerIndex: "ast_layer_index_v1", coverageIndex: "ast_coverage_index_v1" },
      userMocs: { rootConfigured: true, count: 0 },
      localScan: { enabled: true, configured: true, executor: "local-csv", objectIndex: "astro_object_index_v1", coverageIndex: "astro_coverage_index_v1" },
      metadataStore: { engine: "sqlite" },
    }) });
  });
  await page.route("**/api/data-assets", async (route) => {
    if (route.request().method() === "GET") await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ assets: [asset] }) });
    else await route.fallback();
  });
  await page.route("**/api/data-assets/*/remote-scan", async (route) => {
    requestBodies.push((route.request().postDataJSON() ?? {}) as Record<string, unknown>);
    coverageStatus = "pending";
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ run }) });
  });
  await page.route("**/api/surveys", async (route) => {
    if (route.request().method() === "GET") await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ surveys: [surveyCard] }) });
    else await route.fallback();
  });
  await page.route(`**/api/surveys/${surveyId}`, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ survey: surveyRecord }) });
  });
  await page.route("**/api/public-surveys", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ surveys: [] }) });
  });
  await page.route("**/api/survey-footprints", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(footprintManifest) });
  });
  await page.route("**/api/resource-packages/config", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ config: { catalogUrl: "https://example.test/catalog.json", available: true } }) });
  });
  await page.route("**/api/connectors", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ connectors: [connector] }) });
  });
  await page.route("**/api/user-mocs", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ artifacts: [] }) });
  });
  await page.route("**/api/connector-ingest-runs**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runs: coverageStatus === "pending" ? [run] : [] }) });
  });
  await page.route("**/api/sky/coverage**", async (route) => {
    const pending = coverageStatus === "pending";
    const layer = {
      key: `asset:${assetId}`,
      layerId: `workspace-${assetId}`,
      assetId,
      assetIds: [assetId],
      assetName: asset.name,
      surveyId,
      releaseId,
      pixels: pending ? [] : [0, 1],
      byAsset: [{ key: assetId, label: asset.name, files: 1, bytes: 1, objects: 2, objectCount: 2 }],
      status: pending ? "pending" : "ready",
      source: "asset",
      nside: 16,
      availableOrders: [8],
      nativeOrders: [8],
      precision: "exact",
      coverageRole: "object_presence",
    };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: pending ? "pending" : "ready", index: "astro_coverage_index_v1", nside: 16, pixels: layer.pixels, byAsset: layer.byAsset, layers: [layer] }) });
  });

  return { assetId, requestBodies };
}

test("remote coverage submission keeps credentials server-side and shows a pending user MOC", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  let fixture: Awaited<ReturnType<typeof mockRemoteCoverageApi>>;
  await openFresh(page, async () => {
    fixture = await mockRemoteCoverageApi(page);
  });

  const assetCard = page.locator("#sky-layer-list .workspace-asset-card").first();
  await expect(assetCard).toContainText("Remote E2E Catalog");
  await assetCard.locator(".survey-card-body").click();
  const remoteButton = page.locator("#inspector-content .command-button", { hasText: "提交远程覆盖扫描" });
  await expect(remoteButton).toBeVisible();
  await remoteButton.click();

  const dialog = page.locator("#remote-coverage-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("#remote-coverage-survey")).toHaveValue("e2e-survey");
  await expect(dialog.locator("#remote-coverage-release")).toHaveValue("e2e-release-v1");
  await expect(dialog.locator("#remote-coverage-connector")).toHaveValue("connector-e2e-remote");
  await dialog.locator("#remote-coverage-form-submit").click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => fixture!.requestBodies.length, { timeout: 5_000 }).toBe(1);

  const body = fixture!.requestBodies[0]!;
  expect(body).toMatchObject({
    surveyId: "e2e-survey",
    connectorId: "connector-e2e-remote",
    releaseId: "e2e-release-v1",
    product: "Remote E2E Catalog",
    coverage: {
      mode: "catalog-radec",
      coordinateFrame: "ICRS",
      coordinateUnits: "deg",
      coverageRole: "object_presence",
      dataOrigin: "catalog",
      sourceTier: "user_file_derived",
      maxOrder: 10,
      queryOrder: 8,
      previewOrder: 4,
      raColumn: "ra",
      decColumn: "dec",
    },
  });
  expect(JSON.stringify(body)).not.toMatch(/accessKeyId|secretAccessKey|sessionToken|fixture-access-key/);
  await expect(page.locator("#workspace-notification-deck")).toContainText("远程覆盖扫描已提交");
  await expect(page.locator("#sky-layer-list .workspace-asset-card").first()).toContainText(/PENDING|处理中/);
  await expect(page.locator("#inspector-content")).toContainText("覆盖状态处理中", { timeout: 10_000 });
});

test("unified sky layer stack lists each user asset with its own visibility control", async ({ page }) => {
  const { assets } = await apiJson<{ assets: Array<{ id: string; name: string }> }>("/api/data-assets");
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFresh(page);

  const assetCards = page.locator("#sky-layer-list .workspace-asset-card");
  await expect(assetCards).toHaveCount(assets.length, { timeout: 15_000 });
  await expect(page.locator("#workspace-asset-list")).toHaveCount(0);
  await expect(page.locator("#survey-list")).toHaveCount(0);
  if (assets.length > 0) {
    const first = assetCards.first();
    const checkbox = first.locator('input[type="checkbox"]');
    const initiallyChecked = await checkbox.isChecked();
    if (initiallyChecked) {
      await checkbox.uncheck();
    } else {
      await checkbox.check();
    }
    await expect(checkbox).toBeChecked({ checked: !initiallyChecked });
    await first.locator(".survey-card-body").click();
    await expect(page.locator("#inspector-content")).toContainText(assets[0]!.name);
  }
});

test("sky layers default to radial depth and G toggles transient overlap", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFresh(page);

  const assetLabels = await page.locator("#sky-layer-list .workspace-asset-card .survey-card-body").allTextContents();
  expect(assetLabels.every((label) => !/user[-_][a-z0-9-]+/i.test(label))).toBe(true);
  await expect(page.locator("#sky-layer-list")).not.toContainText("COSMOS Custom Catalog");
  await expect(page.locator("#sky-layer-list")).toContainText("COSMOS");

  await expect(page.locator("#scene-canvas")).toHaveAttribute("data-layout-mode", "layers");
  await page.keyboard.press("g");
  await expect(page.locator("#scene-canvas")).toHaveAttribute("data-layout-mode", "overlap");
  await page.keyboard.press("g");
  await expect(page.locator("#scene-canvas")).toHaveAttribute("data-layout-mode", "layers");
});

test("sky layer order persists and drives the Three display depth", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFresh(page);

  const cards = page.locator("#sky-layer-list .survey-card");
  await expect.poll(() => cards.count()).toBeGreaterThan(0);
  if (await cards.count() < 2) return;

  const firstKey = await cards.nth(0).getAttribute("data-layer-key");
  const secondKey = await cards.nth(1).getAttribute("data-layer-key");
  await expect(cards.nth(0).locator(".layer-reorder-actions")).toHaveCount(0);
  const handle = cards.nth(0).locator(".layer-drag-handle");
  await expect(handle).toHaveCount(1);
  await handle.focus();
  await page.keyboard.press("Alt+ArrowDown");
  await expect(cards.nth(0)).toHaveAttribute("data-layer-key", secondKey!);
  await expect(cards.nth(1)).toHaveAttribute("data-layer-key", firstKey!);
  await expect(page.locator("#scene-canvas")).toHaveAttribute("data-layer-order", new RegExp(`^${secondKey},${firstKey}`));

  await page.reload();
  await expect(page.locator("#service-status")).toHaveText("SERVICE ONLINE");
  await expect(page.locator("#sky-layer-list .survey-card").nth(0)).toHaveAttribute("data-layer-key", secondKey!);
});

test("light theme switches the 3D sky to a soft observation canvas", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("astro-workspace:theme:v1", "dark");
  });
  await proxyApi(page);
  await page.goto("/");
  await expect(page.locator("#service-status")).toHaveText("SERVICE ONLINE");
  await page.locator('button[data-mode="layers"]').click();
  const canvas = page.locator("#scene-canvas");
  await expect(canvas).toBeVisible();
  await page.waitForTimeout(500);
  const darkBrightness = averagePixelBrightness(await canvas.screenshot());
  await page.locator("#theme-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.waitForTimeout(250);
  const lightBrightness = averagePixelBrightness(await canvas.screenshot());
  expect(lightBrightness).toBeGreaterThan(darkBrightness + 80);
  await expect(canvas).toHaveAttribute("data-theme", "light");
});

async function findCanvasPoint(
  page: Page,
  predicate: (state: { pixel: number; covered: boolean; selectable: boolean; assetIds: string[] }) => boolean,
  options: { requireAsset?: boolean; excludePixels?: readonly number[] } = {},
): Promise<{ x: number; y: number; pixel: number }> {
  const hits = await page.evaluate(({ requireAsset, excludePixels }) => {
    const canvas = document.querySelector<HTMLCanvasElement>("#scene-canvas");
    if (!canvas) return [];
    const rect = canvas.getBoundingClientRect();
    const excluded = new Set(excludePixels);
    const step = 16;
    for (let y = 8; y < rect.height - 8; y += step) {
      for (let x = 8; x < rect.width - 8; x += step) {
        const clientX = rect.left + x;
        const clientY = rect.top + y;
        canvas.dispatchEvent(new PointerEvent("pointermove", {
          bubbles: true,
          clientX,
          clientY,
          pointerId: 1,
          pointerType: "mouse",
          buttons: 0,
        }));
        const rawPixel = canvas.dataset.hoveredPixel;
        const pixel = Number(rawPixel);
        if (!rawPixel || !Number.isInteger(pixel)) continue;
        const state = {
          x,
          y,
          pixel,
          covered: canvas.dataset.hoveredCovered === "true",
          selectable: canvas.dataset.hoveredSelectable === "true",
          assetIds: (canvas.dataset.hoveredAssetIds ?? "").split(",").filter(Boolean),
        };
        if (state.covered && state.selectable && (!requireAsset || state.assetIds.length > 0) && !excluded.has(pixel)) return [state];
      }
    }
    return [];
  }, { requireAsset: options.requireAsset ?? false, excludePixels: options.excludePixels ?? [] });
  const match = hits.find(predicate);
  if (match) return { x: match.x, y: match.y, pixel: match.pixel };
  throw new Error("No matching HEALPix point found on the visible hemisphere");
}

async function findSelectedCanvasPoint(page: Page, pixel: number): Promise<{ x: number; y: number; pixel: number }> {
  const match = await page.evaluate((selectedPixel) => {
    const canvas = document.querySelector<HTMLCanvasElement>("#scene-canvas");
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const bounds = (canvas.dataset.selectionBounds ?? "").split(",").map(Number);
    const [leftRatio = 0, rightRatio = 1, topRatio = 0, bottomRatio = 1] = bounds;
    const hasBounds = bounds.length === 4 && bounds.every(Number.isFinite);
    const left = hasBounds ? Math.max(0, Math.floor(leftRatio * rect.width) - 24) : 0;
    const right = hasBounds ? Math.min(rect.width, Math.ceil(rightRatio * rect.width) + 24) : rect.width;
    const top = hasBounds ? Math.max(0, Math.floor(topRatio * rect.height) - 24) : 0;
    const bottom = hasBounds ? Math.min(rect.height, Math.ceil(bottomRatio * rect.height) + 24) : rect.height;
    const step = 4;
    for (let y = top; y <= bottom; y += step) {
      for (let x = left; x <= right; x += step) {
        canvas.dispatchEvent(new PointerEvent("pointermove", {
          bubbles: true,
          clientX: rect.left + x,
          clientY: rect.top + y,
          pointerId: 1,
          pointerType: "mouse",
          buttons: 0,
        }));
        if (Number(canvas.dataset.hoveredPixel) === selectedPixel && canvas.dataset.hoveredCovered === "true" && canvas.dataset.hoveredSelectable === "true") {
          return { x, y, pixel: selectedPixel };
        }
      }
    }
    return null;
  }, pixel);
  if (match) return match;
  const diagnostics = await page.locator("#scene-canvas").evaluate((canvas) => ({
    selectedPixels: canvas.getAttribute("data-selected-pixels"),
    selectionBounds: canvas.getAttribute("data-selection-bounds"),
    cameraPosition: canvas.getAttribute("data-camera-position"),
    cameraDistance: canvas.getAttribute("data-camera-distance"),
    hoveredPixel: canvas.getAttribute("data-hovered-pixel"),
    hoveredCovered: canvas.getAttribute("data-hovered-covered"),
  }));
  throw new Error(`No selected HEALPix point found after focus: ${JSON.stringify(diagnostics)}`);
}

test("project status remains available without legacy scene resources", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => localStorage.clear());
  await proxyApi(page);
  await page.goto("/");
  await expect(page.locator("#service-status")).toHaveText("SERVICE ONLINE");
  await page.locator('button[data-mode="layers"]').click();
  await expect(page.locator('button[data-mode="layers"]')).toHaveClass(/active/);
  await expect(page.locator("#scene-canvas")).toBeVisible();
  await expect(page.locator("#loading-indicator")).not.toHaveClass(/visible/);
});

test("keeps a public Assets MOC and a user MOC on one ICRS/NESTED cell", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const publicSurveyId = "assets-fixture";
  const publicReleaseId = "assets-fixture-release";
  const userAssetId = "user-moc-fixture";
  const artifactId = "derived-user-moc-fixture";
  const objectRequests: Array<Record<string, any>> = [];
  const publicSurvey = {
    id: publicSurveyId,
    name: "Public Assets Fixture",
    mission: "Assets",
    color: "#45d7c6",
    description: "Deterministic public Assets MOC fixture",
    modalities: ["catalog"],
    origin: "public",
    releaseCount: 1,
    availableReleaseCount: 1,
    verifiedFootprintReleaseCount: 1,
    coverageStatus: "verified",
  };
  const publicRecord = {
    ...publicSurvey,
    releases: [{
      id: publicReleaseId,
      label: "Assets Fixture Release",
      kind: "public_release",
      availability: "available",
      modalities: ["catalog"],
      products: [{ name: "Assets Public MOC", modality: "catalog", description: "Fixture" }],
      coverage: { status: "verified", summary: "Fixture MOC", sourceUrl: "https://assets.example.test/fixture" },
    }],
  };
  const asset = {
    id: userAssetId,
    name: "User MOC Fixture",
    description: "Deterministic user MOC fixture",
    product: "User MOC Fixture",
    kind: "catalog",
    modalities: ["catalog"],
    access: { connector: "local", uri: "file:///fixture/catalog", format: "csv" },
    connectorIds: [],
    connectorLocationKeys: [],
    status: "ready",
    projectState: "acquired",
    footprintIds: [],
    origin: "user",
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
  };
  const mocLayer = {
    key: `moc:${artifactId}`,
    layerId: "derived-user-moc-layer",
    artifactId,
    productId: "User MOC Fixture",
    modality: "catalog",
    source: "asset",
    status: "ready",
    mocStatus: "ready",
    coverageRole: "object_presence",
    precision: "exact",
    nside: 16,
    availableOrders: [8],
    nativeOrders: [8],
    maxOrder: 8,
    pixels: [0],
    assetIds: [userAssetId],
    byAsset: [{ key: userAssetId, assetId: userAssetId, objectCount: 1 }],
  };
  await openFresh(page, async () => {
    await page.route("**/api/capabilities", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        dataWarehouse: { enabled: false, configured: false },
        userMocs: { rootConfigured: true, count: 1 },
        localScan: { enabled: true, configured: true, executor: "local-csv", objectIndex: "astro_object_index_v1", coverageIndex: "astro_coverage_index_v1" },
        metadataStore: { engine: "sqlite" },
      }) });
    });
    await page.route("**/api/data-assets", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ assets: [asset] }) });
    });
    await page.route("**/api/surveys", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ surveys: [] }) });
    });
    await page.route("**/api/public-surveys", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ surveys: [publicSurvey] }) });
    });
    await page.route(`**/api/public-surveys/${publicSurveyId}`, async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ survey: publicRecord }) });
    });
    await page.route("**/api/survey-footprints", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        schemaVersion: 1,
        generatedAt: "2026-08-27T00:00:00.000Z",
        coordinateFrame: "ICRS",
        nside: 16,
        footprints: [{
          surveyId: publicSurveyId,
          releaseId: publicReleaseId,
          product: "Assets Public MOC",
          label: "Assets Fixture MOC",
          nside: 16,
          pixels: [0],
          quality: "moc",
          sourceUrl: "https://assets.example.test/fixture",
          retrievedAt: "2026-08-27T00:00:00.000Z",
          notes: "Deterministic public Assets MOC fixture",
        }],
      }) });
    });
    await page.route("**/api/resource-packages/config", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ config: { catalogUrl: "", available: false, adminConfigured: false } }) });
    });
    await page.route("**/api/connectors", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ connectors: [] }) });
    });
    await page.route("**/api/user-mocs", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ artifacts: [{
        id: artifactId,
        layerId: "derived-user-moc-layer",
        scanRunId: "scan-user-moc-fixture",
        status: "ready",
        availableOrders: [8],
        maxOrder: 8,
        precision: "exact",
        coverageRole: "object_presence",
        files: [{ name: "moc.fits", mediaType: "application/fits", byteLength: 2880, sha256: "a".repeat(64) }],
        createdAt: "2026-08-27T00:00:00.000Z",
        updatedAt: "2026-08-27T00:00:00.000Z",
      }] }) });
    });
    await page.route("**/api/sky/coverage**", async (route) => {
      const requestUrl = new URL(route.request().url());
      const assetIds = (requestUrl.searchParams.get("assetIds") ?? "").split(",").filter(Boolean);
      if (assetIds.length) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
          status: "ready",
          index: "astro_coverage_index_v1",
          nside: 16,
          pixels: [],
          byAsset: [],
          layers: [{ key: `asset:${userAssetId}`, layerId: `workspace-${userAssetId}`, assetId: userAssetId, assetIds, assetName: asset.name, status: "ready", source: "asset", nside: 16, pixels: [], byAsset: [] }],
        }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        status: "ready",
        index: "astro_coverage_index_v1",
        nside: 16,
        pixels: [0],
        byAsset: [],
        layers: [mocLayer],
      }) });
    });
    await page.route("**/api/sky/objects/query", async (route) => {
      const body = (route.request().postDataJSON() ?? {}) as Record<string, any>;
      objectRequests.push(body);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        status: "ready",
        index: "astro_object_index_v1",
        objects: [{ object_id: "fixture-object", ra_deg: 45, dec_deg: 2.39049, survey: publicSurveyId, release: publicReleaseId, product: "User MOC Fixture", modality: "catalog", asset_id: userAssetId }],
        total: 1,
        limit: 1000,
      }) });
    });
  });

  const canvas = page.locator("#scene-canvas");
  const mocCard = page.locator("#sky-layer-list .workspace-extra-card");
  await expect(mocCard).toContainText("MOC · User MOC Fixture");
  await expect(mocCard.locator("input[type='checkbox']")).toBeChecked();
  await expect(canvas).toHaveAttribute("data-visible-workspace-layer-keys", `moc:${artifactId}`);
  const overview = await canvas.screenshot({ path: testInfo.outputPath("public-user-moc-overview.png") });
  expect(fragmentPixelCount(overview)).toBeGreaterThan(100);

  const point = await findCanvasPoint(page, (state) => state.pixel === 0 && state.covered && state.selectable);
  await canvas.click({ position: point });
  await expect(canvas).toHaveAttribute("data-exploded-pixel", "0");
  await expect.poll(async () => Number(await canvas.getAttribute("data-exploded-layer-count")), { timeout: 3_000 }).toBeGreaterThan(1);
  await canvas.screenshot({ path: testInfo.outputPath("public-user-moc-selected.png") });
  await expect(page.locator("#inspector-content")).toContainText("Public Assets Fixture");
  await expect(page.locator("#inspector-content .coverage-workspace-layer")).toContainText("USER ASSET");
  await expect(page.locator("#inspector-content .coverage-workspace-layer")).toContainText("User MOC Fixture");
  const sphereCenter = await page.locator("#inspector-content .coverage-location small").textContent();
  const centerMatch = /Cell center ([+-]?\d+(?:\.\d+)?)°,[ ]*([+-]?\d+(?:\.\d+)?)°/.exec(sphereCenter ?? "");
  expect(centerMatch).not.toBeNull();

  await canvas.click({ button: "right", position: point });
  await page.locator("#coverage-enter-flat").click();
  const aladin = page.locator("#aladin-explorer");
  await expect(aladin).toBeVisible();
  await expect(aladin).toHaveAttribute("data-nside", "16");
  await expect(aladin).toHaveAttribute("data-pixels", "0");
  await expect.poll(() => objectRequests.length, { timeout: 15_000 }).toBeGreaterThan(0);
  expect(objectRequests[0]!.region).toMatchObject({ nside: 16, pixels: [0], ordering: "NESTED", coordinateFrame: "ICRS" });
  const aladinRa = Number(await aladin.getAttribute("data-center-ra-deg"));
  const aladinDec = Number(await aladin.getAttribute("data-center-dec-deg"));
  expect(Math.abs(aladinRa - Number(centerMatch![1]))).toBeLessThan(0.001);
  expect(Math.abs(aladinDec - Number(centerMatch![2]))).toBeLessThan(0.001);
});

test("sphere selection enters Aladin with an exact region snapshot", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const objectRequests: Array<{ assetIds?: string[]; surveyIds?: string[]; releaseIds?: string[]; region?: { nside?: number; pixels?: number[]; ordering?: string; coordinateFrame?: string }; bbox?: { raMin?: number; raMax?: number; decMin?: number; decMax?: number }; includeAttributes?: boolean }> = [];
  await openFresh(page, async () => {
    await page.route("**/api/sky/objects/query", async (route) => {
      const body = route.request().postDataJSON() as typeof objectRequests[number];
      objectRequests.push(body);
      const bbox = body.bbox ?? { raMin: 0, raMax: 1, decMin: 0, decMax: 1 };
      const ra = ((Number(bbox.raMin ?? 0) + Number(bbox.raMax ?? 0)) / 2) % 360;
      const dec = (Number(bbox.decMin ?? 0) + Number(bbox.decMax ?? 0)) / 2;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: "ready",
          index: "astro_object_index_v1",
          objects: [{
            object_id: "e2e-aladin-object",
            ra_deg: ra,
            dec_deg: dec,
            survey: "cosmos-custom",
            release: "cosmos-custom-v1",
            product: "COSMOS",
            modality: "catalog",
            asset_id: "user-12b69893-1a68-4b20-81dd-fb1ddca31953",
          }],
          total: 1,
          limit: 1000,
        }),
      });
    });
  });
  const canvas = page.locator("#scene-canvas");
  await expect(page.locator("#coverage-context-menu")).toHaveCount(1);
  await expect(page.locator("#coverage-lock-button")).toHaveCount(0);
  await expect(page.locator("#refinement-controls")).toHaveCount(0);
  await expect(page.locator('[data-action="search-region"]')).toHaveCount(0);
  await waitForVisibleAssetCoverage(page);

  const before = await canvas.screenshot({ path: testInfo.outputPath("sphere-overview.png") });
  expect(fragmentPixelCount(before)).toBeGreaterThan(1_000);
  const point = await findCanvasPoint(page, (state) => state.covered && state.selectable && state.assetIds.length > 0, { requireAsset: true });
  await canvas.click({ position: point });
  await expect(page.locator("#layer-selection-count")).toHaveText("1 CELLS");
  await expect(canvas).toHaveAttribute("data-selection-volume", "outline");
  await expect(canvas).toHaveAttribute("data-selection-depth-radii", /.+/);
  await expect(canvas).toHaveAttribute("data-selection-edge-layers", /[1-9]/);
  const selectedPixels = await canvas.getAttribute("data-selected-pixels");
  expect(selectedPixels).toBeTruthy();
  const cameraBeforeFocus = await canvas.getAttribute("data-camera-position");
  await page.keyboard.press("f");
  await expect.poll(async () => canvas.getAttribute("data-camera-position"), { timeout: 3_000 })
    .not.toBe(cameraBeforeFocus);
  const focusedDistance = Number(await canvas.getAttribute("data-camera-distance"));
  const outerRadius = Number(await canvas.getAttribute("data-outer-radius"));
  expect(focusedDistance / outerRadius).toBeLessThan(2.05);
  await expect(canvas).toHaveAttribute("data-selected-pixels", selectedPixels!);
  const selectionTooltip = page.locator("#region-scene-legend");
  await expect(selectionTooltip).toBeVisible();
  await expect.poll(async () => selectionTooltip.getAttribute("data-placement"), { timeout: 3_000 }).toMatch(/right|left|above|below/);
  expect(await selectionTooltip.evaluate((element) => element.getBoundingClientRect().width)).toBeLessThanOrEqual(220);
  await page.locator("#reset-button").click();
  await expect(canvas).toHaveAttribute("data-selected-pixels", selectedPixels!);
  await expect(canvas).toHaveAttribute("data-selection-volume", "outline");

  // Reset changes the camera framing and may put the selected cell on the far
  // side of the sphere. Focus it again, then locate it in the current view.
  await page.keyboard.press("f");
  await page.waitForTimeout(800);
  const resetPoint = await findSelectedCanvasPoint(page, Number(selectedPixels));
  await canvas.click({ button: "right", position: resetPoint });
  await expect(page.locator("#coverage-context-menu")).toBeVisible();
  await expect(page.locator("#coverage-hover")).toBeHidden();
  await expect(page.locator("#coverage-enter-flat")).toHaveText("在 Aladin 中探索");
  await page.locator("#coverage-enter-flat").click();
  const aladin = page.locator("#aladin-explorer");
  await expect(aladin).toBeVisible();
  await expect(page.locator("#aladin-controls")).toBeVisible();
  await expect(page.locator("#aladin-cockpit-rail")).toBeVisible();
  await expect(page.locator(".aladin-sector-banner")).toHaveCount(0);
  await expect(page.locator("#aladin-asset-drawer-toggle")).toBeVisible();
  await expect(page.locator(".aladin-hud-reticle, .aladin-telemetry, .aladin-action-rail, #aladin-asset-drawer-pin")).toHaveCount(0);
  await expect(page.locator("#aladin-loaded-summary")).toBeVisible();
  await expect(page.locator("#aladin-cache-state")).toContainText(/CACHE|FETCH/);
  await expect(page.locator("#aladin-fullscreen")).toBeVisible();
  await expect(page.locator("#scene-camera-readout")).toBeHidden();
  await expect(page.locator("#scene-mode-label")).toHaveText("OBJECT EXPLORE");
  await expect(page.locator("#scene-mode-value")).toHaveText("ALT/AZ");
  await expect(page.locator("#scene-coordinate-readout")).toBeVisible();
  await expect(page.locator("#aladin-coordinate-form, #aladin-ra, #aladin-dec, #aladin-fov, #aladin-go")).toHaveCount(0);
  await expect(page.locator("#aladin-asset-nav .aladin-asset-button")).toHaveCount(1);
  await expect(page.locator(".aladin-location")).toBeHidden();
  await expect(page.locator(".aladin-fov")).toBeHidden();
  await expect(page.locator(".aladin-status-bar")).toBeHidden();
  await expect(canvas).toBeHidden();
  await expect(aladin).toHaveAttribute("data-scene-kind", "aladin");
  await expect(aladin).toHaveAttribute("data-nside", "16");
  await expect(aladin).toHaveAttribute("data-pixels", selectedPixels!);
  await expect(aladin).toHaveAttribute("data-initial-fov-deg");
  await expect(aladin).toHaveAttribute("data-image-survey-id", "2mass");
  await page.locator("#scene-background-settings").click();
  await expect(page.locator("#scene-image-survey-controls")).toBeVisible();
  await expect(page.locator("#scene-background-color-controls")).toBeHidden();
  await expect(page.locator('[data-aladin-survey="2mass"]')).toHaveClass(/active/);
  await page.locator('[data-aladin-survey="allwise"]').click();
  await expect(aladin).toHaveAttribute("data-image-survey-id", "allwise");
  await expect(page.locator('[data-aladin-survey="allwise"]')).toHaveClass(/active/);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("astro-workspace:aladin-image-survey:v1"))).toBe("allwise");
  await page.locator("#scene-background-close").click();
  await expect.poll(() => objectRequests.length, { timeout: 15_000 }).toBeGreaterThan(0);
  expect(objectRequests[0]!.region?.nside).toBe(16);
  expect(objectRequests[0]!.region?.pixels).toEqual(selectedPixels!.split(",").map(Number));
  expect(objectRequests[0]!.region?.ordering).toBe("NESTED");
  expect(objectRequests[0]!.region?.coordinateFrame).toBe("ICRS");
  expect(objectRequests[0]!.includeAttributes).toBe(false);
  expect(objectRequests.every((request) => request.assetIds?.length === 1)).toBe(true);
  expect(objectRequests.every((request) => request.surveyIds === undefined && request.releaseIds === undefined)).toBe(true);
  await expect(page.locator("#object-status")).toContainText("OBJECTS");
  await expect.poll(() => catalogMarkerPixelCount(page), { timeout: 10_000 }).toBeGreaterThan(0);
  const catalogCanvas = page.locator(".aladin-catalogCanvas").last();
  const marker = await catalogCanvas.evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const context = canvas.getContext("2d");
    if (!context) return null;
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let index = 0; index < pixels.length; index += 4) {
      const alpha = pixels[index + 3]!;
      const red = pixels[index]!;
      const green = pixels[index + 1]!;
      const blue = pixels[index + 2]!;
      if (alpha > 150 && Math.max(red, green, blue) - Math.min(red, green, blue) > 35) {
        return { x: (index / 4) % canvas.width, y: Math.floor(index / 4 / canvas.width) };
      }
    }
    return null;
  });
  expect(marker).not.toBeNull();
  const box = await catalogCanvas.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box!.x + marker!.x, box!.y + marker!.y);
  await expect(page.locator("#inspector-panel")).toHaveClass(/aladin-object-selected/);
  await expect(page.locator("#inspector-content")).toContainText("e2e-aladin-object");
  await page.locator("#aladin-fullscreen").click();
  await expect(page.locator("#scene-stage")).toHaveAttribute("data-fullscreen", "true");
  await page.locator("#aladin-fullscreen").click();
  await expect(page.locator("#scene-stage")).toHaveAttribute("data-fullscreen", "false");
  await expect(page.locator("#coverage-context-menu")).toBeHidden();

  await page.locator("#drill-back-button").click();
  await expect(aladin).toBeHidden();
  await expect(canvas).toBeVisible();
  await expect(page.locator("#layer-selection-count")).toHaveText("NO CELL");
  await page.screenshot({ path: testInfo.outputPath("aladin-explorer.png"), fullPage: true });
});

test("Escape exits Aladin even when a layer control has focus", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFresh(page);
  const canvas = page.locator("#scene-canvas");
  const point = await findCanvasPoint(page, (state) => state.covered && state.selectable);
  await canvas.click({ position: point });
  await canvas.click({ button: "right", position: point });
  await page.locator("#coverage-enter-flat").click();
  await expect(page.locator("#aladin-explorer")).toBeVisible();

  const layerControl = page.locator("#sky-layer-list input[type='checkbox']").first();
  await layerControl.focus();
  await page.keyboard.press("Escape");

  await expect(page.locator("#aladin-explorer")).toBeHidden();
  await expect(canvas).toBeVisible();
  await expect(page.locator("#layer-selection-count")).toHaveText("NO CELL");
});

test("main sky supports Ctrl selection across density cells", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFresh(page);
  const canvas = page.locator("#scene-canvas");
  const first = await findCanvasPoint(page, (state) => state.covered && state.selectable);
  await canvas.click({ position: first });
  await expect(page.locator("#layer-selection-count")).toHaveText("1 CELLS");
  const second = await findCanvasPoint(page, (state) => state.covered && state.selectable && state.pixel !== first.pixel, { excludePixels: [first.pixel] });
  await canvas.click({ position: second, modifiers: ["Control"] });
  await expect(page.locator("#layer-selection-count")).toHaveText("2 CELLS");
  await canvas.click({ position: first, modifiers: ["Control"] });
  await expect(page.locator("#layer-selection-count")).toHaveText("1 CELLS");
  await page.screenshot({ path: testInfo.outputPath("ctrl-density-selection.png"), fullPage: true });
});

test("Aladin queries the current RA/Dec viewport for lightweight objects", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const requests: Array<{
    assetIds?: string[];
    surveyIds?: string[];
    releaseIds?: string[];
    cursor?: unknown[];
    region?: { ordering?: string; coordinateFrame?: string };
    bbox?: { raMin?: number; raMax?: number; decMin?: number; decMax?: number };
    includeAttributes?: boolean;
    limit?: number;
  }> = [];
  await openFresh(page, async () => {
    await page.route("**/api/sky/objects/query", async (route) => {
      const body = route.request().postDataJSON() as typeof requests[number];
      requests.push(body);
       const pageNumber = body.bbox ? (body.cursor ? 2 : 1) : 0;
       const objects = body.bbox
         ? Array.from({ length: 1000 }, (_, index) => ({
           object_id: `viewport-object-${(pageNumber - 1) * 1000 + index}`,
           ra_deg: 150.1 + (index % 20) / 1000,
           dec_deg: 2.2 + (index % 20) / 1000,
           survey: "cosmos-custom",
           release: "cosmos-custom-v1",
           product: "COSMOS",
           modality: "catalog",
           asset_id: "user-12b69893-1a68-4b20-81dd-fb1ddca31953",
         }))
          : [{ object_id: "viewport-object-0", ra_deg: 150.1, dec_deg: 2.2, survey: "cosmos-custom", release: "cosmos-custom-v1", product: "COSMOS", modality: "catalog", asset_id: "user-12b69893-1a68-4b20-81dd-fb1ddca31953" }];
       await route.fulfill({
         status: 200,
         contentType: "application/json",
         body: JSON.stringify({
           status: "ready",
           index: "astro_object_index_v1",
            objects,
            total: body.bbox ? 2000 : 1,
            limit: 1000,
            ...(body.bbox && !body.cursor ? { nextCursor: ["viewport-page-2"] } : {}),
         }),
      });
    });
  });
  const canvas = page.locator("#scene-canvas");
  await waitForVisibleAssetCoverage(page);
  const point = await findCanvasPoint(page, (state) => state.covered && state.selectable && state.assetIds.length > 0, { requireAsset: true });
  await canvas.click({ position: point, modifiers: ["Control"] });
  await canvas.click({ button: "right", position: point });
  await page.locator("#coverage-enter-flat").click();
  await expect(page.locator("#aladin-explorer")).toBeVisible();
  await expect.poll(() => requests.length, { timeout: 15_000 }).toBeGreaterThan(0);
  await expect(page.locator("#aladin-asset-nav .aladin-asset-button")).toHaveCount(1);
  await expect(page.locator("#aladin-explorer")).toHaveAttribute("data-object-returned", "2000", { timeout: 15_000 });
  await expect(page.locator("#workspace-notification-deck .workspace-notification").filter({ hasText: "2,000 个对象已载入" })).toBeVisible();
  expect(requests[0]!.region?.ordering).toBe("NESTED");
  expect(requests[0]!.region?.coordinateFrame).toBe("ICRS");
  expect(requests[0]!.includeAttributes).toBe(false);
   expect(requests.some((request) => request.limit === 1000)).toBe(true);
   expect(requests.some((request) => JSON.stringify(request.cursor) === JSON.stringify(["viewport-page-2"]))).toBe(true);
  await expect(page.locator("#aladin-explorer")).toHaveAttribute("data-object-complete", "true");
   await expect(page.locator("#aladin-explorer")).toHaveAttribute("data-catalog-colors", /.+/);
  expect(requests.every((request) => request.assetIds?.length === 1)).toBe(true);
  expect(requests.every((request) => request.surveyIds === undefined && request.releaseIds === undefined)).toBe(true);
   await expect(page.locator("#object-status")).toContainText("2,000 / 2,000 OBJECTS");
  await expect(page.locator("#aladin-asset-nav .aladin-asset-button").first()).toBeVisible();
});

test("Aladin entry returns to the sphere with Escape", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFresh(page);
  const canvas = page.locator("#scene-canvas");
  await waitForVisibleAssetCoverage(page);
  const point = await findCanvasPoint(page, (state) => state.covered && state.selectable && state.assetIds.length > 0, { requireAsset: true });
  await canvas.click({ position: point });
  await canvas.click({ button: "right", position: point });
  await page.locator("#coverage-enter-flat").click();
  await expect(page.locator("#aladin-explorer")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#aladin-explorer")).toBeHidden();
  await expect(canvas).toBeVisible();
});

test("mobile controls keep the sphere free of legacy tool controls", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openFresh(page);
  await page.locator("#controls-toggle").click();
  await expect(page.locator("#controls-panel")).toHaveClass(/mobile-open/);
  await page.locator(".survey-card", { hasText: "SDSS" }).locator("input").check();
  await expect(page.locator("#layer-visible-output")).toHaveText(/^\d+ SOURCES · [\d,]+ CELLS$/);
  await expect(page.locator("[data-layer-interaction]")).toHaveCount(0);
  await expect(page.locator("#layer-tool-strip")).toHaveCount(0);
  await expect(page.locator("#coverage-context-menu")).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("mobile-survey-controls.png"), fullPage: true });
});
