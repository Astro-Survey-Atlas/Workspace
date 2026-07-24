import * as THREE from "three";

import type { DensityCell, SkyPoint } from "./api";
import { clampDec, normalizeRa, raDecToCartesian } from "./coordinates";

export type SkyRepresentation = "coverage" | "density" | "objects";

export interface SkyViewState {
  raDeg: number;
  decDeg: number;
  fovDeg: number;
}

export type SkySelection =
  | { kind: "cell"; value: DensityCell }
  | { kind: "object"; value: SkyPoint }
  | null;

interface CoverageShape {
  startRaDeg: number;
  spanRaDeg: number;
  decMinDeg: number;
  decMaxDeg: number;
}

const SKY_RADIUS = 1;
const DATA_RADIUS = 0.992;

function asVector(raDeg: number, decDeg: number, radius = SKY_RADIUS): THREE.Vector3 {
  const point = raDecToCartesian(raDeg, decDeg, radius);
  return new THREE.Vector3(point.x, point.y, point.z);
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (child instanceof THREE.Mesh || child instanceof THREE.Points || child instanceof THREE.Line) {
      child.geometry.dispose();
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      materials.forEach((material) => material.dispose());
    }
  });
}

export class SkyViewer {
  readonly #canvas: HTMLCanvasElement;
  readonly #scene = new THREE.Scene();
  readonly #camera = new THREE.PerspectiveCamera(45, 1, 0.01, 2.5);
  readonly #renderer: THREE.WebGLRenderer;
  readonly #raycaster = new THREE.Raycaster();
  readonly #pointer = new THREE.Vector2();
  readonly #dataLayer = new THREE.Group();
  readonly #onViewChange: (view: SkyViewState) => void;
  readonly #onSelection: (selection: SkySelection) => void;
  readonly #resizeObserver: ResizeObserver;
  #view: SkyViewState = { raDeg: 180, decDeg: 0, fovDeg: 110 };
  #defaultView: SkyViewState = { ...this.#view };
  #pickTarget: THREE.Object3D | null = null;
  #representation: SkyRepresentation = "coverage";
  #renderQueued = false;
  #dragStart: { x: number; y: number; ra: number; dec: number } | null = null;
  #dragDistance = 0;

  constructor(
    canvas: HTMLCanvasElement,
    onViewChange: (view: SkyViewState) => void,
    onSelection: (selection: SkySelection) => void,
  ) {
    this.#canvas = canvas;
    this.#onViewChange = onViewChange;
    this.#onSelection = onSelection;
    this.#renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
    this.#renderer.setClearColor(0x05070a, 1);
    this.#renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.#renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.#camera.position.set(0, 0, 0);
    this.#camera.up.set(0, 1, 0);
    this.#scene.add(this.#createStarField(), this.#createCoordinateGrid(), this.#dataLayer);

    this.#bindInteraction();
    this.#resizeObserver = new ResizeObserver(() => this.#resize());
    this.#resizeObserver.observe(canvas.parentElement ?? canvas);
    this.#resize();
    this.#applyView();
  }

  get view(): SkyViewState {
    return { ...this.#view };
  }

  get webglVersion(): string {
    return this.#renderer.capabilities.isWebGL2 ? "WEBGL2" : "WEBGL1";
  }

  setDefaultView(view: SkyViewState): void {
    this.#defaultView = { ...view };
  }

  setView(view: SkyViewState): void {
    this.#view = {
      raDeg: normalizeRa(view.raDeg),
      decDeg: clampDec(view.decDeg),
      fovDeg: Math.max(0.08, Math.min(120, view.fovDeg)),
    };
    this.#applyView();
  }

