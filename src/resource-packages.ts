import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import yauzl from "yauzl";

import { COVERAGE_ROLES, DATA_ORIGINS, SOURCE_TIERS } from "./assets-core.js";
import { normalizeSurveyFootprintManifest, type SurveyFootprintManifest } from "./survey-footprints.js";
import type { ReleaseKind, SurveyModality, SurveyRecord, SurveyRelease } from "./survey-registry.js";

const CATALOG_SCHEMA_VERSION = 3;
const PACKAGE_SCHEMA_VERSION = 3;
const PACKAGE_FORMAT_VERSION = "3.0.0";
const STATE_SCHEMA_VERSION = 3;
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 256 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 256;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const PACKAGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const REQUIRED_ARCHIVE_FILES = new Set(["resource-package.json", "footprints/survey-footprints.json", "provenance.json", "README.md"]);

function isLoadableFootprint(footprint: SurveyFootprintManifest["footprints"][number]): boolean {
  // Official overviews have verified display cells even though they are less
  // precise than a MOC, so users must be able to load them.
  return footprint.quality === "moc" || footprint.quality === "official_overview";
}

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
  releaseLabels: Record<string, string>;
  sources: Array<{ releaseId: string; label: string; url: string; authority: string; license?: string }>;
  version: string;
  archiveUrl: string;
  sizeBytes: number;
  sha256: string;
  updatedAt: string;
  hidden: boolean;
  deprecated: boolean;
  replacedBy: string[];
  origin?: "public";
}

interface ResourcePackageCatalogDocument {
  schemaVersion: number;
  version: string;
  generatedAt: string;
  packages: ResourcePackageCatalogEntry[];
}

interface ResourcePackageManifest {
  schemaVersion: number;
  version: string;
  id: string;
  surveyId: string;
  files: Array<{ path: "README.md" | "footprints/survey-footprints.json" | "provenance.json"; sizeBytes: number; sha256: string }>;
  layers: Array<{
    layerId: string;
    surveyId: string;
    coverageRole: string;
    dataOrigin: string;
    sourceTier: string;
    modality: string;
    releaseId: string;
    path: `mocs/${string}.moc.fits`;
    sizeBytes: number;
    sha256: string;
  }>;
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
  /** Read-only Assets survey registry projection; does not imply a package layer exists. */
  publicReleases?: AssetsSurveyRelease[];
}

export type AssetsProductStatus = "acquired" | "overview_only" | "awaiting_geometry" | "not_applicable";

export interface AssetsSurveyProduct {
  name: string;
  modality: SurveyModality;
  description: string;
  status: AssetsProductStatus;
  sourceUrl?: string;
  geometrySourceUrl?: string;
  reason?: string;
  manualStep?: string;
}

export interface AssetsSurveyRelease {
  id: string;
  label: string;
  kind: ReleaseKind;
  releasedYear?: number;
  modalities: SurveyModality[];
  products: AssetsSurveyProduct[];
}

export interface AssetsSurveyRecord {
  id: string;
  name: string;
  mission: string;
  color: string;
  description: string;
  modalities: SurveyModality[];
  releases: AssetsSurveyRelease[];
}

const RESOURCE_SURVEY_COLORS = ["#45d7c6", "#e4b44c", "#d96b67", "#6ca6d9", "#78b96c", "#b77bd1", "#cf8a4c", "#5fb0a8"] as const;
const RESOURCE_SURVEY_MODALITIES: readonly SurveyModality[] = ["imaging", "spectroscopy", "photometry", "time-domain", "integral-field", "ultraviolet", "infrared", "catalog", "simulation"];

function resourceSurveyColor(id: string): string {
  const hash = [...id].reduce((value, character) => ((value * 31) + character.charCodeAt(0)) | 0, 7);
  return RESOURCE_SURVEY_COLORS[Math.abs(hash) % RESOURCE_SURVEY_COLORS.length]!;
}

function resourceSurveyModalities(values: readonly string[]): SurveyModality[] {
  const result = [...new Set(values.filter((value): value is SurveyModality => RESOURCE_SURVEY_MODALITIES.includes(value as SurveyModality)))];
  return result.length ? result : ["catalog"];
}

const ASSETS_PRODUCT_STATUSES: readonly AssetsProductStatus[] = ["acquired", "overview_only", "awaiting_geometry", "not_applicable"];
const SURVEY_RELEASE_KINDS: readonly ReleaseKind[] = ["public_release", "quick_release", "early_release", "science_results", "archive_snapshot", "planned"];

function assetsSurveyModalities(value: unknown, label: string): SurveyModality[] {
  if (!Array.isArray(value)) throw new Error(`${label} is invalid`);
  const result = [...new Set(value.filter((entry): entry is SurveyModality => RESOURCE_SURVEY_MODALITIES.includes(entry as SurveyModality)))];
  if (!result.length) throw new Error(`${label} is invalid`);
  return result;
}

function optionalHttpText(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  const result = text(value, label);
  const parsed = new URL(result);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`${label} must use HTTP or HTTPS`);
  return result;
}

