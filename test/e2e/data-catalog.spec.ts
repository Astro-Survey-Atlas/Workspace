import { expect, test, type Page } from "@playwright/test";
import type { ConnectorIngestRun } from "../../src/connector-history.js";

const apiRoot = process.env.ASTRO_E2E_API ?? "http://astro.workspace.dev.72602.space:32080";
const TRANSIENT_STATUSES = new Set([502, 503, 504]);

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

async function apiJson<T>(path: string): Promise<T> {
  const response = await fetchWithRetry(`${apiRoot}${path}`);
  if (!response.ok) throw new Error(`GET ${path} failed: ${response.status} ${await response.text()}`);
  return await response.json() as T;
}

async function apiResponse(path: string): Promise<Response> {
  return fetchWithRetry(`${apiRoot}${path}`);
}

async function proxyApi(page: Page): Promise<void> {
  await page.route("**/api/**", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.origin === new URL(apiRoot).origin) {
      await route.continue();
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

async function waitForWorkspace(page: Page): Promise<void> {
  await expect(page.locator("#service-status")).toHaveText("SERVICE ONLINE");
  await expect(page.locator("#loading-indicator")).not.toHaveClass(/visible/);
}

async function openCatalog(page: Page): Promise<void> {
  const catalog = page.locator('[data-mode="catalog"]');
  if (!await catalog.evaluate((button) => button.classList.contains("active"))) await catalog.click();
  await expect(catalog).toHaveClass(/active/);
  await expect(page.locator("#catalog-stage")).toBeVisible();
}

test.beforeEach(async ({ page }) => proxyApi(page));
test.afterEach(async ({ page }) => page.close());
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
  await openCatalog(page);

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

test("status explanations are available where records are evaluated", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await waitForWorkspace(page);
  await openCatalog(page);

  const assetHelp = page.locator(".catalog-columns .status-help");
  await expect(assetHelp.locator("svg")).toBeVisible();
  await assetHelp.focus();
  const assetTooltip = page.locator(`#${await assetHelp.getAttribute("aria-describedby")}`);
  await expect(assetTooltip).toBeVisible();
  await expect(assetTooltip).toContainText("计划中");

  await page.locator('[data-mode="packages"]').click();
  const coverageHelp = page.locator(".resource-package-columns .status-help").first();
  await coverageHelp.focus();
  await expect(page.locator(`#${await coverageHelp.getAttribute("aria-describedby")}`)).toContainText("真实覆盖");

  await page.locator('[data-mode="connectors"]').click();
  const connectorHelp = page.locator(".connector-columns .status-help");
  await connectorHelp.focus();
  await expect(page.locator(`#${await connectorHelp.getAttribute("aria-describedby")}`)).toContainText("未检测");

  await page.locator('[data-mode="workflow"]').click();
  const workflowHelp = page.locator("#pipeline-heading .status-help");
  await workflowHelp.focus();
  await expect(page.locator(`#${await workflowHelp.getAttribute("aria-describedby")}`)).toContainText("等待输入");
});

test("user assets remain reachable from the workspace navigation", async ({ page }) => {
  const { assets } = await apiJson<{ assets: Array<{ name: string; origin: string; status: string }> }>("/api/data-assets");
  const catalogRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/data-assets") catalogRequests.push(url.search);
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await waitForWorkspace(page);
  await openCatalog(page);

  await expect(page.locator('[data-mode="catalog"]')).toHaveClass(/active/);
  await expect(page.locator('[data-mode="catalog"]')).toHaveText("用户资产");
  await expect(page.locator("#catalog-stage")).toBeVisible();
  await expect(page.locator("#scene-stage")).toBeHidden();
  await expect(page.locator("#catalog-asset-list .catalog-row")).toHaveCount(assets.length);
  expect(catalogRequests).toContain("");
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
     await expect(page.locator("#inspector-content.catalog-inspector-content")).toBeVisible();
     await expect(page.locator(".catalog-inspector-section-heading .text-button")).toHaveCount(4);
     await expect(page.locator(".catalog-inspector-actions")).toHaveCount(1);
     const inspectorLayout = await page.locator("#inspector-content").evaluate((content) => {
       const headings = [...content.querySelectorAll<HTMLElement>(".catalog-inspector-section-heading")];
       const buttons = headings.map((heading) => heading.querySelector<HTMLElement>(".text-button")!.getBoundingClientRect());
       const actions = content.querySelector<HTMLElement>(".catalog-inspector-actions")!.getBoundingClientRect();
       return {
         headingCount: headings.length,
         buttonsInside: buttons.every((button, index) => button.right <= content.getBoundingClientRect().right && button.left >= headings[index]!.getBoundingClientRect().left),
         actionWidth: actions.width,
       };
     });
     expect(inspectorLayout.headingCount).toBe(4);
     expect(inspectorLayout.buttonsInside).toBe(true);
     expect(inspectorLayout.actionWidth).toBeGreaterThan(0);
  } else {
    await expect(page.locator("#catalog-empty")).toBeVisible();
  }

  await page.locator("#catalog-search").fill("__no_matching_asset__");
  await expect(page.locator("#catalog-empty")).toBeVisible();
});

