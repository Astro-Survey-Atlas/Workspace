import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
const ASSET_KINDS = ["catalog", "image", "spectra", "cube", "timeseries", "other"];
const CONNECTOR_KINDS = ["metadata", "local", "http", "mcp", "tap", "s3", "database", "jdbc"];
const ASSET_STATUSES = ["ready", "metadata_only", "unavailable"];
const PROJECT_STATES = ["public_reference", "acquired", "processed", "deliverable", "planned"];
const PROJECT_STATE_PRIORITY = ["deliverable", "processed", "acquired", "public_reference", "planned"];
export function inferProjectStates(record) {
    const accesses = record.accesses?.length ? record.accesses : [record.access];
    const states = [];
    if (record.status === "metadata_only")
        states.push("public_reference");
    if (accesses.some((access) => ["local", "s3", "database", "jdbc"].includes(access.connector)))
        states.push("acquired");
    if (!states.length)
        states.push("planned");
    return states;
}
export function inferProjectState(record) {
    return inferProjectStates(record)[0] ?? "planned";
}
function textValue(value, name, maximum, required = true) {
    const result = typeof value === "string" ? value.trim() : "";
    if (required && !result)
        throw new RangeError(`${name} is required`);
    if (result.length > maximum)
        throw new RangeError(`${name} must contain at most ${maximum} characters`);
    return result;
}
function optionalText(value, name, maximum) {
    return textValue(value, name, maximum, false) || undefined;
}
function validateAccesses(value) {
    if (value === undefined)
        return undefined;
    if (!Array.isArray(value) || !value.length)
        throw new RangeError("accesses must contain at least one access location");
    return value.map((entry, index) => {
        const access = (entry && typeof entry === "object" ? entry : {});
        if (!CONNECTOR_KINDS.includes(access.connector))
            throw new RangeError(`accesses[${index}].connector is not supported`);
        return {
            connector: access.connector,
            uri: textValue(access.uri, `accesses[${index}].uri`, 2048),
            format: textValue(access.format, `accesses[${index}].format`, 80),
            connectorId: optionalText(access.connectorId, `accesses[${index}].connectorId`, 120),
            label: optionalText(access.label, `accesses[${index}].label`, 120),
        };
    });
}
function validateConnectorIds(value) {
    if (value === undefined)
        return undefined;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
        throw new RangeError("connectorIds must be an array of non-empty strings");
    }
    return [...new Set(value.map((item) => item.trim()))];
}
function validateConnectorLocationKeys(value) {
    if (value === undefined)
        return undefined;
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim() || entry.length > 2048)) {
        throw new RangeError("connectorLocationKeys must be an array of non-empty strings");
    }
    return [...new Set(value.map((entry) => entry.trim()))];
}
function validateSources(value) {
    if (value === undefined)
        return undefined;
    if (!Array.isArray(value))
        throw new RangeError("sources must be an array");
    return value.map((entry, index) => {
        const source = (entry && typeof entry === "object" ? entry : {});
        return {
            label: textValue(source.label, `sources[${index}].label`, 120),
            url: textValue(source.url, `sources[${index}].url`, 2048),
            description: optionalText(source.description, `sources[${index}].description`, 500),
        };
    });
}
function validateLineage(value) {
    if (value === undefined)
        return undefined;
    if (!Array.isArray(value))
        throw new RangeError("lineage must be an array");
    return value.map((entry, index) => {
        const lineage = (entry && typeof entry === "object" ? entry : {});
        return {
            relation: textValue(lineage.relation, `lineage[${index}].relation`, 80),
            label: textValue(lineage.label, `lineage[${index}].label`, 240),
            assetId: optionalText(lineage.assetId, `lineage[${index}].assetId`, 120),
        };
    });
}
function validProjectStates(value, name = "projectStates") {
    if (value === undefined)
        return undefined;
    if (!Array.isArray(value) || !value.length || value.some((state) => !PROJECT_STATES.includes(state))) {
        throw new RangeError(`${name} contains an unsupported state`);
    }
    return [...new Set(value)];
}
function preferredProjectState(states) {
    return PROJECT_STATE_PRIORITY.find((state) => states.includes(state)) ?? "planned";
}
function primaryAccess(value) {
    return value.accesses?.[0] ?? {
        connector: value.connector ?? "metadata",
        uri: value.sourceUri || `asset://${encodeURIComponent(value.name)}`,
        format: value.format || "metadata",
    };
}
function validateInput(input) {
    const value = (input && typeof input === "object" ? input : {});
    const name = textValue(value.name, "name", 120);
    const sourceUri = textValue(value.sourceUri, "sourceUri", 2048, false);
    const format = textValue(value.format, "format", 80, false);
    if (!ASSET_KINDS.includes(value.kind))
        throw new RangeError("kind is not supported");
    if (value.connector !== undefined && !CONNECTOR_KINDS.includes(value.connector))
        throw new RangeError("connector is not supported");
    if (value.status && !ASSET_STATUSES.includes(value.status))
        throw new RangeError("status is not supported");
    if (value.projectState && !PROJECT_STATES.includes(value.projectState))
        throw new RangeError("projectState is not supported");
    const tags = value.tags ?? value.modalities ?? [];
    if (!Array.isArray(tags) || tags.some((item) => typeof item !== "string" || !item.trim())) {
        throw new RangeError("tags must be an array of non-empty strings");
    }
    if (!Array.isArray(value.footprintIds ?? []) || (value.footprintIds ?? []).some((item) => typeof item !== "string" || !item.trim())) {
        throw new RangeError("footprintIds must be an array of non-empty strings");
    }
    const accesses = validateAccesses(value.accesses);
    if (value.connector !== undefined && !sourceUri && !accesses?.length)
        throw new RangeError("sourceUri is required when connector is provided");
    const sources = validateSources(value.sources);
    const lineage = validateLineage(value.lineage);
    const connectorIds = validateConnectorIds(value.connectorIds);
    const connectorLocationKeys = validateConnectorLocationKeys(value.connectorLocationKeys);
    const projectStates = validProjectStates(value.projectStates);
    return {
        name,
        description: textValue(value.description, "description", 500, false) || undefined,
        surveyId: textValue(value.surveyId, "surveyId", 120, false) || undefined,
        releaseId: textValue(value.releaseId, "releaseId", 120, false) || undefined,
        product: textValue(value.product, "product", 160, false) || undefined,
        kind: value.kind,
        modalities: [...new Set((value.modalities ?? []).map((item) => item.trim()))],
        connector: value.connector,
        sourceUri,
        format,
        tags: [...new Set(tags.map((item) => item.trim()))],
        accesses,
        sources,
        connectorIds,
        connectorLocationKeys,
        lineage,
        status: value.status,
        projectState: value.projectState,
        projectStates: projectStates ?? (value.projectState ? [value.projectState] : undefined),
        footprintIds: [...new Set((value.footprintIds ?? []).map((item) => item.trim()))],
    };
}
function normalizeRecord(entry, origin) {
    const accesses = entry.accesses?.length ? entry.accesses : [entry.access];
    const access = accesses[0] ?? entry.access;
    const inferredStates = inferProjectStates({ status: entry.status, access, accesses });
    const declaredStates = validProjectStates(entry.projectStates) ?? (PROJECT_STATES.includes(entry.projectState) ? [entry.projectState] : []);
    const projectStates = declaredStates.length ? declaredStates : inferredStates;
    return {
        ...entry,
        origin,
        tags: [...new Set(entry.tags?.length ? entry.tags : entry.modalities ?? [])],
        modalities: [...new Set(entry.tags?.length ? entry.tags : entry.modalities ?? [])],
        access,
        accesses,
        sources: Array.isArray(entry.sources) ? entry.sources : [],
        connectorIds: Array.isArray(entry.connectorIds) ? [...new Set(entry.connectorIds)] : [],
        connectorLocationKeys: Array.isArray(entry.connectorLocationKeys) ? [...new Set(entry.connectorLocationKeys)] : [],
        projectStates: projectStates.length ? projectStates : ["planned"],
        projectState: PROJECT_STATES.includes(entry.projectState) && projectStates.includes(entry.projectState)
            ? entry.projectState
            : preferredProjectState(projectStates),
    };
}
export class DataCatalogRegistry {
    #bootstrapPath;
    #statePath;
    #builtin = [];
    #user = [];
    #overrides = [];
    constructor(bootstrapPath, statePath) {
        this.#bootstrapPath = bootstrapPath;
        this.#statePath = statePath;
    }
    async initialize() {
        const builtin = JSON.parse(await readFile(this.#bootstrapPath, "utf8"));
        if (!Array.isArray(builtin))
            throw new Error("data catalog bootstrap must be an array");
        this.#builtin = builtin.map((entry) => normalizeRecord(entry, "builtin"));
        try {
            const persisted = JSON.parse(await readFile(this.#statePath, "utf8"));
            if (!Array.isArray(persisted))
                throw new Error("data catalog state must be an array");
            this.#user = persisted
                .filter((entry) => Boolean(entry) && typeof entry === "object" && entry.origin === "user")
                .map((entry) => normalizeRecord(entry, "user"));
            this.#overrides = persisted
                .filter((entry) => Boolean(entry) && typeof entry === "object" && entry.origin === "override")
                .map((entry) => normalizeRecord(entry, "override"));
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
            await this.#persist();
        }
    }
    list() {
        const overrides = new Map(this.#overrides.map((entry) => [entry.id, entry]));
        const builtin = this.#builtin.map((entry) => {
            const override = overrides.get(entry.id);
            return override ? { ...entry, ...override, origin: "builtin" } : entry;
        });
        return [...builtin, ...this.#user].map((entry) => structuredClone(entry));
    }
    get(id) {
        const record = this.list().find((entry) => entry.id === id);
        if (!record)
            throw new Error(`Data asset not found: ${id}`);
        return structuredClone(record);
    }
    async register(input) {
        const value = validateInput(input);
        const now = new Date().toISOString();
        const record = {
            id: `user-${randomUUID()}`,
            name: value.name,
            description: value.description ?? "User-registered data asset. Metadata is stored here; source rows remain at the registered connector URI.",
            surveyId: value.surveyId,
            releaseId: value.releaseId,
            product: value.product ?? value.name,
            kind: value.kind,
            modalities: value.tags ?? value.modalities ?? [],
            tags: value.tags ?? value.modalities ?? [],
            access: primaryAccess(value),
            accesses: value.accesses ?? [primaryAccess(value)],
            sources: value.sources ?? [],
            connectorIds: value.connectorIds ?? [],
            connectorLocationKeys: value.connectorLocationKeys ?? [],
            lineage: value.lineage ?? [],
            status: value.status ?? "metadata_only",
            projectState: value.projectState ?? preferredProjectState(value.projectStates ?? inferProjectStates({
                status: value.status ?? "metadata_only",
                access: primaryAccess(value),
                accesses: value.accesses,
            })),
            projectStates: value.projectStates ?? inferProjectStates({
                status: value.status ?? "metadata_only",
                access: primaryAccess(value),
                accesses: value.accesses,
            }),
            footprintIds: value.footprintIds ?? [],
            origin: "user",
            createdAt: now,
            updatedAt: now,
        };
        this.#user.push(record);
        await this.#persist();
        return structuredClone(record);
    }
    async update(id, input) {
        const index = this.#user.findIndex((entry) => entry.id === id);
        const value = validateInput(input);
        const builtin = this.#builtin.find((entry) => entry.id === id);
        if (index < 0 && !builtin)
            throw new Error(`Data asset not found: ${id}`);
        const current = index >= 0 ? this.#user[index] : this.get(id);
        const updated = {
            ...current,
            name: value.name,
            description: value.description ?? current.description,
            surveyId: value.surveyId,
            releaseId: value.releaseId,
            product: value.product ?? value.name,
            kind: value.kind,
            modalities: value.tags ?? value.modalities ?? [],
            tags: value.tags ?? value.modalities ?? [],
            access: primaryAccess(value),
            accesses: value.accesses ?? [primaryAccess(value)],
            sources: value.sources ?? current.sources ?? [],
            connectorIds: value.connectorIds ?? current.connectorIds ?? [],
            connectorLocationKeys: value.connectorLocationKeys ?? current.connectorLocationKeys ?? [],
            lineage: value.lineage ?? current.lineage ?? [],
            status: value.status ?? current.status,
            projectState: value.projectState ?? preferredProjectState(value.projectStates ?? current.projectStates ?? [current.projectState]),
            projectStates: value.projectStates ?? current.projectStates ?? [current.projectState],
            footprintIds: value.footprintIds ?? [],
            updatedAt: new Date().toISOString(),
        };
        if (index >= 0)
            this.#user[index] = { ...updated, origin: "user" };
        else {
            const override = { ...updated, origin: "override" };
            const overrideIndex = this.#overrides.findIndex((entry) => entry.id === id);
            if (overrideIndex >= 0)
                this.#overrides[overrideIndex] = override;
            else
                this.#overrides.push(override);
        }
        await this.#persist();
        return structuredClone(index >= 0 ? updated : { ...updated, origin: "builtin" });
    }
    async remove(id) {
        const index = this.#user.findIndex((entry) => entry.id === id);
        if (index < 0) {
            if (this.#builtin.some((entry) => entry.id === id))
                throw new RangeError("built-in data assets are read-only");
            throw new Error(`Data asset not found: ${id}`);
        }
        this.#user.splice(index, 1);
        await this.#persist();
    }
    async #persist() {
        await mkdir(path.dirname(this.#statePath), { recursive: true });
        const temporaryPath = `${this.#statePath}.${process.pid}.tmp`;
        await writeFile(temporaryPath, JSON.stringify([...this.#user, ...this.#overrides], null, 2), "utf8");
        await rename(temporaryPath, this.#statePath);
    }
}
