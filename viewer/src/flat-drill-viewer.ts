import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import { cartesianToRaDec, raDecToCartesian, normalizeRa } from "./coordinates";
import { sphericalCellBoundary, sphericalCellCenter } from "./spherical-cell-geometry";
import type { SurveyDrillCell, SurveyObjectPoint } from "./survey-layer-viewer";

export interface FlatDrillViewportBounds {
  raMin: number;
  raMax: number;
  decMin: number;
  decMax: number;
}

export interface FlatDrillState {
  kind: "flat-drill";
  baseNside: number;
  basePixels: number[];
  nside: number;
  fovDeg: number;
  viewport: FlatDrillViewportBounds;
}

export interface FlatDrillCellRecord {
  nside: number;
  pixel: number;
  count: number;
  layers: SurveyDrillCell["layers"];
}

const MAX_LABEL_LAYERS = 4;
const MAX_LABEL_CHARS = 12;

function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh || child instanceof THREE.LineSegments || child instanceof THREE.Points)) return;
    child.geometry.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.forEach((material) => material.dispose());
  });
}

function shortCount(value: number): string {
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}m`;
  return `${(value / 1_000_000_000).toFixed(1)}b`;
}

function shortLabel(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= MAX_LABEL_CHARS ? compact : `${compact.slice(0, MAX_LABEL_CHARS - 1)}…`;
}

function averageDirection(points: readonly THREE.Vector3[]): THREE.Vector3 {
  const result = points.reduce((sum, point) => sum.add(point.clone().normalize()), new THREE.Vector3());
  return result.lengthSq() > 0 ? result.normalize() : new THREE.Vector3(0, 0, 1);
}

function circularRaBounds(values: readonly number[]): { raMin: number; raMax: number } {
  if (!values.length) return { raMin: 0, raMax: 360 };
  const sorted = [...values].map(normalizeRa).sort((left, right) => left - right);
  if (sorted.length === 1) return { raMin: sorted[0]!, raMax: sorted[0]! };
  let largestGap = -1;
  let gapIndex = 0;
  for (let index = 0; index < sorted.length; index += 1) {
    const next = sorted[(index + 1) % sorted.length]! + (index === sorted.length - 1 ? 360 : 0);
    const gap = next - sorted[index]!;
    if (gap > largestGap) {
      largestGap = gap;
      gapIndex = index;
    }
  }
  const start = sorted[(gapIndex + 1) % sorted.length]!;
  const end = sorted[gapIndex]!;
  const span = 360 - largestGap;
  return span > 359.5 ? { raMin: 0, raMax: 360 } : { raMin: start, raMax: end };
}

export class FlatDrillViewer {
  readonly #canvas: HTMLCanvasElement;
  readonly #baseNside: number;
  readonly #basePixels: number[];
  readonly #scene = new THREE.Scene();
  readonly #camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -20, 20);
  readonly #renderer: THREE.WebGLRenderer;
  readonly #controls: OrbitControls;
  readonly #raycaster = new THREE.Raycaster();
  readonly #pointer = new THREE.Vector2();
  readonly #cellsGroup = new THREE.Group();
  readonly #objectsGroup = new THREE.Group();
  readonly #resizeObserver: ResizeObserver;
  readonly #labelCanvas: HTMLCanvasElement;
  readonly #labelContext: CanvasRenderingContext2D;
  readonly #onStateChange: (state: FlatDrillState) => void;
  readonly #onCellClick?: (cell: FlatDrillCellRecord) => void;
  readonly #onObjectPoint?: (point: SurveyObjectPoint) => void;
  readonly #center: THREE.Vector3;
  readonly #east: THREE.Vector3;
  readonly #north: THREE.Vector3;
  #cells: FlatDrillCellRecord[] = [];
  #cellMesh: THREE.Mesh | null = null;
  #objectCloud: THREE.Points | null = null;
  #nside: number;
  #renderQueued = false;
  #pointerStart: { x: number; y: number } | null = null;
  #disposed = false;
  #densityVisible = true;

  constructor(
    canvas: HTMLCanvasElement,
    baseNside: number,
    basePixels: readonly number[],
    onStateChange: (state: FlatDrillState) => void,
    onCellClick?: (cell: FlatDrillCellRecord) => void,
    onObjectPoint?: (point: SurveyObjectPoint) => void,
  ) {
    if (!basePixels.length) throw new RangeError("A flat drill region is required");
    this.#canvas = canvas;
    this.#baseNside = baseNside;
    this.#basePixels = [...new Set(basePixels)].sort((left, right) => left - right);
    this.#nside = baseNside;
    this.#onStateChange = onStateChange;
    this.#onCellClick = onCellClick;
    this.#onObjectPoint = onObjectPoint;

    const basePoints = this.#basePixels.flatMap((pixel) => sphericalCellBoundary(baseNside, pixel, 1));
    this.#center = averageDirection(basePoints);
    this.#east = new THREE.Vector3(0, 1, 0).cross(this.#center);
    if (this.#east.lengthSq() < 1e-6) this.#east.set(1, 0, 0).cross(this.#center);
    this.#east.normalize();
    this.#north = this.#center.clone().cross(this.#east).normalize();

    this.#renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.#renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.#renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.#camera.position.set(0, 0, 6);
    this.#controls = new OrbitControls(this.#camera, canvas);
    this.#controls.enableRotate = false;
    this.#controls.enablePan = true;
    this.#controls.screenSpacePanning = true;
    this.#controls.enableDamping = true;
    this.#controls.dampingFactor = 0.12;
    this.#controls.zoomSpeed = 1.1;
    this.#controls.minZoom = 0.2;
    this.#controls.maxZoom = 500;
    this.#controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
    this.#controls.addEventListener("change", this.#handleControlsChange);
    this.#scene.add(this.#cellsGroup, this.#objectsGroup);

    this.#labelCanvas = document.createElement("canvas");
    this.#labelCanvas.className = "flat-drill-labels";
    this.#labelCanvas.setAttribute("aria-hidden", "true");
    this.#labelCanvas.style.position = "absolute";
    this.#labelCanvas.style.inset = "0";
    this.#labelCanvas.style.width = "100%";
    this.#labelCanvas.style.height = "100%";
    this.#labelCanvas.style.pointerEvents = "none";
    this.#labelCanvas.style.zIndex = "4";
    const parent = canvas.parentElement;
    if (!parent) throw new Error("Flat drill canvas must have a parent");
    if (getComputedStyle(parent).position === "static") parent.style.position = "relative";
    parent.append(this.#labelCanvas);
    const context = this.#labelCanvas.getContext("2d");
    if (!context) throw new Error("Unable to create flat drill label canvas");
    this.#labelContext = context;

    this.#canvas.addEventListener("pointerdown", this.#handlePointerDown);
    this.#canvas.addEventListener("pointerup", this.#handlePointerUp);
    this.#resizeObserver = new ResizeObserver(() => this.#resize());
    this.#resizeObserver.observe(parent);
    this.#frameSelected();
    this.#resize();
  }

  get webglVersion(): string {
    return this.#renderer.capabilities.isWebGL2 ? "WEBGL2" : "WEBGL1";
  }

  get state(): FlatDrillState {
    return {
      kind: "flat-drill",
      baseNside: this.#baseNside,
      basePixels: [...this.#basePixels],
      nside: this.#nside,
      fovDeg: this.#fovDeg(),
      viewport: this.#viewportBounds(),
    };
  }

  setTheme(theme: "light" | "dark"): void {
    this.#canvas.dataset.theme = theme;
    this.#renderer.setClearColor(theme === "light" ? 0xaebbc1 : 0x000000, 1);
    this.#requestRender();
  }

  setCells(cells: readonly SurveyDrillCell[], nside: number): void {
    this.#nside = nside;
    this.#cells = cells
      .filter((cell) => Number.isInteger(cell.pixel) && cell.pixel >= 0 && cell.pixel < 12 * nside ** 2)
      .map((cell) => ({ nside, pixel: cell.pixel, count: cell.count, layers: cell.layers }));
    clearGroup(this.#cellsGroup);
    this.#cellMesh = null;
    if (!this.#cells.length) {
      this.#drawLabels();
      this.#requestRender();
      return;
    }
    const positions: number[] = [];
    const colors: number[] = [];
    const edgePositions: number[] = [];
    const edgeColors: number[] = [];
    const vertices = (cell: FlatDrillCellRecord): THREE.Vector2[] => sphericalCellBoundary(nside, cell.pixel, 1).map((point) => this.#project(point));
    for (const cell of this.#cells) {
      const boundary = vertices(cell);
      if (boundary.length < 4) continue;
      const color = this.#cellColor(cell);
      const fill = cell.count > 0 ? color : new THREE.Color("#23313a");
      const opacityScale = cell.count > 0 ? 1 : 0.45;
      [[boundary[0]!, boundary[1]!, boundary[2]!], [boundary[0]!, boundary[2]!, boundary[3]!]].forEach((triangle) => triangle.forEach((point) => {
        positions.push(point.x, point.y, 0);
        colors.push(fill.r * opacityScale, fill.g * opacityScale, fill.b * opacityScale);
      }));
      boundary.forEach((point, index) => {
        const next = boundary[(index + 1) % boundary.length]!;
        edgePositions.push(point.x, point.y, 0.01, next.x, next.y, 0.01);
        edgeColors.push(color.r, color.g, color.b, color.r, color.g, color.b);
      });
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geometry.computeBoundingSphere();
    this.#cellMesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false, toneMapped: false }));
    this.#cellMesh.userData.cells = this.#cells;
    this.#cellMesh.renderOrder = 2;
    const edgeGeometry = new THREE.BufferGeometry();
    edgeGeometry.setAttribute("position", new THREE.Float32BufferAttribute(edgePositions, 3));
    edgeGeometry.setAttribute("color", new THREE.Float32BufferAttribute(edgeColors, 3));
    edgeGeometry.computeBoundingSphere();
    const edges = new THREE.LineSegments(edgeGeometry, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.72, depthWrite: false, toneMapped: false }));
    edges.renderOrder = 3;
    this.#cellsGroup.add(this.#cellMesh, edges);
    this.#drawLabels();
    this.#requestRender();
  }

  setDensityVisible(visible: boolean): void {
    if (this.#densityVisible === visible) return;
    this.#densityVisible = visible;
    this.#cellsGroup.visible = visible;
    this.#labelCanvas.style.visibility = visible ? "visible" : "hidden";
    this.#canvas.dataset.densityVisible = String(visible);
    this.#requestRender();
  }

  clearObjects(): void {
    clearGroup(this.#objectsGroup);
    this.#objectCloud = null;
    this.#requestRender();
  }

  setObjects(points: readonly SurveyObjectPoint[]): { projected: number; visible: number } {
    clearGroup(this.#objectsGroup);
    this.#objectCloud = null;
    const projected = points.filter((point) => Number.isFinite(point.raDeg) && Number.isFinite(point.decDeg)).flatMap((point) => {
      const coordinate = raDecToCartesian(point.raDeg, point.decDeg, 1);
      const projected = this.#project(new THREE.Vector3(coordinate.x, coordinate.y, coordinate.z));
      return Number.isFinite(projected.x) && Number.isFinite(projected.y) ? [{ point, projected }] : [];
    });
    const viewport = this.#viewportWorldCorners();
    const minX = Math.min(...viewport.map((corner) => corner.x));
    const maxX = Math.max(...viewport.map((corner) => corner.x));
    const minY = Math.min(...viewport.map((corner) => corner.y));
    const maxY = Math.max(...viewport.map((corner) => corner.y));
    const visible = projected.filter(({ projected: point }) => point.x >= minX && point.x <= maxX && point.y >= minY && point.y <= maxY);
    if (!visible.length) {
      this.#drawLabels();
      this.#requestRender();
      this.#emitState();
      return { projected: projected.length, visible: 0 };
    }
    const positions = new Float32Array(visible.length * 3);
    const colors = new Float32Array(visible.length * 3);
    visible.forEach(({ point, projected: position }, index) => {
      positions.set([position.x, position.y, 0.035], index * 3);
      const color = new THREE.Color(point.color ?? "#f2cf62");
      colors.set([color.r, color.g, color.b], index * 3);
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const material = new THREE.PointsMaterial({ size: 4, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.98, depthWrite: false, toneMapped: false });
    this.#objectCloud = new THREE.Points(geometry, material);
    this.#objectCloud.userData.points = visible.map(({ point }) => point);
    this.#objectCloud.renderOrder = 8;
    this.#objectsGroup.add(this.#objectCloud);
    this.#drawLabels();
    this.#requestRender();
    this.#emitState();
    return { projected: projected.length, visible: visible.length };
  }

  setNside(nside: number): void {
    if (!Number.isInteger(nside) || nside < this.#baseNside || this.#nside === nside) return;
    this.#nside = nside;
    this.#emitState();
  }

  resetView(): void {
    this.#frameSelected();
    this.#emitState();
    this.#requestRender();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#resizeObserver.disconnect();
    this.#controls.removeEventListener("change", this.#handleControlsChange);
    this.#controls.dispose();
    this.#canvas.removeEventListener("pointerdown", this.#handlePointerDown);
    this.#canvas.removeEventListener("pointerup", this.#handlePointerUp);
    this.#labelCanvas.remove();
    disposeObject(this.#scene);
    this.#renderer.dispose();
    this.#renderer.getContext().getExtension("WEBGL_lose_context")?.loseContext();
  }

  #project(direction: THREE.Vector3): THREE.Vector2 {
    const point = direction.clone().normalize();
    const denominator = point.dot(this.#center);
    if (denominator <= 0.05) return new THREE.Vector2(Number.NaN, Number.NaN);
    return new THREE.Vector2(point.dot(this.#east) / denominator, point.dot(this.#north) / denominator);
  }

  #unproject(x: number, y: number): THREE.Vector3 {
    return this.#center.clone().addScaledVector(this.#east, x).addScaledVector(this.#north, y).normalize();
  }

  #cellColor(cell: FlatDrillCellRecord): THREE.Color {
    const dominant = [...cell.layers].sort((left, right) => right.count - left.count)[0];
    return new THREE.Color(dominant?.color ?? "#45d7c6");
  }

  #fovDeg(): number {
    const worldHeight = (this.#camera.top - this.#camera.bottom) / this.#camera.zoom;
    const half = Math.max(0.0001, worldHeight / 2);
    const angle = Math.atan(half);
    return THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(angle * 2), 0.01, 180);
  }

  #viewportWorldCorners(): THREE.Vector2[] {
    const width = (this.#camera.right - this.#camera.left) / this.#camera.zoom;
    const height = (this.#camera.top - this.#camera.bottom) / this.#camera.zoom;
    const target = this.#controls.target;
    return [
      new THREE.Vector2(target.x - width / 2, target.y - height / 2),
      new THREE.Vector2(target.x + width / 2, target.y - height / 2),
      new THREE.Vector2(target.x + width / 2, target.y + height / 2),
      new THREE.Vector2(target.x - width / 2, target.y + height / 2),
    ];
  }

  #viewportBounds(): FlatDrillViewportBounds {
    const corners = this.#viewportWorldCorners();
    const coordinates = corners.flatMap((start, index) => {
      const end = corners[(index + 1) % corners.length]!;
      return Array.from({ length: 9 }, (_, step) => {
        const ratio = step / 8;
        const x = THREE.MathUtils.lerp(start.x, end.x, ratio);
        const y = THREE.MathUtils.lerp(start.y, end.y, ratio);
        return cartesianToRaDec(this.#unproject(x, y));
      });
    });
    const ra = circularRaBounds(coordinates.map((coordinate) => coordinate.raDeg));
    const margin = Math.max(0.002, this.#fovDeg() * 0.02);
    const span = ra.raMin <= ra.raMax ? ra.raMax - ra.raMin : ra.raMax + 360 - ra.raMin;
    const expandedRa = span + margin * 2 >= 360
      ? { raMin: 0, raMax: 360 }
      : { raMin: normalizeRa(ra.raMin - margin), raMax: normalizeRa(ra.raMax + margin) };
    return {
      ...expandedRa,
      decMin: Math.max(-90, Math.min(...coordinates.map((coordinate) => coordinate.decDeg)) - margin),
      decMax: Math.min(90, Math.max(...coordinates.map((coordinate) => coordinate.decDeg)) + margin),
    };
  }

  #frameSelected(): void {
    const points = this.#basePixels.flatMap((pixel) => sphericalCellBoundary(this.#baseNside, pixel, 1).map((point) => this.#project(point)));
    const valid = points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
    if (!valid.length) {
      this.#camera.position.set(0, 0, 6);
      this.#controls.target.set(0, 0, 0);
      this.#camera.zoom = 1;
      this.#controls.update();
      return;
    }
    const minX = Math.min(...valid.map((point) => point.x));
    const maxX = Math.max(...valid.map((point) => point.x));
    const minY = Math.min(...valid.map((point) => point.y));
    const maxY = Math.max(...valid.map((point) => point.y));
    const width = Math.max(0.001, maxX - minX);
    const height = Math.max(0.001, maxY - minY);
    const bounds = this.#canvas.getBoundingClientRect();
    const aspect = Math.max(0.2, bounds.width / Math.max(1, bounds.height));
    this.#camera.position.set(0, 0, 6);
    this.#controls.target.set(0, 0, 0);
    this.#camera.zoom = Math.min(1.8 / height, 1.8 * aspect / width);
    this.#controls.update();
  }

  #drawLabels(): void {
    const bounds = this.#canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.#labelCanvas.width = Math.max(1, Math.round(bounds.width * dpr));
    this.#labelCanvas.height = Math.max(1, Math.round(bounds.height * dpr));
    const context = this.#labelContext;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, bounds.width, bounds.height);
    context.font = "10px SFMono-Regular, Consolas, monospace";
    context.textBaseline = "top";
    this.#cells.forEach((cell) => {
      if (cell.count <= 0) return;
      const center = this.#project(sphericalCellCenter(cell.nside, cell.pixel, 1));
      if (!Number.isFinite(center.x) || !Number.isFinite(center.y)) return;
      const projected = new THREE.Vector3(center.x, center.y, 0).project(this.#camera);
      if (projected.z < -1 || projected.z > 1) return;
      const x = (projected.x + 1) * bounds.width / 2 + 3;
      const y = (1 - projected.y) * bounds.height / 2 + 3;
      if (x < -100 || x > bounds.width + 20 || y < -30 || y > bounds.height + 20) return;
      context.fillStyle = "rgba(5, 10, 14, .78)";
      context.fillRect(x - 2, y - 2, 118, 13 + Math.min(MAX_LABEL_LAYERS, cell.layers.length) * 11);
      context.fillStyle = "#f4f8fa";
      context.fillText(`T ${shortCount(cell.count)}`, x, y);
      cell.layers.filter((layer) => layer.count > 0).slice(0, MAX_LABEL_LAYERS).forEach((layer, index) => {
        context.fillStyle = layer.color ?? "#dbe7eb";
        context.fillText(`${shortLabel(layer.label ?? "图层")}: ${shortCount(layer.count)}`, x, y + 11 + index * 11);
      });
    });
  }

  #pickCell(event: PointerEvent): FlatDrillCellRecord | null {
    if (!this.#cellMesh) return null;
    const bounds = this.#canvas.getBoundingClientRect();
    this.#pointer.set(((event.clientX - bounds.left) / bounds.width) * 2 - 1, -((event.clientY - bounds.top) / bounds.height) * 2 + 1);
    this.#raycaster.setFromCamera(this.#pointer, this.#camera);
    const hit = this.#raycaster.intersectObject(this.#cellMesh, false)[0];
    const index = hit?.faceIndex == null ? -1 : Math.floor(hit.faceIndex / 2);
    return index >= 0 ? this.#cells[index] ?? null : null;
  }

  #pickObject(event: PointerEvent): SurveyObjectPoint | null {
    if (!this.#objectCloud) return null;
    const bounds = this.#canvas.getBoundingClientRect();
    this.#pointer.set(((event.clientX - bounds.left) / bounds.width) * 2 - 1, -((event.clientY - bounds.top) / bounds.height) * 2 + 1);
    this.#raycaster.params.Points.threshold = 0.045 / Math.max(1, this.#camera.zoom);
    this.#raycaster.setFromCamera(this.#pointer, this.#camera);
    const hit = this.#raycaster.intersectObject(this.#objectCloud, false)[0];
    const points = this.#objectCloud.userData.points as SurveyObjectPoint[] | undefined;
    return hit?.index == null || !points ? null : points[hit.index] ?? null;
  }

  readonly #handleControlsChange = (): void => {
    this.#drawLabels();
    this.#onStateChange(this.state);
    this.#requestRender();
  };

  readonly #handlePointerDown = (event: PointerEvent): void => {
    if (event.button === 0) this.#pointerStart = { x: event.clientX, y: event.clientY };
  };

  readonly #handlePointerUp = (event: PointerEvent): void => {
    if (event.button !== 0 || !this.#pointerStart) return;
    const distance = Math.hypot(event.clientX - this.#pointerStart.x, event.clientY - this.#pointerStart.y);
    this.#pointerStart = null;
    if (distance >= 5) return;
    const object = this.#pickObject(event);
    if (object) {
      this.#onObjectPoint?.(object);
      return;
    }
    const cell = this.#pickCell(event);
    if (cell) this.#onCellClick?.(cell);
  };

  #resize(): void {
    const bounds = this.#canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(bounds.width));
    const height = Math.max(1, Math.round(bounds.height));
    this.#renderer.setSize(width, height, false);
    this.#camera.left = -(width / height);
    this.#camera.right = width / height;
    this.#camera.top = 1;
    this.#camera.bottom = -1;
    this.#camera.updateProjectionMatrix();
    this.#drawLabels();
    this.#onStateChange(this.state);
    this.#requestRender();
  }

  #requestRender(): void {
    if (this.#renderQueued || this.#disposed) return;
    this.#renderQueued = true;
    requestAnimationFrame(() => {
      this.#renderQueued = false;
      this.#controls.update();
      this.#renderer.render(this.#scene, this.#camera);
    });
  }

  #emitState(): void {
    if (!this.#disposed) this.#onStateChange(this.state);
  }
}

function clearGroup(group: THREE.Group): void {
  for (const child of [...group.children]) {
    group.remove(child);
    disposeObject(child);
  }
}
