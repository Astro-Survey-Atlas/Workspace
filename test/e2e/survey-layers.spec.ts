import { expect, test, type Page } from "@playwright/test";
import { PNG } from "pngjs";

const apiRoot = process.env.ASTRO_E2E_API ?? "http://astro.agent.dev.72602.online:32080";

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
  await page.locator('[data-mode="layers"]').click();
  await expect(page.locator("#loading-indicator")).not.toHaveClass(/visible/);
  await expect(page.locator("#volume-canvas")).toBeVisible();
  await page.waitForTimeout(900);
}

test("desktop survey footprints are selectable fragments with layer and overlap layouts", async ({ page }, testInfo) => {
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
  await expect(page.locator("#layer-selection-count")).toContainText("已固定");
  await expect(page.locator("#coverage-pin-status")).toHaveClass(/active/);
  await expect(page.locator("#coverage-pin-status")).toHaveText("已固定");
  await page.screenshot({ path: testInfo.outputPath("selected-cell-stack.png"), fullPage: true });

  await page.locator(".survey-card", { hasText: "SDSS" }).locator("input").check();
  await page.locator(".survey-card", { hasText: "HST" }).locator("input").check();
  const visibleIds = (await canvas.getAttribute("data-visible-survey-ids"))?.split(",") ?? [];
  expect(new Set(visibleIds)).toEqual(new Set(["legacy-surveys", "sdss", "hst"]));
  await expect(page.locator("#layer-visible-output")).toHaveText("3 ACTIVE");
  await expect(page.locator("#layer-selection-count")).toContainText("已固定");
  await expect(page.locator("#coverage-pin-status")).toHaveClass(/active/);
  await expect(canvas).toHaveAttribute("data-camera-position", cameraPositionBefore!);
  await page.waitForTimeout(500);
  const multiLayerImage = await canvas.screenshot({ path: testInfo.outputPath("multi-layer-fragments.png") });

  await page.locator('[data-layer-interaction="region"]').click();
  await expect(page.locator("#layer-selection-count")).toHaveText("尚未选择");
  await canvas.click({ position: legacyPoint });
  await expect(page.locator("#layer-selection-count")).toHaveText("已选 1 个");
  await expect(page.locator("#inspector-kicker")).toHaveText("REGION SELECTION");
  await expect(page.locator("#inspector-content")).toContainText("区域已选中");
  await canvas.screenshot({ path: testInfo.outputPath("selected-region-overlay.png") });
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

test("mobile controls expose multi-survey selection and a separate region tool", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openFresh(page);
  await page.locator("#controls-toggle").click();
  await expect(page.locator("#controls-panel")).toHaveClass(/mobile-open/);
  await page.locator(".survey-card", { hasText: "SDSS" }).locator("input").check();
  await expect(page.locator("#layer-visible-output")).toHaveText("2 ACTIVE");
  await page.locator('[data-layer-interaction="region"]').click();
  await expect(page.locator(".region-multi-control")).toHaveCount(0);
  await expect(page.locator("#layer-interaction-note")).toContainText("自动扩展选区");
  await expect(page.locator("#volume-canvas")).toHaveAttribute("data-interaction-mode", "region");
  await page.screenshot({ path: testInfo.outputPath("mobile-survey-controls.png"), fullPage: true });
});
