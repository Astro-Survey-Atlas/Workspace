import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { PublicResourcePackage } from "./resource-packages.js";

export type SurveyModality = "imaging" | "spectroscopy" | "photometry" | "time-domain" | "integral-field" | "ultraviolet" | "infrared" | "catalog" | "simulation";
export type ReleaseKind = "public_release" | "quick_release" | "early_release" | "science_results" | "archive_snapshot" | "planned";
export type ReleaseAvailability = "available" | "metadata_only" | "planned";
export type FootprintStatus = "verified" | "summary_only" | "pending";

export interface SurveyProduct {
  name: string;
  modality: SurveyModality;
  description: string;
}

export interface SurveyReleaseCoverage {
  status: FootprintStatus;
  summary: string;
  areaDeg2?: number;
  sourceUrl: string;
}

export interface SurveyRelease {
  id: string;
  label: string;
  phase?: string;
  kind: ReleaseKind;
  availability: ReleaseAvailability;
  releasedYear?: number;
  modalities: SurveyModality[];
  products: SurveyProduct[];
  coverage: SurveyReleaseCoverage;
}

export interface SurveyRecord {
  id: string;
  name: string;
  mission: string;
  color: string;
  description: string;
  modalities: SurveyModality[];
  origin: "public" | "user";
  releases: SurveyRelease[];
}

export interface SurveyCard {
  id: string;
  name: string;
  mission: string;
  color: string;
  description: string;
  modalities: SurveyModality[];
  origin: "public" | "user";
  releaseCount: number;
  availableReleaseCount: number;
  verifiedFootprintReleaseCount: number;
  coverageStatus: FootprintStatus;
}

export interface SurveyRegistrationInput {
  id?: string;
  name: string;
  mission?: string;
  color?: string;
  sourceUrl: string;
  description?: string;
  modalities: SurveyModality[];
  releases?: SurveyReleaseRegistrationInput[];
}

export type SurveyReleaseRegistrationInput = SurveyRelease;

const MODALITIES: readonly SurveyModality[] = ["imaging", "spectroscopy", "photometry", "time-domain", "integral-field", "ultraviolet", "infrared", "catalog", "simulation"];
const RELEASE_KINDS: readonly ReleaseKind[] = ["public_release", "quick_release", "early_release", "science_results", "archive_snapshot", "planned"];
const RELEASE_AVAILABILITIES: readonly ReleaseAvailability[] = ["available", "metadata_only", "planned"];
const FOOTPRINT_STATUSES: readonly FootprintStatus[] = ["verified", "summary_only", "pending"];
const REGISTRATION_FIELDS = new Set(["id", "name", "mission", "color", "sourceUrl", "description", "modalities", "releases"]);
const RECORD_FIELDS = new Set(["id", "name", "mission", "color", "description", "modalities", "origin", "releases"]);
const RELEASE_FIELDS = new Set(["id", "label", "phase", "kind", "availability", "releasedYear", "modalities", "products", "coverage"]);
const PRODUCT_FIELDS = new Set(["name", "modality", "description"]);
const COVERAGE_FIELDS = new Set(["status", "summary", "areaDeg2", "sourceUrl"]);
const STABLE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,118}[a-z0-9])?$/;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RangeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function rejectUnknownFields(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(value).find((field) => !allowed.has(field));
  if (unknown) throw new RangeError(`${label} contains unknown field: ${unknown}`);
}

function requiredText(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim()) throw new RangeError(`${name} is required`);
  const result = value.trim();
  if (result.length > maximum) throw new RangeError(`${name} must contain at most ${maximum} characters`);
  return result;
}

function optionalText(value: unknown, name: string, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new RangeError(`${name} must be a string`);
  const result = value.trim();
  if (result.length > maximum) throw new RangeError(`${name} must contain at most ${maximum} characters`);
  return result || undefined;
}

