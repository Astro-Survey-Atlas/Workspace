import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import yauzl from "yauzl";

import { normalizeSurveyFootprintManifest, type SurveyFootprintManifest } from "./survey-footprints.js";

const CATALOG_SCHEMA_VERSION = 2;
const PACKAGE_SCHEMA_VERSION = 2;
const STATE_SCHEMA_VERSION = 2;
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 256 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 16;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const PACKAGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const ARCHIVE_FILES = new Set(["resource-package.json", "footprints/survey-footprints.json", "README.md"]);

export interface ResourcePackageCatalogEntry {
  id: string;
  name: string;
  description: string;
  surveyId: string;
  modalities: string[];
  wavelengths: string[];
  productTypes: string[];
  facilities: string[];
  coverageAuthorities: string[];
  accessModes: string[];
  releases: string[];
  sources: Array<{ label: string; url: string; authority: string; license?: string }>;
  version: string;
  archiveUrl: string;
  sizeBytes: number;
  sha256: string;
  updatedAt: string;
  hidden: boolean;
  deprecated: boolean;
  replacedBy: string[];
}

interface ResourcePackageCatalogDocument {
  schemaVersion: number;
  generatedAt: string;
  packages: ResourcePackageCatalogEntry[];
}

interface ResourcePackageManifest {
  schemaVersion: number;
  id: string;
  name: string;
  description: string;
  surveyId: string;
  version: string;
  createdAt: string;
  footprintManifest: "footprints/survey-footprints.json";
}

interface InstalledPackage {
  id: string;
  version: string;
  sha256: string;
  installedAt: string;
  activeReleaseIds: string[];
}

interface ResourcePackageState {
  schemaVersion: number;
  packages: InstalledPackage[];
}

export type ResourcePackageStatus = "not_installed" | "installed" | "active" | "update_available";

export interface PublicResourcePackage extends ResourcePackageCatalogEntry {
  installedVersion?: string;
  installedAt?: string;
  activeReleaseIds: string[];
  availableReleaseIds: string[];
  active: boolean;
  status: ResourcePackageStatus;
}

export interface ResourcePackageLoad {
  packageId: string;
  releaseIds: string[];
}

export interface ResourcePackageJob {
  id: string;
  packageId: string;
  version: string;
  status: "queued" | "running" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
  phase: "queued" | "downloading" | "verifying" | "installing" | "completed" | "failed";
  downloadedBytes: number;
  totalBytes: number;
  error?: string;
}

export interface ResourcePackageManagerOptions {
  catalogUrl: string;
  root: string;
  statePath: string;
  maxArchiveBytes?: number;
  maxExtractedBytes?: number;
  downloadTimeoutMs?: number;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maximum = 2048): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new Error(`${label} is invalid`);
  return value.trim();
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.length || value.some((entry) => typeof entry !== "string" || !entry.trim())) throw new Error(`${label} is invalid`);
  return [...new Set(value.map((entry) => String(entry).trim()))];
}

function optionalStringList(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  return stringList(value, label);
}

function sources(value: unknown, label: string): ResourcePackageCatalogEntry["sources"] {
  if (!Array.isArray(value) || !value.length) throw new Error(`${label} is invalid`);
  return value.map((item) => {
    const source = object(item, label);
    return {
      label: text(source.label, `${label} label`, 160),
      url: text(source.url, `${label} URL`),
      authority: text(source.authority, `${label} authority`, 80),
      ...(source.license === undefined ? {} : { license: text(source.license, `${label} license`, 160) }),
    };
  });
}

