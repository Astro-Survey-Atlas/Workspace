import { expect, test, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import type * as THREE from "three";

type GeometrySample = {
  selected: number[];
  highlights: Array<{ pixel: number; angleDeg: number; radius: number; key?: string; withinBounds: boolean }>;
  whiteMin: number;
  whiteMax: number;
  outerRadius: number;
  anchorContainsHighlights: boolean;
};

declare global {
  interface Window {
    cellAlignment: {
      point: (key: string, edgeFraction?: number) => { x: number; y: number };
      sample: () => GeometrySample;
      hovered: () => number | null;
      reorder: () => void;
      hideLocal: () => void;
      overlap: (active: boolean) => void;
    };
  }
}

// Exercise the production viewer itself with an isolated synthetic scene. No
// Workspace/Assets API or resource-package setup is involved in this fixture.
let server: ViteDevServer;
let origin: string;
test.beforeAll(async () => {
  server = await createServer({ server: { host: "127.0.0.1", port: 4198, strictPort: true } });
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture server address");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => server?.close());

async function openScene(page: Page, publicCount: number, local: boolean, theme = "light") {
  await page.setViewportSize({ width: 1000, height: 850 });
  await page.route("**/cell-alignment-fixture", route => route.fulfill({
    contentType: "text/html",
    body: `<html data-theme="${theme}"><body style="margin:0"><div style="width:1000px;height:850px"><canvas style="width:100%;height:100%"></canvas></div></body></html>`,
  }));
  await page.goto(`${origin}/cell-alignment-fixture`);
  const time = new Date("2026-01-01T00:00:00Z");
  await page.clock.install({ time });
  await page.clock.pauseAt(time);
  await page.evaluate(async ({ publicCount, local }) => {
    const viewerUrl = "/src/survey-layer-viewer.ts";
    const code = await (await fetch(viewerUrl)).text();
    const renderPassUrl = /import \{ RenderPass \} from "([^"]+)"/.exec(code)?.[1];
    const threeUrl = /import \* as THREE from "([^"]+)"/.exec(code)?.[1];
    if (!renderPassUrl || !threeUrl) throw new Error("Missing production rendering imports");
    const { RenderPass } = await import(renderPassUrl);
    const T = await import(threeUrl);
    const geometryUrl = "/src/spherical-cell-geometry.ts";
    const { sphericalCellCenter, healpixPixelFromSceneDirection } = await import(geometryUrl);
    let scene: THREE.Scene, camera: THREE.PerspectiveCamera;
    const render = RenderPass.prototype.render;
    RenderPass.prototype.render = function (this: { scene: THREE.Scene; camera: THREE.PerspectiveCamera }, ...args: unknown[]) {
      scene = this.scene;
      camera = this.camera;
      return render.apply(this, args);
    };
    const { SurveyLayerViewer } = await import(viewerUrl);
    const surveys = Array.from({ length: publicCount }, (_, index) => ({ id: `synthetic-${index}`, name: `Survey ${index}`, color: index % 2 ? "#be9cf2" : "#e5aa53" }));
    const manifest = { schemaVersion: 1, generatedAt: "2026-01-01T00:00:00Z", coordinateFrame: "ICRS", nside: 16,
      footprints: surveys.map(survey => ({ surveyId: survey.id, releaseId: "synthetic", product: "synthetic", label: survey.name, nside: 16, pixels: [1702] })) };
    let selected: number[] = [], hovered: number | null = null;
    const viewer = new SurveyLayerViewer(document.querySelector("canvas"), manifest, surveys,
      (selection: { pixels: number[] } | null) => { selected = selection?.pixels ?? []; },
      (hover: { pixel: number } | null) => { hovered = hover?.pixel ?? null; }, () => {}, () => {}, () => {});
    if (local) {
      viewer.setWorkspaceCoverageLayers([{ key: "asset:synthetic-csst", assetId: "synthetic-csst", surveyId: "csst", color: "#55cf95", nside: 16, pixels: [1702] }], 16);
      viewer.setVisibleAssets(["synthetic-csst"]);
    }
    viewer.setVisibleSurveys(surveys.map(survey => survey.id));
    const order = [...(local ? ["asset:synthetic-csst"] : []), ...surveys.map(survey => `public-survey:${survey.id}`)];
    viewer.setLayerOrder(order);
    viewer.focusCell(16, 1702);
    const vertices = (mesh: THREE.Mesh) => {
      const positions = mesh.geometry.getAttribute("position");
      return Array.from({ length: positions.count }, (_, index) => new T.Vector3().fromBufferAttribute(positions, index).applyMatrix4(mesh.matrixWorld));
    };
    const sourceKey = (mesh: THREE.Mesh): string | undefined => mesh.userData.layerKey ?? (mesh.userData.surveyId ? `public-survey:${mesh.userData.surveyId}` : undefined);
    window.cellAlignment = {
      hovered: () => hovered,
      reorder: () => viewer.setLayerOrder([...order].reverse()),
      hideLocal: () => viewer.setVisibleAssets([]),
      overlap: active => viewer.setOverlapMode(active),
      point: (key, edgeFraction = 0) => {
        scene.updateMatrixWorld(true);
        let source: THREE.Mesh | undefined;
        scene.traverse(object => {
          const mesh = object as THREE.Mesh;
          if (mesh.isMesh && sourceKey(mesh) === key && mesh.userData.records?.length && mesh.renderOrder < 10_000) source = mesh;
        });
        if (!source) throw new Error(`Missing visible source: ${key}`);
        const points = vertices(source);
        const center = points.reduce((sum, point) => sum.add(point), new T.Vector3()).divideScalar(points.length);
        const edge = points[0].clone().add(points[1]).multiplyScalar(0.5);
        const point = center.lerp(edge, edgeFraction).project(camera);
        return { x: (point.x + 1) * 500, y: (1 - point.y) * 425 };
      },
      sample: () => {
        scene.updateMatrixWorld(true);
        let whiteMin = Infinity, whiteMax = 0;
        scene.traverse(object => {
          const line = object as THREE.LineSegments;
          if (!line.isLineSegments || line.renderOrder !== 12_002) return;
          const positions = line.geometry.getAttribute("position");
          for (let index = 0; index < positions.count; index++) {
            const radius = new T.Vector3().fromBufferAttribute(positions, index).applyMatrix4(line.matrixWorld).length();
            whiteMin = Math.min(whiteMin, radius);
            whiteMax = Math.max(whiteMax, radius);
          }
        });
        const highlights: GeometrySample["highlights"] = [];
        const bounds = viewer.state.selectionAnchor?.bounds;
        let anchorContainsHighlights = Boolean(bounds);
        scene.traverse(object => {
          const mesh = object as THREE.Mesh;
          if (!mesh.isMesh || mesh.userData.surveyId === "__overlap__" || mesh.renderOrder < 11_000 || mesh.renderOrder >= 12_000) return;
          const points = vertices(mesh);
          const center = points.reduce((sum, point) => sum.add(point), new T.Vector3()).divideScalar(points.length);
          highlights.push({ pixel: healpixPixelFromSceneDirection(16, center), angleDeg: T.MathUtils.radToDeg(center.angleTo(sphericalCellCenter(16, 1702, 1))), radius: center.length(), key: sourceKey(mesh),
            withinBounds: points.every(point => point.length() >= whiteMin - 0.002 && point.length() <= whiteMax + 0.002) });
          for (const point of points) {
            point.project(camera);
            const x = (point.x + 1) / 2, y = (1 - point.y) / 2;
            if (!bounds || x < bounds.leftRatio - 0.001 || x > bounds.rightRatio + 0.001 || y < bounds.topRatio - 0.001 || y > bounds.bottomRatio + 0.001) anchorContainsHighlights = false;
          }
        });
        return { selected, highlights, whiteMin, whiteMax, outerRadius: viewer.state.outerRadius, anchorContainsHighlights };
      },
    };
  }, { publicCount, local });
  await page.clock.runFor(1000);
}

