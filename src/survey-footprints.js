import { readFile } from "node:fs/promises";
import path from "node:path";
export const SURVEY_FOOTPRINT_SCHEMA_VERSION = 1;
function assertManifest(value) {
    if (!value || typeof value !== "object")
        throw new Error("Survey footprint manifest must be an object");
    const manifest = value;
    if (manifest.schemaVersion !== SURVEY_FOOTPRINT_SCHEMA_VERSION || manifest.coordinateFrame !== "ICRS" || !Number.isInteger(manifest.nside) || !Array.isArray(manifest.footprints)) {
        throw new Error("Survey footprint manifest has an unsupported schema");
    }
    for (const footprint of manifest.footprints) {
        if (!footprint || typeof footprint.surveyId !== "string" || typeof footprint.releaseId !== "string" || typeof footprint.product !== "string" || !Array.isArray(footprint.pixels) || footprint.nside !== manifest.nside) {
            throw new Error("Survey footprint manifest contains an invalid footprint");
        }
        if (footprint.pixels.some((pixel) => !Number.isInteger(pixel) || pixel < 0 || pixel >= 12 * manifest.nside ** 2)) {
            throw new Error(`Survey footprint contains an invalid HEALPix cell: ${footprint.surveyId}`);
        }
    }
}
/** Read a compact, generated coverage catalog. It contains metadata only, never survey rows or images. */
export class SurveyFootprintCatalog {
    #manifestPath;
    #manifest = null;
    constructor(root) {
        this.#manifestPath = path.join(root, "survey-footprints.json");
    }
    async list() {
        if (this.#manifest)
            return this.#manifest;
        const parsed = JSON.parse(await readFile(this.#manifestPath, "utf8"));
        assertManifest(parsed);
        this.#manifest = {
            ...parsed,
            footprints: parsed.footprints.map((footprint) => ({
                ...footprint,
                pixels: [...new Set(footprint.pixels)].sort((left, right) => left - right),
            })),
        };
        return this.#manifest;
    }
}
