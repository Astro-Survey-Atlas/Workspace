import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import {
  buildSphericalCellEdges,
  buildSphericalCellSheetGeometry,
  healpixPixelFromSceneDirection,
  sphericalCellBoundary,
} from "./spherical-cell-geometry";

export interface RegionRefinementMask {
  baseNside: number;
  basePixels: number[];
  nside: number;
  candidatePixels: number[];
  selectedPixels: number[];
}

export interface RegionRefinementState extends RegionRefinementMask {
  cameraDistance: number;
  canRefine: boolean;
  canGoBack: boolean;
  selectedAreaDeg2: number;
}

interface RefinementSnapshot {
  nside: number;
  candidatePixels: number[];
  selectedPixels: number[];
}

const RETAINED_FILL_COLOR = new THREE.Color("#526168");
const RETAINED_EDGE_COLOR = new THREE.Color("#829096");
const COVERAGE_EDGE_COLOR = new THREE.Color("#557a75");
const EXCLUDED_FILL_COLOR = new THREE.Color("#202a2f");
const EXCLUDED_EDGE_COLOR = new THREE.Color("#354147");
const MAX_NSIDE = 128;
const FULL_SKY_AREA_DEG2 = 41_252.96124941927;

function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh || child instanceof THREE.LineSegments || child instanceof THREE.Points)) return;
    child.geometry.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.forEach((material) => material.dispose());
  });
}

function releaseWebglContext(renderer: THREE.WebGLRenderer): void {
  renderer.getContext().getExtension("WEBGL_lose_context")?.loseContext();
}

function childrenOf(pixels: Iterable<number>): number[] {
  return [...pixels].flatMap((pixel) => [pixel * 4, pixel * 4 + 1, pixel * 4 + 2, pixel * 4 + 3]);
}

export function ancestorPixel(pixel: number, nside: number, ancestorNside: number): number {
  if (ancestorNside > nside || nside % ancestorNside !== 0) throw new RangeError("ancestor NSIDE must divide the current NSIDE");
  const ratio = nside / ancestorNside;
  return Math.floor(pixel / (ratio * ratio));
}

export class RegionRefinementViewer {
  readonly #canvas: HTMLCanvasElement;
  readonly #baseNside: number;
  readonly #basePixels: number[];
  readonly #scene = new THREE.Scene();
  readonly #camera = new THREE.PerspectiveCamera(42, 1, 0.01, 20);
  readonly #renderer: THREE.WebGLRenderer;
  readonly #starField: THREE.Points;
  readonly #controls: OrbitControls;
  readonly #raycaster = new THREE.Raycaster();
  readonly #pointer = new THREE.Vector2();
  readonly #regionGroup = new THREE.Group();
  readonly #resizeObserver: ResizeObserver;
  readonly #onStateChange: (state: RegionRefinementState) => void;
  readonly #history: RefinementSnapshot[] = [];
  readonly #coveredBasePixels = new Set<number>();
  #nside: number;
  #candidatePixels: number[];
  #selectedPixels: Set<number>;
  #pointerStart: { x: number; y: number } | null = null;
  #renderQueued = false;

  constructor(
    canvas: HTMLCanvasElement,
    baseNside: number,
    basePixels: readonly number[],
    coveredBasePixels: Iterable<number>,
    onStateChange: (state: RegionRefinementState) => void,
  ) {
    if (!basePixels.length) throw new RangeError("A region is required for refinement");
    this.#canvas = canvas;
    this.#baseNside = baseNside;
    this.#basePixels = [...new Set(basePixels)].sort((left, right) => left - right);
    this.#nside = Math.min(MAX_NSIDE, baseNside * 2);
    this.#candidatePixels = this.#nside === baseNside ? [...this.#basePixels] : childrenOf(this.#basePixels);
    this.#selectedPixels = new Set(this.#candidatePixels);
    this.#onStateChange = onStateChange;
    this.setCoveredBasePixels(coveredBasePixels, false);

    this.#renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.#renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.#renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.#controls = new OrbitControls(this.#camera, canvas);
    this.#controls.enablePan = false;
    this.#controls.enableDamping = true;
    this.#controls.dampingFactor = 0.08;
    this.#controls.minDistance = 0.26;
    this.#controls.maxDistance = 5;
    this.#controls.addEventListener("change", this.#handleControlsChange);
    this.#starField = this.#backgroundStars();
    this.#scene.add(this.#starField, this.#regionGroup);
    this.setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
    this.#canvas.addEventListener("pointerdown", this.#handlePointerDown);
    this.#canvas.addEventListener("pointerup", this.#handlePointerUp);
    this.#canvas.addEventListener("pointermove", this.#handlePointerMove);
    this.#canvas.addEventListener("pointerleave", this.#handlePointerLeave);
    this.#resizeObserver = new ResizeObserver(() => this.#resize());
    this.#resizeObserver.observe(canvas.parentElement ?? canvas);
    this.#focusRegion();
    this.#rebuild();
    this.#resize();
  }

