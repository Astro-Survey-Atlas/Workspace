import * as THREE from "three";
import { Healpix, Pointing, Vec3 } from "healpixjs";
export const TRIANGLES_PER_SPHERICAL_CELL = 12;
export const TRIANGLES_PER_SPHERICAL_CELL_SHEET = 2;
const healpixCache = new Map();
function healpix(nside) {
    let instance = healpixCache.get(nside);
    if (!instance) {
        instance = new Healpix(nside);
        healpixCache.set(nside, instance);
    }
    return instance;
}
function sceneVector(vector, radius) {
    return new THREE.Vector3(-vector.y * radius, vector.z * radius, -vector.x * radius);
}
/** Inverse of the shared HEALPix -> Three.js celestial frame used by sceneVector. */
export function sceneDirectionToHealpixVector(direction) {
    const length = Math.hypot(direction.x, direction.y, direction.z);
    if (length === 0)
        return new Vec3(1, 0, 0);
    return new Vec3(-direction.z / length, -direction.x / length, direction.y / length);
}
/** Map a Three.js celestial direction to the nested HEALPix pixel at the given NSIDE. */
export function healpixPixelFromSceneDirection(nside, direction) {
    return healpix(nside).ang2pix(new Pointing(sceneDirectionToHealpixVector(direction)));
}
export function sphericalCellBoundary(nside, pixel, radius) {
    return healpix(nside).getBoundaries(pixel).map((vector) => sceneVector(vector, radius));
}
function insetBoundary(boundary, radius, inset) {
    if (inset <= 0)
        return boundary;
    const center = boundary.reduce((sum, point) => sum.add(point), new THREE.Vector3()).normalize();
    return boundary.map((point) => point.clone().normalize().lerp(center, inset).normalize().multiplyScalar(radius));
}
export function buildSphericalCellGeometry(cells) {
    const positions = [];
    const colors = [];
    const triangles = [
        [4, 5, 6], [4, 6, 7],
        [0, 2, 1], [0, 3, 2],
        [0, 1, 5], [0, 5, 4],
        [1, 2, 6], [1, 6, 5],
        [2, 3, 7], [2, 7, 6],
        [3, 0, 4], [3, 4, 7],
    ];
    cells.forEach((cell) => {
        const inner = insetBoundary(sphericalCellBoundary(cell.nside, cell.pixel, cell.innerRadius), cell.innerRadius, cell.inset ?? 0);
        const outer = insetBoundary(sphericalCellBoundary(cell.nside, cell.pixel, cell.outerRadius), cell.outerRadius, cell.inset ?? 0);
        const vertices = [...inner, ...outer];
        if (vertices.length !== 8)
            throw new Error("HEALPix cell boundary is not quadrilateral");
        triangles.forEach((triangle) => {
            triangle.forEach((vertexIndex) => {
                const vertex = vertices[vertexIndex];
                positions.push(vertex.x, vertex.y, vertex.z);
                colors.push(cell.color.r, cell.color.g, cell.color.b);
            });
        });
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
}
export function buildSphericalCellSheetGeometry(cells) {
    const positions = [];
    const colors = [];
    const triangles = [[0, 1, 2], [0, 2, 3]];
    cells.forEach((cell) => {
        const vertices = insetBoundary(sphericalCellBoundary(cell.nside, cell.pixel, cell.radius), cell.radius, cell.inset ?? 0);
        if (vertices.length !== 4)
            throw new Error("HEALPix cell boundary is not quadrilateral");
        triangles.forEach((triangle) => {
            triangle.forEach((vertexIndex) => {
                const vertex = vertices[vertexIndex];
                positions.push(vertex.x, vertex.y, vertex.z);
                colors.push(cell.color.r, cell.color.g, cell.color.b);
            });
        });
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geometry.computeBoundingSphere();
    return geometry;
}
export function buildSphericalCellEdges(cells) {
    const positions = [];
    const colors = [];
    cells.forEach((cell) => {
        const radius = ("radius" in cell ? cell.radius : cell.outerRadius) + 0.0015;
        const boundary = insetBoundary(sphericalCellBoundary(cell.nside, cell.pixel, radius), radius, cell.inset ?? 0);
        for (let index = 0; index < boundary.length; index += 1) {
            const start = boundary[index];
            const end = boundary[(index + 1) % boundary.length];
            positions.push(start.x, start.y, start.z, end.x, end.y, end.z);
            colors.push(cell.color.r, cell.color.g, cell.color.b, cell.color.r, cell.color.g, cell.color.b);
        }
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geometry.computeBoundingSphere();
    return geometry;
}