test("data asset API exposes only Atlas user records", async () => {
  const all = await apiJson<{ assets: Array<{ id: string; origin: string }> }>("/api/data-assets");
  expect(all.assets.every((asset) => asset.origin === "user")).toBe(true);
  const filtered = await apiResponse("/api/data-assets?origin=user");
  expect(filtered.status).toBe(400);
  await expect(filtered.json()).resolves.toEqual({ error: "data asset origin filters are not supported" });
});

test("mobile catalog keeps creation modal and details reachable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await waitForWorkspace(page);
  await openCatalog(page);

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
  await expect(page.locator("#catalog-product")).toHaveCount(0);
  await expect(page.locator("#catalog-status-input")).toHaveCount(0);
  await expect(page.locator("#catalog-project-state-list")).toHaveCount(0);
  await expect(page.locator("#catalog-tags")).toHaveCount(0);
  await expect(page.locator("#catalog-new-connector")).toBeVisible();
  await expect(page.locator(".catalog-connector-field legend")).toContainText("Connector");
  await expect(page.locator(".catalog-connector-field legend")).toContainText("必选");
  await expect(page.locator(".catalog-connector-field")).not.toContainText("可选");
  const connectorChoices = page.locator('#catalog-connector-list input[type="radio"]');
  if (await connectorChoices.count()) {
    await expect(connectorChoices.first()).toHaveAttribute("required", "");
    await connectorChoices.first().check();
    if (await connectorChoices.count() > 1) {
      await connectorChoices.nth(1).check();
      await expect(connectorChoices.first()).not.toBeChecked();
      await expect(connectorChoices.nth(1)).toBeChecked();
    }
  } else {
    await expect(page.locator("#catalog-connector-list")).toContainText("请先新建一个 Connector");
  }
  await expect(page.locator("#catalog-description")).toBeVisible();
  await page.locator("#catalog-dialog-close").click();
  await expect(page.locator("#catalog-create-dialog")).toBeHidden();
  const first = page.locator("#catalog-asset-list .catalog-row").first();
  if (await first.count()) {
    await first.click();
     await expect(page.locator("#inspector-panel")).toHaveClass(/mobile-open/);
     await expect(page.locator("#inspector-content h2")).toBeVisible();
     await expect(page.locator(".catalog-inspector-section-heading .text-button")).toHaveCount(4);
     await expect(page.locator(".catalog-inspector-actions .command-button")).toBeVisible();
   }
});

