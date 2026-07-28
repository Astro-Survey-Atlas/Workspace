import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
function optionalText(value, maximum) {
    if (value == null)
        return undefined;
    const result = typeof value === "string" ? value.trim() : "";
    if (result.length > maximum)
        throw new RangeError(`run text must contain at most ${maximum} characters`);
    return result || undefined;
}
function optionalCount(value, name) {
    if (value == null || value === "")
        return undefined;
    const result = Number(value);
    if (!Number.isInteger(result) || result < 0)
        throw new RangeError(`${name} must be a non-negative integer`);
    return result;
}
export class ConnectorIngestRunCatalog {
    #statePath;
    #records = [];
    constructor(statePath) { this.#statePath = statePath; }
    async initialize() {
        try {
            const parsed = JSON.parse(await readFile(this.#statePath, "utf8"));
            if (!Array.isArray(parsed))
                throw new Error("connector ingest run state must be an array");
            this.#records = parsed.filter((entry) => Boolean(entry) && typeof entry === "object");
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
            this.#records = [];
            await this.#persist();
        }
    }
    list(locationKey) {
        return this.#records
            .filter((record) => !locationKey || record.locationKey === locationKey)
            .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
            .map((record) => structuredClone(record));
    }
    async add(locationKey, input) {
        if (!locationKey)
            throw new RangeError("locationKey is required");
        if (!["queued", "running", "succeeded", "failed"].includes(input.status))
            throw new RangeError("status is not supported");
        const record = {
            id: `ingest-${randomUUID()}`,
            locationKey,
            jobId: optionalText(input.jobId, 180),
            batchId: optionalText(input.batchId, 180),
            assetId: optionalText(input.assetId, 180),
            assetName: optionalText(input.assetName, 240),
            status: input.status,
            startedAt: optionalText(input.startedAt, 80) ?? new Date().toISOString(),
            completedAt: optionalText(input.completedAt, 80),
            fileCount: optionalCount(input.fileCount, "fileCount"),
            documentCount: optionalCount(input.documentCount, "documentCount"),
            error: optionalText(input.error, 2000),
            createdAt: new Date().toISOString(),
        };
        this.#records.push(record);
        await this.#persist();
        return structuredClone(record);
    }
    async remove(locationKey, id) {
        const index = this.#records.findIndex((record) => record.locationKey === locationKey && record.id === id);
        if (index < 0)
            throw new Error(`Connector ingest run not found: ${id}`);
        this.#records.splice(index, 1);
        await this.#persist();
    }
    async #persist() {
        await mkdir(path.dirname(this.#statePath), { recursive: true });
        const temporaryPath = `${this.#statePath}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(temporaryPath, JSON.stringify(this.#records, null, 2), "utf8");
        await rename(temporaryPath, this.#statePath);
    }
}