function parseEntry(value: unknown): ResourcePackageCatalogEntry {
  const entry = object(value, "Resource package catalog entry");
  const id = text(entry.id, "Resource package id", 80);
  const version = text(entry.version, "Resource package version", 40);
  const sha256 = text(entry.sha256, "Resource package SHA-256", 64).toLowerCase();
  if (!PACKAGE_ID.test(id) || !VERSION.test(version) || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`Resource package catalog contains an invalid identity: ${id}`);
  if (!Number.isSafeInteger(entry.sizeBytes) || Number(entry.sizeBytes) <= 0) throw new Error(`Resource package catalog contains an invalid archive size: ${id}`);
  return {
    id,
    name: text(entry.name, "Resource package name", 160),
    description: text(entry.description, "Resource package description", 2000),
    surveyId: text(entry.surveyId, "Resource package survey id", 80),
    modalities: stringList(entry.modalities, "Resource package modalities"),
    wavelengths: stringList(entry.wavelengths, "Resource package wavelengths"),
    productTypes: stringList(entry.productTypes, "Resource package product types"),
    facilities: stringList(entry.facilities, "Resource package facilities"),
    coverageAuthorities: stringList(entry.coverageAuthorities, "Resource package coverage authorities"),
    accessModes: stringList(entry.accessModes, "Resource package access modes"),
    releases: stringList(entry.releases, "Resource package releases"),
    sources: sources(entry.sources, "Resource package sources"),
    version,
    archiveUrl: text(entry.archiveUrl, "Resource package archive URL"),
    sizeBytes: Number(entry.sizeBytes),
    sha256,
    updatedAt: text(entry.updatedAt, "Resource package update time", 80),
    hidden: entry.hidden === true,
    deprecated: entry.deprecated === true,
    replacedBy: optionalStringList(entry.replacedBy, "Resource package replacements"),
  };
}

function parseLegacyEntry(value: unknown): ResourcePackageCatalogEntry {
  const entry = object(value, "Legacy resource package catalog entry");
  const surveys = stringList(entry.surveys, "Legacy resource package surveys");
  const id = text(entry.id, "Resource package id", 80);
  const version = text(entry.version, "Resource package version", 40);
  const sha256 = text(entry.sha256, "Resource package SHA-256", 64).toLowerCase();
  if (!PACKAGE_ID.test(id) || !VERSION.test(version) || !/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(entry.sizeBytes) || Number(entry.sizeBytes) <= 0) throw new Error(`Resource package catalog contains an invalid identity: ${id}`);
  return {
    id,
    name: text(entry.name, "Resource package name", 160),
    description: text(entry.description, "Resource package description", 2000),
    surveyId: surveys[0]!,
    modalities: [text(entry.modality, "Resource package modality", 80)],
    wavelengths: ["legacy"], productTypes: ["coverage"], facilities: ["multiple"], coverageAuthorities: ["legacy"], accessModes: ["archive"], releases: ["legacy"],
    sources: [{ label: "Legacy bundled coverage", url: "https://astro.workspace.dev.72602.space", authority: "legacy" }],
    version, archiveUrl: text(entry.archiveUrl, "Resource package archive URL"), sizeBytes: Number(entry.sizeBytes), sha256,
    updatedAt: text(entry.updatedAt, "Resource package update time", 80), hidden: true, deprecated: true, replacedBy: optionalStringList(entry.replacedBy, "Resource package replacements"),
  };
}

function parseCatalog(value: unknown): ResourcePackageCatalogDocument {
  const document = object(value, "Resource package catalog");
  if ((document.schemaVersion !== CATALOG_SCHEMA_VERSION && document.schemaVersion !== 1) || !Array.isArray(document.packages)) throw new Error("Resource package catalog has an unsupported schema");
  const packages = document.packages.map((entry) => document.schemaVersion === 1 || object(entry, "Resource package catalog entry").surveys ? parseLegacyEntry(entry) : parseEntry(entry));
  const identities = new Set<string>();
  for (const entry of packages) {
    const identity = `${entry.id}@${entry.version}`;
    if (identities.has(identity)) throw new Error(`Resource package catalog contains a duplicate: ${identity}`);
    identities.add(identity);
  }
  return { schemaVersion: CATALOG_SCHEMA_VERSION, generatedAt: text(document.generatedAt, "Resource package catalog generation time", 80), packages };
}

function parseManifest(value: unknown): ResourcePackageManifest {
  const manifest = object(value, "Resource package manifest");
  if (manifest.schemaVersion !== PACKAGE_SCHEMA_VERSION || manifest.footprintManifest !== "footprints/survey-footprints.json") throw new Error("Resource package manifest has an unsupported schema");
  const id = text(manifest.id, "Resource package id", 80);
  const version = text(manifest.version, "Resource package version", 40);
  if (!PACKAGE_ID.test(id) || !VERSION.test(version)) throw new Error("Resource package manifest has an invalid identity");
  return {
    schemaVersion: PACKAGE_SCHEMA_VERSION,
    id,
    name: text(manifest.name, "Resource package name", 160),
    description: text(manifest.description, "Resource package description", 2000),
    surveyId: text(manifest.surveyId, "Resource package survey id", 80),
    version,
    createdAt: text(manifest.createdAt, "Resource package creation time", 80),
    footprintManifest: "footprints/survey-footprints.json",
  };
}