test("local asset registration inspects CSV columns before creating a scan spec", async ({ page }) => {
  const localConnector = {
    id: "e2e-local-csv",
    locationKey: "local:///data/e2e-csv",
    displayPath: "/data/e2e-csv",
    name: "E2E local CSV",
    description: "Local CSV fixture",
    kind: "local",
    config: { rootPath: "/data/e2e-csv" },
    status: "ready",
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
    origin: "user",
    credentials: { accessKeyId: "", secretConfigured: false },
  };
  const existing = await apiJson<{ connectors: unknown[] }>("/api/connectors");
  let inspectBody: unknown;
  await page.route("**/api/connectors", async (route) => {
    await route.fulfill({ json: { connectors: [...existing.connectors, localConnector] } });
  });
  await page.route("**/api/connectors/e2e-local-csv/local-files", async (route) => {
    await route.fulfill({ json: { files: [{ relativePath: "catalog.csv", byteSize: 2048, modifiedAt: "2026-08-14T00:00:00.000Z" }] } });
  });
  await page.route("**/api/connectors/e2e-local-csv/local-files/inspect", async (route) => {
    inspectBody = route.request().postDataJSON();
    await route.fulfill({ json: {
      inspection: {
        sourceRelativePath: "catalog.csv",
        columns: [{ name: "object_id", type: "string" }, { name: "ra_deg", type: "number" }, { name: "dec_deg", type: "number" }, { name: "flux", type: "number" }],
        inferred: { objectIdColumn: "object_id", raColumn: "ra_deg", decColumn: "dec_deg", confidence: 0.96 },
      },
    } });
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await waitForWorkspace(page);
  await openCatalog(page);
  await page.locator("#catalog-new").click();
  const localRadio = page.locator('#catalog-connector-list input[type="radio"][value="local:///data/e2e-csv"]');
  await expect(localRadio).toBeVisible();
  await localRadio.check();

  const scanFieldset = page.locator("#catalog-scan-fieldset");
  await expect(scanFieldset).toBeVisible();
  await expect(page.locator("#catalog-source-file")).toHaveValue("catalog.csv");
  await expect(page.locator("#catalog-scan-feedback")).toHaveCount(0);

  await page.locator("#catalog-inspect-file").click();
  await expect.poll(() => inspectBody).toEqual({ sourceRelativePath: "catalog.csv" });
  await expect(page.locator("#catalog-object-id-column")).toHaveValue("object_id");
  await expect(page.locator("#catalog-ra-column")).toHaveValue("ra_deg");
  await expect(page.locator("#catalog-dec-column")).toHaveValue("dec_deg");
  await expect(page.locator("#workspace-notification-deck .workspace-notification").last()).toContainText("本地文件表头已读取");
  await expect(page.locator("#workspace-notification-deck .workspace-notification").last()).toContainText("4 个字段");
  await expect(page.locator("#workspace-notification-deck .workspace-notification").last()).toContainText("96%");
  await page.locator("#catalog-dialog-close").click();
});

test("workspace notifications share one mobile deck with dedupe, cap, and expiry", async ({ page }) => {
  test.setTimeout(45_000);
  const localConnector = {
    id: "e2e-notification-local",
    locationKey: "local:///data/e2e-notifications",
    displayPath: "/data/e2e-notifications",
    name: "E2E notification CSV",
    description: "Notification fixture",
    kind: "local",
    config: { rootPath: "/data/e2e-notifications" },
    status: "ready",
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
    origin: "user",
    credentials: { accessKeyId: "", secretConfigured: false },
  };
  await page.route("**/api/connectors", async (route) => {
    await route.fulfill({ json: { connectors: [localConnector] } });
  });
  const files = Array.from({ length: 6 }, (_, index) => ({
    relativePath: `catalog-${index + 1}.csv`,
    byteSize: 1024 + index,
    modifiedAt: "2026-08-14T00:00:00.000Z",
  }));
  await page.route("**/api/connectors/e2e-notification-local/local-files", async (route) => {
    await route.fulfill({ json: { files } });
  });
  await page.route("**/api/connectors/e2e-notification-local/local-files/inspect", async (route) => {
    const body = route.request().postDataJSON() as { sourceRelativePath?: string };
    const fileIndex = Number(body.sourceRelativePath?.match(/(\d+)/)?.[1] ?? 1);
    await route.fulfill({ json: {
      inspection: {
        sourceRelativePath: body.sourceRelativePath,
        columns: [
          { name: "object_id", type: "string" },
          { name: "ra_deg", type: "number" },
          { name: "dec_deg", type: "number" },
          ...Array.from({ length: fileIndex }, (_, index) => ({ name: `value_${index + 1}`, type: "number" })),
        ],
        inferred: { objectIdColumn: "object_id", raColumn: "ra_deg", decColumn: "dec_deg", confidence: 0.9 },
      },
    } });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await waitForWorkspace(page);
  await openCatalog(page);
  await page.locator("#catalog-new").click();
  await page.locator('#catalog-connector-list input[type="radio"][value="local:///data/e2e-notifications"]').check();
  await expect(page.locator("#catalog-source-file option")).toHaveCount(files.length);
  await page.locator("#workspace-notification-deck").evaluate((element) => element.replaceChildren());

  const inspect = page.locator("#catalog-inspect-file");
  await page.locator("#catalog-source-file").selectOption("catalog-1.csv");
  await inspect.click();
  const firstNotification = page.locator("#workspace-notification-deck .workspace-notification").last();
  await expect(firstNotification).toContainText("本地文件表头已读取");
  await expect(firstNotification.locator("strong")).toHaveCount(1);
  await expect(firstNotification.locator("small")).toHaveCount(1);
  await expect(firstNotification.evaluate((element) => [...element.children].map((child) => child.tagName))).resolves.toEqual(["STRONG", "SMALL"]);
  const mobileDeck = await page.locator("#workspace-notification-deck").boundingBox();
  expect(mobileDeck).not.toBeNull();
  expect(mobileDeck!.width).toBeLessThanOrEqual(374);

  // Two identical inspections are emitted inside the short dedupe window.
  await Promise.all([inspect.click(), inspect.click()]);
  await expect.poll(() => page.locator("#workspace-notification-deck .workspace-notification").count()).toBeLessThanOrEqual(2);

  for (const file of files.slice(1)) {
    await page.locator("#catalog-source-file").selectOption(file.relativePath);
    await inspect.click();
    await expect(page.locator("#workspace-notification-deck .workspace-notification").last()).toContainText("本地文件表头已读取");
  }
  await expect(page.locator("#workspace-notification-deck .workspace-notification")).toHaveCount(5);
  await expect(page.locator("#catalog-dialog-close")).toBeVisible();
  await expect(page.locator("#workspace-notification-deck .workspace-notification")).toHaveCount(0, { timeout: 12_000 });
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

test("connector view exposes S3, local path, and JDBC registration without scan parameter controls", async ({ page }) => {
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
  await expect(page.locator("#connector-status")).toHaveCount(0);
  await expect(page.locator('#connector-registration-form [name="status"]')).toHaveCount(0);
  await expect(page.locator('#connector-registration-form [name="accessKeyId"]')).toBeVisible();
  await expect(page.locator('#connector-registration-form [name="secretAccessKey"]')).toBeVisible();
  await expect(page.locator("#connector-registration-form")).not.toContainText("凭据引用");
  await page.locator("#connector-name").fill("UI connection verification");
  await page.locator("#connector-s3-endpoint").fill("https://s3.example");
  await page.locator("#connector-s3-bucket").fill("fixture");
  await page.locator('#connector-registration-form [name="accessKeyId"]').fill("fixture-access");
  await page.locator('#connector-registration-form [name="secretAccessKey"]').fill("fixture-secret");
  await expect(page.locator("#connector-check-form")).toBeEnabled();
  await expect(page.locator("#connector-form-message")).toHaveCount(0);
  await expect(page.locator("#workspace-notification-deck")).toHaveCount(1);
  await page.locator("#connector-kind").selectOption("local");
  await expect(page.locator("#connector-local-root")).toBeVisible();
  await page.locator("#connector-kind").selectOption("jdbc");
  await expect(page.locator("#connector-jdbc-url")).toBeVisible();
  await expect(page.locator("#connector-config-s3")).toBeHidden();
  await page.locator("#connector-dialog-close").click();
  await expect(page.locator("#connector-create-dialog")).toBeHidden();
  const connectorRows = page.locator("#connector-list .connector-row");
  if (await connectorRows.count()) {
    const connector = connectorRows.first();
    const name = (await connector.locator("strong").textContent())?.trim() ?? "";
    await page.locator("#connector-search").fill(name);
    await expect(connectorRows).toHaveCount(1);
    await expect(page.locator("#inspector-view")).toBeVisible();
    await connector.click();
    await expect(page.locator("#inspector-content")).toContainText(name);
    const edit = page.locator("#inspector-content").getByRole("button", { name: "编辑配置" });
    await expect(edit).toHaveAttribute("title", "编辑配置");
    await expect(edit.locator("svg")).toBeVisible();
    await edit.click();
    await expect(page.locator("#inspector-content .connector-inline-editor")).toBeVisible();
    await expect(page.locator("#inspector-content .connector-inspector-detail > h2")).toHaveCount(0);
  }
});

test("survey registration belongs to user assets, not public resources or connector configuration", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await waitForWorkspace(page);

  await page.locator('[data-mode="connectors"]').click();
  await expect(page.locator('#connector-list-search [data-action="new-survey"]')).toHaveCount(0);

  await page.locator('[data-mode="catalog"]').click();
  await page.locator("#catalog-new").click();
  await expect(page.locator("#catalog-create-dialog")).toBeVisible();
  await expect(page.locator("#catalog-new-survey")).toBeVisible();
  await page.locator("#catalog-new-survey").click();
  await expect(page.locator("#survey-registration-dialog")).toBeVisible();
  await page.locator("#survey-registration-close").click();

  await page.locator('[data-mode="packages"]').click();
  await expect(page.locator('#resource-package-stage [data-action="new-survey"]')).toHaveCount(0);
});

test("connector actions and unified scan history expose only supported execution", async ({ page }) => {
  const now = "2026-08-13T10:00:00.000Z";
  let warehouseEnabled = true;
  let submittedBody: unknown;
  const connectors = [
    {
      id: "connector-s3-fixture", locationKey: "s3://fixture/catalog", displayPath: "s3://fixture/catalog",
      name: "S3 science archive", description: "Fixture S3 connector", kind: "s3", config: { bucket: "fixture", prefix: "catalog", region: "us-east-1" },
      status: "ready", createdAt: now, updatedAt: now, origin: "user",
      lastCheck: { status: "ok", checkedAt: now, summary: "连接正常" }, credentials: { accessKeyId: "fixture-access", secretConfigured: true },
    },
    {
      id: "connector-local-fixture", locationKey: "local:///data/catalog", displayPath: "/data/catalog",
      name: "Local mounted catalog", description: "Fixture local connector", kind: "local", config: { rootPath: "/data/catalog" },
      status: "ready", createdAt: now, updatedAt: now, origin: "user", credentials: { accessKeyId: "", secretConfigured: false },
    },
    {
      id: "connector-jdbc-fixture", locationKey: "jdbc:fixture", displayPath: "jdbc:postgresql://db/catalog/public",
      name: "JDBC science database", description: "Fixture JDBC connector", kind: "jdbc", config: { url: "jdbc:postgresql://db/catalog", schema: "public" },
      status: "ready", createdAt: now, updatedAt: now, origin: "user", credentials: { accessKeyId: "", secretConfigured: false },
    },
  ];
  const runs: ConnectorIngestRun[] = [
    {
      id: "run-flink", locationKey: "s3://fixture/catalog", connectorId: "connector-s3-fixture", connectorName: "S3 science archive", connectorKind: "s3", executor: "flink-ingest",
      target: { uri: "s3://fixture/catalog" }, assetIds: ["asset-s3"], status: "running", startedAt: now, createdAt: now, jobId: "flink-scan-01", fileCount: 12,
    },
    {
      id: "run-local", locationKey: "local:///data/catalog", connectorId: "connector-local-fixture", connectorName: "Local mounted catalog", connectorKind: "local", executor: "local-filesystem",
      target: { uri: "file:///data/catalog" }, assetIds: ["asset-local"], status: "succeeded", startedAt: now, completedAt: now, createdAt: now, fileCount: 8, documentCount: 8,
    },
    {
      id: "run-jdbc", locationKey: "jdbc:fixture", connectorId: "connector-jdbc-fixture", connectorName: "JDBC science database", connectorKind: "jdbc", executor: "jdbc-query",
      target: { uri: "jdbc:postgresql://db/catalog/public" }, assetIds: ["asset-jdbc"], status: "failed", startedAt: now, completedAt: now, createdAt: now, error: "Query executor unavailable",
    },
  ];

  await page.route("**/api/capabilities", (route) => route.fulfill({ json: { dataWarehouse: { enabled: warehouseEnabled }, metadataStore: { engine: "postgres" } } }));
  await page.route("**/api/connectors", (route) => route.fulfill({ json: { connectors } }));
  await page.route("**/api/connector-ingest-runs", (route) => route.fulfill({ json: { runs } }));
  await page.route("**/api/connectors/connector-s3-fixture/scan-runs", async (route) => {
    submittedBody = route.request().postDataJSON();
    const run: ConnectorIngestRun = { ...runs[0]!, id: "run-submitted", jobId: "flink-scan-02", status: "queued" };
    runs.unshift(run);
    await route.fulfill({ status: 202, json: { run } });
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await waitForWorkspace(page);
  await page.locator('[data-mode="connectors"]').click();

  const inspector = page.locator("#inspector-content");
  await expect(inspector).toContainText("S3 science archive");
  await expect(inspector.locator(".connector-scan-form")).toHaveCount(0);
  await expect(inspector).not.toContainText(/扫描路径|文件后缀|空间模式|小批|pilot/i);
  for (const label of ["检测连接", "编辑配置", "删除 Connector"]) {
    const action = inspector.getByRole("button", { name: label });
    await expect(action).toHaveAttribute("title", label);
    await expect(action.locator("svg")).toBeVisible();
  }
  const iconTops = await inspector.locator(".connector-icon-actions button").evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().top));
  expect(new Set(iconTops.map((top) => Math.round(top))).size).toBe(1);

  const execute = inspector.getByRole("button", { name: "执行扫描" });
  await expect(execute).toBeEnabled();
  await expect(execute).toHaveClass(/primary-command/);
  await execute.click();
  await expect(page.locator("#workspace-notification-deck .workspace-notification").filter({ hasText: "普通扫描任务已提交" })).toBeVisible();
  expect(submittedBody).toEqual({});

  await page.getByRole("tab", { name: "扫描记录" }).click();
  await expect(page.locator("#connector-history-view")).toBeVisible();
  await expect(page.locator("#connector-list-view")).toBeHidden();
  await expect(page.locator("#connector-history-list .connector-history-row")).toHaveCount(4);
  await expect(page.locator("#connector-history-list")).toContainText("flink-ingest");
  await expect(page.locator("#connector-history-list")).toContainText("local-filesystem");
  await expect(page.locator("#connector-history-list")).toContainText("jdbc-query");
  await page.locator("#connector-run-kind-filter").selectOption("local");
  await expect(page.locator("#connector-history-list .connector-history-row")).toHaveCount(1);
  await page.locator("#connector-history-list .connector-history-row").click();
  await expect(page.locator("#inspector-kicker")).toHaveText("SCAN RUN DETAIL");
  await expect(inspector).toContainText("local-filesystem");
  await expect(inspector).toContainText("file:///data/catalog");
  await page.locator("#connector-run-kind-filter").selectOption("all");
  await page.locator("#connector-run-status-filter").selectOption("failed");
  await expect(page.locator("#connector-history-list .connector-history-row")).toHaveCount(1);
  await expect(page.locator("#connector-history-list")).toContainText("JDBC science database");

  await page.getByRole("tab", { name: "Connector list" }).click();
  await page.locator("#connector-list .connector-row", { hasText: "Local mounted catalog" }).click();
  await expect(inspector.getByRole("button", { name: "执行扫描" })).toBeDisabled();
  await expect(inspector).toContainText("本地路径扫描执行器尚未接入");
  await page.locator("#connector-list .connector-row", { hasText: "JDBC science database" }).click();
  await expect(inspector.getByRole("button", { name: "执行扫描" })).toBeDisabled();
  await expect(inspector).toContainText("JDBC 扫描执行器尚未接入");

  warehouseEnabled = false;
  await page.locator('[data-mode="catalog"]').click();
  await page.locator('[data-mode="connectors"]').click();
  await page.locator("#connector-list .connector-row", { hasText: "S3 science archive" }).click();
  await expect(inspector.getByRole("button", { name: "执行扫描" })).toBeDisabled();
  await expect(inspector).toContainText("数据仓库不可用");
});
