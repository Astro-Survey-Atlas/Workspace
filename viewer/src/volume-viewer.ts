import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Healpix, Pointing } from "healpixjs";

import type { AtlasJointCellView, VolumeManifest, VolumePointData } from "./api";
import { raDecToCartesian } from "./coordinates";
import { buildSphericalCellGeometry, TRIANGLES_PER_SPHERICAL_CELL } from "./spherical-cell-geometry";
import { radialShellIndex, volumePosition } from "./volume-math";

export interface VolumeSelection {
  kind: "object";
  index: number;
  targetId: bigint;
  raDeg: number;
  decDeg: number;
  bestZ: number;
  zErr: number;
  comovingDistanceMpc: number;
  shellIndex: number;
}

export interface JointCellSelection extends AtlasJointCellView {
  kind: "joint-cell";
  nside: number;
  radialBins: number;
}

export interface VolumeViewState {
  shellCount: number;
  cutAngleDeg: number;
  shellOpacity: number;
  pointSize: number;
  radialMinMpc: number;
  radialMaxMpc: number;
  cameraDistance: number;
  outerRadius: number;
  representation: "cells" | "points";
}

const OUTER_RADIUS = 1;
const DEFAULT_CAMERA_DISTANCE = 2.4;
const MIN_CAMERA_DISTANCE = 1.15;
const MAX_CAMERA_DISTANCE = 6;
const SHELL_SEGMENTS = 72;

function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh || child instanceof THREE.Points || child instanceof THREE.LineSegments)) return;
    child.geometry.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.forEach((material) => material.dispose());
  });
}

function releaseWebglContext(renderer: THREE.WebGLRenderer): void {
  renderer.getContext().getExtension("WEBGL_lose_context")?.loseContext();
}

function colorForRadius(value: number): THREE.Color {
  const low = new THREE.Color(0x42d4c6);
  const middle = new THREE.Color(0xf2cf62);
  const high = new THREE.Color(0xf07768);
  return value < 0.55 ? low.lerp(middle, value / 0.55) : middle.lerp(high, (value - 0.55) / 0.45);
}

function asVector(raDeg: number, decDeg: number, radius = 1): THREE.Vector3 {
  const point = raDecToCartesian(raDeg, decDeg, radius);
  return new THREE.Vector3(point.x, point.y, point.z);
}

function shellGridGeometry(radius: number, phiStart: number, phiLength: number, dense: boolean): THREE.BufferGeometry {
  const positions: number[] = [];
  const appendSegment = (start: THREE.Vector3, end: THREE.Vector3): void => {
    positions.push(start.x, start.y, start.z, end.x, end.y, end.z);
  };
  const point = (phi: number, theta: number): THREE.Vector3 => new THREE.Vector3(
    -radius * Math.cos(phi) * Math.sin(theta),
    radius * Math.cos(theta),
    radius * Math.sin(phi) * Math.sin(theta),
  );

  const longitudeCount = dense ? 12 : 6;
  const latitudeCount = dense ? 12 : 6;
  const arcSteps = dense ? 72 : 48;
  for (let longitude = 0; longitude <= longitudeCount; longitude += 1) {
    const phi = phiStart + (phiLength * longitude) / longitudeCount;
    for (let step = 0; step < arcSteps / 2; step += 1) {
      appendSegment(point(phi, (Math.PI * step) / (arcSteps / 2)), point(phi, (Math.PI * (step + 1)) / (arcSteps / 2)));
    }
  }
  for (let latitude = 1; latitude < latitudeCount; latitude += 1) {
    const theta = (Math.PI * latitude) / latitudeCount;
    for (let step = 0; step < arcSteps; step += 1) {
      appendSegment(
        point(phiStart + (phiLength * step) / arcSteps, theta),
        point(phiStart + (phiLength * (step + 1)) / arcSteps, theta),
      );
    }
  }
  return new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
}

function radialGuideGeometry(phiStart: number, phiLength: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const directions = [phiStart, phiStart + phiLength];
  directions.forEach((phi) => {
    for (let latitude = 0; latitude <= 6; latitude += 1) {
      const theta = (Math.PI * latitude) / 6;
      positions.push(
        0, 0, 0,
        -Math.cos(phi) * Math.sin(theta),
        Math.cos(theta),
        Math.sin(phi) * Math.sin(theta),
      );
    }
  });
  return new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
}