async function expectAligned(page: Page, count: number) {
  const sample = await page.evaluate(() => window.cellAlignment.sample());
  expect(sample.selected).toEqual([1702]);
  expect(sample.highlights).toHaveLength(count);
  for (const cell of sample.highlights) {
    expect(cell.pixel).toBe(1702);
    expect(cell.angleDeg).toBeLessThan(0.05);
    expect(cell.withinBounds).toBe(true);
    expect(cell.radius).toBeGreaterThan(0.045);
  }
  expect(sample.outerRadius).toBeGreaterThanOrEqual(sample.whiteMax - 0.002);
  expect(sample.anchorContainsHighlights).toBe(true);
  return sample;
}

test("public source centers and inset edges pick the rendered cell at different depths", async ({ page }) => {
  await openScene(page, 2, false);
  for (const key of ["public-survey:synthetic-0", "public-survey:synthetic-1"]) {
    for (const fraction of [0, 1.01]) {
      const point = await page.evaluate(({ key, fraction }) => window.cellAlignment.point(key, fraction), { key, fraction });
      await page.mouse.move(point.x, point.y);
      expect(await page.evaluate(() => window.cellAlignment.hovered())).toBe(1702);
    }
  }
  const point = await page.evaluate(() => window.cellAlignment.point("public-survey:synthetic-0"));
  await page.mouse.click(point.x, point.y);
  await page.clock.runFor(900);
  await expectAligned(page, 2);
});

