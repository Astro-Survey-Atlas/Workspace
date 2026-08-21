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
  await expect(page.locator("#volume-canvas")).toBeVisible();
  await page.waitForTimeout(900);
}

async function waitForVisibleAssetCoverage(page: Page): Promise<void> {
  const assetToggle = page.locator("#sky-layer-list .workspace-asset-card input[type='checkbox']").first();
  await expect(assetToggle).toBeVisible({ timeout: 15_000 });
  if (!await assetToggle.isChecked()) await assetToggle.check();
  await expect.poll(async () => page.locator("#volume-canvas").getAttribute("data-visible-asset-ids"), {
    timeout: 15_000,
  }).toMatch(/.+/);
}

test("unified sky layer stack lists each user asset with its own visibility control", async ({ page }) => {
  const { assets } = await apiJson<{ assets: Array<{ id: string; name: string }> }>("/api/data-assets?origin=user");
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

test("sky layers default to semantic overlap and expose radial depth as display-only", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFresh(page);

  const overlap = page.locator('[data-layer-layout="overlap"]');
  const radial = page.locator('[data-layer-layout="layers"]');
  await expect(overlap).toHaveClass(/active/);
  await expect(overlap).toHaveAttribute("aria-pressed", "true");
  await expect(radial).toHaveText("径向展开");
  await expect(radial).toHaveAttribute("title", /不代表物理距离/);

  const assetLabels = await page.locator("#sky-layer-list .workspace-asset-card .survey-card-body").allTextContents();
  expect(assetLabels.every((label) => !/user[-_][a-z0-9-]+/i.test(label))).toBe(true);
  await expect(page.locator("#sky-layer-list")).not.toContainText("COSMOS Custom Catalog");
  await expect(page.locator("#sky-layer-list")).toContainText("COSMOS");

  await radial.click();
  await expect(radial).toHaveClass(/active/);
  await expect(page.locator("#volume-canvas")).toHaveAttribute("data-layout-mode", "layers");
  await overlap.click();
  await expect(overlap).toHaveClass(/active/);
  await expect(page.locator("#volume-canvas")).toHaveAttribute("data-layout-mode", "overlap");
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
  await expect(page.locator("#volume-canvas")).toHaveAttribute("data-layer-order", new RegExp(`^${secondKey},${firstKey}`));

  await page.reload();
  await expect(page.locator("#service-status")).toHaveText("SERVICE ONLINE");
  await expect(page.locator("#sky-layer-list .survey-card").nth(0)).toHaveAttribute("data-layer-key", secondKey!);
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
     return { fontSize: style.fontSize, fontWeight: style.fontWeight, marginTop: style.marginTop, marginBottom: style.marginBottom, color: style.color };
   });
  await row.click();
  await expect(page.locator("#public-survey-overview-stage")).toBeVisible();
  await expect(page.locator("#public-survey-overview-title")).toHaveText("Euclid");
   const overviewTitleStyle = await page.locator("#public-survey-overview-title").evaluate((element) => {
     const style = getComputedStyle(element);
     return { fontSize: style.fontSize, fontWeight: style.fontWeight, marginTop: style.marginTop, marginBottom: style.marginBottom, color: style.color };
   });
  expect(overviewTitleStyle).toEqual(resourceTitleStyle);
   await expect(page.locator("#public-survey-overview-stage > .public-survey-overview-header")).toBeVisible();
   await expect(page.locator("#public-survey-overview-stage > .public-release-detail-header")).toHaveCount(0);
   const overviewHeaderLayout = await page.locator("#public-survey-overview-stage > .public-survey-overview-header").evaluate((header) => {
     const back = header.querySelector<HTMLElement>("#public-survey-overview-back")!.getBoundingClientRect();
     const title = header.querySelector<HTMLElement>("#public-survey-overview-title")!.getBoundingClientRect();
      return { backRight: back.right, titleLeft: title.left, backTop: back.top, titleTop: title.top };
    });
    expect(overviewHeaderLayout.backRight).toBeLessThanOrEqual(overviewHeaderLayout.titleLeft);
    expect(overviewHeaderLayout.backTop).toBeLessThanOrEqual(overviewHeaderLayout.titleTop + 4);
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
  await expect(page.locator(".public-release-product").getByRole("button", { name: /填写覆盖范围|维护覆盖范围/ })).toHaveCount(0);
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
  await expect(page.locator("#resource-package-feedback")).toHaveAttribute("data-status", "success");
  await expect(page.locator("#resource-package-feedback")).toContainText("数据覆盖天球已刷新");
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
       backBeforeTitle: backRect.right <= titleRect.left,
       backAtTop: backRect.top <= titleRect.top + 4,
      titleColor: getComputedStyle(title).color,
       stageBackground: getComputedStyle(stage).backgroundColor,
     };
   });
  expect(layout.titleInside).toBe(true);
  expect(layout.backInside).toBe(true);
    expect(layout.columnsInside).toBe(true);
    expect(layout.backBeforeTitle).toBe(true);
    expect(layout.backAtTop).toBe(true);
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