function parseAssetsSurveyCatalog(value: unknown): AssetsSurveyRecord[] {
  const document = object(value, "Assets survey catalog");
  if (document.schemaVersion !== 1 || !Array.isArray(document.surveys)) throw new Error("Assets survey catalog has an unsupported schema");
  return document.surveys.map((entry, surveyIndex) => {
    const survey = object(entry, `Assets survey ${surveyIndex}`);
    const releases = Array.isArray(survey.releases) ? survey.releases.map((releaseValue, releaseIndex) => {
      const release = object(releaseValue, `Assets survey ${surveyIndex} release ${releaseIndex}`);
      const products = Array.isArray(release.products) ? release.products.map((productValue, productIndex) => {
        const product = object(productValue, `Assets survey ${surveyIndex} release ${releaseIndex} product ${productIndex}`);
        const status = text(product.status, "Assets survey product status", 40) as AssetsProductStatus;
        if (!ASSETS_PRODUCT_STATUSES.includes(status)) throw new Error("Assets survey product status is invalid");
        const sourceUrl = optionalHttpText(product.sourceUrl, "Assets survey product source URL");
        const geometrySourceUrl = optionalHttpText(product.geometrySourceUrl, "Assets survey product geometry URL");
        return {
          name: text(product.name, "Assets survey product name", 200),
          modality: assetsSurveyModalities([product.modality], "Assets survey product modality")[0]!,
          description: text(product.description, "Assets survey product description", 4000),
          status,
          ...(sourceUrl === undefined ? {} : { sourceUrl }),
          ...(geometrySourceUrl === undefined ? {} : { geometrySourceUrl }),
          ...(product.reason === undefined ? {} : { reason: text(product.reason, "Assets survey product reason", 2000) }),
          ...(product.manualStep === undefined ? {} : { manualStep: text(product.manualStep, "Assets survey product manual step", 2000) }),
        } satisfies AssetsSurveyProduct;
      }) : [];
      if (!products.length) throw new Error(`Assets survey ${surveyIndex} release ${releaseIndex} has no products`);
      const kindValue = text(release.kind, "Assets survey release kind", 40);
      const kind = SURVEY_RELEASE_KINDS.includes(kindValue as ReleaseKind) ? kindValue as ReleaseKind : "planned";
      const releasedYear = release.releasedYear === undefined ? undefined : Number(release.releasedYear);
      if (releasedYear !== undefined && (!Number.isSafeInteger(releasedYear) || releasedYear < 1900 || releasedYear > 3000)) throw new Error("Assets survey release year is invalid");
      return {
        id: text(release.id, "Assets survey release id", 160),
        label: text(release.label, "Assets survey release label", 240),
        kind,
        ...(releasedYear === undefined ? {} : { releasedYear }),
        modalities: assetsSurveyModalities(release.modalities, "Assets survey release modalities"),
        products,
      } satisfies AssetsSurveyRelease;
    }) : [];
    if (!releases.length) throw new Error(`Assets survey ${surveyIndex} has no releases`);
    return {
      id: text(survey.id, "Assets survey id", 120),
      name: text(survey.name, "Assets survey name", 200),
      mission: text(survey.mission, "Assets survey mission", 300),
      color: text(survey.color, "Assets survey color", 32),
      description: text(survey.description, "Assets survey description", 5000),
      modalities: assetsSurveyModalities(survey.modalities, "Assets survey modalities"),
      releases,
    } satisfies AssetsSurveyRecord;
  });
}

function resourceSurveyRelease(id: string, label: string, record: PublicResourcePackage, sourceUrl: string): SurveyRelease {
  const modalities = resourceSurveyModalities(record.modalities);
  return {
    id,
    label,
    kind: "public_release",
    availability: "available",
    modalities,
    products: record.productTypes.map((name) => ({ name, modality: modalities[0]!, description: record.description })),
    coverage: { status: "verified", summary: record.description, sourceUrl },
  };
}

function assetsReleaseToSurveyRelease(release: AssetsSurveyRelease, fallbackSourceUrl: string): SurveyRelease {
  const statuses = new Set(release.products.map((product) => product.status));
  const acquired = statuses.has("acquired") && !statuses.has("awaiting_geometry");
  const overview = statuses.has("overview_only") && !acquired && !statuses.has("awaiting_geometry");
  const sourceUrl = release.products.find((product) => product.sourceUrl)?.sourceUrl
    ?? release.products.find((product) => product.geometrySourceUrl)?.geometrySourceUrl
    ?? fallbackSourceUrl;
  return {
    id: release.id,
    label: release.label,
    kind: release.kind,
    availability: acquired ? "available" : "metadata_only",
    ...(release.releasedYear === undefined ? {} : { releasedYear: release.releasedYear }),
    modalities: release.modalities,
    products: release.products.map(({ name, modality, description }) => ({ name, modality, description })),
    coverage: {
      status: acquired ? "verified" : overview ? "summary_only" : "pending",
      summary: release.products.map((product) => product.description).join(" "),
      sourceUrl,
    },
  };
}

