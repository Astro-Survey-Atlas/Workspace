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
  await expect(page.locator("#catalog-ready-count")).toHaveText("3");

  const first = page.locator("#catalog-asset-list .catalog-row").first();
  await expect(first).toContainText("Euclid Q1 MER final catalog");
  await expect(first.locator(".catalog-status")).toHaveText("公开参考 · 已掌握");
  await first.click();
  await expect(page.locator("#inspector-kicker")).toHaveText("LINEAGE NAVIGATOR");
  await expect(page.locator("#inspector-content")).toContainText("暂无派生关系");
  await expect(page.locator("#inspector-content")).toContainText("Euclid");
  await expect(page.locator("#inspector-content")).toContainText("catalog+mcp://euclid-q1-mer-final");
  await expect(page.locator("#asset-detail-stage")).toBeVisible();
  await expect(page.locator("#asset-detail-body")).toContainText("公开来源");
  await page.locator("#asset-detail-back").click();

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

test("data production keeps cross-match runnable and exposes cutout/package contracts", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.locator('[data-mode="workflow"]').click();
  await expect(page.locator('[data-mode="workflow"]')).toHaveClass(/active/);
  await expect(page.locator('[data-production-action="crossmatch"]')).toHaveClass(/active/);
  await expect(page.locator("#workflow-form")).toBeVisible();
  await page.locator('[data-production-action="cutout"]').click();
  await expect(page.locator('[data-production-action="cutout"]')).toHaveClass(/active/);
  await expect(page.locator("#workflow-form")).toBeHidden();
  await expect(page.locator("#production-action-copy")).toContainText("cutout");
  await page.locator('[data-production-action="package"]').click();
  await expect(page.locator("#production-action-copy")).toContainText("打包");
});

test("connector view exposes S3, local path, and JDBC registration without scan controls", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.locator('[data-mode="connectors"]').click();
  await expect(page.locator('[data-mode="connectors"]')).toHaveClass(/active/);
  await expect(page.locator("#connector-stage")).toBeVisible();
  await expect(page.locator("#connector-registration-form")).toBeVisible();
  await expect(page.locator("#connector-kind option")).toHaveCount(3);
  await expect(page.locator('#connector-registration-form [name="accessKeyId"]')).toBeVisible();
  await expect(page.locator('#connector-registration-form [name="secretAccessKey"]')).toBeVisible();
  await expect(page.locator("#connector-registration-form")).not.toContainText("凭据引用");
  await page.route("**/api/connectors/check", async (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ check: { status: "ok", checkedAt: new Date().toISOString(), summary: "连接正常，凭据与 Bucket 均已验证", detail: "未列举或扫描 Prefix。" } }),
  }));
  await page.locator("#connector-name").fill("UI connection verification");
  await page.locator("#connector-s3-endpoint").fill("https://s3.example");
  await page.locator("#connector-s3-bucket").fill("fixture");
  await page.locator('#connector-registration-form [name="accessKeyId"]').fill("fixture-access");
  await page.locator('#connector-registration-form [name="secretAccessKey"]').fill("fixture-secret");
  await page.locator("#connector-check-form").click();
  await expect(page.locator("#connector-form-message")).toHaveAttribute("data-status", "ok");
  await expect(page.locator("#connector-form-message")).toContainText("连接正常");
  await page.locator("#connector-kind").selectOption("local");
  await expect(page.locator("#connector-local-root")).toBeVisible();
  await page.locator("#connector-kind").selectOption("jdbc");
  await expect(page.locator("#connector-jdbc-url")).toBeVisible();
  await expect(page.locator("#connector-config-s3")).toBeHidden();
  await expect(page.locator("#connector-controls")).toContainText("不枚举或扫描目录");
  await expect(page.locator("#inspector-view")).toBeVisible();
  await page.locator("#connector-list .connector-row").filter({ hasText: "Euclid Q1" }).click();
  await expect(page.locator("#inspector-content")).toContainText("Access Key");
  await expect(page.locator("#inspector-content")).toContainText("Secret Key");
  await expect(page.locator("#inspector-content")).not.toContainText("凭据引用");
  await page.locator("#inspector-content").getByRole("button", { name: "检测连接" }).click();
  await expect(page.locator("#inspector-content .connector-check-feedback")).toContainText("连接正常");
  await page.locator("#inspector-content").getByRole("button", { name: "编辑配置" }).click();
  await expect(page.locator("#inspector-content .connector-inline-editor")).toBeVisible();
  await expect(page.locator("#inspector-content .connector-inspector-detail > h2")).toHaveCount(0);
  await expect(page.locator('#inspector-content [name="accessKeyId"]')).not.toHaveValue("");
  await expect(page.locator('#inspector-content [name="secretAccessKey"]')).toHaveValue("");
});
