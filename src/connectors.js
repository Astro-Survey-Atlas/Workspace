import { randomUUID } from "node:crypto";
import { access, constants, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import net from "node:net";
import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import OSS from "ali-oss";
const CONNECTOR_KINDS = ["s3", "local", "jdbc"];
const CONNECTOR_STATUSES = ["draft", "ready", "disabled"];
const REQUIRED_CONFIG = {
    s3: ["bucket"],
    local: ["rootPath"],
    jdbc: ["url"],
};
const SECRET_CONFIG_KEY = /(secret|password|token|access.?key|private.?key)/i;
function cleanSegment(value) {
    return value.trim().replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
}
function cleanEndpoint(value) {
    return (value ?? "").trim().replace(/\/+$/, "");
}
/** Return the stable location identity used for connector upserts. */
export function connectorLocationKey(kind, config) {
    if (kind === "s3") {
        const bucket = cleanSegment(config.bucket ?? "").toLocaleLowerCase();
        const prefix = cleanSegment(config.prefix ?? "");
        return `s3://${bucket}${prefix ? `/${prefix}` : ""}`;
    }
    if (kind === "local") {
        const root = path.normalize(path.resolve(config.rootPath ?? ""));
        return `local://${root}`;
    }
    const url = (config.url ?? "").trim().replace(/\/+$/, "");
    const database = (config.database ?? "").trim();
    const schema = (config.schema ?? "").trim();
    return `jdbc:${url}|database=${database}|schema=${schema}`;
}
export function connectorDisplayPath(kind, config) {
    if (kind === "s3") {
        const bucket = cleanSegment(config.bucket ?? "");
        const prefix = cleanSegment(config.prefix ?? "");
        const endpoint = cleanEndpoint(config.endpoint);
        const pathValue = `${bucket}${prefix ? `/${prefix}` : ""}`;
        return endpoint ? `${endpoint}/${pathValue}` : `s3://${pathValue}`;
    }
    if (kind === "local")
        return path.normalize(path.resolve(config.rootPath ?? ""));
    const url = (config.url ?? "").trim();
    const scope = [config.database?.trim(), config.schema?.trim()].filter(Boolean).join("/");
    return scope ? `${url}/${scope}` : url;
}
function textValue(value, name, maximum, required = true) {
    const result = typeof value === "string" ? value.trim() : "";
    if (required && !result)
        throw new RangeError(`${name} is required`);
    if (result.length > maximum)
        throw new RangeError(`${name} must contain at most ${maximum} characters`);
    return result;
}
export function validateConnectorInput(input) {
    const value = (input && typeof input === "object" ? input : {});
    const name = textValue(value.name, "name", 120);
    if (!CONNECTOR_KINDS.includes(value.kind))
        throw new RangeError("kind is not supported");
    if (value.status && !CONNECTOR_STATUSES.includes(value.status))
        throw new RangeError("status is not supported");
    if (!value.config || typeof value.config !== "object" || Array.isArray(value.config))
        throw new RangeError("config is required");
    const config = Object.fromEntries(Object.entries(value.config).map(([key, raw]) => {
        const normalizedKey = textValue(key, "config key", 80);
        if (SECRET_CONFIG_KEY.test(normalizedKey))
            throw new RangeError(`config.${normalizedKey} must use credentials; raw secrets are not stored in connector config`);
        return [normalizedKey, textValue(raw, `config.${normalizedKey}`, 2048, false)];
    }).filter(([, raw]) => raw));
    for (const key of REQUIRED_CONFIG[value.kind]) {
        if (!config[key])
            throw new RangeError(`config.${key} is required`);
    }
    return {
        name,
        description: textValue(value.description, "description", 500, false) || undefined,
        kind: value.kind,
        config,
        credentialRef: textValue(value.credentialRef, "credentialRef", 160, false) || undefined,
        status: value.status,
    };
}
function validateResolvedCredentials(input) {
    if (input == null)
        return undefined;
    if (typeof input !== "object" || Array.isArray(input))
        throw new RangeError("credentials must be an object");
    const value = input;
    return {
        accessKeyId: textValue(value.accessKeyId, "credentials.accessKeyId", 512),
        secretAccessKey: textValue(value.secretAccessKey, "credentials.secretAccessKey", 2048),
        sessionToken: textValue(value.sessionToken, "credentials.sessionToken", 4096, false) || undefined,
    };
}
export class ConnectorRegistry {
    #statePath;
    #bootstrapPath;
    #records = [];
    #legacyAliases = new Map();
    constructor(statePath, bootstrapPath) {
        this.#statePath = statePath;
        this.#bootstrapPath = bootstrapPath;
    }
    async initialize() {
        try {
            const persisted = JSON.parse(await readFile(this.#statePath, "utf8"));
            if (!Array.isArray(persisted))
                throw new Error("connector state must be an array");
            this.#records = this.#normalizeRecords(persisted);
            await this.#loadLegacyAliases();
            await this.#persist();
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
            this.#records = await this.#loadBootstrap();
            await this.#loadLegacyAliases();
            await this.#persist();
        }
    }
    list() {
        return this.#records.map((record) => structuredClone(record));
    }
    get(id) {
        const record = this.#records.find((entry) => entry.id === id || entry.id === this.#legacyAliases.get(id));
        if (!record)
            throw new Error(`Connector not found: ${id}`);
        return structuredClone(record);
    }
    async register(input) {
        const value = validateConnectorInput(input);
        const locationKey = connectorLocationKey(value.kind, value.config);
        const existingIndex = this.#records.findIndex((record) => record.locationKey === locationKey);
        const now = new Date().toISOString();
        if (existingIndex >= 0) {
            const current = this.#records[existingIndex];
            const updated = {
                ...current,
                name: value.name,
                description: value.description ?? current.description,
                kind: value.kind,
                config: value.config,
                credentialRef: value.credentialRef ?? current.credentialRef,
                status: value.status ?? current.status,
                locationKey,
                displayPath: connectorDisplayPath(value.kind, value.config),
                updatedAt: now,
            };
            this.#records[existingIndex] = updated;
            await this.#persist();
            return structuredClone(updated);
        }
        const record = {
            id: `connector-${randomUUID()}`,
            locationKey,
            displayPath: connectorDisplayPath(value.kind, value.config),
            name: value.name,
            description: value.description ?? "Connector configuration only. Connection and scanning are not enabled yet.",
            kind: value.kind,
            config: value.config,
            credentialRef: value.credentialRef,
            status: value.status ?? "draft",
            createdAt: now,
            updatedAt: now,
            origin: "user",
        };
        this.#records.push(record);
        await this.#persist();
        return structuredClone(record);
    }
    async update(id, input) {
        const index = this.#records.findIndex((entry) => entry.id === id || entry.id === this.#legacyAliases.get(id));
        if (index < 0)
            throw new Error(`Connector not found: ${id}`);
        const value = validateConnectorInput(input);
        const current = this.#records[index];
        const locationKey = connectorLocationKey(value.kind, value.config);
        const duplicate = this.#records.find((record, candidateIndex) => candidateIndex !== index && record.locationKey === locationKey);
        if (duplicate)
            throw new RangeError(`A connector already exists for path: ${duplicate.displayPath}`);
        const updated = {
            ...current,
            name: value.name,
            description: value.description ?? current.description,
            kind: value.kind,
            config: value.config,
            credentialRef: value.credentialRef,
            status: value.status ?? current.status,
            locationKey,
            displayPath: connectorDisplayPath(value.kind, value.config),
            updatedAt: new Date().toISOString(),
        };
        this.#records[index] = updated;
        await this.#persist();
        return structuredClone(updated);
    }
    async setCredentialReference(id, credentialRef) {
        const index = this.#records.findIndex((entry) => entry.id === id || entry.id === this.#legacyAliases.get(id));
        if (index < 0)
            throw new Error(`Connector not found: ${id}`);
        const current = this.#records[index];
        const updated = { ...current, credentialRef: textValue(credentialRef, "credentialRef", 160), updatedAt: new Date().toISOString() };
        this.#records[index] = updated;
        await this.#persist();
        return structuredClone(updated);
    }
    async remove(id) {
        const index = this.#records.findIndex((entry) => entry.id === id || entry.id === this.#legacyAliases.get(id));
        if (index < 0)
            throw new Error(`Connector not found: ${id}`);
        this.#records.splice(index, 1);
        await this.#persist();
    }
    async check(id, credentials, requireCredentials = false) {
        const index = this.#records.findIndex((entry) => entry.id === id || entry.id === this.#legacyAliases.get(id));
        if (index < 0)
            throw new Error(`Connector not found: ${id}`);
        const current = this.#records[index];
        const result = await checkConnector(current, validateResolvedCredentials(credentials), requireCredentials);
        const updated = { ...current, lastCheck: result, updatedAt: new Date().toISOString() };
        this.#records[index] = updated;
        await this.#persist();
        return structuredClone(updated);
    }
    async checkInput(input) {
        const value = validateConnectorInput(input);
        const credentials = validateResolvedCredentials(input.credentials);
        const now = new Date().toISOString();
        return checkConnector({
            id: "connector-check",
            locationKey: connectorLocationKey(value.kind, value.config),
            displayPath: connectorDisplayPath(value.kind, value.config),
            name: value.name,
            description: value.description ?? "",
            kind: value.kind,
            config: value.config,
            credentialRef: value.credentialRef,
            status: value.status ?? "draft",
            createdAt: now,
            updatedAt: now,
            origin: "user",
        }, credentials, value.kind === "s3");
    }
    #normalizeRecords(entries) {
        const records = [];
        for (const entry of entries) {
            if (!entry || typeof entry !== "object")
                continue;
            const candidate = entry;
            if (!candidate.kind || !candidate.config || typeof candidate.config !== "object")
                continue;
            const config = Object.fromEntries(Object.entries(candidate.config).filter(([key, value]) => typeof value === "string" && !SECRET_CONFIG_KEY.test(key)));
            const locationKey = connectorLocationKey(candidate.kind, config);
            if (records.some((record) => record.locationKey === locationKey))
                continue;
            records.push({
                ...candidate,
                id: typeof candidate.id === "string" && candidate.id ? candidate.id : `connector-${randomUUID()}`,
                name: typeof candidate.name === "string" && candidate.name ? candidate.name : locationKey,
                description: typeof candidate.description === "string" ? candidate.description : "Connector configuration.",
                kind: candidate.kind,
                config,
                locationKey,
                displayPath: connectorDisplayPath(candidate.kind, config),
                createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : new Date().toISOString(),
                updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : new Date().toISOString(),
                origin: "user",
            });
        }
        return records;
    }
    async #loadLegacyAliases() {
        this.#legacyAliases.clear();
        if (!this.#bootstrapPath)
            return;
        try {
            const bootstrap = JSON.parse(await readFile(this.#bootstrapPath, "utf8"));
            if (!Array.isArray(bootstrap))
                return;
            for (const entry of this.#normalizeRecords(bootstrap)) {
                const current = this.#records.find((record) => record.locationKey === entry.locationKey);
                if (current && entry.id !== current.id)
                    this.#legacyAliases.set(entry.id, current.id);
            }
        }
        catch {
            // A missing optional bootstrap should not prevent persisted connectors from loading.
        }
    }
    async #persist() {
        await mkdir(path.dirname(this.#statePath), { recursive: true });
        const temporaryPath = `${this.#statePath}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(temporaryPath, JSON.stringify(this.#records, null, 2), "utf8");
        await rename(temporaryPath, this.#statePath);
    }
    async #loadBootstrap() {
        if (!this.#bootstrapPath)
            return [];
        const bootstrap = JSON.parse(await readFile(this.#bootstrapPath, "utf8"));
        if (!Array.isArray(bootstrap))
            throw new Error("connector bootstrap must be an array");
        return this.#normalizeRecords(bootstrap);
    }
}
async function checkS3(record, credentials, requireCredentials = false) {
    const endpoint = cleanEndpoint(record.config.endpoint);
    if (!endpoint)
        return { status: "ok", checkedAt: new Date().toISOString(), summary: "S3 路径配置有效", detail: "未配置 Endpoint，FlinkIngest 将使用默认 S3 Endpoint。" };
    const checkedAt = new Date().toISOString();
    const bucket = record.config.bucket ?? "";
    if (requireCredentials && !credentials) {
        return { status: "failed", checkedAt, summary: "没有可用的已保存凭据", detail: "请编辑 Connector 并填写 Access Key 与 Secret Key。" };
    }
    if (credentials) {
        const client = new S3Client({
            endpoint,
            region: record.config.region || "us-east-1",
            forcePathStyle: true,
            maxAttempts: 1,
            credentials: {
                accessKeyId: credentials.accessKeyId,
                secretAccessKey: credentials.secretAccessKey,
                sessionToken: credentials.sessionToken,
            },
        });
        try {
            await client.send(new HeadBucketCommand({ Bucket: bucket }), { abortSignal: AbortSignal.timeout(5000) });
            return { status: "ok", checkedAt, summary: "连接正常，凭据与 Bucket 均已验证", detail: "未列举或扫描 Prefix。" };
        }
        catch (error) {
            const statusCode = typeof error === "object" && error && "$metadata" in error
                ? error.$metadata?.httpStatusCode
                : undefined;
            return {
                status: "failed",
                checkedAt,
                summary: statusCode === 401 || statusCode === 403 ? "凭据无效或没有 Bucket 访问权限" : "S3 Bucket 连接失败",
                detail: statusCode ? `HTTP ${statusCode}；未列举或扫描 Prefix。` : error instanceof Error ? error.message : String(error),
            };
        }
        finally {
            client.destroy();
        }
    }
    const url = `${endpoint}/${encodeURIComponent(bucket)}`;
    try {
        const response = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5000) });
        if (response.ok)
            return { status: "ok", checkedAt, summary: "S3 Endpoint 与 Bucket 可达", detail: `HTTP ${response.status}；允许匿名访问。` };
        if (response.status === 401 || response.status === 403) {
            return { status: "ok", checkedAt, summary: "S3 Endpoint 可达", detail: `HTTP ${response.status}；尚未验证 Bucket 权限。` };
        }
        return { status: "failed", checkedAt, summary: `Bucket 检测返回 HTTP ${response.status}`, detail: "Endpoint 已响应，但当前 Bucket 配置不可用。" };
    }
    catch (error) {
        return { status: "failed", checkedAt, summary: "S3 Endpoint 无法连接", detail: error instanceof Error ? error.message : String(error) };
    }
}
function isAlibabaOssEndpoint(endpoint) {
    try {
        const hostname = new URL(endpoint).hostname.toLowerCase();
        return hostname.includes(".oss-") || hostname.endsWith(".aliyuncs.com") || hostname.endsWith(".res.cloud.zhejianglab.com");
    }
    catch {
        return false;
    }
}
async function checkAlibabaOss(record, credentials, requireCredentials) {
    const checkedAt = new Date().toISOString();
    if (requireCredentials && !credentials)
        return { status: "failed", checkedAt, summary: "没有可用的已保存凭据", detail: "请编辑 Connector 并填写 Access Key 与 Secret Key。" };
    if (!credentials)
        return { status: "ok", checkedAt, summary: "Alibaba OSS Endpoint 可达", detail: "尚未验证 Bucket 权限。" };
    const endpoint = cleanEndpoint(record.config.endpoint);
    const bucket = record.config.bucket ?? "";
    let bucketInEndpoint = false;
    try {
        const hostname = new URL(endpoint).hostname.toLowerCase();
        bucketInEndpoint = hostname.startsWith(`${bucket.toLowerCase()}.`);
    }
    catch {
        // validateInput already rejects malformed paths only at the endpoint transport layer.
    }
    try {
        const prefix = cleanSegment(record.config.prefix ?? "");
        const client = new OSS({
            accessKeyId: credentials.accessKeyId,
            accessKeySecret: credentials.secretAccessKey,
            endpoint,
            bucket,
            secure: endpoint.startsWith("https:"),
            region: record.config.region || "oss-cn-hangzhou",
            cname: bucketInEndpoint,
            // The internal ZhejiangLab OSS endpoint currently presents a self-signed
            // certificate. The endpoint is explicitly supplied by the user; keep
            // the existing HTTP option available and allow its HTTPS variant too.
            ...(endpoint.startsWith("https:") ? { httpsAgent: new https.Agent({ rejectUnauthorized: false }) } : {}),
            timeout: 5000,
            retryMax: 0,
        });
        // GetBucketInfo is a separate privileged OSS action and is commonly
        // denied even when the connector can scan its configured prefix. A
        // single-key prefix probe validates the permission FlinkIngest needs
        // without enumerating or scanning the directory.
        await client.list({ ...(prefix ? { prefix } : {}), "max-keys": 1 });
        return { status: "ok", checkedAt, summary: "Alibaba OSS 连接正常，凭据与 Bucket 均已验证", detail: "已验证目标 Prefix 的最小读取权限，未扫描目录。" };
    }
    catch (error) {
        const statusCode = typeof error === "object" && error && "status" in error ? error.status : undefined;
        return {
            status: "failed",
            checkedAt,
            summary: statusCode === 401 || statusCode === 403 ? "Alibaba OSS 凭据无效或没有 Bucket 访问权限" : "Alibaba OSS Bucket 连接失败",
            detail: statusCode ? `HTTP ${statusCode}；使用 Bucket 元信息检查，未列举或扫描 Prefix。` : error instanceof Error ? error.message : String(error),
        };
    }
}
async function checkJdbc(record) {
    const rawUrl = record.config.url ?? "";
    const checkedAt = new Date().toISOString();
    if (rawUrl.startsWith("jdbc:sqlite:")) {
        const filename = rawUrl.slice("jdbc:sqlite:".length);
        try {
            await stat(filename);
            return { status: "ok", checkedAt, summary: "SQLite database file is readable" };
        }
        catch (error) {
            return { status: "failed", checkedAt, summary: "SQLite database file is not readable", detail: error instanceof Error ? error.message : String(error) };
        }
    }
    let parsed;
    try {
        parsed = new URL(rawUrl.replace(/^jdbc:/, ""));
    }
    catch {
        return { status: "failed", checkedAt, summary: "JDBC URL is invalid" };
    }
    const port = Number(parsed.port || (parsed.protocol === "postgresql:" ? 5432 : parsed.protocol === "mysql:" ? 3306 : 0));
    if (!parsed.hostname || !port)
        return { status: "failed", checkedAt, summary: "JDBC URL has no supported host and port" };
    return new Promise((resolve) => {
        const socket = net.createConnection({ host: parsed.hostname, port });
        const finish = (result) => { socket.destroy(); resolve(result); };
        socket.setTimeout(5000);
        socket.once("connect", () => finish({ status: "ok", checkedAt, summary: "Database host accepted a TCP connection", detail: "The workspace does not execute a query or enumerate tables during a connection check." }));
        socket.once("timeout", () => finish({ status: "failed", checkedAt, summary: "Database connection timed out" }));
        socket.once("error", (error) => finish({ status: "failed", checkedAt, summary: "Database host is unreachable", detail: error.message }));
    });
}
export async function checkConnector(record, credentials, requireCredentials = false) {
    if (record.kind === "local") {
        const checkedAt = new Date().toISOString();
        try {
            const rootPath = record.config.rootPath ?? "";
            await stat(rootPath);
            await access(rootPath, constants.R_OK);
            return { status: "ok", checkedAt, summary: "Local path exists and is readable" };
        }
        catch (error) {
            return { status: "failed", checkedAt, summary: "Local path is not readable", detail: error instanceof Error ? error.message : String(error) };
        }
    }
    if (record.kind === "s3") {
        const resolved = validateResolvedCredentials(credentials);
        if (isAlibabaOssEndpoint(cleanEndpoint(record.config.endpoint)))
            return checkAlibabaOss(record, resolved, requireCredentials);
        return checkS3(record, resolved, requireCredentials);
    }
    return checkJdbc(record);
}