function parseState(value: unknown): { state: ResourcePackageState; legacy: boolean } {
  const state = object(value, "Resource package state");
  if ((state.schemaVersion !== STATE_SCHEMA_VERSION && state.schemaVersion !== 1) || !Array.isArray(state.packages)) throw new Error("Resource package state has an unsupported schema");
  const legacy = state.schemaVersion === 1;
  const packages = state.packages.map((item) => {
    const record = object(item, "Installed resource package");
    const id = text(record.id, "Installed resource package id", 80);
    const version = text(record.version, "Installed resource package version", 40);
    const sha256 = text(record.sha256, "Installed resource package SHA-256", 64);
    const activeReleaseIds = legacy
      ? []
      : Array.isArray(record.activeReleaseIds) && record.activeReleaseIds.every((releaseId) => typeof releaseId === "string" && releaseId.trim())
        ? record.activeReleaseIds.map((releaseId) => String(releaseId).trim())
        : null;
    if (!PACKAGE_ID.test(id) || !VERSION.test(version) || !/^[a-f0-9]{64}$/i.test(sha256) || (legacy ? typeof record.active !== "boolean" : !activeReleaseIds || new Set(activeReleaseIds).size !== activeReleaseIds.length)) throw new Error(`Installed resource package is invalid: ${id}`);
    return {
      id,
      version,
      sha256: sha256.toLowerCase(),
      installedAt: text(record.installedAt, "Resource package install time", 80),
      activeReleaseIds: activeReleaseIds ?? [],
      ...(legacy && record.active === true ? { legacyActive: true } : {}),
    };
  });
  return { state: { schemaVersion: STATE_SCHEMA_VERSION, packages }, legacy };
}

async function readUrl(url: URL, timeoutMs: number): Promise<Buffer> {
  if (url.protocol === "file:") return readFile(url);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Unsupported resource catalog protocol: ${url.protocol}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`Resource catalog request failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 4 * 1024 * 1024) throw new Error("Resource package catalog is too large");
  return bytes;
}

async function download(url: URL, destination: string, expectedBytes: number, maximumBytes: number, timeoutMs: number, onProgress: (bytes: number) => void): Promise<string> {
  if (expectedBytes > maximumBytes) throw new Error("Resource package exceeds the configured download limit");
  const hash = createHash("sha256");
  let bytes = 0;
  const output = createWriteStream(destination, { flags: "wx" });
  if (url.protocol === "file:") {
    const info = await stat(url);
    if (info.size !== expectedBytes || info.size > maximumBytes) throw new Error("Resource package archive size does not match the catalog");
    const input = createReadStream(url);
    input.on("data", (chunk: string | Buffer) => { bytes += chunk.length; hash.update(chunk); onProgress(bytes); });
    await pipeline(input, output);
  } else {
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Unsupported resource package protocol: ${url.protocol}`);
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok || !response.body) throw new Error(`Resource package download failed: HTTP ${response.status}`);
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength !== expectedBytes) throw new Error("Resource package Content-Length does not match the catalog");
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        onProgress(bytes);
        if (bytes > maximumBytes) throw new Error("Resource package exceeds the configured download limit");
        hash.update(value);
        if (!output.write(value)) await new Promise<void>((resolve) => output.once("drain", resolve));
      }
      output.end();
      await new Promise<void>((resolve, reject) => output.once("finish", resolve).once("error", reject));
    } catch (error) {
      output.destroy();
      throw error;
    }
  }
  if (bytes !== expectedBytes) throw new Error("Resource package archive size does not match the catalog");
  return hash.digest("hex");
}

function openZip(archivePath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => yauzl.open(archivePath, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (error, zip) => error || !zip ? reject(error ?? new Error("Unable to open resource package")) : resolve(zip)));
}