  reset(): void {
    this.setView(this.#defaultView);
  }

  showAllSky(): void {
    this.setView({ raDeg: 180, decDeg: 0, fovDeg: 110 });
  }

  showCoverage(shape: CoverageShape): void {
    this.#clearDataLayer();
    this.#representation = "coverage";
    const points: THREE.Vector3[] = [];
    const samples = 64;
    for (let index = 0; index <= samples; index += 1) {
      const ra = normalizeRa(shape.startRaDeg + (shape.spanRaDeg * index) / samples);
      points.push(asVector(ra, shape.decMinDeg, DATA_RADIUS));
    }
    for (let index = samples; index >= 0; index -= 1) {
      const ra = normalizeRa(shape.startRaDeg + (shape.spanRaDeg * index) / samples);
      points.push(asVector(ra, shape.decMaxDeg, DATA_RADIUS));
    }
    points.push(points[0]!.clone());
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const line = new THREE.Line(
      geometry,
      new THREE.LineBasicMaterial({ color: 0x4ed6c8, transparent: true, opacity: 0.95 }),
    );
    line.renderOrder = 4;
    this.#dataLayer.add(line);
    this.#pickTarget = null;
    this.#requestRender();
  }

  showDensity(cells: DensityCell[]): void {
    this.#clearDataLayer();
    this.#representation = "density";
    const positions: number[] = [];
    const colors: number[] = [];
    const edgePositions: number[] = [];
    const faceCells: DensityCell[] = [];
    const maxCount = Math.max(1, ...cells.map(({ count }) => count));
    const low = new THREE.Color(0x27b8c7);
    const mid = new THREE.Color(0xf0c64f);
    const high = new THREE.Color(0xef6a61);

    cells.forEach((cell) => {
      const center = asVector(cell.centerRaDeg, cell.centerDecDeg, DATA_RADIUS);
      const strength = Math.log1p(cell.count) / Math.log1p(maxCount);
      const color = strength < 0.55
        ? low.clone().lerp(mid, strength / 0.55)
        : mid.clone().lerp(high, (strength - 0.55) / 0.45);
      cell.vertices.forEach((vertex, index) => {
        const next = cell.vertices[(index + 1) % cell.vertices.length]!;
        const triangle = [
          center,
          asVector(vertex.raDeg, vertex.decDeg, DATA_RADIUS),
          asVector(next.raDeg, next.decDeg, DATA_RADIUS),
        ];
        triangle.forEach((point) => {
          positions.push(point.x, point.y, point.z);
          colors.push(color.r, color.g, color.b);
        });
        faceCells.push(cell);
        const edgeStart = asVector(vertex.raDeg, vertex.decDeg, DATA_RADIUS - 0.002);
        const edgeEnd = asVector(next.raDeg, next.decDeg, DATA_RADIUS - 0.002);
        edgePositions.push(edgeStart.x, edgeStart.y, edgeStart.z, edgeEnd.x, edgeEnd.y, edgeEnd.z);
      });
    });

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geometry.computeBoundingSphere();
    const material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.66,
      side: THREE.BackSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.faceCells = faceCells;
    mesh.renderOrder = 3;
    this.#dataLayer.add(mesh);
    const edgeGeometry = new THREE.BufferGeometry();
    edgeGeometry.setAttribute("position", new THREE.Float32BufferAttribute(edgePositions, 3));
    const edges = new THREE.LineSegments(
      edgeGeometry,
      new THREE.LineBasicMaterial({ color: 0xf0f4f5, transparent: true, opacity: 0.34, depthWrite: false }),
    );
    edges.renderOrder = 4;
    this.#dataLayer.add(edges);
    this.#pickTarget = mesh;
    this.#requestRender();
  }

  showObjects(points: SkyPoint[]): void {
    this.#clearDataLayer();
    this.#representation = "objects";
    const positions = new Float32Array(points.length * 3);
    const strengths = new Float32Array(points.length);
    points.forEach((point, index) => {
      const position = asVector(point.raDeg, point.decDeg, DATA_RADIUS);
      positions.set([position.x, position.y, position.z], index * 3);
      const snr = Number(point.attributes.center_snr ?? "");
      strengths[index] = Number.isFinite(snr) ? Math.min(1, Math.log1p(Math.max(0, snr)) / 5) : 0.45;
    });

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("aStrength", new THREE.BufferAttribute(strengths, 1));
    geometry.computeBoundingSphere();
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uPointSize: { value: Math.min(window.devicePixelRatio, 2) * 4.2 },
        uColorLow: { value: new THREE.Color(0x5ad4d8) },
        uColorHigh: { value: new THREE.Color(0xffd166) },
      },
      vertexShader: `
        attribute float aStrength;
        varying float vStrength;
        uniform float uPointSize;
        void main() {
          vStrength = aStrength;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = uPointSize * mix(0.72, 1.35, aStrength);
        }
      `,
      fragmentShader: `
        varying float vStrength;
        uniform vec3 uColorLow;
        uniform vec3 uColorHigh;
        void main() {
          vec2 centered = gl_PointCoord - vec2(0.5);
          float radius = length(centered);
          float alpha = 1.0 - smoothstep(0.34, 0.5, radius);
          if (alpha <= 0.01) discard;
          vec3 color = mix(uColorLow, uColorHigh, vStrength);
          gl_FragColor = vec4(color, alpha * 0.94);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const pointCloud = new THREE.Points(geometry, material);
    pointCloud.userData.points = points;
    pointCloud.renderOrder = 4;
    this.#dataLayer.add(pointCloud);
    this.#pickTarget = pointCloud;
    this.#raycaster.params.Points = { threshold: 0.006 };
    this.#requestRender();
  }

  dispose(): void {
    this.#resizeObserver.disconnect();
    this.#clearDataLayer();
    disposeObject(this.#scene);
    this.#renderer.dispose();
  }

  #createStarField(): THREE.Points {
    const random = seededRandom(0xa57c0de);
    const count = 2200;
    const positions = new Float32Array(count * 3);
    for (let index = 0; index < count; index += 1) {
      const ra = random() * 360;
      const dec = (Math.asin(random() * 2 - 1) * 180) / Math.PI;
      const point = asVector(ra, dec, 1.015);
      positions.set([point.x, point.y, point.z], index * 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    return new THREE.Points(
      geometry,
      new THREE.PointsMaterial({ color: 0xa8b0bc, size: 1.05, sizeAttenuation: false, transparent: true, opacity: 0.28 }),
    );
  }

  #createCoordinateGrid(): THREE.Group {
    const grid = new THREE.Group();
    const material = new THREE.LineBasicMaterial({ color: 0x8d98a8, transparent: true, opacity: 0.14 });
    for (let ra = 0; ra < 360; ra += 30) {
      const points: THREE.Vector3[] = [];
      for (let dec = -90; dec <= 90; dec += 2) points.push(asVector(ra, dec, 1.004));
      grid.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), material));
    }
    for (let dec = -60; dec <= 60; dec += 30) {
      const points: THREE.Vector3[] = [];
      for (let ra = 0; ra <= 360; ra += 3) points.push(asVector(ra, dec, 1.004));
      grid.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), material));
    }
    return grid;
  }

  #bindInteraction(): void {
    this.#canvas.addEventListener("pointerdown", (event) => {
      this.#canvas.setPointerCapture(event.pointerId);
      this.#dragStart = { x: event.clientX, y: event.clientY, ra: this.#view.raDeg, dec: this.#view.decDeg };
      this.#dragDistance = 0;
    });
    this.#canvas.addEventListener("pointermove", (event) => {
      if (!this.#dragStart) return;
      const bounds = this.#canvas.getBoundingClientRect();
      const dx = event.clientX - this.#dragStart.x;
      const dy = event.clientY - this.#dragStart.y;
      this.#dragDistance = Math.max(this.#dragDistance, Math.hypot(dx, dy));
      const horizontalFov = this.#view.fovDeg * Math.max(1, bounds.width / Math.max(1, bounds.height));
      const cosDec = Math.max(0.12, Math.cos((this.#dragStart.dec * Math.PI) / 180));
      this.#view.raDeg = normalizeRa(this.#dragStart.ra + (dx / Math.max(1, bounds.width)) * horizontalFov / cosDec);
      this.#view.decDeg = clampDec(this.#dragStart.dec + (dy / Math.max(1, bounds.height)) * this.#view.fovDeg);
      this.#applyView();
    });
    this.#canvas.addEventListener("pointerup", (event) => {
      if (this.#dragDistance < 5) this.#pick(event);
      this.#dragStart = null;
      this.#canvas.releasePointerCapture(event.pointerId);
    });
    this.#canvas.addEventListener("pointercancel", () => {
      this.#dragStart = null;
    });
    this.#canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      const factor = Math.exp(event.deltaY * 0.0015);
      this.#view.fovDeg = Math.max(0.08, Math.min(120, this.#view.fovDeg * factor));
      this.#applyView();
    }, { passive: false });
  }

  #pick(event: PointerEvent): void {
    if (!this.#pickTarget) {
      this.#onSelection(null);
      return;
    }
    const bounds = this.#canvas.getBoundingClientRect();
    this.#pointer.set(
      ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
      -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
    );
    this.#raycaster.setFromCamera(this.#pointer, this.#camera);
    const hit = this.#raycaster.intersectObject(this.#pickTarget, false)[0];
    if (!hit) {
      this.#onSelection(null);
      return;
    }
    if (this.#representation === "density" && hit.faceIndex != null) {
      const faceCells = this.#pickTarget.userData.faceCells as DensityCell[];
      this.#onSelection({ kind: "cell", value: faceCells[hit.faceIndex]! });
      return;
    }
    if (this.#representation === "objects" && hit.index != null) {
      const points = this.#pickTarget.userData.points as SkyPoint[];
      this.#onSelection({ kind: "object", value: points[hit.index]! });
    }
  }

  #clearDataLayer(): void {
    for (const child of [...this.#dataLayer.children]) {
      this.#dataLayer.remove(child);
      disposeObject(child);
    }
    this.#pickTarget = null;
    this.#onSelection(null);
  }

  #applyView(): void {
    this.#camera.fov = this.#view.fovDeg;
    this.#camera.updateProjectionMatrix();
    const target = asVector(this.#view.raDeg, this.#view.decDeg);
    this.#camera.lookAt(target);
    this.#onViewChange({ ...this.#view });
    this.#requestRender();
  }

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
      this.#renderer.render(this.#scene, this.#camera);
    });
  }
}
