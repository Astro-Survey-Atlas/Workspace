import { expect, test, type Page } from "@playwright/test";

const apiRoot = process.env.ASTRO_E2E_API ?? "http://astro.workspace.dev.72602.space:32080";

async function apiJson<T>(path: string): Promise<T> {
  const response = await fetch(`${apiRoot}${path}`);
  if (!response.ok) throw new Error(`GET ${path} failed: ${response.status} ${await response.text()}`);
  return await response.json() as T;
}

async function apiResponse(path: string): Promise<Response> {
  return fetch(`${apiRoot}${path}`);
}

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

async function waitForWorkspace(page: Page): Promise<void> {
  await expect(page.locator("#service-status")).toHaveText("SERVICE ONLINE");
  await expect(page.locator("#loading-indicator")).not.toHaveClass(/visible/);
}

test.beforeEach(async ({ page }) => proxyApi(page));

test("theme follows the system until a choice is persisted", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#f4f7f8");
  await expect(page.locator("#theme-toggle")).toHaveAttribute("aria-label", "切换到深色主题");

  await page.locator("#theme-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("#theme-toggle")).toHaveAttribute("title", "切换到浅色主题");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("astro-workspace:theme:v1"))).toBe("dark");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("light theme keeps metrics, actions, overlays, and scroll regions legible", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1440, height: 760 });
  await page.goto("/");
  await waitForWorkspace(page);

  const lightStyles = await page.evaluate(() => {
    const css = (selector: string) => getComputedStyle(document.querySelector<HTMLElement>(selector)!);
    return {
      metric: css("#metric-one").color,
      summary: css("#catalog-user-count").color,
      stage: css("#catalog-stage").backgroundColor,
      overlay: css("#coverage-hover").backgroundColor,
      shadow: getComputedStyle(document.documentElement).getPropertyValue("--shadow").trim(),
    };
  });
  expect(lightStyles.metric).not.toBe("rgb(255, 255, 255)");
  expect(lightStyles.summary).not.toBe("rgb(255, 255, 255)");
  expect(lightStyles.stage).not.toBe("rgb(7, 11, 15)");
  expect(lightStyles.overlay).toMatch(/^rgba?\(255, 255, 255/);
  expect(lightStyles.shadow).not.toBe("");

  await page.locator('[data-mode="packages"]').click();
  const disabledAction = page.locator("#resource-package-apply");
  await expect(disabledAction).toBeDisabled();
  const disabledColors = await disabledAction.evaluate((element) => {
    const style = getComputedStyle(element);
    return { color: style.color, background: style.backgroundColor };
  });
  expect(disabledColors.color).not.toBe("rgb(255, 255, 255)");
  expect(disabledColors.background).not.toBe("rgb(8, 125, 120)");

  const stage = page.locator("#resource-package-stage");
  await stage.hover();
  await expect.poll(() => stage.evaluate((element) => getComputedStyle(element).scrollbarColor))
    .not.toBe("rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)");
});

test("user assets are the default workspace view", async ({ page }) => {
  const { assets } = await apiJson<{ assets: Array<{ name: string; origin: string; status: string }> }>("/api/data-assets?origin=user");
  const catalogRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/data-assets") catalogRequests.push(url.search);
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await waitForWorkspace(page);

  await expect(page.locator('[data-mode="catalog"]')).toHaveClass(/active/);
  await expect(page.locator('[data-mode="catalog"]')).toHaveText("用户资产");
  await expect(page.locator("#catalog-stage")).toBeVisible();
  await expect(page.locator("#scene-stage")).toBeHidden();
  await expect(page.locator("#catalog-asset-list .catalog-row")).toHaveCount(assets.length);
  expect(catalogRequests).toContain("?origin=user");
  await expect(page.locator("#catalog-user-count")).toHaveText(String(assets.length));
  await expect(page.locator("#catalog-ready-count")).toHaveText(String(assets.filter((asset) => asset.status === "ready").length));
  await expect(page.locator("#catalog-asset-list")).not.toContainText("Euclid Q1 MER final catalog");

  if (assets.length > 0) {
    const first = page.locator("#catalog-asset-list .catalog-row").first();
    await first.click();
    await expect(page.locator("#inspector-kicker")).toHaveText("DATA ASSET DETAIL");
    await expect(page.locator("#inspector-content h2")).toHaveText(assets[0]!.name);
    await expect(page.locator("#catalog-stage")).toBeVisible();
    await expect(page.locator("#inspector-content")).toContainText("公开来源");
  } else {
    await expect(page.locator("#catalog-empty")).toBeVisible();
  }

  await page.locator("#catalog-search").fill("__no_matching_asset__");
  await expect(page.locator("#catalog-empty")).toBeVisible();
});

test("data asset origin query filters records and rejects invalid values", async () => {
  const all = await apiJson<{ assets: Array<{ id: string; origin: string }> }>("/api/data-assets");
  const users = await apiJson<{ assets: Array<{ id: string; origin: string }> }>("/api/data-assets?origin=user");
  const builtin = await apiJson<{ assets: Array<{ id: string; origin: string }> }>("/api/data-assets?origin=builtin");

  expect(users.assets.every((asset) => asset.origin === "user")).toBe(true);
  expect(builtin.assets.every((asset) => asset.origin === "builtin")).toBe(true);
  expect([...users.assets, ...builtin.assets].map((asset) => asset.id).sort()).toEqual(all.assets.map((asset) => asset.id).sort());
  const invalid = await apiResponse("/api/data-assets?origin=other");
  expect(invalid.status).toBe(400);
  await expect(invalid.json()).resolves.toEqual({ error: "origin must be user or builtin" });
});

test("mobile catalog keeps creation modal and details reachable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await waitForWorkspace(page);

  await expect(page.locator("#catalog-stage")).toBeVisible();
  await expect(page.locator("#theme-toggle")).toBeVisible();
  await expect(page.locator("#controls-toggle")).toBeVisible();
  await page.locator("#controls-toggle").click();
  await expect(page.locator("#controls-panel")).toHaveClass(/mobile-open/);
  await page.locator("#controls-toggle").click();
  await expect(page.locator("#controls-panel")).not.toHaveClass(/mobile-open/);
  await page.locator("#catalog-new").click();
  await expect(page.locator("#catalog-create-dialog")).toBeVisible();
  await expect(page.locator("#catalog-registration-form")).toBeVisible();
  await page.locator("#catalog-dialog-close").click();
  await expect(page.locator("#catalog-create-dialog")).toBeHidden();
  const first = page.locator("#catalog-asset-list .catalog-row").first();
  if (await first.count()) {
    await first.click();
    await expect(page.locator("#inspector-panel")).toHaveClass(/mobile-open/);
    await expect(page.locator("#inspector-content h2")).toBeVisible();
  }
});