for (const theme of ["light", "dark"]) test(`radial expansion keeps a single aligned highlight and volume throughout ${theme} animation`, async ({ page }, testInfo) => {
  await openScene(page, 2, true, theme);
  const point = await page.evaluate(() => window.cellAlignment.point("asset:synthetic-csst"));
  await page.mouse.click(point.x, point.y);
  await page.clock.runFor(240);
  await expectAligned(page, 3);
  await page.clock.runFor(300);
  await expectAligned(page, 3);
  await page.clock.runFor(400);
  const expanded = await expectAligned(page, 3);
  await page.screenshot({ path: testInfo.outputPath(`radial-expansion-${theme}.png`) });
  const radii = new Map(expanded.highlights.map(cell => [cell.key, cell.radius]));
  expect(radii.get("asset:synthetic-csst")!).toBeGreaterThan(radii.get("public-survey:synthetic-0")!);
  expect(radii.get("public-survey:synthetic-0")!).toBeGreaterThan(radii.get("public-survey:synthetic-1")!);
  await page.mouse.click(point.x, point.y);
  await page.clock.runFor(360);
  await expectAligned(page, 3);
  await page.clock.runFor(300);
  await expectAligned(page, 3);
  await page.evaluate(() => window.cellAlignment.reorder());
  await page.clock.runFor(500);
  await expectAligned(page, 3);
  await page.evaluate(() => window.cellAlignment.hideLocal());
  await page.clock.runFor(500);
  await expectAligned(page, 2);
  await page.evaluate(() => window.cellAlignment.overlap(true));
  await page.clock.runFor(500);
  const overlap = await expectAligned(page, 2);
  expect(Math.max(...overlap.highlights.map(cell => cell.radius)) - Math.min(...overlap.highlights.map(cell => cell.radius))).toBeLessThan(0.01);
});

test("many expanded layers retain positive radii and stay inside the selection volume", async ({ page }) => {
  await openScene(page, 10, true);
  const point = await page.evaluate(() => window.cellAlignment.point("asset:synthetic-csst"));
  await page.mouse.click(point.x, point.y);
  await page.clock.runFor(900);
  await expectAligned(page, 11);
});