function stableId(value: unknown, name: string): string {
  const result = requiredText(value, name, 120);
  if (!STABLE_ID.test(result)) throw new RangeError(`${name} must be a lowercase stable identifier`);
  return result;
}

function webUrl(value: unknown, name: string): string {
  const result = requiredText(value, name, 2048);
  let protocol: string;
  try {
    protocol = new URL(result).protocol;
  } catch {
    throw new RangeError(`${name} must be a valid URL`);
  }
  if (protocol !== "https:" && protocol !== "http:") throw new RangeError(`${name} must use http or https`);
  return result;
}

function surveyModalities(value: unknown, name = "modalities"): SurveyModality[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MODALITIES.length || value.some((entry) => !MODALITIES.includes(entry as SurveyModality))) {
    throw new RangeError(`${name} must contain one or more supported values`);
  }
  return [...new Set(value as SurveyModality[])];
}

function surveyColor(value: unknown, required = false): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !HEX_COLOR.test(value.trim())) throw new RangeError("color must be a six-digit hexadecimal color");
  return value.trim().toLowerCase();
}

function normalizeProduct(value: unknown, index: number): SurveyProduct {
  const product = objectValue(value, `products[${index}]`);
  rejectUnknownFields(product, PRODUCT_FIELDS, `products[${index}]`);
  if (!MODALITIES.includes(product.modality as SurveyModality)) throw new RangeError(`products[${index}].modality is not supported`);
  return {
    name: requiredText(product.name, `products[${index}].name`, 160),
    modality: product.modality as SurveyModality,
    description: requiredText(product.description, `products[${index}].description`, 500),
  };
}

function normalizeCoverage(value: unknown): SurveyReleaseCoverage {
  const coverage = objectValue(value, "coverage");
  rejectUnknownFields(coverage, COVERAGE_FIELDS, "coverage");
  if (!FOOTPRINT_STATUSES.includes(coverage.status as FootprintStatus)) throw new RangeError("coverage.status is not supported");
  let areaDeg2: number | undefined;
  if (coverage.areaDeg2 !== undefined) {
    if (typeof coverage.areaDeg2 !== "number" || !Number.isFinite(coverage.areaDeg2) || coverage.areaDeg2 < 0 || coverage.areaDeg2 > 50_000) {
      throw new RangeError("coverage.areaDeg2 must be a finite number from 0 through 50000");
    }
    areaDeg2 = coverage.areaDeg2;
  }
  return {
    status: coverage.status as FootprintStatus,
    summary: requiredText(coverage.summary, "coverage.summary", 1000),
    ...(areaDeg2 === undefined ? {} : { areaDeg2 }),
    sourceUrl: webUrl(coverage.sourceUrl, "coverage.sourceUrl"),
  };
}

function normalizeRelease(value: unknown): SurveyRelease {
  const input = objectValue(value, "release");
  rejectUnknownFields(input, RELEASE_FIELDS, "release");
  if (!RELEASE_KINDS.includes(input.kind as ReleaseKind)) throw new RangeError("release.kind is not supported");
  if (!RELEASE_AVAILABILITIES.includes(input.availability as ReleaseAvailability)) throw new RangeError("release.availability is not supported");
  if (!Array.isArray(input.products) || input.products.length < 1 || input.products.length > 100) {
    throw new RangeError("release.products must contain between 1 and 100 products");
  }
  let releasedYear: number | undefined;
  if (input.releasedYear !== undefined) {
    if (!Number.isInteger(input.releasedYear) || (input.releasedYear as number) < 1800 || (input.releasedYear as number) > 3000) {
      throw new RangeError("release.releasedYear must be an integer from 1800 through 3000");
    }
    releasedYear = input.releasedYear as number;
  }
  const modalities = surveyModalities(input.modalities, "release.modalities");
  const products = input.products.map(normalizeProduct);
  if (products.some((product) => !modalities.includes(product.modality))) {
    throw new RangeError("release products must use a modality declared by the release");
  }
  const phase = optionalText(input.phase, "release.phase", 120);
  return {
    id: stableId(input.id, "release.id"),
    label: requiredText(input.label, "release.label", 160),
    ...(phase === undefined ? {} : { phase }),
    kind: input.kind as ReleaseKind,
    availability: input.availability as ReleaseAvailability,
    ...(releasedYear === undefined ? {} : { releasedYear }),
    modalities,
    products,
    coverage: normalizeCoverage(input.coverage),
  };
}

