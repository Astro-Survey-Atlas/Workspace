import { expect, test, type Page } from "@playwright/test";

const apiRoot = process.env.ASTRO_E2E_API ?? "http://astro.workspace.dev.72602.space:32080";
const TRANSIENT_STATUSES = new Set([502, 503, 504]);

async function retryDelay(attempt: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
}

async function proxyApi(page: Page): Promise<void> {
  await page.route("**/api/**", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.pathname.startsWith("/api/agent/workspace-sessions")) {
      const path = requestUrl.pathname;
      const session = {
        id: "wag_e2e_layout",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        messages: [{ id: "msg_ready", role: "assistant", content: "Agent ready", createdAt: "2026-01-01T00:00:00.000Z" }],
      };
      if (requestUrl.pathname === "/api/agent/workspace-sessions" && route.request().method() === "GET") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sessions: [session] }) });
        return;
      }
      if (requestUrl.pathname === "/api/agent/workspace-sessions" && route.request().method() === "POST") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ session }) });
        return;
      }
      if (path === "/api/agent/workspace-sessions/wag_e2e_layout/messages" && route.request().method() === "POST") {
        const body = JSON.parse(route.request().postData() ?? "{}") as { message?: string };
        const updated = { ...session, updatedAt: "2026-01-01T00:00:01.000Z", messages: [...session.messages, { id: "msg_user", role: "user", content: body.message ?? "", createdAt: "2026-01-01T00:00:01.000Z" }] };
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ session: updated }) });
        return;
      }
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        let response = await route.fetch({ url: `${apiRoot}${requestUrl.pathname}${requestUrl.search}`, timeout: 10_000 });
        if (!TRANSIENT_STATUSES.has(response.status()) || attempt === 2) {
          await route.fulfill({ response });
          return;
        }
        await response.body().catch(() => undefined);
        await retryDelay(attempt);
      } catch {
        if (attempt === 2) { await route.abort().catch(() => undefined); return; }
        await retryDelay(attempt);
      }
    }
  });
}

async function waitForWorkspace(page: Page): Promise<void> {
  await expect.poll(() => page.locator("#service-status").textContent()).toBe("SERVICE ONLINE");
  await expect(page.locator("#loading-indicator")).not.toHaveClass(/visible/);
}

interface LayoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
}

async function readAgentLayout(page: Page): Promise<{
  topbar: LayoutRect;
  scene: LayoutRect;
  panel: LayoutRect;
  statusbar: LayoutRect;
}> {
  return page.evaluate(() => {
    const read = (selector: string): LayoutRect => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`Missing layout element: ${selector}`);
      return element.getBoundingClientRect().toJSON();
    };
    return { topbar: read(".topbar"), scene: read("#scene-stage"), panel: read("#agent-panel"), statusbar: read(".statusbar") };
  });
}

test("agent dock has one input and pushes the workspace content", async ({ page }) => {
  await proxyApi(page);
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?mode=layers");
  await waitForWorkspace(page);

  const before = await readAgentLayout(page);
  await page.locator("#agent-collapsed-input").fill("布局回归测试");
  await page.locator("#agent-collapsed-form").dispatchEvent("submit");
  await expect(page.locator("#agent-panel")).toBeVisible();
  await expect(page.locator("#agent-expanded-form")).toHaveCount(0);
  await expect(page.locator("form:visible")).toHaveCount(1);
  await expect(page.locator("#agent-collapse")).toHaveAttribute("aria-label", "关闭 Agent");
  const closeColors = await page.locator("#agent-collapse").evaluate((element) => {
    const style = getComputedStyle(element);
    return { color: style.color, background: style.backgroundColor };
  });
  expect(closeColors.color).not.toBe("rgb(255, 255, 255)");
  expect(closeColors.color).not.toBe(closeColors.background);

  const after = await readAgentLayout(page);
  const shift = before.topbar.y - after.topbar.y;
  expect(shift).toBeGreaterThan(1);
  expect(Math.abs(after.topbar.height - before.topbar.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.scene.height - before.scene.height)).toBeLessThanOrEqual(1);
  expect(Math.abs((before.scene.y - after.scene.y) - shift)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.panel.y - after.scene.bottom)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.panel.bottom - after.statusbar.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.statusbar.bottom - 900)).toBeLessThanOrEqual(1);
  const inputBar = await page.locator(".statusbar").evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      borderWidths: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth],
      borderStyles: [style.borderTopStyle, style.borderRightStyle, style.borderBottomStyle, style.borderLeftStyle],
      boxShadow: style.boxShadow,
    };
  });
  expect(inputBar.borderWidths).toEqual(["0px", "0px", "0px", "0px"]);
  expect(inputBar.borderStyles).toEqual(["none", "none", "none", "none"]);
  expect(inputBar.boxShadow).toBe("none");
});

