import type { SurveyFootprint } from "./survey-footprints.js";

export interface PublicSourceIdentity {
  surveyId: string;
  releaseId: string;
  product: string;
  sourceId?: string;
  layerId?: string;
}

const MAX_ID_PART_LENGTH = 180;
const PUBLIC_PREFIX = "public";
const GEOMETRY_PREFIX = "geometry:public";

function normalizePart(value: unknown, name: string): string {
  if (typeof value !== "string") throw new RangeError(`${name} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_ID_PART_LENGTH || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new RangeError(`${name} must be a non-empty printable string`);
  }
  return normalized;
}

export function normalizePublicSourceIdentity(value: PublicSourceIdentity): PublicSourceIdentity {
  const surveyId = normalizePart(value.surveyId, "surveyId");
  const releaseId = normalizePart(value.releaseId, "releaseId");
  const product = normalizePart(value.product, "product");
  const sourceId = value.sourceId === undefined ? undefined : normalizePart(value.sourceId, "sourceId");
  const layerId = value.layerId === undefined ? undefined : normalizePart(value.layerId, "layerId");
  if (!sourceId && !layerId) throw new RangeError("a public source identity requires sourceId or layerId");
  return {
    surveyId,
    releaseId,
    product,
    ...(sourceId ? { sourceId } : {}),
    ...(layerId ? { layerId } : {}),
  };
}

function encodePart(value: string): string {
  return encodeURIComponent(value);
}

function decodePart(value: string, name: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (encodePart(decoded) !== value) throw new Error();
    return normalizePart(decoded, name);
  } catch {
    throw new RangeError(`invalid encoded ${name}`);
  }
}

export function formatPublicSourceId(value: PublicSourceIdentity): string {
  const identity = normalizePublicSourceIdentity(value);
  const parts = [PUBLIC_PREFIX, encodePart(identity.surveyId), encodePart(identity.releaseId), encodePart(identity.product)];
  if (identity.sourceId) parts.push(`sourceId=${encodePart(identity.sourceId)}`);
  if (identity.layerId) parts.push(`layerId=${encodePart(identity.layerId)}`);
  return parts.join(":");
}

export function parsePublicSourceId(value: string): PublicSourceIdentity | undefined {
  if (typeof value !== "string" || !value.startsWith(`${PUBLIC_PREFIX}:`)) return undefined;
  const parts = value.split(":");
  if (parts.length < 5 || parts.length > 6 || parts[0] !== PUBLIC_PREFIX) return undefined;
  try {
    const identity: PublicSourceIdentity = {
      surveyId: decodePart(parts[1]!, "surveyId"),
      releaseId: decodePart(parts[2]!, "releaseId"),
      product: decodePart(parts[3]!, "product"),
    };
    const keys = new Set<string>();
    for (const part of parts.slice(4)) {
      const separator = part.indexOf("=");
      if (separator <= 0 || separator === part.length - 1) return undefined;
      const key = part.slice(0, separator);
      const encoded = part.slice(separator + 1);
      if (key !== "sourceId" && key !== "layerId") return undefined;
      if (keys.has(key)) return undefined;
      keys.add(key);
      const decoded = decodePart(encoded, key);
      if (key === "sourceId") identity.sourceId = decoded;
      else identity.layerId = decoded;
    }
    const normalized = normalizePublicSourceIdentity(identity);
    return formatPublicSourceId(normalized) === value ? normalized : undefined;
  } catch {
    return undefined;
  }
}

export function isConcretePublicSourceId(value: string): boolean {
  return parsePublicSourceId(value) !== undefined;
}

export function publicSourceIdentityForFootprint(footprint: Pick<SurveyFootprint, "surveyId" | "releaseId" | "product" | "sourceId" | "layerId">): PublicSourceIdentity | undefined {
  if (!footprint.sourceId && !footprint.layerId) return undefined;
  return normalizePublicSourceIdentity({
    surveyId: footprint.surveyId,
    releaseId: footprint.releaseId,
    product: footprint.product,
    ...(footprint.sourceId ? { sourceId: footprint.sourceId } : {}),
    ...(footprint.layerId ? { layerId: footprint.layerId } : {}),
  });
}

export function publicSourceIdForFootprint(footprint: Pick<SurveyFootprint, "surveyId" | "releaseId" | "product" | "sourceId" | "layerId">): string | undefined {
  const identity = publicSourceIdentityForFootprint(footprint);
  return identity ? formatPublicSourceId(identity) : undefined;
}

export function publicGeometrySourceIdForFootprint(footprint: Pick<SurveyFootprint, "surveyId" | "releaseId" | "product">): string {
  return [GEOMETRY_PREFIX, encodePart(normalizePart(footprint.surveyId, "surveyId")), encodePart(normalizePart(footprint.releaseId, "releaseId")), encodePart(normalizePart(footprint.product, "product"))].join(":");
}