/** Read-only display metadata for public layers shipped in Assets v3 packages. */
export function resourcePackageSurveyRecords(packages: readonly PublicResourcePackage[]): SurveyRecord[] {
  const groups = new Map<string, PublicResourcePackage[]>();
  for (const record of packages) groups.set(record.surveyId, [...(groups.get(record.surveyId) ?? []), record]);
  return [...groups].map(([surveyId, records]) => {
    const first = records[0]!;
    const releases = new Map<string, SurveyRelease>();
    for (const record of records) {
      const metadata = new Map((record.publicReleases ?? []).map((release) => [release.id, release]));
      for (const release of metadata.values()) releases.set(release.id, assetsReleaseToSurveyRelease(release, record.archiveUrl));
      for (const releaseId of record.releases) if (!releases.has(releaseId)) {
        const source = record.sources.find((entry) => entry.releaseId === releaseId);
        releases.set(releaseId, resourceSurveyRelease(releaseId, record.releaseLabels[releaseId] ?? releaseId, record, source?.url ?? record.archiveUrl));
      }
    }
    return {
      id: surveyId,
      name: first.name,
      mission: [...new Set(records.flatMap((record) => record.facilities))].join(" / ") || first.name,
      color: resourceSurveyColor(surveyId),
      description: records.map((record) => record.description).filter((value, index, all) => all.indexOf(value) === index).join(" "),
      modalities: resourceSurveyModalities(records.flatMap((record) => record.modalities)),
      origin: "public",
      releases: [...releases.values()],
    };
  });
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
  /** Parent of assets-snapshots/ and assets-current/. */
  snapshotRoot?: string;
  /** Optional Assets survey metadata endpoint; otherwise derived from an HTTP catalog URL. */
  surveyCatalogUrl?: string;
  /** Optional allow-list for remote catalog origins. An empty list allows any HTTP(S) origin. */
  allowedOrigins?: readonly string[];
  maxArchiveBytes?: number;
  maxExtractedBytes?: number;
  downloadTimeoutMs?: number;
}

export class ResourceCatalogUnavailableError extends Error {
  constructor(message: string) {
    super(`Assets catalog unavailable: ${message}`);
    this.name = "ResourceCatalogUnavailableError";
  }
}

export class ResourceCatalogSyncError extends Error {
  constructor(message: string) {
    super(`Assets catalog sync failed: ${message}`);
    this.name = "ResourceCatalogSyncError";
  }
}

export interface ResourceCatalogStatus {
  catalogUrl: string;
  available: boolean;
  unavailableReason?: string;
  catalogSha256?: string;
  generatedAt?: string;
  syncedAt?: string;
}

function normalizeAllowedOrigins(origins: readonly string[] | undefined): Set<string> {
  return new Set((origins ?? []).map((origin) => {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`Unsupported resource catalog origin: ${origin}`);
    return parsed.origin;
  }));
}

function deriveSurveyCatalogUrl(catalogUrl: URL): URL | undefined {
  if (catalogUrl.protocol === "file:") return undefined;
  const marker = "/resource-packages/catalog.json";
  const basePath = catalogUrl.pathname.endsWith(marker) ? catalogUrl.pathname.slice(0, -marker.length) : "/api/v1";
  return new URL(`${basePath}/surveys`, catalogUrl.origin);
}

export function validateResourceCatalogUrl(value: string, allowedOrigins: readonly string[] = [], allowFile = true): URL {
  const url = new URL(value);
  if (url.protocol === "file:") {
    if (!allowFile) throw new RangeError("Resource catalog URL must use HTTP or HTTPS");
    return url;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new RangeError(`Unsupported resource catalog protocol: ${url.protocol}`);
  const allowed = normalizeAllowedOrigins(allowedOrigins);
  if (allowed.size && !allowed.has(url.origin)) throw new RangeError(`Resource catalog origin is not allowed: ${url.origin}`);
  return url;
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
      releaseId: text(source.releaseId, `${label} release id`, 120),
      label: text(source.label, `${label} label`, 160),
      url: text(source.url, `${label} URL`),
      authority: text(source.authority, `${label} authority`, 80),
      ...(source.license === undefined ? {} : { license: text(source.license, `${label} license`, 160) }),
    };
  });
}

function releaseLabels(value: unknown, releases: string[], label: string): Record<string, string> {
  const labels = object(value, label);
  const result: Record<string, string> = {};
  for (const releaseId of releases) result[releaseId] = text(labels[releaseId], `${label} ${releaseId}`, 160);
  return result;
}