function release(
  id: string,
  label: string,
  options: Omit<SurveyRelease, "id" | "label">,
): SurveyRelease {
  return { id, label, ...options };
}

const PUBLIC_SURVEY_COLORS = ["#45d7c6", "#e4b44c", "#d96b67", "#6ca6d9", "#78b96c", "#b77bd1", "#cf8a4c", "#5fb0a8"] as const;

function publicSurveyColor(id: string): string {
  const hash = [...id].reduce((value, character) => ((value * 31) + character.charCodeAt(0)) | 0, 7);
  return PUBLIC_SURVEY_COLORS[Math.abs(hash) % PUBLIC_SURVEY_COLORS.length]!;
}

function publicModalities(values: readonly string[]): SurveyModality[] {
  const result = [...new Set(values.filter((value): value is SurveyModality => MODALITIES.includes(value as SurveyModality)))];
  return result.length ? result : ["catalog"];
}

/** Project Assets v3 catalog metadata into the existing read-only survey view. */
export function publicSurveysFromPackages(packages: readonly PublicResourcePackage[]): SurveyRecord[] {
  const groups = new Map<string, PublicResourcePackage[]>();
  for (const record of packages) groups.set(record.surveyId, [...(groups.get(record.surveyId) ?? []), record]);
  return [...groups].map(([surveyId, records]) => {
    const first = records[0]!;
    const modalities = publicModalities(records.flatMap((record) => record.modalities));
    const releases = new Map<string, SurveyRelease>();
    for (const record of records) for (const releaseId of record.releases) {
      const source = record.sources.find((entry) => entry.releaseId === releaseId);
      const releaseModalities = publicModalities(record.modalities);
      releases.set(releaseId, release(releaseId, record.releaseLabels[releaseId] ?? releaseId, {
        kind: "public_release",
        availability: "available",
        modalities: releaseModalities,
        products: record.productTypes.map((name) => ({
          name,
          modality: releaseModalities[0]!,
          description: record.description,
        })),
        coverage: {
          status: "verified",
          summary: record.description,
          sourceUrl: source?.url ?? record.archiveUrl,
        },
      }));
    }
    return {
      id: surveyId,
      name: first.name,
      mission: [...new Set(records.flatMap((record) => record.facilities))].join(" / ") || first.name,
      color: publicSurveyColor(surveyId),
      description: records.map((record) => record.description).filter((value, index, all) => all.indexOf(value) === index).join(" "),
      modalities,
      origin: "public",
      releases: [...releases.values()],
    };
  });
}

function deriveCoverageStatus(releases: readonly SurveyRelease[]): FootprintStatus {
  if (releases.some((entry) => entry.coverage.status === "verified")) return "verified";
  if (releases.some((entry) => entry.coverage.status === "summary_only")) return "summary_only";
  return "pending";
}

export function surveyCardFor(record: SurveyRecord): SurveyCard {
  return {
    id: record.id,
    name: record.name,
    mission: record.mission,
    color: record.color,
    description: record.description,
    modalities: record.modalities,
    origin: record.origin,
    releaseCount: record.releases.length,
    availableReleaseCount: record.releases.filter((entry) => entry.availability === "available").length,
    verifiedFootprintReleaseCount: record.releases.filter((entry) => entry.coverage.status === "verified").length,
    coverageStatus: deriveCoverageStatus(record.releases),
  };
}

