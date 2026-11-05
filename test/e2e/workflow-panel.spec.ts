import { expect, test, type Page } from "@playwright/test";

const apiRoot = process.env.ASTRO_E2E_API ?? "http://astro.workspace.dev.72602.space:32080";

async function proxyAndStubWorkflowApi(page: Page): Promise<void> {
  const workflowKey = "euclid-desi-crossmatch@1";
  const steps = [
    { id: "parse_input", title: "输入校验", kind: "tool", toolId: "input.validate", status: "succeeded", attempts: 1 },
    { id: "query_euclid", title: "查询 Euclid", kind: "tool", toolId: "catalog.euclid", status: "succeeded", attempts: 1 },
    { id: "query_desi", title: "查询 DESI", kind: "tool", toolId: "catalog.desi", status: "succeeded", attempts: 1 },
    { id: "normalize", title: "坐标规范化", kind: "tool", toolId: "catalog.normalize", status: "succeeded", attempts: 1 },
    { id: "crossmatch", title: "球面交叉匹配", kind: "tool", toolId: "crossmatch.nearest_spherical", status: "succeeded", attempts: 1 },
    { id: "human_filter", title: "人工筛选", kind: "human_gate", status: "waiting_for_input", attempts: 0 },
    { id: "cutout", title: "FITS 图像裁切", kind: "tool", toolId: "cutout.execute_grouped", status: "pending", attempts: 0 },
    { id: "export", title: "导出", kind: "export", status: "pending", attempts: 0 },
  ];
  const run = {
    id: "run-e2e-pending",
    workflowId: "euclid-desi-crossmatch",
    workflowVersion: 1,
    workflowKey,
    status: "waiting_for_input",
    createdAt: "2026-11-04T00:00:00.000Z",
    updatedAt: "2026-11-04T00:00:10.000Z",
    input: { raDeg: 12, decDeg: -2, queryRadiusArcsec: 250 },
    steps,
    events: [],
    summary: { euclidRows: 2, desiRows: 3, matchRows: 1 },
    preview: [{ euclidObjectId: "e1", desiObjectId: "d1", separationArcsec: 0.4 }],
    artifacts: [{ name: "crossmatch.csv", mediaType: "text/csv", byteLength: 24, sha256: "a".repeat(64), rowCount: 1 }],
    lineage: { sources: [], artifacts: [], relatedScanRunIds: [] },
    waiting: { reason: "filter", stepId: "human_filter", message: "请由研究者检查 1 个候选。", availableFields: ["separationArcsec"] },
  };
  await page.route("**/api/**", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.pathname === "/api/workflows") {
      await route.fulfill({ json: { workflows: [{ id: "euclid-desi-crossmatch", version: 1, key: workflowKey, title: "Euclid × DESI 交叉匹配", description: "", inputSchema: {}, steps: steps.map(({ id, title, kind, toolId }) => ({ id, title, kind, ...(toolId ? { toolId } : {}), dependsOn: [] })), outputs: [] }] } });
      return;
    }
    if (requestUrl.pathname === "/api/workflow-runs" && route.request().method() === "GET") {
      await route.fulfill({ json: { runs: [{ id: run.id, workflowKey, status: run.status, createdAt: run.createdAt, updatedAt: run.updatedAt, candidateCount: 1, artifactCount: 1, waitingReason: "filter" }] } });
      return;
    }
    if (requestUrl.pathname === `/api/workflow-runs/${run.id}`) {
      await route.fulfill({ json: { run } });
      return;
    }
    if (requestUrl.pathname === "/api/tools") {
      await route.fulfill({ json: { tools: [] } });
      return;
    }
    if (requestUrl.pathname === "/api/data-assets") {
      await route.fulfill({ json: { assets: [] } });
      return;
    }
    if (requestUrl.pathname === "/api/surveys" || requestUrl.pathname === "/api/public-surveys") {
      await route.fulfill({ json: { surveys: [] } });
      return;
    }
    if (requestUrl.pathname === "/api/survey-footprints") {
      await route.fulfill({ json: { schemaVersion: 1, coordinateFrame: "ICRS", ordering: "NESTED", footprints: [] } });
      return;
    }
    if (requestUrl.pathname === "/api/resource-packages/config") {
      await route.fulfill({ json: { config: { catalogUrl: "https://example.invalid", available: false, unavailableReason: "test" } } });
      return;
    }
    if (requestUrl.pathname === "/api/capabilities") {
      await route.fulfill({ json: { dataWarehouse: { enabled: false }, userMocs: { rootConfigured: false, count: 0 }, metadataStore: { engine: "sqlite" } } });
      return;
    }
    if (requestUrl.pathname === "/api/agent/workspace-sessions") {
      if (route.request().method() === "GET") {
        await route.fulfill({ json: { sessions: [] } });
      } else {
        await route.fulfill({ json: { session: { id: "session-e2e", createdAt: "2026-11-04T00:00:00.000Z", updatedAt: "2026-11-04T00:00:00.000Z", messages: [] } } });
      }
      return;
    }
    if (requestUrl.pathname === "/api/production-pipelines") {
      await route.fulfill({ json: { pipelines: [] } });
      return;
    }
    if (requestUrl.pathname === "/api/production-runs") {
      await route.fulfill({ json: { runs: [] } });
      return;
    }
    if (requestUrl.pathname === "/api/connectors") {
      await route.fulfill({ json: { connectors: [] } });
      return;
    }
    if (requestUrl.pathname === "/api/coverage-downloads") {
      await route.fulfill({ json: { jobs: [] } });
      return;
    }
    try {
      const response = await route.fetch({ url: `${apiRoot}${requestUrl.pathname}${requestUrl.search}`, timeout: 10_000 });
      await route.fulfill({ response });
    } catch {
      await route.abort().catch(() => undefined);
    }
  });
}

test("data production restores a pending Workflow and keeps pipeline tools available", async ({ page }) => {
  await proxyAndStubWorkflowApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?mode=workflow");

  await expect(page.locator("#service-status")).toHaveText("SERVICE ONLINE");
  await expect(page.locator("#workflow-stage")).toBeVisible();
  await expect(page.locator("#workflow-gate")).toBeVisible();
  await expect(page.locator("#workflow-gate-title")).toHaveText("等待人工筛选");
  await expect(page.locator("#workflow-run-id")).toHaveAttribute("title", "run-e2e-pending");
  await expect(page.locator("#workflow-run-history .workflow-history-row")).toHaveCount(1);
  await expect(page.locator("#workflow-accept-all")).toBeVisible();

  await page.locator("#production-view-pipelines").click();
  await expect(page.locator("#production-stage")).toBeVisible();
  await expect(page.locator("#workflow-stage")).toBeHidden();
  await expect(page.locator("#production-template-sidebar")).toBeVisible();

  await page.locator("#production-view-workflow").click();
  await expect(page.locator("#workflow-stage")).toBeVisible();
  await expect(page.locator("#workflow-gate")).toBeVisible();
});