  get webglVersion(): string {
    return this.#renderer.capabilities.isWebGL2 ? "WEBGL2" : "WEBGL1";
  }

  setTheme(theme: "light" | "dark"): void {
    this.#canvas.dataset.theme = theme;
    this.#renderer.setClearColor(theme === "light" ? 0xaebbc1 : 0x000000, 1);
    (this.#starField.material as THREE.PointsMaterial).color.setHex(theme === "light" ? 0x65757d : 0x71808b);
    (this.#starField.material as THREE.PointsMaterial).opacity = theme === "light" ? 0.24 : 0.24;
    this.#requestRender();
  }

  get state(): RegionRefinementState {
    return {
      baseNside: this.#baseNside,
      basePixels: [...this.#basePixels],
      nside: this.#nside,
      candidatePixels: [...this.#candidatePixels],
      selectedPixels: [...this.#selectedPixels].sort((left, right) => left - right),
      cameraDistance: this.#camera.position.distanceTo(this.#controls.target),
      canRefine: this.#nside < MAX_NSIDE && this.#selectedPixels.size > 0,
      canGoBack: this.#history.length > 0,
      selectedAreaDeg2: this.#selectedPixels.size * FULL_SKY_AREA_DEG2 / (12 * this.#nside * this.#nside),
    };
  }

  setCoveredBasePixels(pixels: Iterable<number>, rebuild = true): void {
    this.#coveredBasePixels.clear();
    for (const pixel of pixels) this.#coveredBasePixels.add(pixel);
    if (rebuild) this.#rebuild();
  }

  refine(): void {
    if (this.#nside >= MAX_NSIDE || !this.#selectedPixels.size) return;
    this.#history.push({
      nside: this.#nside,
      candidatePixels: [...this.#candidatePixels],
      selectedPixels: [...this.#selectedPixels],
    });
    this.#nside *= 2;
    this.#candidatePixels = childrenOf(this.#selectedPixels);
    this.#selectedPixels = new Set(this.#candidatePixels);
    this.#rebuild();
  }

  goBack(): void {
    const previous = this.#history.pop();
    if (!previous) return;
    this.#nside = previous.nside;
    this.#candidatePixels = previous.candidatePixels;
    this.#selectedPixels = new Set(previous.selectedPixels);
    this.#rebuild();
  }

  reset(): void {
    this.#history.length = 0;
    this.#nside = Math.min(MAX_NSIDE, this.#baseNside * 2);
    this.#candidatePixels = this.#nside === this.#baseNside ? [...this.#basePixels] : childrenOf(this.#basePixels);
    this.#selectedPixels = new Set(this.#candidatePixels);
    this.#focusRegion();
    this.#rebuild();
  }

  dispose(): void {
    this.#resizeObserver.disconnect();
    this.#controls.removeEventListener("change", this.#handleControlsChange);
    this.#controls.dispose();
    this.#canvas.removeEventListener("pointerdown", this.#handlePointerDown);
    this.#canvas.removeEventListener("pointerup", this.#handlePointerUp);
    this.#canvas.removeEventListener("pointermove", this.#handlePointerMove);
    this.#canvas.removeEventListener("pointerleave", this.#handlePointerLeave);
    disposeObject(this.#scene);
    this.#renderer.dispose();
    releaseWebglContext(this.#renderer);
  }

  #rebuild(): void {
    for (const child of [...this.#regionGroup.children]) {
      this.#regionGroup.remove(child);
      disposeObject(child);
    }
    const cells = this.#candidatePixels.map((pixel) => ({
      nside: this.#nside,
      pixel,
      radius: 0.997,
      color: this.#selectedPixels.has(pixel) ? RETAINED_FILL_COLOR : EXCLUDED_FILL_COLOR,
      inset: 0.045,
    }));
    const cellMesh = new THREE.Mesh(buildSphericalCellSheetGeometry(cells), new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.42,
      side: THREE.DoubleSide,
      depthWrite: false,
    }));
    const cellEdges = new THREE.LineSegments(buildSphericalCellEdges(cells.map((cell) => ({
      ...cell,
      color: this.#selectedPixels.has(cell.pixel) ? RETAINED_EDGE_COLOR : EXCLUDED_EDGE_COLOR,
    }))), new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.68,
      depthWrite: false,
    }));
    cellMesh.renderOrder = 2;
    cellEdges.renderOrder = 3;
    this.#regionGroup.add(cellMesh, cellEdges);

    const covered = [...this.#selectedPixels]
      .filter((pixel) => this.#coveredBasePixels.has(ancestorPixel(pixel, this.#nside, this.#baseNside)))
      .map((pixel) => ({ nside: this.#nside, pixel, radius: 1.001, color: COVERAGE_EDGE_COLOR, inset: 0.17 }));
    if (covered.length) {
      const coverageEdges = new THREE.LineSegments(buildSphericalCellEdges(covered), new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.52,
        depthWrite: false,
      }));
      coverageEdges.renderOrder = 4;
      this.#regionGroup.add(coverageEdges);
    }
    this.#onStateChange(this.state);
    this.#requestRender();
  }

  #pick(event: PointerEvent): number | null {
    const bounds = this.#canvas.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return null;
    this.#pointer.set(((event.clientX - bounds.left) / bounds.width) * 2 - 1, -((event.clientY - bounds.top) / bounds.height) * 2 + 1);
    this.#raycaster.setFromCamera(this.#pointer, this.#camera);
    const origin = this.#raycaster.ray.origin;
    const direction = this.#raycaster.ray.direction;
    const b = 2 * origin.dot(direction);
    const c = origin.lengthSq() - 1;
    const discriminant = b * b - 4 * c;
    if (discriminant < 0) return null;
    const sqrt = Math.sqrt(discriminant);
    const near = (-b - sqrt) / 2;
    const far = (-b + sqrt) / 2;
    const distance = near > 1e-5 ? near : far > 1e-5 ? far : null;
    if (distance == null) return null;
    const point = origin.clone().addScaledVector(direction, distance);
    const pixel = healpixPixelFromSceneDirection(this.#nside, point);
    return this.#candidatePixels.includes(pixel) ? pixel : null;
  }

  #toggle(pixel: number): void {
    if (this.#selectedPixels.has(pixel)) this.#selectedPixels.delete(pixel);
    else this.#selectedPixels.add(pixel);
    this.#rebuild();
  }

  #focusRegion(): void {
    const boundary = this.#basePixels.flatMap((pixel) => sphericalCellBoundary(this.#baseNside, pixel, 1));
    const direction = boundary.reduce((sum, point) => sum.add(point), new THREE.Vector3()).normalize();
    const angularRadius = Math.max(...boundary.map((point) => direction.angleTo(point)));
    const distance = THREE.MathUtils.clamp(Math.tan(angularRadius) * 2.8, 0.3, 1.4);
    const tangent = Math.abs(direction.y) > 0.9
      ? new THREE.Vector3(1, 0, 0)
      : new THREE.Vector3(0, 1, 0).cross(direction).normalize();
    this.#controls.target.copy(direction.clone().multiplyScalar(0.94));
    this.#camera.position.copy(this.#controls.target).addScaledVector(direction, distance).addScaledVector(tangent, distance * 0.08);
    this.#camera.lookAt(this.#controls.target);
    this.#controls.update();
  }

  #backgroundStars(): THREE.Points {
    const positions = new Float32Array(420 * 3);
    for (let index = 0; index < 420; index += 1) {
      const z = 1 - (2 * (index + 0.5)) / 420;
      const radius = Math.sqrt(1 - z * z);
      const phi = index * Math.PI * (3 - Math.sqrt(5));
      positions.set([Math.cos(phi) * radius * 6, z * 6, Math.sin(phi) * radius * 6], index * 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    return new THREE.Points(geometry, new THREE.PointsMaterial({ color: 0x71808b, size: 0.006, transparent: true, opacity: 0.24 }));
  }

  readonly #handleControlsChange = (): void => this.#requestRender();
  readonly #handlePointerDown = (event: PointerEvent): void => {
    if (event.button === 0) this.#pointerStart = { x: event.clientX, y: event.clientY };
  };
  readonly #handlePointerUp = (event: PointerEvent): void => {
    if (event.button !== 0 || !this.#pointerStart) return;
    const distance = Math.hypot(event.clientX - this.#pointerStart.x, event.clientY - this.#pointerStart.y);
    this.#pointerStart = null;
    if (distance >= 5) return;
    const pixel = this.#pick(event);
    if (pixel != null) this.#toggle(pixel);
  };
  readonly #handlePointerMove = (event: PointerEvent): void => {
    if (this.#pointerStart && Math.hypot(event.clientX - this.#pointerStart.x, event.clientY - this.#pointerStart.y) >= 5) return;
    const pixel = this.#pick(event);
    if (pixel == null) {
      delete this.#canvas.dataset.hoveredPixel;
      return;
    }
    this.#canvas.dataset.hoveredPixel = String(pixel);
    this.#canvas.dataset.hoveredSelected = String(this.#selectedPixels.has(pixel));
  };
  readonly #handlePointerLeave = (): void => {
    delete this.#canvas.dataset.hoveredPixel;
    delete this.#canvas.dataset.hoveredSelected;
  };

  #resize(): void {
    const bounds = this.#canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(bounds.width));
    const height = Math.max(1, Math.round(bounds.height));
    this.#renderer.setSize(width, height, false);
    this.#renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.#camera.aspect = width / height;
    this.#camera.updateProjectionMatrix();
    this.#requestRender();
  }

  #requestRender(): void {
    if (this.#renderQueued) return;
    this.#renderQueued = true;
    requestAnimationFrame(() => {
      this.#renderQueued = false;
      this.#controls.update();
      this.#renderer.render(this.#scene, this.#camera);
    });
  }
}
