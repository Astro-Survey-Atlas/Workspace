import { Healpix } from "healpixjs";

import type { SurveyFootprint, SurveyFootprintManifest } from "./survey-footprints.js";

export interface SurveyLayerIdentity {
  id: string;
}

export interface SurveyLayerSlot {
  surveyId: string;
  displayRadius: number;
  hasFootprint: boolean;
}

export type SurveyLayerLayoutMode = "layers" | "overlap";

export interface CoverageCellMembership {
  surveyIds: string[];
  releaseIds: string[];
  artifacts: SurveyFootprint[];
}

export interface SurveyLayerModel {
  slots: SurveyLayerSlot[];
  coverageByPixel: Map<number, CoverageCellMembership>;
  pixelsBySurvey: Map<string, number[]>;
}

export const SURVEY_LAYER_BASE_RADIUS = 1;
export const SURVEY_LAYER_DISPLAY_STEP = 0.075;

const healpixByNside = new Map<number, Healpix>();
const SIDE_NEIGHBOUR_INDICES = [1, 3, 5, 7] as const;

function healpix(nside: number): Healpix {
  let instance = healpixByNside.get(nside);
  if (!instance) {
    instance = new Healpix(nside);
    healpixByNside.set(nside, instance);
  }
  return instance;
}

export function buildSurveyLayerModel(
  surveys: readonly SurveyLayerIdentity[],
  manifest: SurveyFootprintManifest,
): SurveyLayerModel {
  const footprintSurveyIds = new Set(manifest.footprints.map((footprint) => footprint.surveyId));
  const pixelsBySurvey = new Map<string, Set<number>>();
  const coverageByPixel = new Map<number, { surveyIds: Set<string>; releaseIds: Set<string>; artifacts: SurveyFootprint[] }>();

  for (const footprint of manifest.footprints) {
    const pixels = pixelsBySurvey.get(footprint.surveyId) ?? new Set<number>();
    pixelsBySurvey.set(footprint.surveyId, pixels);
    for (const pixel of footprint.pixels) {
      pixels.add(pixel);
      const coverage = coverageByPixel.get(pixel) ?? { surveyIds: new Set<string>(), releaseIds: new Set<string>(), artifacts: [] };
      coverage.surveyIds.add(footprint.surveyId);
      coverage.releaseIds.add(footprint.releaseId);
      coverage.artifacts.push(footprint);
      coverageByPixel.set(pixel, coverage);
    }
  }

  return {
    slots: surveys.map((survey) => ({
      surveyId: survey.id,
      displayRadius: SURVEY_LAYER_BASE_RADIUS,
      hasFootprint: footprintSurveyIds.has(survey.id),
    })),
    pixelsBySurvey: new Map([...pixelsBySurvey].map(([surveyId, pixels]) => [surveyId, [...pixels].sort((left, right) => left - right)])),
    coverageByPixel: new Map([...coverageByPixel].map(([pixel, coverage]) => [pixel, {
      surveyIds: [...coverage.surveyIds].sort(),
      releaseIds: [...coverage.releaseIds].sort(),
      artifacts: [...coverage.artifacts].sort((left, right) => `${left.surveyId}:${left.releaseId}:${left.product}`.localeCompare(`${right.surveyId}:${right.releaseId}:${right.product}`)),
    }])),
  };
}

/** Display radii are packed around a neutral radius and have no physical meaning. */
export function visibleSurveySlots(
  model: SurveyLayerModel,
  visibleSurveyIds: Iterable<string>,
  layoutMode: SurveyLayerLayoutMode,
): SurveyLayerSlot[] {
  const visible = new Set(visibleSurveyIds);
  const selected = model.slots.filter((slot) => slot.hasFootprint && visible.has(slot.surveyId));
  const midpoint = (selected.length - 1) / 2;
  return selected.map((slot, index) => ({
    ...slot,
    displayRadius: layoutMode === "overlap"
      ? SURVEY_LAYER_BASE_RADIUS
      : SURVEY_LAYER_BASE_RADIUS + (index - midpoint) * SURVEY_LAYER_DISPLAY_STEP,
  }));
}

export function visibleCoverageAtPixel(
  model: SurveyLayerModel,
  pixel: number,
  visibleSurveyIds: Iterable<string>,
): CoverageCellMembership | null {
  const membership = model.coverageByPixel.get(pixel);
  if (!membership) return null;
  const visible = new Set(visibleSurveyIds);
  const artifacts = membership.artifacts.filter((artifact) => visible.has(artifact.surveyId));
  if (!artifacts.length) return null;
  return {
    surveyIds: [...new Set(artifacts.map((artifact) => artifact.surveyId))].sort(),
    releaseIds: [...new Set(artifacts.map((artifact) => artifact.releaseId))].sort(),
    artifacts,
  };
}

export function overlapCountByPixel(
  model: SurveyLayerModel,
  visibleSurveyIds: Iterable<string>,
): Map<number, number> {
  const visible = new Set(visibleSurveyIds);
  return new Map([...model.coverageByPixel]
    .map(([pixel, membership]) => [pixel, membership.surveyIds.filter((surveyId) => visible.has(surveyId)).length] as const)
    .filter(([, count]) => count > 0));
}

/** HEALPix returns SW, W, NW, N, NE, E, SE, S. Keep only shared-edge neighbours. */
export function sideNeighbours(nside: number, pixel: number): number[] {
  const neighbours = healpix(nside).neighbours(pixel);
  return SIDE_NEIGHBOUR_INDICES
    .map((index) => neighbours[index] ?? -1)
    .filter((neighbour) => neighbour >= 0);
}

export function sharesSide(nside: number, left: number, right: number): boolean {
  return sideNeighbours(nside, left).includes(right);
}

export function isSideConnected(nside: number, pixels: Iterable<number>): boolean {
  const selected = new Set(pixels);
  if (selected.size < 2) return true;
  const pending = [selected.values().next().value as number];
  const visited = new Set<number>();
  while (pending.length) {
    const pixel = pending.pop();
    if (pixel == null || visited.has(pixel)) continue;
    visited.add(pixel);
    for (const neighbour of sideNeighbours(nside, pixel)) {
      if (selected.has(neighbour) && !visited.has(neighbour)) pending.push(neighbour);
    }
  }
  return visited.size === selected.size;
}

export type RegionToggleResult =
  | { ok: true; pixels: number[]; changed: "added" | "removed" | "replaced" }
  | { ok: false; reason: "not-adjacent" | "would-disconnect"; pixels: number[] };

export function toggleConnectedRegion(
  nside: number,
  currentPixels: Iterable<number>,
  pixel: number,
  additive: boolean,
): RegionToggleResult {
  const current = new Set(currentPixels);
  if (!additive) return { ok: true, pixels: [pixel], changed: "replaced" };
  if (current.size === 0) return { ok: true, pixels: [pixel], changed: "added" };
  if (!current.has(pixel)) {
    if (![...current].some((candidate) => sharesSide(nside, candidate, pixel))) {
      return { ok: false, reason: "not-adjacent", pixels: [...current].sort((left, right) => left - right) };
    }
    current.add(pixel);
    return { ok: true, pixels: [...current].sort((left, right) => left - right), changed: "added" };
  }
  current.delete(pixel);
  if (!isSideConnected(nside, current)) {
    return { ok: false, reason: "would-disconnect", pixels: [...currentPixels].sort((left, right) => left - right) };
  }
  return { ok: true, pixels: [...current].sort((left, right) => left - right), changed: "removed" };
}