function validateRegistration(input: SurveyRegistrationInput): SurveyRegistrationInput {
  const raw = objectValue(input, "survey registration");
  rejectUnknownFields(raw, REGISTRATION_FIELDS, "survey registration");
  let releases: SurveyRelease[] | undefined;
  if (raw.releases !== undefined) {
    if (!Array.isArray(raw.releases) || raw.releases.length < 1 || raw.releases.length > 100) {
      throw new RangeError("releases must contain between 1 and 100 releases");
    }
    releases = raw.releases.map(normalizeRelease);
    if (new Set(releases.map((entry) => entry.id)).size !== releases.length) throw new RangeError("releases contains duplicate release ids");
  }
  const modalities = surveyModalities(raw.modalities);
  if (releases?.some((releaseEntry) => releaseEntry.modalities.some((modality) => !modalities.includes(modality)))) {
    throw new RangeError("release modalities must be declared by the survey");
  }
  const mission = optionalText(raw.mission, "mission", 120);
  const color = surveyColor(raw.color);
  const description = optionalText(raw.description, "description", 500);
  return {
    ...(raw.id === undefined ? {} : { id: stableId(raw.id, "id") }),
    name: requiredText(raw.name, "name", 120),
    ...(mission === undefined ? {} : { mission }),
    ...(color === undefined ? {} : { color }),
    sourceUrl: webUrl(raw.sourceUrl, "sourceUrl"),
    ...(description === undefined ? {} : { description }),
    modalities,
    ...(releases === undefined ? {} : { releases }),
  };
}

function normalizePersistedSurvey(value: unknown): SurveyRecord {
  const raw = objectValue(value, "survey registry record");
  rejectUnknownFields(raw, RECORD_FIELDS, "survey registry record");
  if (raw.origin !== "user") throw new Error("survey registry record origin must be user");
  if (!Array.isArray(raw.releases) || raw.releases.length < 1 || raw.releases.length > 100) {
    throw new Error("survey registry record must contain between 1 and 100 releases");
  }
  const releases = raw.releases.map(normalizeRelease);
  if (new Set(releases.map((entry) => entry.id)).size !== releases.length) throw new Error("survey registry record contains duplicate release ids");
  const modalities = surveyModalities(raw.modalities);
  if (releases.some((releaseEntry) => releaseEntry.modalities.some((modality) => !modalities.includes(modality)))) {
    throw new Error("survey registry record contains a release modality not declared by the survey");
  }
  return {
    id: stableId(raw.id, "id"),
    name: requiredText(raw.name, "name", 120),
    mission: requiredText(raw.mission, "mission", 120),
    color: surveyColor(raw.color, true)!,
    description: requiredText(raw.description, "description", 500),
    modalities,
    origin: "user",
    releases,
  };
}

export class SurveyRegistry {
  readonly #statePath: string;
  #registrations: SurveyRecord[] = [];
  #mutations: Promise<void> = Promise.resolve();

  constructor(statePath: string) {
    this.#statePath = statePath;
  }