function parseEntry(value: unknown): ResourcePackageCatalogEntry {
  const entry = object(value, "Resource package catalog entry");
  const id = text(entry.id, "Resource package id", 80);
  const version = text(entry.version, "Resource package version", 40);
  const sha256 = text(entry.sha256, "Resource package SHA-256", 64).toLowerCase();
  if (!PACKAGE_ID.test(id) || !VERSION.test(version) || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`Resource package catalog contains an invalid identity: ${id}`);
  if (!Number.isSafeInteger(entry.sizeBytes) || Number(entry.sizeBytes) <= 0) throw new Error(`Resource package catalog contains an invalid archive size: ${id}`);
  const releases = stringList(entry.releases, "Resource package releases");
  const parsedSources = sources(entry.sources, "Resource package sources");
  if (parsedSources.some((source) => !releases.includes(source.releaseId))) throw new Error(`Resource package catalog contains a source for an unknown release: ${id}`);
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
    releases,
    releaseLabels: releaseLabels(entry.releaseLabels, releases, "Resource package release labels"),
    sources: parsedSources,
    version,
    archiveUrl: text(entry.archiveUrl, "Resource package archive URL"),
    sizeBytes: Number(entry.sizeBytes),
    sha256,
    updatedAt: text(entry.updatedAt, "Resource package update time", 80),
    hidden: entry.hidden === true,
    deprecated: entry.deprecated === true,
    replacedBy: optionalStringList(entry.replacedBy, "Resource package replacements"),
    ...(entry.origin === undefined ? {} : { origin: "public" as const }),
  };
}

function parseCatalog(value: unknown): ResourcePackageCatalogDocument {
  const document = object(value, "Resource package catalog");
  if (document.schemaVersion !== CATALOG_SCHEMA_VERSION || document.version !== PACKAGE_FORMAT_VERSION || !Array.isArray(document.packages)) throw new Error("Resource package catalog has an unsupported schema");
  const packages = document.packages.map((entry) => parseEntry(entry));
  const identities = new Set<string>();
  for (const entry of packages) {
    const identity = `${entry.id}@${entry.version}`;
    if (identities.has(identity)) throw new Error(`Resource package catalog contains a duplicate: ${identity}`);
    identities.add(identity);
  }
  return { schemaVersion: CATALOG_SCHEMA_VERSION, version: PACKAGE_FORMAT_VERSION, generatedAt: text(document.generatedAt, "Resource package catalog generation time", 80), packages };
}

function parseManifest(value: unknown): ResourcePackageManifest {
  const manifest = object(value, "Resource package manifest");
  if (manifest.schemaVersion !== PACKAGE_SCHEMA_VERSION || typeof manifest.version !== "string") throw new Error("Resource package manifest has an unsupported schema");
  const id = text(manifest.id, "Resource package id", 80);
  const version = text(manifest.version, "Resource package version", 40);
  if (!PACKAGE_ID.test(id) || !VERSION.test(version)) throw new Error("Resource package manifest has an invalid identity");
  const files = Array.isArray(manifest.files) ? manifest.files.map((item, index) => {
    const record = object(item, `Resource package supporting file ${index}`);
    const filePath = text(record.path, `Resource package supporting file ${index} path`, 120);
    const sizeBytes = record.sizeBytes;
    const sha256 = text(record.sha256, `Resource package supporting file ${index} SHA-256`, 64).toLowerCase();
    if (!(REQUIRED_ARCHIVE_FILES.has(filePath) && filePath !== "resource-package.json") || !Number.isSafeInteger(sizeBytes) || Number(sizeBytes) <= 0 || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`Resource package supporting file ${index} is invalid`);
    return { path: filePath as "README.md" | "footprints/survey-footprints.json" | "provenance.json", sizeBytes: Number(sizeBytes), sha256 };
  }) : [];
  if (files.length !== 3 || new Set(files.map((file) => file.path)).size !== 3 || !files.every((file) => ["README.md", "footprints/survey-footprints.json", "provenance.json"].includes(file.path))) throw new Error("Resource package supporting files are invalid");
  const layers = Array.isArray(manifest.layers) ? manifest.layers.map((item, index) => {
    const layer = object(item, `Resource package layer ${index}`);
    const layerId = text(layer.layerId, `Resource package layer ${index} layer id`, 160);
    const layerPath = text(layer.path, `Resource package layer ${index} path`, 512);
    const sizeBytes = layer.sizeBytes;
    const sha256 = text(layer.sha256, `Resource package layer ${index} SHA-256`, 64).toLowerCase();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(layerId) || layerPath !== `mocs/${layerId}.moc.fits` || !Number.isSafeInteger(sizeBytes) || Number(sizeBytes) <= 0 || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`Resource package layer ${index} is invalid`);
    for (const field of ["surveyId", "coverageRole", "dataOrigin", "sourceTier", "modality", "releaseId"]) text(layer[field], `Resource package layer ${index} ${field}`, 160);
    if (!(COVERAGE_ROLES as readonly unknown[]).includes(layer.coverageRole)) throw new Error(`Resource package layer ${index} has an invalid coverageRole`);
    if (!(DATA_ORIGINS as readonly unknown[]).includes(layer.dataOrigin)) throw new Error(`Resource package layer ${index} has an invalid dataOrigin`);
    if (!(SOURCE_TIERS as readonly unknown[]).includes(layer.sourceTier)) throw new Error(`Resource package layer ${index} has an invalid sourceTier`);
    return {
      layerId,
      surveyId: text(layer.surveyId, `Resource package layer ${index} survey id`, 80),
      coverageRole: text(layer.coverageRole, `Resource package layer ${index} coverage role`, 80),
      dataOrigin: text(layer.dataOrigin, `Resource package layer ${index} data origin`, 80),
      sourceTier: text(layer.sourceTier, `Resource package layer ${index} source tier`, 80),
      modality: text(layer.modality, `Resource package layer ${index} modality`, 80),
      releaseId: text(layer.releaseId, `Resource package layer ${index} release id`, 120),
      path: layerPath as `mocs/${string}.moc.fits`,
      sizeBytes: Number(sizeBytes),
      sha256,
    };
  }) : [];
  if (layers.length === 0 || layers.length > MAX_ZIP_ENTRIES || new Set(layers.map((layer) => layer.layerId)).size !== layers.length || new Set(layers.map((layer) => layer.path)).size !== layers.length) throw new Error("Resource package layers are invalid");
  const surveyId = text(manifest.surveyId, "Resource package survey id", 80);
  if (layers.some((layer) => layer.surveyId !== surveyId)) throw new Error("Resource package layers do not match the declared survey");
  return { schemaVersion: PACKAGE_SCHEMA_VERSION, version, id, surveyId, files, layers };
}

