import { expect, test, type Page } from "@playwright/test";
import { PNG } from "pngjs";
import { Healpix } from "healpixjs";

const apiRoot = process.env.ASTRO_E2E_API ?? "http://astro.workspace.dev.72602.space:32080";
const baselinePackageIds = ["public-legacy-surveys-footprints", "public-sdss-footprints", "public-hst-footprints"];
let initialActivePackageIds: string[] = [];

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiRoot}${path}`, init);
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path} failed: ${response.status} ${await response.text()}`);
  return await response.json() as T;
}

async function installPackage(id: string): Promise<void> {
  const catalog = await apiJson<{ packages: Array<{ id: string; installedVersion?: string }> }>("/api/resource-packages");
  const record = catalog.packages.find((candidate) => candidate.id === id);
  if (!record) throw new Error(`Missing E2E resource package: ${id}`);
  if (!record.installedVersion) {
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
  const catalog = await apiJson<{ packages: Array<{ id: string; active: boolean }> }>("/api/resource-packages");
  initialActivePackageIds = catalog.packages.filter((record) => record.active).map((record) => record.id);
  await Promise.all(baselinePackageIds.map((id) => installPackage(id)));
  await apiJson("/api/resource-packages/active", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: [...new Set([...initialActivePackageIds.filter((id) => id !== "public-euclid-footprints"), ...baselinePackageIds])] }),
  });
});

test.afterAll(async () => {
  await apiJson("/api/resource-packages/active", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: initialActivePackageIds }),
  });
});

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

function brightScenePixelCount(buffer: Buffer): number {
  const image = PNG.sync.read(buffer);
  let count = 0;
  for (let y = 50; y < image.height - 50; y += 1) {
    for (let x = 50; x < image.width - 50; x += 1) {
      const index = (y * image.width + x) * 4;
      if (Math.max(image.data[index]!, image.data[index + 1]!, image.data[index + 2]!) > 170) count += 1;
    }
  }
  return count;
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

async function openFresh(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.clear());
  await proxyApi(page);
  await page.goto("/");
  await expect(page.locator('[data-mode="catalog"]')).toHaveClass(/active/);
  await expect(page.locator("#catalog-stage")).toBeVisible();
  await expect(page.locator("#service-status")).toHaveText("SERVICE ONLINE");
  await expect(page.locator("#loading-indicator")).not.toHaveClass(/visible/);
  await page.locator('button[data-mode="layers"]').click();
  await expect(page.locator('button[data-mode="layers"]')).toHaveClass(/active/);
  await expect(page.locator("#loading-indicator")).not.toHaveClass(/visible/);
  await expect(page.locator("#volume-canvas")).toBeVisible();
  await page.waitForTimeout(900);
}

test("resource package draft downloads and loads one survey explicitly", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => localStorage.clear());
  await proxyApi(page);
  await page.goto("/");
  await expect(page.locator("#service-status")).toHaveText("SERVICE ONLINE");
  await expect(page.locator("#loading-indicator")).not.toHaveClass(/visible/);

  const packageButton = page.locator('[data-mode="packages"]');
  await expect(packageButton).toHaveCount(1);
  await expect(packageButton.evaluate((button) => button.nextElementSibling?.getAttribute("data-mode"))).resolves.toBe("connectors");
  await packageButton.click();
  await expect(packageButton).toHaveClass(/active/);
  await expect(page.locator("#resource-package-stage")).toBeVisible();

  const row = page.locator(".resource-package-row", { hasText: "Euclid" });
  const toggle = row.locator('input[type="checkbox"]');
  await row.click();
  await expect(page.locator("#inspector-content")).toContainText("Euclid");
  await expect(page.locator("#inspector-content")).toContainText("official-overview");
  const activeBefore = await page.locator("#resource-package-active-count").textContent();
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(page.locator("#resource-package-pending")).toContainText("待加载");
  await expect(page.locator("#resource-package-active-count")).toHaveText(activeBefore ?? "0");
  await expect(packageButton).toHaveClass(/active/);

  const download = page.locator("#resource-package-download");
  if (await download.isEnabled()) await download.click();
  await expect(download).toBeDisabled();
  await page.locator("#resource-package-apply").click();
  await expect(page.locator("#resource-package-pending")).toHaveText("草稿与天球一致");
  await expect(row.locator(".resource-package-status")).toHaveText("已加载");
  await expect(packageButton).toHaveClass(/active/);

  await toggle.uncheck();
  await page.locator("#resource-package-apply").click();
  await expect(row.locator(".resource-package-status")).toHaveText("已下载");
  await page.locator('[data-mode="layers"]').click();
  const canvas = page.locator("#volume-canvas");
  await expect(canvas).toBeVisible();
  const visibleSurveys = new Set((await canvas.getAttribute("data-visible-survey-ids"))?.split(",") ?? []);
  expect(visibleSurveys.has("euclid")).toBe(false);
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

