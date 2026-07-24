import { expect, test } from "@playwright/test";

test("data catalog is the default foundation view", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  await expect(page.locator('[data-mode="catalog"]')).toHaveClass(/active/);
  await expect(page.locator("#catalog-stage")).toBeVisible();
  await expect(page.locator("#scene-stage")).toBeHidden();
  await expect(page.locator("#catalog-asset-list .catalog-row")).toHaveCount(8);
  await expect(page.locator("#catalog-builtin-count")).toHaveText("8");
  await expect(page.locator("#catalog-user-count")).toHaveText("0");
  await expect(page.locator("#catalog-ready-count")).toHaveText("2");

  const first = page.locator("#catalog-asset-list .catalog-row").first();
  await expect(first).toContainText("Euclid Q1 MER final catalog");
  await first.click();
  await expect(page.locator("#inspector-kicker")).toHaveText("DATA ASSET");
  await expect(page.locator("#inspector-content")).toContainText("系统内置 · 只读");
  await expect(page.locator("#inspector-content")).toContainText("Euclid");
  await expect(page.locator("#inspector-content")).toContainText("catalog+mcp://euclid-q1-mer-final");

  await page.locator("#catalog-search").fill("DESI-COSMOS");
  await expect(page.locator("#catalog-asset-list .catalog-row")).toHaveCount(1);
  await expect(page.locator("#catalog-asset-list")).toContainText("DESI-COSMOS v2.0 SPECZ");
  await page.locator("#catalog-search").fill("");
  await page.locator("#catalog-origin-filter").selectOption("user");
  await expect(page.locator("#catalog-empty")).toBeVisible();
});

test("mobile catalog keeps registration and details reachable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  await expect(page.locator("#catalog-stage")).toBeVisible();
  await page.locator("#controls-toggle").click();
  await expect(page.locator("#catalog-registration-form")).toBeVisible();
  await page.locator("#controls-toggle").click();
  await page.locator("#catalog-asset-list .catalog-row").first().click();
  await expect(page.locator("#inspector-panel")).toHaveClass(/mobile-open/);
  await expect(page.locator("#inspector-content")).toContainText("Euclid Q1 MER final catalog");
});
