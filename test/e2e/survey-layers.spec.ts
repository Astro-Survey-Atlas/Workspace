import { expect, test, type Page } from "@playwright/test";
import { PNG } from "pngjs";
import { Healpix } from "healpixjs";

const apiRoot = process.env.ASTRO_E2E_API ?? "http://astro.workspace.dev.72602.space:32080";
const baselinePackageIds = ["public-legacy-surveys-footprints", "public-sdss-footprints", "public-hst-footprints"];
type PackageState = { id: string; activeReleaseIds: string[]; availableReleaseIds: string[] };
let initialLoads: Array<{ packageId: string; releaseIds: string[] }> = [];

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiRoot}${path}`, init);
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

test.afterEach(async ({ page }) => page.unrouteAll({ behavior: "ignoreErrors" }));

async function proxyApi(page: Page): Promise<void> {
  await page.route("**/api/**", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.origin === new URL(apiRoot).origin) {
      await route.continue();
      return;
    }
    const response = await route.fetch({ url: `${apiRoot}${requestUrl.pathname}${requestUrl.search}` });
    await route.fulfill({ response });
  });
}

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
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("astro-workspace:theme:v1", "dark");
  });
  await proxyApi(page);
  await beforeGoto?.();
  await page.goto("/");
  await expect(page.locator("#service-status")).toHaveText("SERVICE ONLINE");
  await expect(page.locator("#loading-indicator")).not.toHaveClass(/visible/);
  const layersMode = page.locator('button[data-mode="layers"]');
  if (!await layersMode.evaluate((button) => button.classList.contains("active"))) await layersMode.click();
  await expect(page.locator('button[data-mode="layers"]')).toHaveClass(/active/);
  await expect(page.locator("#loading-indicator")).not.toHaveClass(/visible/);
  await expect(page.locator("#volume-canvas")).toBeVisible();
  await page.waitForTimeout(900);
}

test("layers list each user asset independently with its own visibility control", async ({ page }) => {
  const { assets } = await apiJson<{ assets: Array<{ id: string; name: string }> }>("/api/data-assets?origin=user");
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFresh(page);

  const assetCards = page.locator("#workspace-asset-list .workspace-asset-card");
  await expect(assetCards).toHaveCount(assets.length, { timeout: 15_000 });
  await expect(page.locator("#layer-asset-count")).toHaveText(String(assets.length));
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

test("sky layers default to semantic overlap and expose radial depth as display-only", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFresh(page);

  const overlap = page.locator('[data-layer-layout="overlap"]');
  const radial = page.locator('[data-layer-layout="layers"]');
  await expect(overlap).toHaveClass(/active/);
  await expect(overlap).toHaveAttribute("aria-pressed", "true");
  await expect(radial).toHaveText("径向展开");
  await expect(radial).toHaveAttribute("title", /不代表物理距离/);

  const assetLabels = await page.locator("#workspace-asset-list .survey-card-body").allTextContents();
  expect(assetLabels.every((label) => !/user[-_][a-z0-9-]+/i.test(label))).toBe(true);

  await radial.click();
  await expect(radial).toHaveClass(/active/);
  await expect(page.locator("#volume-canvas")).toHaveAttribute("data-layout-mode", "layers");
  await overlap.click();
  await expect(overlap).toHaveClass(/active/);
  await expect(page.locator("#volume-canvas")).toHaveAttribute("data-layout-mode", "overlap");
});

test("public resource package installs and applies all releases atomically", async ({ page }) => {
  const { releases } = await apiJson<{ releases: Array<{ surveyId: string; releaseId: string; products: Array<{ coverageStatus: string }> }> }>("/api/public-release-details");
  const euclidQ1 = releases.find((release) => release.surveyId === "euclid" && release.releaseId === "euclid-q1");
  if (!euclidQ1) throw new Error("Missing Euclid Q1 public release detail");
  const euclidQ1Statuses = euclidQ1.products.map((product) => product.coverageStatus);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => localStorage.clear());
  await proxyApi(page);
  await page.goto("/");
  await expect(page.locator("#service-status")).toHaveText("SERVICE ONLINE");
  await expect(page.locator("#loading-indicator")).not.toHaveClass(/visible/);

  const packageButton = page.locator('[data-mode="packages"]');
  await expect(packageButton).toHaveCount(1);
  await expect(packageButton).toHaveText("公开资源集");
  await expect(packageButton.evaluate((button) => button.nextElementSibling?.getAttribute("data-mode"))).resolves.toBe("connectors");
  await packageButton.click();
  await expect(packageButton).toHaveClass(/active/);
  await expect(page.locator("#resource-package-stage")).toBeVisible();
  const row = page.locator(".resource-package-row", { hasText: "Euclid" });
  const toggle = row.locator('input[type="checkbox"]');
  await expect(row.locator(".resource-package-tag")).not.toHaveCount(0);
  await expect(row.locator(".resource-package-tag").first()).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(row.locator(".item-progress")).toHaveCount(1);
  await expect(row.locator(".resource-package-version")).toHaveText("0 / 4 产品有真实覆盖");
  await expect(row.locator(".resource-package-version")).not.toHaveAttribute("role", "button");
  await expect(row).not.toContainText("2.0.0");
  const resourceTitleStyle = await page.locator("#resource-package-stage .catalog-stage-header h2").evaluate((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return { fontSize: style.fontSize, fontWeight: style.fontWeight, marginTop: style.marginTop, marginBottom: style.marginBottom, color: style.color, left: rect.left };
  });
  await row.click();
  await expect(page.locator("#public-survey-overview-stage")).toBeVisible();
  await expect(page.locator("#public-survey-overview-title")).toHaveText("Euclid");
  const overviewTitleStyle = await page.locator("#public-survey-overview-title").evaluate((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return { fontSize: style.fontSize, fontWeight: style.fontWeight, marginTop: style.marginTop, marginBottom: style.marginBottom, color: style.color, left: rect.left };
  });
  expect(overviewTitleStyle).toEqual(resourceTitleStyle);
  await expect(page.locator("#public-survey-overview-stage > .public-survey-overview-header")).toBeVisible();
  await expect(page.locator("#public-survey-overview-stage > .public-release-detail-header")).toHaveCount(0);
  await expect(page.locator(".public-survey-overview-releases-section > .section-heading")).toHaveCount(0);
  await expect(page.locator(".public-survey-overview-columns > span")).toHaveCount(2);
  await expect(page.locator(".public-survey-overview-columns")).toContainText("公开版本");
  await expect(page.locator(".public-survey-overview-columns")).toContainText("覆盖状态");
  await expect(page.locator("#public-survey-overview-releases .public-survey-overview-release")).toHaveCount(3);
  await expect.poll(() => new URL(page.url()).searchParams.get("survey")).toBe("euclid");
  await expect.poll(() => new URL(page.url()).searchParams.get("release")).toBeNull();
  await page.locator("#public-survey-overview-releases .public-survey-overview-release", { hasText: "Q1" }).click();
  await expect(page.locator("#public-release-detail-stage")).toBeVisible();
  await expect(page.locator("#public-release-detail-title")).toHaveText("Q1");
  await expect(page.locator("#public-release-detail-source")).toHaveText(/数据发布页/);
  await expect(page.locator("#public-release-detail-source")).toHaveCSS("font-size", "10px");
  await expect(page.locator("#public-release-product-count")).toHaveText("0 / 2 已收录");
  await expect(page.locator(".public-release-product[data-coverage-status='acquired']")).toHaveCount(euclidQ1Statuses.filter((status) => status === "acquired").length);
  await expect(page.locator(".public-release-product[data-coverage-status='overview_only']")).toHaveCount(euclidQ1Statuses.filter((status) => status === "overview_only").length);
  await expect(page.locator(".public-release-product[data-coverage-status='awaiting_geometry']")).toHaveCount(euclidQ1Statuses.filter((status) => status === "awaiting_geometry").length);
  if (euclidQ1Statuses.includes("overview_only")) {
    await expect(page.locator(".public-release-product[data-coverage-status='overview_only']", { hasText: "仅有官方概览" })).not.toHaveCount(0);
  }
  await expect(page.locator(".public-release-product-links").getByRole("link", { name: /覆盖来源/ })).toHaveCount(2);
  await expect(page.locator(".public-release-product").getByRole("button", { name: "填写覆盖范围" })).toHaveCount(euclidQ1Statuses.filter((status) => status === "awaiting_geometry").length);
  await expect.poll(() => new URL(page.url()).searchParams.get("release")).toBe("euclid-q1");
  await packageButton.click();
  await expect(page.locator("#resource-package-stage")).toBeVisible();
  await expect(page.locator("#public-survey-overview-stage")).toBeHidden();
  await expect(page.locator("#public-release-detail-stage")).toBeHidden();
  await expect.poll(() => new URL(page.url()).searchParams.get("release")).toBeNull();
  await expect(toggle).toBeDisabled();
  await expect(row).toHaveAttribute("data-loadable", "false");
  await expect(toggle).toHaveAttribute("title", /不能应用到天球/);

  const loadableRow = page.locator(".resource-package-row", { hasText: "Pan-STARRS1" });
  const loadableToggle = loadableRow.locator('input[type="checkbox"]');
  await expect(loadableRow).toHaveAttribute("data-loadable", "true");
  const activeBefore = await page.locator("#resource-package-active-count").textContent();
  await expect(loadableToggle).not.toBeChecked();
  await loadableToggle.check();
  await expect(page.locator("#resource-package-active-count")).toHaveText(activeBefore ?? "0");
  await expect(packageButton).toHaveClass(/active/);

  const apply = page.locator("#resource-package-apply");
  await expect(apply).toBeVisible();
  await expect(page.locator("#resource-package-pending, #resource-package-download, #resource-package-download-dialog")).toHaveCount(0);
  await expect(page.locator("#inspector-content").getByRole("button", { name: /应用|重置/ })).toHaveCount(0);
  await apply.click();
  await expect(apply).toBeDisabled();
  await expect(loadableRow.locator(".resource-package-status")).toHaveText("已应用");
  await expect(packageButton).toHaveClass(/active/);

  await loadableToggle.uncheck();
  await expect(apply).toBeVisible();
  await apply.click();
  await expect(apply).toBeDisabled();
  await expect(loadableRow.locator(".resource-package-status")).toHaveText("已下载");
  await page.locator('button[data-mode="layers"]').click();
  const canvas = page.locator("#volume-canvas");
  await expect(canvas).toBeVisible();
  const visibleSurveys = new Set((await canvas.getAttribute("data-visible-survey-ids"))?.split(",") ?? []);
  expect(visibleSurveys.has("euclid")).toBe(false);
  expect(visibleSurveys.has("panstarrs")).toBe(false);
});

test("a release deep link opens its detail page directly", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("astro-workspace:theme:v1", "dark"));
  await proxyApi(page);
  await page.goto("/?mode=packages&survey=sdss&release=sdss-dr01");
  await expect(page.locator("#service-status")).toHaveText("SERVICE ONLINE");
  await expect(page.locator("#public-release-detail-stage")).toBeVisible();
  await expect(page.locator("#public-release-detail-title")).not.toHaveText("");
  await expect(page.locator("#public-release-product-list .public-release-product")).not.toHaveCount(0);
  await expect.poll(() => new URL(page.url()).searchParams.get("release")).toBe("sdss-dr01");
});

test("public survey overview header remains aligned in light mobile layout", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem("astro-workspace:theme:v1", "light"));
  await proxyApi(page);
  await page.goto("/?mode=packages&survey=euclid");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator("#public-survey-overview-stage")).toBeVisible();
  await expect(page.locator("#public-survey-overview-title")).toBeVisible();
  await expect(page.locator(".public-survey-overview-columns > span")).toHaveCount(2);
  await expect(page.locator("#public-survey-overview-back")).toBeVisible();
  const layout = await page.locator("#public-survey-overview-stage").evaluate((stage) => {
    const title = stage.querySelector<HTMLElement>("#public-survey-overview-title")!;
    const back = stage.querySelector<HTMLElement>("#public-survey-overview-back")!;
    const columns = stage.querySelector<HTMLElement>(".public-survey-overview-columns")!;
    const stageRect = stage.getBoundingClientRect();
    const titleRect = title.getBoundingClientRect();
    const backRect = back.getBoundingClientRect();
    const columnsRect = columns.getBoundingClientRect();
    return {
      titleInside: titleRect.left >= stageRect.left && titleRect.right <= stageRect.right,
      backInside: backRect.left >= stageRect.left && backRect.right <= stageRect.right,
      columnsInside: columnsRect.left >= stageRect.left && columnsRect.right <= stageRect.right,
      titleColor: getComputedStyle(title).color,
      stageBackground: getComputedStyle(stage).backgroundColor,
    };
  });
  expect(layout.titleInside).toBe(true);
  expect(layout.backInside).toBe(true);
  expect(layout.columnsInside).toBe(true);
  expect(layout.titleColor).not.toBe("rgb(255, 255, 255)");
  expect(layout.stageBackground).not.toBe("rgb(7, 11, 15)");
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
  const canvas = page.locator("#volume-canvas");
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

async function findCanvasPoint(page: Page, predicate: (state: { pixel: number; covered: boolean; selectable: boolean }) => boolean): Promise<{ x: number; y: number; pixel: number }> {
  const canvas = page.locator("#volume-canvas");
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("Canvas has no layout bounds");
  for (let y = 70; y < bounds.height - 70; y += 10) {
    for (let x = 70; x < bounds.width - 70; x += 10) {
      await page.mouse.move(bounds.x + x, bounds.y + y);
      const rawPixel = await canvas.getAttribute("data-hovered-pixel");
      if (rawPixel === null) continue;
      const pixel = Number(rawPixel);
      if (!Number.isInteger(pixel)) continue;
      const state = {
        pixel,
        covered: (await canvas.getAttribute("data-hovered-covered")) === "true",
        selectable: (await canvas.getAttribute("data-hovered-selectable")) === "true",
      };
      if (predicate(state)) return { x, y, pixel };
    }
  }
  throw new Error("No matching HEALPix point found on the visible hemisphere");
}

test("project status remains available when joint volume resources fail", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => localStorage.clear());
  await proxyApi(page);
  await page.route("**/api/atlases", async (route) => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ error: "joint atlas unavailable" }),
  }));
  await page.route("**/api/volumes", async (route) => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ error: "radial volume unavailable" }),
  }));

  await page.goto("/");
  await expect(page.locator("#service-status")).toHaveText("SERVICE ONLINE");
  await page.locator('button[data-mode="layers"]').click();
  await expect(page.locator('button[data-mode="layers"]')).toHaveClass(/active/);
  await expect(page.locator("#volume-canvas")).toBeVisible();
  await expect(page.locator("#loading-indicator")).not.toHaveClass(/visible/);
});

test("desktop sky drills density cells without fixed-region controls", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFresh(page);
  const canvas = page.locator("#volume-canvas");
  await expect(canvas).toHaveAttribute("data-visible-survey-ids", "legacy-surveys");
  await expect(page.locator(".survey-card", { hasText: "DESI" })).toHaveCount(0);
  await expect(page.locator("#survey-list")).not.toContainText("PENDING");
  await expect(page.locator("#focus-button")).toHaveCount(0);
  await expect(page.locator(".scene-hud-top #reset-button")).toBeVisible();
  await expect(page.locator("#coverage-lock-button")).toHaveCount(0);
  await expect(page.locator("#coverage-context-menu")).toHaveCount(0);
  await expect(page.locator("#refinement-controls")).toHaveCount(0);
  await expect(page.locator('[data-action="search-region"]')).toHaveCount(0);

  const legacyImage = await canvas.screenshot({ path: testInfo.outputPath("legacy-fragments.png") });
  const legacyLitPixels = fragmentPixelCount(legacyImage);
  expect(legacyLitPixels).toBeGreaterThan(1_000);
  const cameraDistanceBefore = Number(await canvas.getAttribute("data-camera-distance"));
  const cameraPositionBefore = await canvas.getAttribute("data-camera-position");
  const legacyPoint = fragmentPoint(legacyImage);
  await canvas.click({ position: legacyPoint });
  await expect(page.locator("#inspector-kicker")).toHaveText("AVAILABLE DATA IN THIS SKY CELL");
  await expect(page.locator("#inspector-content")).toContainText("Legacy Surveys");
  await expect(page.locator(".coverage-location")).toContainText("RA");
  await expect(page.locator(".coverage-location")).toContainText("Dec");
  await expect(page.locator(".coverage-stack")).toContainText("DR10");
  await expect(page.locator(".coverage-stack")).toContainText("MOC GEOMETRY");
  await expect(page.locator(".coverage-next-step button")).toBeDisabled();
  await expect(page.locator(".survey-solo")).toHaveCount(0);
  await page.waitForTimeout(750);
  const cameraDistanceAfter = Number(await canvas.getAttribute("data-camera-distance"));
  expect(Math.abs(cameraDistanceAfter - cameraDistanceBefore)).toBeLessThan(0.01);
  await expect(canvas).toHaveAttribute("data-camera-position", cameraPositionBefore!);
  await canvas.screenshot({ path: testInfo.outputPath("selected-cell-explosion.png") });
  await expect(page.locator("#scene-mode-value")).toContainText("NESTED NSIDE 16");
  await expect(page.locator("#layer-selection-count")).toHaveText("1 CELLS");

  await page.locator(".survey-card", { hasText: "SDSS" }).locator("input").check();
  await page.locator(".survey-card", { hasText: "HST" }).locator("input").check();
  const visibleIds = (await canvas.getAttribute("data-visible-survey-ids"))?.split(",") ?? [];
  expect(new Set(visibleIds)).toEqual(new Set(["legacy-surveys", "sdss", "hst"]));
  await expect(page.locator("#layer-visible-output")).toHaveText("3 PUBLIC · 1 ASSET");
  await expect(canvas).toHaveAttribute("data-camera-position", cameraPositionBefore!);
  await page.waitForTimeout(500);
  const multiLayerImage = await canvas.screenshot({ path: testInfo.outputPath("multi-layer-fragments.png") });

  const drillPoint = await findCanvasPoint(page, (state) => state.covered && state.selectable);
  await canvas.dblclick({ position: drillPoint });
  await expect(page.locator("#scene-mode-value")).toContainText("NESTED NSIDE 32");
  await expect(page.locator("#scene-badge")).toContainText("NSIDE 32");
  await canvas.screenshot({ path: testInfo.outputPath("main-sky-drill-nside32.png") });

  await page.locator('[data-layer-layout="overlap"]').click();
  await expect(canvas).toHaveAttribute("data-layout-mode", "overlap");
  await page.waitForTimeout(500);
  await canvas.screenshot({ path: testInfo.outputPath("overlap-fragments.png") });

  await page.locator("#layer-clear-all").click();
  await expect(canvas).toHaveAttribute("data-visible-survey-ids", "");
  await page.waitForTimeout(350);
  const emptyImage = await canvas.screenshot({ path: testInfo.outputPath("empty-fragment-scene.png") });
  expect(fragmentPixelCount(emptyImage)).toBeLessThan(legacyLitPixels * 0.2);
});

test("main sky supports Ctrl selection across density cells", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFresh(page);
  const canvas = page.locator("#volume-canvas");
  const first = await findCanvasPoint(page, (state) => state.covered && state.selectable);
  await canvas.click({ position: first });
  await expect(page.locator("#layer-selection-count")).toHaveText("1 CELLS");
  const second = await findCanvasPoint(page, (state) => state.covered && state.selectable && state.pixel !== first.pixel);
  await canvas.click({ position: second, modifiers: ["Control"] });
  await expect(page.locator("#layer-selection-count")).toHaveText("2 CELLS");
  await page.screenshot({ path: testInfo.outputPath("ctrl-density-selection.png"), fullPage: true });
});

test("wheel zoom refines selected cells and switches to object density", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  let objectRequestSeen = false;
  page.on("request", (request) => {
    if (request.url().includes("/api/sky/objects/query")) objectRequestSeen = true;
  });
  await openFresh(page, async () => {
    await page.route("**/api/sky/objects/query", async (route) => {
      const request = route.request();
      const body = request.postDataJSON() as { region?: { ordering?: string; coordinateFrame?: string } };
      expect(body.region?.ordering).toBe("NESTED");
      expect(body.region?.coordinateFrame).toBe("ICRS");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: "ready",
          index: "astro_object_index_v1",
          objects: [{ object_id: "e2e-object", ra_deg: 150, dec_deg: 1.4, survey: "cosmos-custom", release: "cosmos-custom-v1", product: "COSMOS", modality: "catalog", asset_id: "user-12b69893-1a68-4b20-81dd-fb1ddca31953" }],
          total: 1,
          limit: 10000,
        }),
      });
    });
  });
  const canvas = page.locator("#volume-canvas");
  const point = await findCanvasPoint(page, (state) => state.covered && state.selectable);
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("Canvas has no layout bounds");
  await canvas.dblclick({ position: point });
  await expect(page.locator("#scene-mode-value")).toContainText("NESTED NSIDE 32");
  await page.mouse.move(bounds.x + point.x, bounds.y + point.y);

  for (let index = 0; index < 100; index += 1) {
    await page.mouse.wheel(0, -480);
    await page.waitForTimeout(60);
    const status = await page.locator("#scene-mode-value").textContent();
    if (status?.includes("NSIDE 256") && (await page.locator("#object-status").textContent())?.includes("OBJECTS")) break;
  }

  await expect.poll(() => objectRequestSeen, { timeout: 20_000 }).toBe(true);
  await expect.poll(async () => page.locator("#scene-mode-value").textContent(), { timeout: 15_000 })
    .toMatch(/NSIDE (64|128|256)/);
  await expect.poll(async () => page.locator("#object-status").textContent(), { timeout: 20_000 })
    .toMatch(/\d+ \/ \d+ OBJECTS/);
  await expect(page.locator("#scene-mode-value")).toHaveText(/FOV 0\.(?:[0-4]\d|50)°/);
});

test("mobile controls expose survey filters and keyboard-addressable sky tools", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openFresh(page);
  await page.locator("#controls-toggle").click();
  await expect(page.locator("#controls-panel")).toHaveClass(/mobile-open/);
  await page.locator(".survey-card", { hasText: "SDSS" }).locator("input").check();
  await expect(page.locator("#layer-visible-output")).toHaveText("2 PUBLIC · 1 ASSET");
  await page.keyboard.press("g");
  await expect(page.locator(".region-multi-control")).toHaveCount(0);
  await expect(page.locator("#volume-canvas")).toHaveAttribute("data-interaction-mode", "region");
  await expect(page.locator('[data-layer-interaction="region"]')).toHaveClass(/active/);
  await expect(page.locator('[data-layer-interaction="region"]')).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("f");
  await expect(page.locator("#volume-canvas")).toHaveAttribute("data-interaction-mode", "inspect");
  await page.screenshot({ path: testInfo.outputPath("mobile-survey-controls.png"), fullPage: true });
});