test("agent dock opens existing history without sending a message or adding another input", async ({ page }) => {
  await proxyApi(page);
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?mode=layers");
  await waitForWorkspace(page);

  await expect(page.locator("#agent-panel")).toBeHidden();
  await page.locator("#agent-open").click();
  await expect(page.locator("#agent-panel")).toBeVisible();
  await expect(page.locator("#agent-messages")).toContainText("Agent ready");
  await expect(page.locator("#agent-expanded-form")).toHaveCount(0);
  await expect(page.locator("form:visible")).toHaveCount(1);
  await expect(page.locator("#agent-collapsed-input")).toHaveValue("");
});

test("agent dock lifts the full mobile workspace without collapsing the header", async ({ page }) => {
  await proxyApi(page);
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?mode=layers");
  await waitForWorkspace(page);

  const before = await readAgentLayout(page);
  await page.locator("#agent-collapsed-input").fill("移动端布局回归测试");
  await page.locator("#agent-collapsed-form").dispatchEvent("submit");
  await expect(page.locator("#agent-panel")).toBeVisible();

  const after = await readAgentLayout(page);
  const shift = before.topbar.y - after.topbar.y;
  expect(shift).toBeGreaterThan(1);
  expect(Math.abs(after.topbar.height - before.topbar.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.scene.height - before.scene.height)).toBeLessThanOrEqual(1);
  expect(Math.abs((before.scene.y - after.scene.y) - shift)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.panel.y - after.scene.bottom)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.panel.bottom - after.statusbar.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.statusbar.bottom - 844)).toBeLessThanOrEqual(1);
});

test("light theme keeps the first inspector action readable", async ({ page }) => {
  await proxyApi(page);
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?mode=layers");
  await waitForWorkspace(page);
  const assetBody = page.locator('[data-layer-key^="asset:"] .survey-card-body').first();
  await expect(assetBody).toBeVisible();
  await assetBody.click();
  const action = page.locator(".inspector-actions > button:first-child");
  await expect(action).toBeVisible();
  const colors = await action.evaluate((element) => {
    const style = getComputedStyle(element);
    return { color: style.color, background: style.backgroundColor };
  });
  expect(colors.background).not.toBe("rgb(255, 255, 255)");
  expect(colors.color).not.toBe(colors.background);
});

test("workspace uses the supplied Atlas Workspace brand asset", async ({ page }) => {
  await proxyApi(page);
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await waitForWorkspace(page);
  await expect(page).toHaveTitle("Astro Survey Atlas Workspace");
  const logo = page.locator(".brand-mark");
  await expect(logo).toHaveAttribute("src", "/astro-survey-atlas-workspace.svg");
  await expect.poll(() => logo.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await expect(page.locator(".brand-lockup strong")).toHaveText("Astro Survey Atlas Workspace");
  await expect(page.locator(".brand-wordmark")).toHaveText("Workspace");
  await expect(page.locator(".brand-wordmark")).toBeVisible();
});