test("data production keeps cross-match runnable and exposes cutout/package contracts", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await waitForWorkspace(page);
  await page.locator('[data-mode="workflow"]').click();
  await expect(page.locator('[data-mode="workflow"]')).toHaveClass(/active/);
  await expect(page.locator('[data-production-action="crossmatch"]')).toHaveClass(/active/);
  await expect(page.locator("#workflow-form")).toBeHidden();
  await page.locator("#workflow-new").click();
  await expect(page.locator("#workflow-form")).toBeVisible();
  await page.locator("#workflow-dialog-close").click();
  await page.locator('[data-production-action="cutout"]').click();
  await expect(page.locator('[data-production-action="cutout"]')).toHaveClass(/active/);
  await expect(page.locator("#workflow-form")).toBeHidden();
  await expect(page.locator("#production-action-copy")).toContainText("cutout");
  await page.locator('[data-production-action="package"]').click();
  await expect(page.locator("#production-action-copy")).toContainText("打包");
});

test("connector view exposes S3, local path, and JDBC registration without scan controls", async ({ page }) => {
  await page.route(/\/api\/connectors\/check$/, async (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ check: { status: "ok", checkedAt: new Date().toISOString(), summary: "连接正常，凭据与 Bucket 均已验证", detail: "未列举或扫描 Prefix。" } }),
  }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await waitForWorkspace(page);
  await page.locator('[data-mode="connectors"]').click();
  await expect(page.locator('[data-mode="connectors"]')).toHaveClass(/active/);
  await expect(page.locator("#connector-stage")).toBeVisible();
  await expect(page.locator("#connector-registration-form")).toBeHidden();
  await page.locator("#connector-new").click();
  await expect(page.locator("#connector-create-dialog")).toBeVisible();
  await expect(page.locator("#connector-registration-form")).toBeVisible();
  await expect(page.locator("#connector-kind option")).toHaveCount(3);
  await expect(page.locator('#connector-registration-form [name="accessKeyId"]')).toBeVisible();
  await expect(page.locator('#connector-registration-form [name="secretAccessKey"]')).toBeVisible();
  await expect(page.locator("#connector-registration-form")).not.toContainText("凭据引用");
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
  await page.locator("#connector-dialog-close").click();
  await expect(page.locator("#connector-create-dialog")).toBeHidden();
  await page.locator("#connector-search").fill("Euclid Q1");
  await expect(page.locator("#connector-list .connector-row")).toHaveCount(1);
  await expect(page.locator("#connector-search-hint")).toContainText("1 /");
  await expect(page.locator("#inspector-view")).toBeVisible();
  await page.locator("#connector-list .connector-row").filter({ hasText: "Euclid Q1" }).click();
  await expect(page.locator("#inspector-content")).toContainText("Access Key");
  await expect(page.locator("#inspector-content")).toContainText("Secret Key");
  await expect(page.locator("#inspector-content")).not.toContainText("凭据引用");
  await page.locator("#inspector-content").getByRole("button", { name: "检测连接" }).click();
  await expect(page.locator("#inspector-content .connector-check-feedback"))
    .toContainText(/连接正常|没有可用的已保存凭据/, { timeout: 20_000 });
  await page.locator("#inspector-content").getByRole("button", { name: "编辑配置" }).click();
  await expect(page.locator("#inspector-content .connector-inline-editor")).toBeVisible();
  await expect(page.locator("#inspector-content .connector-inspector-detail > h2")).toHaveCount(0);
  await expect(page.locator('#inspector-content [name="secretAccessKey"]')).toHaveValue("");
});