function parseState(value: unknown): ResourcePackageState {
  const state = object(value, "Resource package state");
  if (state.schemaVersion !== STATE_SCHEMA_VERSION || !Array.isArray(state.packages)) throw new Error("Resource package state has an unsupported schema");
  const packages = state.packages.map((item) => {
    const record = object(item, "Installed resource package");
    const id = text(record.id, "Installed resource package id", 80);
    const version = text(record.version, "Installed resource package version", 40);
    const sha256 = text(record.sha256, "Installed resource package SHA-256", 64);
    const activeReleaseIds = Array.isArray(record.activeReleaseIds) && record.activeReleaseIds.every((releaseId) => typeof releaseId === "string" && releaseId.trim())
      ? record.activeReleaseIds.map((releaseId) => String(releaseId).trim())
      : null;
    if (!PACKAGE_ID.test(id) || !VERSION.test(version) || !/^[a-f0-9]{64}$/i.test(sha256) || !activeReleaseIds || new Set(activeReleaseIds).size !== activeReleaseIds.length) throw new Error(`Installed resource package is invalid: ${id}`);
    return {
      id,
      version,
      sha256: sha256.toLowerCase(),
      installedAt: text(record.installedAt, "Resource package install time", 80),
      activeReleaseIds,
    };
  });
  return { schemaVersion: STATE_SCHEMA_VERSION, packages };
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
        const allowed = REQUIRED_ARCHIVE_FILES.has(name) || /^mocs\/[a-zA-Z0-9._-]+\.moc\.fits$/.test(name);
        if (entries > MAX_ZIP_ENTRIES || !allowed || name.startsWith("/") || name.split("/").includes("..") || (mode & 0o170000) === 0o120000 || seen.has(name)) throw new Error(`Resource package contains an unsafe ZIP entry: ${name}`);
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
      if (![...REQUIRED_ARCHIVE_FILES].every((name) => seen.has(name))) reject(new Error("Resource package is missing required files"));
      else resolve();
    });
    zip.readEntry();
  });
}

async function filesUnder(root: string, prefix = ""): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await filesUnder(root, relative));
    else if (entry.isFile()) result.push(relative);
    else throw new Error(`Resource package contains an invalid extracted entry: ${relative}`);
  }
  return result;
}

function validateFitsMoc(bytes: Buffer, label: string): void {
  if (bytes.length < 2880 || bytes.length % 2880 !== 0) throw new Error(`Invalid FITS MOC: ${label}`);
  const header = bytes.subarray(0, Math.min(bytes.length, 2880 * 4)).toString("ascii");
  if (!header.startsWith("SIMPLE  =") || !/NAXIS\s*=/.test(header) || !/(NUNIQ|PIXEL|MOCORDER|MOCVERS)/i.test(header)) throw new Error(`Invalid FITS MOC: ${label}`);
}

async function validateManifestFiles(stagingPath: string, manifest: ResourcePackageManifest): Promise<void> {
  const expected = new Set([...REQUIRED_ARCHIVE_FILES, ...manifest.layers.map((layer) => layer.path)]);
  const actual = await filesUnder(stagingPath);
  if (actual.length !== expected.size || actual.some((file) => !expected.has(file))) throw new Error("Resource package contains extra or undeclared ZIP entries");
  const provenance = object(JSON.parse(await readFile(path.join(stagingPath, "provenance.json"), "utf8")) as unknown, "Resource package provenance");
  if (!Number.isSafeInteger(provenance.schemaVersion)) throw new Error("Resource package provenance has an unsupported schema");
  for (const file of manifest.files) {
    const bytes = await readFile(path.join(stagingPath, file.path));
    if (bytes.length !== file.sizeBytes) throw new Error(`Supporting file size does not match manifest: ${file.path}`);
    if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw new Error(`Supporting file SHA-256 does not match manifest: ${file.path}`);
  }
  for (const layer of manifest.layers) {
    const bytes = await readFile(path.join(stagingPath, layer.path));
    if (bytes.length !== layer.sizeBytes) throw new Error(`MOC size does not match manifest: ${layer.path}`);
    if (createHash("sha256").update(bytes).digest("hex") !== layer.sha256) throw new Error(`MOC SHA-256 does not match manifest: ${layer.path}`);
    validateFitsMoc(bytes, layer.path);
  }
}

