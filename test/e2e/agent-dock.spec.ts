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

test("agent dock has one input and pushes the workspace content", async ({ page }) => {
  await proxyApi(page);
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?mode=layers");
  await waitForWorkspace(page);

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

  const layout = await page.evaluate(() => {
    const read = (selector: string) => document.querySelector<HTMLElement>(selector)?.getBoundingClientRect().toJSON();
    return { scene: read("#scene-stage"), panel: read("#agent-panel"), statusbar: read(".statusbar") };
  });
  expect(layout.scene).not.toBeNull();
  expect(layout.panel).not.toBeNull();
  expect(layout.scene!.bottom).toBeLessThanOrEqual(layout.panel!.y + 0.5);
  expect(layout.panel!.bottom).toBeLessThanOrEqual(layout.statusbar!.y + 0.5);
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