async function extractArchive(archivePath: string, destination: string, maximumBytes: number): Promise<void> {
  const zip = await openZip(archivePath);
  let entries = 0;
  let extractedBytes = 0;
  const seen = new Set<string>();
  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error) => { zip.close(); reject(error); };
    zip.on("error", fail);
    zip.on("entry", (entry) => {
      void (async () => {
        entries += 1;
        const name = entry.fileName.replaceAll("\\", "/");
        const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
        if (entries > MAX_ZIP_ENTRIES || !ARCHIVE_FILES.has(name) || name.startsWith("/") || name.split("/").includes("..") || (mode & 0o170000) === 0o120000 || seen.has(name)) throw new Error(`Resource package contains an unsafe ZIP entry: ${name}`);
        seen.add(name);
        extractedBytes += entry.uncompressedSize;
        if (extractedBytes > maximumBytes) throw new Error("Resource package exceeds the configured extraction limit");
        const outputPath = path.join(destination, ...name.split("/"));
        await mkdir(path.dirname(outputPath), { recursive: true });
        const input = await new Promise<NodeJS.ReadableStream>((entryResolve, entryReject) => zip.openReadStream(entry, (error, stream) => error || !stream ? entryReject(error ?? new Error("Unable to read ZIP entry")) : entryResolve(stream)));
        await pipeline(input, createWriteStream(outputPath, { flags: "wx", mode: 0o644 }));
        zip.readEntry();
      })().catch(fail);
    });
    zip.on("end", () => {
      if (!["resource-package.json", "footprints/survey-footprints.json", "README.md"].every((name) => seen.has(name))) reject(new Error("Resource package is missing required files"));
      else resolve();
    });
    zip.readEntry();
  });
}

export class ResourcePackageManager {
  readonly #catalogUrl: URL;
  readonly #root: string;
  readonly #statePath: string;
  readonly #maxArchiveBytes: number;
  readonly #maxExtractedBytes: number;
  readonly #downloadTimeoutMs: number;
  #catalog: ResourcePackageCatalogDocument = { schemaVersion: CATALOG_SCHEMA_VERSION, generatedAt: "", packages: [] };
  #state: ResourcePackageState = { schemaVersion: STATE_SCHEMA_VERSION, packages: [] };
  #jobs = new Map<string, ResourcePackageJob>();
  #installedFootprints = new Map<string, SurveyFootprintManifest>();
  #installing = new Set<string>();
  #mutation = Promise.resolve();