async function findSelectedRefinementPoint(page: Page): Promise<{ x: number; y: number; pixel: number }> {
  const canvas = page.locator("#volume-canvas");
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("Canvas has no layout bounds");
  for (let y = 70; y < bounds.height - 70; y += 8) {
    for (let x = 70; x < bounds.width - 70; x += 8) {
      await page.mouse.move(bounds.x + x, bounds.y + y);
      const rawPixel = await canvas.getAttribute("data-hovered-pixel");
      if (rawPixel != null && await canvas.getAttribute("data-hovered-selected") === "true") return { x, y, pixel: Number(rawPixel) };
    }
  }
  throw new Error("No selected refinement cell found on the visible region");
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

test("desktop survey footprints are selectable fragments with layer and overlap layouts", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFresh(page);
  const canvas = page.locator("#volume-canvas");
  await expect(canvas).toHaveAttribute("data-visible-survey-ids", "legacy-surveys");
  await expect(page.locator(".survey-card", { hasText: "DESI" }).locator("input")).toBeDisabled();
  await expect(page.locator("#focus-button")).toHaveCount(0);
  await expect(page.locator(".scene-hud-top #reset-button")).toBeVisible();

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
  await canvas.click({ position: legacyPoint, button: "right" });
  await expect(page.locator("#coverage-context-menu")).toBeVisible();
  await page.locator("#coverage-context-menu button").click();
  await expect(page.locator("#layer-selection-count")).toContainText("LOCKED");
  await expect(page.locator("#coverage-pin-status")).toHaveClass(/active/);
  await expect(page.locator("#coverage-pin-status")).toHaveText("已固定");
  await page.screenshot({ path: testInfo.outputPath("selected-cell-stack.png"), fullPage: true });

  await page.locator(".survey-card", { hasText: "SDSS" }).locator("input").check();
  await page.locator(".survey-card", { hasText: "HST" }).locator("input").check();
  const visibleIds = (await canvas.getAttribute("data-visible-survey-ids"))?.split(",") ?? [];
  expect(new Set(visibleIds)).toEqual(new Set(["legacy-surveys", "sdss", "hst"]));
  await expect(page.locator("#layer-visible-output")).toHaveText("3 ACTIVE");
  await expect(page.locator("#layer-selection-count")).toContainText("LOCKED");
  await expect(page.locator("#coverage-pin-status")).toHaveClass(/active/);
  await expect(canvas).toHaveAttribute("data-camera-position", cameraPositionBefore!);
  await page.waitForTimeout(500);
  const multiLayerImage = await canvas.screenshot({ path: testInfo.outputPath("multi-layer-fragments.png") });

  await page.locator('[data-layer-interaction="region"]').click();
  await expect(page.locator("#layer-selection-count")).toHaveText("G");
  await canvas.click({ position: legacyPoint });
  await expect(page.locator("#layer-selection-count")).toHaveText("1 CELLS");
  await expect(page.locator("#inspector-kicker")).toHaveText("REGION SELECTION");
  await expect(page.locator("#inspector-content")).toContainText("完整角向选区已高亮");
  await expect(page.locator('[data-action="search-region"]')).toBeVisible();
  await expect(page.locator('[data-action="download-region"]')).toBeVisible();
  await expect(page.locator("#region-scene-legend")).toContainText("SELECTED SKY REGION");
  await canvas.screenshot({ path: testInfo.outputPath("selected-region-overlay.png") });

  await page.locator('[data-action="search-region"]').click();
  await expect(canvas).toHaveAttribute("data-mode", "refine");
  await expect(canvas).toHaveAttribute("data-refinement-nside", "32");
  await expect(page.locator("#refinement-level-output")).toHaveText("NSIDE 32");
  await expect(page.locator("#scene-legend")).toBeHidden();
  await expect(page.locator("#agent-toggle")).not.toHaveAttribute("hidden", "");
  await expect(page.locator("#inspector-content")).toContainText("Legacy Surveys DR10 Tractor catalog");
  const candidateCount = Number(await page.locator("#refinement-candidate-count").textContent());
  const selectedCount = Number(await page.locator("#refinement-selected-count").textContent());
  expect(candidateCount).toBe(4);
  expect(selectedCount).toBe(4);
  const refinementPoint = await findSelectedRefinementPoint(page);
  await canvas.click({ position: refinementPoint });
  await expect(page.locator("#refinement-selected-count")).toHaveText("3");
  await expect(canvas).not.toHaveAttribute("data-selected-pixels", new RegExp(`(^|,)${refinementPoint.pixel}(,|$)`));
  await page.locator("#refinement-next").click();
  await expect(canvas).toHaveAttribute("data-refinement-nside", "64");
  await expect(page.locator("#refinement-candidate-count")).toHaveText("12");
  await expect(page.locator('[data-action="export-refined-query"]')).toBeVisible();
  const refinementImage = await canvas.screenshot({ path: testInfo.outputPath("region-refinement-canvas.png") });
  expect(brightScenePixelCount(refinementImage)).toBeLessThan(50);
  await page.screenshot({ path: testInfo.outputPath("region-refinement.png"), fullPage: true });
  await page.locator('[data-mode="layers"]').click();
  await expect(canvas).toHaveAttribute("data-selected-pixels", /\d+/);
  await page.locator('[data-layer-interaction="inspect"]').click();

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

test("region mode selects uncovered cells and every one of their eight neighbours", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFresh(page);
  const canvas = page.locator("#volume-canvas");
  await page.locator('[data-layer-interaction="region"]').click();

  const empty = await findCanvasPoint(page, (state) => !state.covered && state.selectable);
  await canvas.click({ position: empty });
  await expect(canvas).toHaveAttribute("data-selected-pixels", String(empty.pixel));
  await expect(page.locator("#layer-selection-count")).toHaveText("1 CELLS");
  await expect(page.locator("#inspector-content")).toContainText("当前可见巡天暂无覆盖");

  const neighbours = new Set([...new Healpix(16).neighbours(empty.pixel)].filter((pixel) => pixel >= 0));
  const adjacent = await findCanvasPoint(page, (state) => state.selectable && state.pixel !== empty.pixel && neighbours.has(state.pixel));
  await canvas.click({ position: adjacent });
  await expect(page.locator("#layer-selection-count")).toHaveText("2 CELLS");
  await expect(page.locator("#region-scene-legend")).toContainText("2 CELLS");
  const selected = (await canvas.getAttribute("data-selected-pixels"))?.split(",").map(Number) ?? [];
  expect(new Set(selected)).toEqual(new Set([empty.pixel, adjacent.pixel]));
  await page.screenshot({ path: testInfo.outputPath("uncovered-eight-neighbour-region.png"), fullPage: true });
});

test("mobile controls expose survey filters and keyboard-addressable sky tools", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openFresh(page);
  await page.locator("#controls-toggle").click();
  await expect(page.locator("#controls-panel")).toHaveClass(/mobile-open/);
  await page.locator(".survey-card", { hasText: "SDSS" }).locator("input").check();
  await expect(page.locator("#layer-visible-output")).toHaveText("2 ACTIVE");
  await page.keyboard.press("g");
  await expect(page.locator(".region-multi-control")).toHaveCount(0);
  await expect(page.locator("#volume-canvas")).toHaveAttribute("data-interaction-mode", "region");
  await expect(page.locator('[data-layer-interaction="region"]')).toHaveClass(/active/);
  await expect(page.locator('[data-layer-interaction="region"]')).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("f");
  await expect(page.locator("#volume-canvas")).toHaveAttribute("data-interaction-mode", "inspect");
  await page.screenshot({ path: testInfo.outputPath("mobile-survey-controls.png"), fullPage: true });
});