  async initialize(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.#statePath, "utf8")) as unknown;
      if (!Array.isArray(parsed)) throw new Error("survey registry state must be an array");
      const persisted = parsed.map(normalizePersistedSurvey);
      const allIds = new Set<string>();
      const registrations: SurveyRecord[] = [];
      for (const record of persisted) {
        if (allIds.has(record.id)) throw new Error(`Survey id conflicts with an existing id: ${record.id}`);
        allIds.add(record.id);
        for (const releaseEntry of record.releases) {
          if (allIds.has(releaseEntry.id)) throw new Error(`Release id conflicts with an existing id: ${releaseEntry.id}`);
          allIds.add(releaseEntry.id);
        }
        registrations.push(record);
      }
      this.#registrations = registrations;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await mkdir(path.dirname(this.#statePath), { recursive: true });
        await this.#persist();
        return;
      }
      throw error;
    }
  }

  list(): SurveyCard[] {
    return this.#all().map(surveyCardFor);
  }

  get(id: string): SurveyRecord {
    const record = this.#all().find((entry) => entry.id === id);
    if (!record) throw new Error(`Survey not found: ${id}`);
    return structuredClone(record);
  }

  async register(input: SurveyRegistrationInput): Promise<SurveyRecord> {
    return this.#mutate(async () => {
      const value = validateRegistration(input);
      const id = value.id ?? `user-${randomUUID()}`;
      this.#assertSurveyIdAvailable(id);
      const releases = value.releases ?? [release(`${id}-source`, "Registered source", {
        kind: "archive_snapshot",
        availability: "metadata_only",
        modalities: value.modalities,
        products: [{
          name: "Registered source",
          modality: value.modalities.includes("catalog") ? "catalog" : value.modalities[0]!,
          description: "Metadata registration only; source rows are not copied into this workspace.",
        }],
        coverage: { status: "pending", summary: "Metadata source is registered. Scan or attach a MOC/HEALPix footprint to enable spatial drill-down.", sourceUrl: value.sourceUrl },
      })];
      if (releases.some((releaseEntry) => releaseEntry.id === id)) throw new RangeError(`Release id conflicts with survey id: ${id}`);
      for (const releaseEntry of releases) this.#assertReleaseIdAvailable(releaseEntry.id);
      const record: SurveyRecord = {
        id,
        name: value.name,
        mission: value.mission ?? "User registered source",
        color: value.color ?? "#ffcc70",
        description: value.description ?? "User-registered data source. Register a coverage artifact before spatial drill-down.",
        modalities: value.modalities,
        origin: "user",
        releases,
      };
      const registrations = [...this.#registrations, record];
      await this.#persist(registrations);
      this.#registrations = registrations;
      return structuredClone(record);
    });
  }

  async addRelease(surveyId: string, input: SurveyReleaseRegistrationInput): Promise<SurveyRelease> {
    return this.#mutate(async () => {
      const id = stableId(surveyId, "surveyId");
      const currentIndex = this.#registrations.findIndex((entry) => entry.id === id);
      if (currentIndex < 0) {
        throw new Error(`Survey not found: ${id}`);
      }
      const releaseEntry = normalizeRelease(input);
      if (releaseEntry.modalities.some((modality) => !this.#registrations[currentIndex]!.modalities.includes(modality))) {
        throw new RangeError("release modalities must be declared by the survey");
      }
      this.#assertReleaseIdAvailable(releaseEntry.id);
      const current = this.#registrations[currentIndex]!;
      const updated: SurveyRecord = { ...current, releases: [...current.releases, releaseEntry] };
      const registrations = this.#registrations.map((entry, index) => index === currentIndex ? updated : entry);
      await this.#persist(registrations);
      this.#registrations = registrations;
      return structuredClone(releaseEntry);
    });
  }

  #assertSurveyIdAvailable(id: string): void {
    if (this.#all().some((entry) => entry.id === id || entry.releases.some((releaseEntry) => releaseEntry.id === id))) {
      throw new RangeError(`Survey id already exists: ${id}`);
    }
  }

  #assertReleaseIdAvailable(id: string): void {
    if (this.#all().some((entry) => entry.id === id || entry.releases.some((releaseEntry) => releaseEntry.id === id))) {
      throw new RangeError(`Release id already exists: ${id}`);
    }
  }

  async #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutations.then(operation, operation);
    this.#mutations = result.then(() => undefined, () => undefined);
    return result;
  }

  async #persist(registrations = this.#registrations): Promise<void> {
    await mkdir(path.dirname(this.#statePath), { recursive: true });
    const temporaryPath = `${this.#statePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(registrations, null, 2), "utf8");
    await rename(temporaryPath, this.#statePath);
  }

  #all(): SurveyRecord[] {
    return this.#registrations;
  }
}