  constructor(options: ResourcePackageManagerOptions) {
    this.#catalogUrl = new URL(options.catalogUrl);
    this.#root = options.root;
    this.#statePath = options.statePath;
    this.#maxArchiveBytes = options.maxArchiveBytes ?? MAX_ARCHIVE_BYTES;
    this.#maxExtractedBytes = options.maxExtractedBytes ?? MAX_EXTRACTED_BYTES;
    this.#downloadTimeoutMs = options.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  }

  async initialize(): Promise<void> {
    this.#catalog = parseCatalog(JSON.parse((await readUrl(this.#catalogUrl, this.#downloadTimeoutMs)).toString("utf8")) as unknown);
    await mkdir(path.join(this.#root, "downloads"), { recursive: true });
    await mkdir(path.join(this.#root, "staging"), { recursive: true });
    await mkdir(path.join(this.#root, "installed"), { recursive: true });
    try {
      const parsed = parseState(JSON.parse(await readFile(this.#statePath, "utf8")) as unknown);
      this.#state = parsed.state;
      for (const installed of this.#state.packages) {
        const manifest = await this.#validateInstalled(installed);
        this.#installedFootprints.set(installed.id, manifest);
        if (parsed.legacy && (installed as InstalledPackage & { legacyActive?: boolean }).legacyActive) installed.activeReleaseIds = this.#releaseIds(manifest);
        delete (installed as InstalledPackage & { legacyActive?: boolean }).legacyActive;
      }
      if (parsed.legacy) await this.#persist();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.#persist();
    }
  }

  list(): PublicResourcePackage[] {
    return this.#catalog.packages.filter((entry) => !entry.hidden).map((entry) => {
      const installed = this.#state.packages.find((record) => record.id === entry.id);
      const update = Boolean(installed && installed.version !== entry.version);
      return this.#toPublic(entry, installed, update);
    });
  }

  get(id: string): PublicResourcePackage {
    const result = this.#publicRecord(id);
    if (!result) throw new Error(`Resource package not found: ${id}`);
    return result;
  }

  install(id: string): ResourcePackageJob {
    const entry = this.#catalog.packages.find((candidate) => candidate.id === id);
    if (!entry) throw new Error(`Resource package not found: ${id}`);
    if (this.#installing.has(id)) throw new RangeError(`Resource package install already in progress: ${id}`);
    const now = new Date().toISOString();
    const job: ResourcePackageJob = { id: randomUUID(), packageId: id, version: entry.version, status: "queued", phase: "queued", downloadedBytes: 0, totalBytes: entry.sizeBytes, createdAt: now, updatedAt: now };
    this.#jobs.set(job.id, job);
    this.#installing.add(id);
    void this.#runInstall(entry, job);
    return { ...job };
  }

  job(id: string): ResourcePackageJob {
    const job = this.#jobs.get(id);
    if (!job) throw new Error(`Resource package job not found: ${id}`);
    return { ...job };
  }

  async activate(id: string): Promise<PublicResourcePackage> {
    const installed = this.#installed(id);
    await this.setActive(this.#loadsExcept(id).concat({ packageId: id, releaseIds: this.#availableReleaseIds(installed) }));
    return this.get(id);
  }

  async deactivate(id: string): Promise<PublicResourcePackage> {
    this.#installed(id);
    await this.setActive(this.#loadsExcept(id));
    return this.get(id);
  }

  async setActive(loads: ResourcePackageLoad[]): Promise<PublicResourcePackage[]> {
    if (!Array.isArray(loads)) throw new RangeError("loads must be an array");
    const packageIds = loads.map((load) => load?.packageId);
    if (loads.some((load) => !load || typeof load.packageId !== "string" || !Array.isArray(load.releaseIds) || load.releaseIds.some((id) => typeof id !== "string" || !id.trim()))) throw new RangeError("loads must contain packageId and releaseIds");
    if (new Set(packageIds).size !== packageIds.length) throw new RangeError("loads must contain unique resource package ids");
    await this.#mutate(async () => {
      const draft = this.#state.packages.map((installed) => ({ ...installed, activeReleaseIds: [] as string[] }));
      const selected: SurveyFootprintManifest[] = [];
      for (const load of loads) {
        const entry = this.#catalog.packages.find((candidate) => candidate.id === load.packageId && !candidate.hidden);
        const installed = draft.find((record) => record.id === load.packageId);
        if (!entry) throw new Error(`Resource package not found: ${load.packageId}`);
        if (!installed) throw new RangeError(`Resource package must be installed before loading: ${load.packageId}`);
        if (installed.version !== entry.version) throw new RangeError(`Resource package version must be current before loading: ${load.packageId}`);
        if (new Set(load.releaseIds).size !== load.releaseIds.length) throw new RangeError(`releaseIds must be unique for resource package: ${load.packageId}`);
        const manifest = this.#installedFootprints.get(load.packageId);
        if (!manifest) throw new Error(`Installed resource package manifest is unavailable: ${load.packageId}`);
        const available = new Set(this.#releaseIds(manifest));
        for (const releaseId of load.releaseIds) if (!available.has(releaseId)) throw new RangeError(`Unknown release for resource package ${load.packageId}: ${releaseId}`);
        installed.activeReleaseIds = [...load.releaseIds];
        if (load.releaseIds.length) selected.push({ ...manifest, footprints: manifest.footprints.filter((footprint) => load.releaseIds.includes(footprint.releaseId)) });
      }
      this.#validateSelection(selected);
      await this.#persist(draft);
      this.#state = { schemaVersion: STATE_SCHEMA_VERSION, packages: draft };
    });
    return this.list();
  }

  async remove(id: string): Promise<void> {
    await this.#mutate(async () => {
      const installed = this.#installed(id);
      if (installed.activeReleaseIds.length) throw new RangeError(`Deactivate resource package before deleting it: ${id}`);
      await rm(path.join(this.#root, "installed", id), { recursive: true, force: true });
      this.#state.packages = this.#state.packages.filter((record) => record.id !== id);
      await this.#persist();
      this.#installedFootprints.delete(id);
    });
  }

  async activeFootprints(): Promise<SurveyFootprintManifest> {
    const manifests = this.#state.packages.filter((record) => record.activeReleaseIds.length).map((record) => {
      const manifest = this.#installedFootprints.get(record.id);
      if (!manifest) throw new Error(`Installed resource package manifest is unavailable: ${record.id}`);
      return { ...manifest, footprints: manifest.footprints.filter((footprint) => record.activeReleaseIds.includes(footprint.releaseId)) };
    });
    if (!manifests.length) return { schemaVersion: 1, generatedAt: new Date().toISOString(), coordinateFrame: "ICRS", nside: 16, footprints: [] };
    this.#validateSelection(manifests);
    const nside = manifests[0]!.nside;
    const footprints = new Map<string, SurveyFootprintManifest["footprints"][number]>();
    for (const manifest of manifests) for (const footprint of manifest.footprints) {
      const identity = `${footprint.surveyId}:${footprint.releaseId}:${footprint.product}`;
      const existing = footprints.get(identity);
      if (existing && JSON.stringify(existing) !== JSON.stringify(footprint)) throw new Error(`Active resource packages contain conflicting footprint: ${identity}`);
      footprints.set(identity, footprint);
    }
    return { schemaVersion: 1, generatedAt: new Date().toISOString(), coordinateFrame: "ICRS", nside, footprints: [...footprints.values()] };
  }

  async #runInstall(entry: ResourcePackageCatalogEntry, job: ResourcePackageJob): Promise<void> {
    job.status = "running";
    job.phase = "downloading";
    job.updatedAt = new Date().toISOString();
    const archivePath = path.join(this.#root, "downloads", `${entry.id}-${entry.version}-${job.id}.zip`);
    const stagingPath = path.join(this.#root, "staging", job.id);
    try {
      const archiveUrl = new URL(entry.archiveUrl, this.#catalogUrl);
      const digest = await download(archiveUrl, archivePath, entry.sizeBytes, this.#maxArchiveBytes, this.#downloadTimeoutMs, (bytes) => { job.downloadedBytes = bytes; job.updatedAt = new Date().toISOString(); });
      job.phase = "verifying";
      if (digest !== entry.sha256) throw new Error("Resource package SHA-256 does not match the catalog");
      job.phase = "installing";
      await mkdir(stagingPath, { recursive: true });
      await extractArchive(archivePath, stagingPath, this.#maxExtractedBytes);
      const manifest = parseManifest(JSON.parse(await readFile(path.join(stagingPath, "resource-package.json"), "utf8")) as unknown);
      if (manifest.id !== entry.id || manifest.version !== entry.version || manifest.surveyId !== entry.surveyId) throw new Error("Resource package manifest does not match the catalog");
      const footprints = normalizeSurveyFootprintManifest(JSON.parse(await readFile(path.join(stagingPath, manifest.footprintManifest), "utf8")) as unknown);
      if (!footprints.footprints.length || footprints.footprints.some((footprint) => footprint.surveyId !== manifest.surveyId)) throw new Error("Resource package footprints do not match its survey");
      const finalParent = path.join(this.#root, "installed", entry.id);
      const finalPath = path.join(finalParent, entry.version);
      await mkdir(finalParent, { recursive: true });
      await rm(finalPath, { recursive: true, force: true });
      await rename(stagingPath, finalPath);
      await this.#mutate(async () => {
        const current = this.#state.packages.find((record) => record.id === entry.id);
        this.#state.packages = this.#state.packages.filter((record) => record.id !== entry.id);
        const activeReleaseIds = current?.activeReleaseIds.filter((releaseId) => footprints.footprints.some((footprint) => footprint.releaseId === releaseId)) ?? [];
        this.#state.packages.push({ id: entry.id, version: entry.version, sha256: entry.sha256, installedAt: new Date().toISOString(), activeReleaseIds });
        this.#installedFootprints.set(entry.id, footprints);
        await this.#persist();
      });
      job.status = "completed";
      job.phase = "completed";
    } catch (error) {
      job.status = "failed";
      job.phase = "failed";
      job.error = error instanceof Error ? error.message : String(error);
    } finally {
      job.updatedAt = new Date().toISOString();
      this.#installing.delete(entry.id);
      await rm(archivePath, { force: true });
      await rm(stagingPath, { recursive: true, force: true });
    }
  }

  #installed(id: string): InstalledPackage {
    const installed = this.#state.packages.find((record) => record.id === id);
    if (!installed) throw new Error(`Resource package is not installed: ${id}`);
    return installed;
  }

  #publicRecord(id: string): PublicResourcePackage | undefined {
    const entry = this.#catalog.packages.find((candidate) => candidate.id === id);
    if (!entry) return undefined;
    const installed = this.#state.packages.find((record) => record.id === id);
    const update = Boolean(installed && installed.version !== entry.version);
    return this.#toPublic(entry, installed, update);
  }

  async #validateInstalled(record: InstalledPackage): Promise<SurveyFootprintManifest> {
    const entry = this.#catalog.packages.find((candidate) => candidate.id === record.id);
    if (!entry || (entry.version === record.version && entry.sha256 !== record.sha256)) throw new Error(`Installed resource package is absent from the trusted catalog: ${record.id}@${record.version}`);
    const manifest = await this.#readFootprints(record);
    const available = new Set(this.#releaseIds(manifest));
    if (record.activeReleaseIds.some((releaseId) => !available.has(releaseId))) throw new Error(`Installed resource package state contains an unknown release: ${record.id}`);
    return manifest;
  }

  async #readFootprints(record: InstalledPackage): Promise<SurveyFootprintManifest> {
    return normalizeSurveyFootprintManifest(JSON.parse(await readFile(path.join(this.#root, "installed", record.id, record.version, "footprints", "survey-footprints.json"), "utf8")) as unknown);
  }

  async #persist(packages = this.#state.packages): Promise<void> {
    await mkdir(path.dirname(this.#statePath), { recursive: true });
    const temporary = `${this.#statePath}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({ schemaVersion: STATE_SCHEMA_VERSION, packages }, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, this.#statePath);
  }

  #releaseIds(manifest: SurveyFootprintManifest): string[] {
    return [...new Set(manifest.footprints.map((footprint) => footprint.releaseId))];
  }

  #availableReleaseIds(installed: InstalledPackage): string[] {
    const manifest = this.#installedFootprints.get(installed.id);
    return manifest ? this.#releaseIds(manifest) : [];
  }

  #loadsExcept(id: string): ResourcePackageLoad[] {
    return this.#state.packages.filter((record) => record.id !== id && record.activeReleaseIds.length).map((record) => ({ packageId: record.id, releaseIds: [...record.activeReleaseIds] }));
  }

  #toPublic(entry: ResourcePackageCatalogEntry, installed: InstalledPackage | undefined, update: boolean): PublicResourcePackage {
    const activeReleaseIds = installed ? [...installed.activeReleaseIds] : [];
    const active = activeReleaseIds.length > 0;
    return { ...entry, installedVersion: installed?.version, installedAt: installed?.installedAt, activeReleaseIds, availableReleaseIds: installed ? this.#availableReleaseIds(installed) : [], active, status: active ? "active" : update ? "update_available" : installed ? "installed" : "not_installed" };
  }

  #validateSelection(manifests: SurveyFootprintManifest[]): void {
    if (!manifests.length) return;
    const nside = manifests[0]!.nside;
    if (manifests.some((manifest) => manifest.nside !== nside)) throw new RangeError("Active resource packages use incompatible HEALPix resolutions");
    const footprints = new Map<string, SurveyFootprintManifest["footprints"][number]>();
    for (const manifest of manifests) for (const footprint of manifest.footprints) {
      const identity = `${footprint.surveyId}:${footprint.releaseId}:${footprint.product}`;
      const existing = footprints.get(identity);
      if (existing && JSON.stringify(existing) !== JSON.stringify(footprint)) throw new RangeError(`Active resource packages contain conflicting footprint: ${identity}`);
      footprints.set(identity, footprint);
    }
  }

  async #mutate(operation: () => Promise<void>): Promise<void> {
    const next = this.#mutation.then(operation, operation);
    this.#mutation = next.catch(() => undefined);
    await next;
  }
}