export class VolumeViewer {
  readonly #canvas: HTMLCanvasElement;
  readonly #manifest: VolumeManifest;
  readonly #scene = new THREE.Scene();
  readonly #camera = new THREE.PerspectiveCamera(52, 1, 0.015, 20);
  readonly #renderer: THREE.WebGLRenderer;
  readonly #starField: THREE.Points;
  readonly #controls: OrbitControls;
  readonly #raycaster = new THREE.Raycaster();
  readonly #pointer = new THREE.Vector2();
  readonly #shellLayer = new THREE.Group();
  readonly #dataLayer = new THREE.Group();
  readonly #voxelLayer = new THREE.Group();
  readonly #selectionLayer = new THREE.Group();
  readonly #resizeObserver: ResizeObserver;
  readonly #cutRotation = new THREE.Quaternion();
  readonly #onSelection: (selection: VolumeSelection | JointCellSelection | null) => void;
  readonly #onStateChange: (state: VolumeViewState) => void;
  #points: VolumePointData | null = null;
  #pointCloud: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial> | null = null;
  #pointMaterial: THREE.ShaderMaterial | null = null;
  #voxelMesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> | null = null;
  #jointCells: AtlasJointCellView[] = [];
  #jointNside = 32;
  #jointRadialBins = 8;
  #representation: "cells" | "points" = "cells";
  #angularFilter: { nside: number; pixel: number } | null = null;
  #shellCount = 8;
  #cutAngleDeg = 72;
  #shellOpacity = 0.045;
  #pointSize = 2.4;
  #radialMinMpc = 0;
  #radialMaxMpc: number;
  #renderQueued = false;
  #backgroundColor: number | null = null;
  #pointerStart: { x: number; y: number } | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    manifest: VolumeManifest,
    onSelection: (selection: VolumeSelection | JointCellSelection | null) => void,
    onStateChange: (state: VolumeViewState) => void,
  ) {
    this.#canvas = canvas;
    this.#manifest = manifest;
    this.#onSelection = onSelection;
    this.#onStateChange = onStateChange;
    this.#radialMaxMpc = manifest.radialCoordinate.domainMaxMpc;
    this.#renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
    this.#renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.#renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.#renderer.debug.checkShaderErrors = true;

    const dataAxis = asVector(manifest.coverage.centerRaDeg, manifest.coverage.centerDecDeg).normalize();
    this.#cutRotation.setFromUnitVectors(new THREE.Vector3(-1, 0, 0), dataAxis);
    this.#shellLayer.quaternion.copy(this.#cutRotation);
    this.#starField = this.#createBackgroundStars();
    this.#scene.add(this.#starField, this.#shellLayer, this.#voxelLayer, this.#dataLayer, this.#selectionLayer);
    this.setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");

    this.#controls = new OrbitControls(this.#camera, canvas);
    this.#controls.target.set(0, 0, 0);
    this.#controls.enablePan = false;
    this.#controls.enableDamping = true;
    this.#controls.dampingFactor = 0.07;
    this.#controls.minDistance = MIN_CAMERA_DISTANCE;
    this.#controls.maxDistance = MAX_CAMERA_DISTANCE;
    this.#controls.addEventListener("change", () => {
      this.#emitState();
      this.#requestRender();
    });

    this.#bindInteraction();
    this.#resizeObserver = new ResizeObserver(() => this.#resize());
    this.#resizeObserver.observe(canvas.parentElement ?? canvas);
    this.#rebuildShells();
    this.focusData();
    this.#resize();
  }

  get webglVersion(): string {
    return this.#renderer.capabilities.isWebGL2 ? "WEBGL2" : "WEBGL1";
  }

  setTheme(theme: "light" | "dark"): void {
    this.#canvas.dataset.theme = theme;
    this.#renderer.setClearColor(this.#backgroundColor ?? (theme === "light" ? 0xaebbc1 : 0x000000), 1);
    (this.#starField.material as THREE.PointsMaterial).color.setHex(theme === "light" ? 0x879ca8 : 0x8793a0);
    (this.#starField.material as THREE.PointsMaterial).opacity = theme === "light" ? 0.34 : 0.22;
    this.#requestRender();
  }

  setBackgroundColor(color: string | null): void {
    if (color === null) {
      this.#backgroundColor = null;
      this.setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
      return;
    }
    const parsed = new THREE.Color(color);
    this.#backgroundColor = parsed.getHex();
    this.#renderer.setClearColor(parsed, 1);
    this.#requestRender();
  }

  get state(): VolumeViewState {
    return {
      shellCount: this.#shellCount,
      cutAngleDeg: this.#cutAngleDeg,
      shellOpacity: this.#shellOpacity,
      pointSize: this.#pointSize,
      radialMinMpc: this.#radialMinMpc,
      radialMaxMpc: this.#radialMaxMpc,
      cameraDistance: this.#camera.position.length(),
      outerRadius: OUTER_RADIUS,
      representation: this.#representation,
    };
  }

  setData(points: VolumePointData): void {
    if (points.count !== this.#manifest.pointCount) throw new Error("Point data does not match volume manifest");
    this.#points = points;
    if (this.#pointCloud) {
      this.#dataLayer.remove(this.#pointCloud);
      disposeObject(this.#pointCloud);
    }
    const positions = new Float32Array(points.count * 3);
    const normalizedDistance = new Float32Array(points.count);
    const angularVisible = new Float32Array(points.count);
    const filterHealpix = this.#angularFilter ? new Healpix(this.#angularFilter.nside) : null;
    for (let index = 0; index < points.count; index += 1) {
      const distanceMpc = points.comovingDistanceMpc[index]!;
      const position = volumePosition(
        points.raDeg[index]!,
        points.decDeg[index]!,
        distanceMpc,
        this.#manifest.radialCoordinate.domainMaxMpc,
        OUTER_RADIUS,
      );
      positions.set([position.x, position.y, position.z], index * 3);
      normalizedDistance[index] = distanceMpc / this.#manifest.radialCoordinate.domainMaxMpc;
      angularVisible[index] = !filterHealpix || filterHealpix.ang2pix(new Pointing(
        null,
        false,
        ((90 - points.decDeg[index]!) * Math.PI) / 180,
        (points.raDeg[index]! * Math.PI) / 180,
      )) === this.#angularFilter!.pixel ? 1 : 0;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("aRadius", new THREE.BufferAttribute(normalizedDistance, 1));
    geometry.setAttribute("aAngularVisible", new THREE.BufferAttribute(angularVisible, 1));
    geometry.computeBoundingSphere();
    this.#pointMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uPointSize: { value: this.#pointSize * Math.min(window.devicePixelRatio, 2) },
        uMinRadius: { value: 0 },
        uMaxRadius: { value: 1 },
        uColorLow: { value: new THREE.Color(0x42d4c6) },
        uColorMid: { value: new THREE.Color(0xf2cf62) },
        uColorHigh: { value: new THREE.Color(0xf07768) },
      },
      vertexShader: `
        attribute float aRadius;
        attribute float aAngularVisible;
        uniform float uPointSize;
        uniform float uMinRadius;
        uniform float uMaxRadius;
        varying float vRadius;
        varying float vVisible;
        void main() {
          vRadius = aRadius;
          vVisible = aAngularVisible * step(uMinRadius, aRadius) * step(aRadius, uMaxRadius);
          vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * viewPosition;
          gl_PointSize = uPointSize * clamp(1.9 / max(0.3, -viewPosition.z), 0.72, 2.4);
        }
      `,
      fragmentShader: `
        uniform vec3 uColorLow;
        uniform vec3 uColorMid;
        uniform vec3 uColorHigh;
        varying float vRadius;
        varying float vVisible;
        void main() {
          if (vVisible < 0.5) discard;
          float radius = length(gl_PointCoord - vec2(0.5));
          float alpha = 1.0 - smoothstep(0.22, 0.5, radius);
          if (alpha <= 0.01) discard;
          vec3 color = mix(uColorLow, uColorMid, smoothstep(0.0, 0.56, vRadius));
          color = mix(color, uColorHigh, smoothstep(0.5, 1.0, vRadius));
          gl_FragColor = vec4(color, alpha * 0.42);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });
    this.#pointCloud = new THREE.Points(geometry, this.#pointMaterial);
    this.#pointCloud.renderOrder = 10;
    this.#pointCloud.visible = this.#representation === "points";
    this.#dataLayer.add(this.#pointCloud);
    this.#raycaster.params.Points = { threshold: 0.018 };
    this.#requestRender();
  }

  setAngularFilter(filter: { nside: number; pixel: number } | null): void {
    this.#angularFilter = filter;
    if (!this.#points || !this.#pointCloud) return;
    const attribute = this.#pointCloud.geometry.getAttribute("aAngularVisible") as THREE.BufferAttribute;
    const filterHealpix = filter ? new Healpix(filter.nside) : null;
    for (let index = 0; index < this.#points.count; index += 1) {
      const visible = !filterHealpix || filterHealpix.ang2pix(new Pointing(
        null,
        false,
        ((90 - this.#points.decDeg[index]!) * Math.PI) / 180,
        (this.#points.raDeg[index]! * Math.PI) / 180,
      )) === filter!.pixel;
      attribute.setX(index, visible ? 1 : 0);
    }
    attribute.needsUpdate = true;
    this.#clearSelection();
    this.#requestRender();
  }

  setJointCells(cells: AtlasJointCellView[], nside: number, radialBins: number): void {
    this.#jointCells = cells;
    this.#jointNside = nside;
    this.#jointRadialBins = radialBins;
    if (this.#voxelMesh) {
      this.#voxelLayer.remove(this.#voxelMesh);
      disposeObject(this.#voxelMesh);
    }
    const maximum = Math.max(1, ...cells.map((cell) => cell.count));
    const domainMaxMpc = this.#manifest.radialCoordinate.domainMaxMpc;
    const geometry = buildSphericalCellGeometry(cells.map((cell) => {
      const midpoint = (cell.radialMinMpc + cell.radialMaxMpc) / (2 * domainMaxMpc);
      const intensity = 0.38 + 0.62 * (Math.log1p(cell.count) / Math.log1p(maximum));
      return {
        nside,
        pixel: cell.pixel,
        innerRadius: cell.radialMinMpc / domainMaxMpc,
        outerRadius: cell.radialMaxMpc / domainMaxMpc,
        color: colorForRadius(midpoint).multiplyScalar(intensity),
      };
    }));
    this.#voxelMesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide,
      depthWrite: false,
    }));
    this.#voxelMesh.renderOrder = 9;
    this.#voxelMesh.visible = this.#representation === "cells";
    this.#voxelLayer.add(this.#voxelMesh);
    this.#clearSelection();
    this.#emitState();
    this.#requestRender();
  }

  setRepresentation(representation: "cells" | "points"): void {
    this.#representation = representation;
    if (this.#voxelMesh) this.#voxelMesh.visible = representation === "cells";
    if (this.#pointCloud) this.#pointCloud.visible = representation === "points";
    this.#shellOpacity = representation === "cells" ? 0.018 : 0.045;
    this.#rebuildShells();
    this.#clearSelection();
    this.#emitState();
    this.#requestRender();
  }

  setShellCount(shellCount: number): void {
    if (![1, 2, 4, 8, 16, 32].includes(shellCount)) throw new RangeError("Unsupported shell count");
    this.#shellCount = shellCount;
    this.#clearSelection();
    this.#rebuildShells();
  }

  setCutAngle(cutAngleDeg: number): void {
    this.#cutAngleDeg = THREE.MathUtils.clamp(cutAngleDeg, 30, 120);
    this.#rebuildShells();
  }

  setShellOpacity(opacity: number): void {
    this.#shellOpacity = THREE.MathUtils.clamp(opacity, 0.01, 0.16);
    this.#shellLayer.traverse((child) => {
      if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshBasicMaterial) {
        child.material.opacity = this.#shellOpacity;
      }
    });
    this.#emitState();
    this.#requestRender();
  }

  setPointSize(size: number): void {
    this.#pointSize = THREE.MathUtils.clamp(size, 1, 5.5);
    if (this.#pointMaterial) this.#pointMaterial.uniforms.uPointSize!.value = this.#pointSize * Math.min(window.devicePixelRatio, 2);
    this.#emitState();
    this.#requestRender();
  }

  setRadialRange(minMpc: number, maxMpc: number): void {
    const domainMax = this.#manifest.radialCoordinate.domainMaxMpc;
    this.#radialMinMpc = THREE.MathUtils.clamp(Math.min(minMpc, maxMpc - 50), 0, domainMax - 50);
    this.#radialMaxMpc = THREE.MathUtils.clamp(Math.max(maxMpc, this.#radialMinMpc + 50), 50, domainMax);
    if (this.#pointMaterial) {
      this.#pointMaterial.uniforms.uMinRadius!.value = this.#radialMinMpc / domainMax;
      this.#pointMaterial.uniforms.uMaxRadius!.value = this.#radialMaxMpc / domainMax;
    }
    this.#clearSelection();
    this.#emitState();
    this.#requestRender();
  }

  focusData(): void {
    const axis = asVector(this.#manifest.coverage.centerRaDeg, this.#manifest.coverage.centerDecDeg).normalize();
    let tangent = new THREE.Vector3().crossVectors(axis, new THREE.Vector3(0, 1, 0));
    if (tangent.lengthSq() < 0.01) tangent = new THREE.Vector3(1, 0, 0);
    tangent.normalize();
    this.#camera.position.copy(axis.multiplyScalar(0.62).add(tangent.multiplyScalar(1.0)).normalize().multiplyScalar(DEFAULT_CAMERA_DISTANCE));
    this.#camera.up.set(0, 1, 0);
    this.#controls.target.set(0, 0, 0);
    this.#controls.update();
    this.#emitState();
    this.#requestRender();
  }

  reset(): void {
    this.#shellCount = 8;
    this.#cutAngleDeg = 72;
    this.#shellOpacity = 0.045;
    this.#pointSize = 2.4;
    this.#radialMinMpc = 0;
    this.#radialMaxMpc = this.#manifest.radialCoordinate.domainMaxMpc;
    this.#representation = "cells";
    this.#angularFilter = null;
    this.#rebuildShells();
    this.setPointSize(this.#pointSize);
    this.setRadialRange(this.#radialMinMpc, this.#radialMaxMpc);
    this.focusData();
  }

  dispose(): void {
    this.#resizeObserver.disconnect();
    this.#controls.dispose();
    disposeObject(this.#scene);
    this.#renderer.dispose();
    releaseWebglContext(this.#renderer);
  }

  #createBackgroundStars(): THREE.Points {
    const count = 1100;
    const positions = new Float32Array(count * 3);
    let state = 0x51a7c0de;
    const random = (): number => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x1_0000_0000;
    };
    for (let index = 0; index < count; index += 1) {
      const point = new THREE.Vector3(random() * 2 - 1, random() * 2 - 1, random() * 2 - 1).normalize().multiplyScalar(8);
      positions.set([point.x, point.y, point.z], index * 3);
    }
    const geometry = new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(positions, 3));
    return new THREE.Points(geometry, new THREE.PointsMaterial({
      color: 0x8793a0,
      size: 1,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
    }));
  }

  #rebuildShells(): void {
    for (const child of [...this.#shellLayer.children]) {
      this.#shellLayer.remove(child);
      disposeObject(child);
    }
    const cutRadians = THREE.MathUtils.degToRad(this.#cutAngleDeg);
    const phiStart = cutRadians / 2;
    const phiLength = Math.PI * 2 - cutRadians;
    for (let index = 1; index <= this.#shellCount; index += 1) {
      const radius = (index / this.#shellCount) * OUTER_RADIUS;
      const radialValue = index / this.#shellCount;
      const color = colorForRadius(radialValue);
      const surface = new THREE.Mesh(
        new THREE.SphereGeometry(radius, SHELL_SEGMENTS, 36, phiStart, phiLength, 0, Math.PI),
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: this.#shellOpacity,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      surface.renderOrder = index;
      const grid = new THREE.LineSegments(
        shellGridGeometry(radius, phiStart, phiLength, index === this.#shellCount),
        new THREE.LineBasicMaterial({
          color,
          transparent: true,
          opacity: index === this.#shellCount ? 0.32 : 0.12,
          depthWrite: false,
        }),
      );
      grid.renderOrder = index + 1;
      this.#shellLayer.add(surface, grid);
    }
    const guides = new THREE.LineSegments(
      radialGuideGeometry(phiStart, phiLength),
      new THREE.LineBasicMaterial({ color: 0xb7c0c9, transparent: true, opacity: 0.35, depthWrite: false }),
    );
    guides.renderOrder = this.#shellCount + 2;
    this.#shellLayer.add(guides);
    const origin = new THREE.Mesh(
      new THREE.SphereGeometry(0.012, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0xf4f7f8 }),
    );
    this.#shellLayer.add(origin);
    this.#emitState();
    this.#requestRender();
  }

  #bindInteraction(): void {
    this.#canvas.addEventListener("pointerdown", (event) => {
      this.#pointerStart = { x: event.clientX, y: event.clientY };
    });
    this.#canvas.addEventListener("pointerup", (event) => {
      if (!this.#pointerStart) return;
      const distance = Math.hypot(event.clientX - this.#pointerStart.x, event.clientY - this.#pointerStart.y);
      this.#pointerStart = null;
      if (distance < 5) this.#pick(event);
    });
    this.#canvas.addEventListener("pointercancel", () => {
      this.#pointerStart = null;
    });
  }

  #pick(event: PointerEvent): void {
    const bounds = this.#canvas.getBoundingClientRect();
    this.#pointer.set(
      ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
      -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
    );
    this.#raycaster.setFromCamera(this.#pointer, this.#camera);
    if (this.#representation === "cells" && this.#voxelMesh) {
      const voxelHit = this.#raycaster.intersectObject(this.#voxelMesh, false)[0];
      if (!voxelHit || voxelHit.faceIndex == null) {
        this.#clearSelection();
        return;
      }
      const index = Math.floor(voxelHit.faceIndex / TRIANGLES_PER_SPHERICAL_CELL);
      const cell = this.#jointCells[index];
      if (!cell) return;
      this.#clearSelection(false);
      const domainMaxMpc = this.#manifest.radialCoordinate.domainMaxMpc;
      const marker = new THREE.Mesh(
        buildSphericalCellGeometry([{
          nside: this.#jointNside,
          pixel: cell.pixel,
          innerRadius: cell.radialMinMpc / domainMaxMpc,
          outerRadius: cell.radialMaxMpc / domainMaxMpc,
          color: new THREE.Color(0xffffff),
        }]),
        new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.95 }),
      );
      marker.renderOrder = 20;
      this.#selectionLayer.add(marker);
      this.#onSelection({ kind: "joint-cell", nside: this.#jointNside, radialBins: this.#jointRadialBins, ...cell });
      this.#requestRender();
      return;
    }
    if (!this.#pointCloud || !this.#points) return;
    const hit = this.#raycaster.intersectObject(this.#pointCloud, false).find((candidate) => {
      if (candidate.index == null) return false;
      const distanceMpc = this.#points!.comovingDistanceMpc[candidate.index]!;
      const angularVisible = this.#pointCloud!.geometry.getAttribute("aAngularVisible").getX(candidate.index);
      return angularVisible > 0.5 && distanceMpc >= this.#radialMinMpc && distanceMpc <= this.#radialMaxMpc;
    });
    if (!hit || hit.index == null) {
      this.#clearSelection();
      return;
    }
    const index = hit.index;
    const distanceMpc = this.#points.comovingDistanceMpc[index]!;
    const position = this.#pointCloud.geometry.getAttribute("position");
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.018, 16, 10),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.96 }),
    );
    marker.position.set(position.getX(index), position.getY(index), position.getZ(index));
    this.#clearSelection(false);
    this.#selectionLayer.add(marker);
    this.#onSelection({
      kind: "object",
      index,
      targetId: this.#points.targetId[index]!,
      raDeg: this.#points.raDeg[index]!,
      decDeg: this.#points.decDeg[index]!,
      bestZ: this.#points.bestZ[index]!,
      zErr: this.#points.zErr[index]!,
      comovingDistanceMpc: distanceMpc,
      shellIndex: radialShellIndex(distanceMpc, this.#manifest.radialCoordinate.domainMaxMpc, this.#shellCount),
    });
    this.#requestRender();
  }

  #clearSelection(notify = true): void {
    for (const child of [...this.#selectionLayer.children]) {
      this.#selectionLayer.remove(child);
      disposeObject(child);
    }
    if (notify) this.#onSelection(null);
    this.#requestRender();
  }

  #emitState(): void {
    this.#onStateChange(this.state);
  }

  #resize(): void {
    const bounds = this.#canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(bounds.width));
    const height = Math.max(1, Math.round(bounds.height));
    this.#renderer.setSize(width, height, false);
    this.#renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.#camera.aspect = width / height;
    this.#camera.updateProjectionMatrix();
    if (this.#pointMaterial) this.#pointMaterial.uniforms.uPointSize!.value = this.#pointSize * Math.min(window.devicePixelRatio, 2);
    this.#requestRender();
  }

  #requestRender(): void {
    if (this.#renderQueued) return;
    this.#renderQueued = true;
    requestAnimationFrame(() => {
      this.#renderQueued = false;
      const moving = this.#controls.update();
      this.#renderer.render(this.#scene, this.#camera);
      if (moving) this.#requestRender();
    });
  }
}