export class ResourcePackageManager {
  #catalogUrl: URL;
  #surveyCatalogUrl?: URL;
  readonly #surveyCatalogUrlExplicit: boolean;
  readonly #root: string;
  readonly #statePath: string;
  readonly #maxArchiveBytes: number;
  readonly #maxExtractedBytes: number;
  readonly #downloadTimeoutMs: number;
  readonly #snapshotRoot?: string;
  readonly #allowedOrigins: Set<string>;
  #catalog: ResourcePackageCatalogDocument = { schemaVersion: CATALOG_SCHEMA_VERSION, version: PACKAGE_FORMAT_VERSION, generatedAt: "", packages: [] };
  #state: ResourcePackageState = { schemaVersion: STATE_SCHEMA_VERSION, packages: [] };
  #jobs = new Map<string, ResourcePackageJob>();
  #installedFootprints = new Map<string, SurveyFootprintManifest>();
  #installing = new Set<string>();
  #mutation = Promise.resolve();
  #catalogError?: Error;
  #catalogSha256?: string;
  #catalogSyncedAt?: string;
  #surveyCatalog: AssetsSurveyRecord[] = [];
  #surveyCatalogBytes?: Buffer;

  constructor(options: ResourcePackageManagerOptions) {
    this.#allowedOrigins = normalizeAllowedOrigins(options.allowedOrigins);
    this.#catalogUrl = validateResourceCatalogUrl(options.catalogUrl, [...this.#allowedOrigins]);
    this.#surveyCatalogUrlExplicit = options.surveyCatalogUrl !== undefined;
    this.#surveyCatalogUrl = options.surveyCatalogUrl
      ? validateResourceCatalogUrl(options.surveyCatalogUrl, [...this.#allowedOrigins])
      : deriveSurveyCatalogUrl(this.#catalogUrl);
    this.#root = options.root;
    this.#statePath = options.statePath;
    this.#maxArchiveBytes = options.maxArchiveBytes ?? MAX_ARCHIVE_BYTES;
    this.#maxExtractedBytes = options.maxExtractedBytes ?? MAX_EXTRACTED_BYTES;
    this.#downloadTimeoutMs = options.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS;
    this.#snapshotRoot = options.snapshotRoot;
  }

  async initialize(): Promise<void> {
    let catalog: ResourcePackageCatalogDocument | undefined;
    try {
      const catalogBytes = await readUrl(this.#catalogUrl, this.#downloadTimeoutMs);
      const parsed = parseCatalog(JSON.parse(catalogBytes.toString("utf8")) as unknown);
      catalog = parsed;
      this.#catalogError = undefined;
      this.#catalogSha256 = createHash("sha256").update(catalogBytes).digest("hex");
      this.#catalogSyncedAt = new Date().toISOString();
      if (!await this.#fetchSurveyMetadata()) await this.#loadSurveySnapshot();
      if (this.#snapshotRoot) await this.#writeSnapshot(catalogBytes);
    } catch (error) {
      this.#catalogError = error instanceof Error ? error : new Error(String(error));
      if (this.#snapshotRoot) {
        try {
          const snapshotBytes = await readFile(path.join(this.#snapshotRoot, "assets-current", "catalog.json"));
          catalog = parseCatalog(JSON.parse(snapshotBytes.toString("utf8")) as unknown);
          await this.#loadSurveySnapshot();
          this.#catalogError = undefined;
          this.#catalogSha256 = createHash("sha256").update(snapshotBytes).digest("hex");
          this.#catalogSyncedAt = undefined;
        } catch {
          catalog = undefined;
        }
      }
    }
    this.#catalog = catalog ?? { schemaVersion: CATALOG_SCHEMA_VERSION, version: PACKAGE_FORMAT_VERSION, generatedAt: "", packages: [] };
    await mkdir(path.join(this.#root, "downloads"), { recursive: true });
    await mkdir(path.join(this.#root, "staging"), { recursive: true });
    await mkdir(path.join(this.#root, "installed"), { recursive: true });
    try {
      const parsed = parseState(JSON.parse(await readFile(this.#statePath, "utf8")) as unknown);
      this.#state = parsed;
      let stateChanged = false;
      for (const installed of this.#state.packages) {
        const manifest = await this.#validateInstalled(installed);
        this.#installedFootprints.set(installed.id, manifest);
        const available = new Set(this.#releaseIds(manifest));
        const retained = installed.activeReleaseIds.filter((releaseId) => available.has(releaseId));
        if (retained.length !== installed.activeReleaseIds.length) {
          installed.activeReleaseIds = retained;
          stateChanged = true;
        }
      }
      if (stateChanged) await this.#persist();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.#persist();
    }
  }

  get available(): boolean { return this.#catalogError === undefined; }

  get unavailableReason(): string | undefined { return this.#catalogError?.message; }

  get catalogUrl(): string { return this.#catalogUrl.href; }

  setCatalogUrl(value: string): string {
    this.#catalogUrl = validateResourceCatalogUrl(value, [...this.#allowedOrigins], false);
    if (!this.#surveyCatalogUrlExplicit) this.#surveyCatalogUrl = deriveSurveyCatalogUrl(this.#catalogUrl);
    return this.#catalogUrl.href;
  }

  catalogStatus(): ResourceCatalogStatus {
    return {
      catalogUrl: this.#catalogUrl.href,
      available: this.available,
      ...(this.#catalogError ? { unavailableReason: this.#catalogError.message } : {}),
      ...(this.#catalogSha256 ? { catalogSha256: this.#catalogSha256 } : {}),
      ...(this.#catalog.generatedAt ? { generatedAt: this.#catalog.generatedAt } : {}),
      ...(this.#catalogSyncedAt ? { syncedAt: this.#catalogSyncedAt } : {}),
    };
  }

  /** Fetch and trust a v3 catalog without downloading any package archive. */
  async sync(): Promise<ResourceCatalogStatus> {
    let catalogBytes: Buffer;
    let parsed: ResourcePackageCatalogDocument;
    try {
      catalogBytes = await readUrl(this.#catalogUrl, this.#downloadTimeoutMs);
      parsed = parseCatalog(JSON.parse(catalogBytes.toString("utf8")) as unknown);
      for (const installed of this.#state.packages) {
        const entry = parsed.packages.find((candidate) => candidate.id === installed.id);
        if (!entry || (entry.version === installed.version && entry.sha256 !== installed.sha256)) {
          throw new Error(`Installed resource package is absent from the trusted catalog: ${installed.id}@${installed.version}`);
        }
        await this.#readFootprints(installed);
      }
      const surveyMetadata = await this.#fetchSurveyMetadata();
      if (!surveyMetadata && !this.#surveyCatalogBytes) await this.#loadSurveySnapshot();
      if (this.#snapshotRoot) await this.#writeSnapshot(catalogBytes);
    } catch (error) {
      throw new ResourceCatalogSyncError(error instanceof Error ? error.message : String(error));
    }
    this.#catalog = parsed;
    this.#catalogError = undefined;
    this.#catalogSha256 = createHash("sha256").update(catalogBytes).digest("hex");
    this.#catalogSyncedAt = new Date().toISOString();
    return this.catalogStatus();
  }

  async #fetchSurveyMetadata(): Promise<boolean> {
    if (!this.#surveyCatalogUrl) return false;
    try {
      const bytes = await readUrl(this.#surveyCatalogUrl, this.#downloadTimeoutMs);
      this.#surveyCatalog = parseAssetsSurveyCatalog(JSON.parse(bytes.toString("utf8")) as unknown);
      this.#surveyCatalogBytes = bytes;
      return true;
    } catch {
      return false;
    }
  }

  async #loadSurveySnapshot(): Promise<boolean> {
    if (!this.#snapshotRoot) return false;
    try {
      const bytes = await readFile(path.join(this.#snapshotRoot, "assets-current", "surveys.json"));
      this.#surveyCatalog = parseAssetsSurveyCatalog(JSON.parse(bytes.toString("utf8")) as unknown);
      this.#surveyCatalogBytes = bytes;
      return true;
    } catch {
      this.#surveyCatalog = [];
      this.#surveyCatalogBytes = undefined;
      return false;
    }
  }

  async #writeSnapshot(bytes: Buffer): Promise<void> {
    if (!this.#snapshotRoot) return;
    const digest = createHash("sha256").update(bytes).digest("hex");
    const snapshots = path.join(this.#snapshotRoot, "assets-snapshots");
    await mkdir(snapshots, { recursive: true });
    const snapshot = path.join(snapshots, digest);
    await mkdir(snapshot, { recursive: true });
    await writeFile(path.join(snapshot, "catalog.json"), bytes, { flag: "wx" }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    if (this.#surveyCatalogBytes) {
      await writeFile(path.join(snapshot, "surveys.json"), this.#surveyCatalogBytes, { flag: "wx" }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
    }
    const current = path.join(this.#snapshotRoot, "assets-current");
    const temporary = path.join(this.#snapshotRoot, `.assets-current-${process.pid}-${randomUUID()}`);
    await symlink(path.relative(this.#snapshotRoot, snapshot), temporary, "dir");
    await rename(temporary, current).catch(async (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await rm(current, { recursive: true, force: true });
      await rename(temporary, current);
    });
  }

  #assertAvailable(): void {
    if (this.#catalogError) throw new ResourceCatalogUnavailableError(this.#catalogError.message);
  }

  list(): PublicResourcePackage[] {
    this.#assertAvailable();
    return this.#catalog.packages.filter((entry) => !entry.hidden).map((entry) => {
      const installed = this.#state.packages.find((record) => record.id === entry.id);
      const update = Boolean(installed && installed.version !== entry.version);
      return this.#toPublic(entry, installed, update);
    });
  }

  get(id: string): PublicResourcePackage {
    this.#assertAvailable();
    const result = this.#publicRecord(id);
    if (!result) throw new Error(`Resource package not found: ${id}`);
    return result;
  }

  install(id: string): ResourcePackageJob {
    this.#assertAvailable();
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
    this.#assertAvailable();
    const installed = this.#installed(id);
    await this.setActive(this.#loadsExcept(id).concat({ packageId: id, releaseIds: this.#availableReleaseIds(installed) }));
    return this.get(id);
  }

  async deactivate(id: string): Promise<PublicResourcePackage> {
    this.#assertAvailable();
    this.#installed(id);
    await this.setActive(this.#loadsExcept(id));
    return this.get(id);
  }

  async setActive(loads: ResourcePackageLoad[]): Promise<PublicResourcePackage[]> {
    this.#assertAvailable();
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
        if (load.releaseIds.length) selected.push({ ...manifest, footprints: manifest.footprints.filter((footprint) => isLoadableFootprint(footprint) && load.releaseIds.includes(footprint.releaseId)) });
      }
      this.#validateSelection(selected);
      await this.#persist(draft);
      this.#state = { schemaVersion: STATE_SCHEMA_VERSION, packages: draft };
    });
    return this.list();
  }

  async remove(id: string): Promise<void> {
    await this.#mutate(async () => {
      this.#installed(id);
      const previous = this.#state.packages.map((record) => ({ ...record, activeReleaseIds: [...record.activeReleaseIds] }));
      const next = previous.filter((record) => record.id !== id);
      await this.#persist(next);
      try {
        await rm(path.join(this.#root, "installed", id), { recursive: true, force: true });
      } catch (error) {
        await this.#persist(previous);
        throw error;
      }
      this.#state = { schemaVersion: STATE_SCHEMA_VERSION, packages: next };
      this.#installedFootprints.delete(id);
    });
  }

  async activeFootprints(): Promise<SurveyFootprintManifest> {
    this.#assertAvailable();
    const manifests = this.#state.packages.filter((record) => record.activeReleaseIds.length).map((record) => {
      const manifest = this.#installedFootprints.get(record.id);
      if (!manifest) throw new Error(`Installed resource package manifest is unavailable: ${record.id}`);
      return { ...manifest, footprints: manifest.footprints.filter((footprint) => isLoadableFootprint(footprint) && record.activeReleaseIds.includes(footprint.releaseId)) };
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
      await validateManifestFiles(stagingPath, manifest);
      const footprints = normalizeSurveyFootprintManifest(JSON.parse(await readFile(path.join(stagingPath, "footprints/survey-footprints.json"), "utf8")) as unknown);
      if (!footprints.footprints.length || footprints.footprints.some((footprint) => footprint.surveyId !== manifest.surveyId)) throw new Error("Resource package footprints do not match its survey");
      const finalParent = path.join(this.#root, "installed", entry.id);
      const finalPath = path.join(finalParent, entry.version);
      await mkdir(finalParent, { recursive: true });
      await rm(finalPath, { recursive: true, force: true });
      await rename(stagingPath, finalPath);
      await this.#mutate(async () => {
        const current = this.#state.packages.find((record) => record.id === entry.id);
        this.#state.packages = this.#state.packages.filter((record) => record.id !== entry.id);
        const loadableReleaseIds = new Set(this.#releaseIds(footprints));
        const activeReleaseIds = current?.activeReleaseIds.filter((releaseId) => loadableReleaseIds.has(releaseId)) ?? [];
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
    // A previously trusted installation remains readable while Assets is
    // offline. Public operations still fail through #assertAvailable until a
    // trusted catalog is available again.
    if (!entry && this.#catalogError) return this.#readFootprints(record);
    if (!entry || (entry.version === record.version && entry.sha256 !== record.sha256)) throw new Error(`Installed resource package is absent from the trusted catalog: ${record.id}@${record.version}`);
    const manifest = await this.#readFootprints(record);
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
    return [...new Set(manifest.footprints.filter(isLoadableFootprint).map((footprint) => footprint.releaseId))];
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
    const survey = this.#surveyCatalog.find((record) => record.id === entry.surveyId);
    return {
      ...entry,
      installedVersion: installed?.version,
      installedAt: installed?.installedAt,
      activeReleaseIds,
      availableReleaseIds: installed ? this.#availableReleaseIds(installed) : [],
      active,
      status: update ? "update_available" : active ? "active" : installed ? "installed" : "not_installed",
      ...(survey ? { publicReleases: survey.releases } : {}),
    };
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