async function findCanvasPoint(page: Page, predicate: (state: { pixel: number; covered: boolean; selectable: boolean; assetIds: string[] }) => boolean): Promise<{ x: number; y: number; pixel: number }> {
  const hits = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>("#volume-canvas");
    if (!canvas) return [];
    const rect = canvas.getBoundingClientRect();
    const results: Array<{ x: number; y: number; pixel: number; covered: boolean; selectable: boolean; assetIds: string[] }> = [];
    for (let y = 8; y < rect.height - 8; y += 8) {
      for (let x = 8; x < rect.width - 8; x += 8) {
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
        results.push({
          x,
          y,
          pixel,
          covered: canvas.dataset.hoveredCovered === "true",
          selectable: canvas.dataset.hoveredSelectable === "true",
          assetIds: (canvas.dataset.hoveredAssetIds ?? "").split(",").filter(Boolean),
        });
      }
    }
    return results;
  });
  const match = hits.find(predicate);
  if (match) return { x: match.x, y: match.y, pixel: match.pixel };
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
  const canvas = page.locator("#volume-canvas");
  await expect(page.locator("#coverage-context-menu")).toHaveCount(1);
  await expect(page.locator("#coverage-lock-button")).toHaveCount(0);
  await expect(page.locator("#refinement-controls")).toHaveCount(0);
  await expect(page.locator('[data-action="search-region"]')).toHaveCount(0);
  await waitForVisibleAssetCoverage(page);

  const before = await canvas.screenshot({ path: testInfo.outputPath("sphere-overview.png") });
  expect(fragmentPixelCount(before)).toBeGreaterThan(1_000);
  const point = await findCanvasPoint(page, (state) => state.covered && state.selectable && state.assetIds.length > 0);
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

  await canvas.click({ button: "right", position: point });
  await expect(page.locator("#coverage-context-menu")).toBeVisible();
  await expect(page.locator("#coverage-enter-flat")).toHaveText("在 Aladin 中探索");
  await page.locator("#coverage-enter-flat").click();
  const aladin = page.locator("#aladin-explorer");
  await expect(aladin).toBeVisible();
  await expect(page.locator("#aladin-controls")).toBeVisible();
  await expect(page.locator("#aladin-cockpit-rail")).toBeHidden();
  await expect(page.locator(".aladin-sector-banner")).toHaveCount(0);
  await expect(page.locator("#aladin-asset-drawer-toggle")).toBeVisible();
  await page.locator("#aladin-asset-drawer-toggle").click();
  await expect(page.locator("#aladin-cockpit-rail")).toBeVisible();
  await expect(page.locator(".aladin-hud-reticle")).toBeVisible();
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
  const canvas = page.locator("#volume-canvas");
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
  const canvas = page.locator("#volume-canvas");
  const first = await findCanvasPoint(page, (state) => state.covered && state.selectable);
  await canvas.click({ position: first });
  await expect(page.locator("#layer-selection-count")).toHaveText("1 CELLS");
  const second = await findCanvasPoint(page, (state) => state.covered && state.selectable && state.pixel !== first.pixel);
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
  const canvas = page.locator("#volume-canvas");
  await waitForVisibleAssetCoverage(page);
  const point = await findCanvasPoint(page, (state) => state.covered && state.selectable && state.assetIds.length > 0);
  await canvas.click({ position: point, modifiers: ["Control"] });
  await canvas.click({ button: "right", position: point });
  await page.locator("#coverage-enter-flat").click();
  await expect(page.locator("#aladin-explorer")).toBeVisible();
  await expect.poll(() => requests.length, { timeout: 15_000 }).toBeGreaterThan(0);
  await expect(page.locator("#aladin-asset-nav .aladin-asset-button")).toHaveCount(1);
  await page.locator("#aladin-asset-drawer-toggle").click();
  await expect(page.locator("#aladin-explorer")).toHaveAttribute("data-object-returned", "2000", { timeout: 15_000 });
  await expect(page.locator("#aladin-status")).toContainText("2,000 个对象");
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
  const canvas = page.locator("#volume-canvas");
  await waitForVisibleAssetCoverage(page);
  const point = await findCanvasPoint(page, (state) => state.covered && state.selectable && state.assetIds.length > 0);
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
  await expect(page.locator("#layer-visible-output")).toHaveText(/^\d+ ACTIVE · 2 PUBLIC · \d+ OWNED$/);
  await expect(page.locator("[data-layer-interaction]")).toHaveCount(0);
  await expect(page.locator("#layer-tool-strip")).toHaveCount(0);
  await expect(page.locator("#coverage-context-menu")).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("mobile-survey-controls.png"), fullPage: true });
});
