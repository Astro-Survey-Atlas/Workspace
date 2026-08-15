import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

import type { PublicReleaseProductStatus } from "./public-release-details.js";
import type { SurveyFootprintManifest } from "./survey-footprints.js";
import type { SurveyRecord } from "./survey-registry.js";

export const MANUAL_FOOTPRINT_SCHEMA_VERSION = 1;
export const MANUAL_FOOTPRINT_NSIDE = 16;
export const MANUAL_FOOTPRINT_ORDERING = "NESTED" as const;

export type ManualFootprintStatus = "draft" | "validated" | "published";

export interface ManualFootprintInput {
  surveyId: string;
  releaseId: string;
  product: string;
  label: string;
  sourceUrl: string;
  method: string;
  calculatedAt: string;
  ordering: typeof MANUAL_FOOTPRINT_ORDERING;
  nside: typeof MANUAL_FOOTPRINT_NSIDE;
  pixels: number[];
}

export interface ManualFootprintRecord extends ManualFootprintInput {
  status: ManualFootprintStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  validatedAt?: string;
  publishedAt?: string;
}

interface ManualFootprintState {
  schemaVersion: typeof MANUAL_FOOTPRINT_SCHEMA_VERSION;
  records: ManualFootprintRecord[];
}

export interface ManualFootprintRegistryOptions {
  statePath: string;
  surveys?: readonly SurveyRecord[];
  resolveSurvey?: (surveyId: string) => SurveyRecord | undefined;
  releaseProducts?: readonly PublicReleaseProductStatus[];
  now?: () => Date;
}

const INPUT_FIELDS = new Set(["surveyId", "releaseId", "product", "label", "sourceUrl", "method", "calculatedAt", "ordering", "nside", "pixels"]);
const RECORD_FIELDS = new Set([...INPUT_FIELDS, "status", "revision", "createdAt", "updatedAt", "validatedAt", "publishedAt"]);

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RangeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function rejectUnknownFields(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(value).filter((field) => !allowed.has(field));
  if (unknown.length) throw new RangeError(`${label} contains unknown field: ${unknown[0]}`);
}

function text(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim()) throw new RangeError(`${field} is required`);
  const result = value.trim();
  if (result.length > maximum) throw new RangeError(`${field} must contain at most ${maximum} characters`);
  return result;
}

function isoTime(value: unknown, field: string): string {
  const result = text(value, field, 64);
  const date = new Date(result);
  if (!Number.isFinite(date.getTime()) || !/^\d{4}-\d{2}-\d{2}T/.test(result)) throw new RangeError(`${field} must be an ISO timestamp`);
  return result;
}

function identity(value: Pick<ManualFootprintInput, "surveyId" | "releaseId" | "product">): string {
  return `${value.surveyId}:${value.releaseId}:${value.product}`;
}

function normalizeInput(value: unknown): ManualFootprintInput {
  const input = objectValue(value, "manual footprint");
  rejectUnknownFields(input, INPUT_FIELDS, "manual footprint");
  const sourceUrl = text(input.sourceUrl, "sourceUrl", 2048);
  let source: URL;
  try { source = new URL(sourceUrl); } catch { throw new RangeError("sourceUrl must be a valid HTTPS URL"); }
  if (source.protocol !== "https:") throw new RangeError("sourceUrl must use HTTPS");
  if (input.ordering !== MANUAL_FOOTPRINT_ORDERING) throw new RangeError(`ordering must be ${MANUAL_FOOTPRINT_ORDERING}`);
  if (input.nside !== MANUAL_FOOTPRINT_NSIDE) throw new RangeError(`nside must be ${MANUAL_FOOTPRINT_NSIDE}`);
  if (!Array.isArray(input.pixels) || input.pixels.length === 0 || input.pixels.length > 3072) throw new RangeError("pixels must contain between 1 and 3072 cells");
  if (input.pixels.some((pixel) => !Number.isInteger(pixel) || pixel < 0 || pixel > 3071)) throw new RangeError("pixels must contain integers from 0 through 3071");
  return {
    surveyId: text(input.surveyId, "surveyId", 120),
    releaseId: text(input.releaseId, "releaseId", 120),
    product: text(input.product, "product", 160),
    label: text(input.label, "label", 200),
    sourceUrl,
    method: text(input.method, "method", 500),
    calculatedAt: isoTime(input.calculatedAt, "calculatedAt"),
    ordering: MANUAL_FOOTPRINT_ORDERING,
    nside: MANUAL_FOOTPRINT_NSIDE,
    pixels: [...new Set(input.pixels as number[])].sort((left, right) => left - right),
  };
}

function parseRecord(value: unknown): ManualFootprintRecord {
  const raw = objectValue(value, "manual footprint record");
  rejectUnknownFields(raw, RECORD_FIELDS, "manual footprint record");
  const input = normalizeInput(Object.fromEntries(Object.entries(raw).filter(([field]) => INPUT_FIELDS.has(field))));
  if (!(["draft", "validated", "published"] as unknown[]).includes(raw.status)) throw new Error("manual footprint record has an invalid status");
  if (!Number.isInteger(raw.revision) || (raw.revision as number) < 1) throw new Error("manual footprint record has an invalid revision");
  const record: ManualFootprintRecord = {
    ...input,
    status: raw.status as ManualFootprintStatus,
    revision: raw.revision as number,
    createdAt: isoTime(raw.createdAt, "createdAt"),
    updatedAt: isoTime(raw.updatedAt, "updatedAt"),
  };
  if (raw.validatedAt !== undefined) record.validatedAt = isoTime(raw.validatedAt, "validatedAt");
  if (raw.publishedAt !== undefined) record.publishedAt = isoTime(raw.publishedAt, "publishedAt");
  return record;
}

export class ManualFootprintRegistry {
  readonly #statePath: string;
  readonly #resolveSurvey: (surveyId: string) => SurveyRecord | undefined;
  readonly #releaseProducts: ReadonlySet<string>;
  readonly #now: () => Date;
  #state: ManualFootprintState = { schemaVersion: MANUAL_FOOTPRINT_SCHEMA_VERSION, records: [] };
  #mutations: Promise<void> = Promise.resolve();

  constructor(options: ManualFootprintRegistryOptions) {
    this.#statePath = path.resolve(options.statePath);
    if (!options.resolveSurvey && !options.surveys) throw new TypeError("surveys or resolveSurvey is required");
    this.#resolveSurvey = options.resolveSurvey ?? ((surveyId) => options.surveys!.find((candidate) => candidate.id === surveyId));
    this.#releaseProducts = new Set((options.releaseProducts ?? []).map(identity));
    this.#now = options.now ?? (() => new Date());
  }

  async initialize(): Promise<void> {
    try {
      const raw = objectValue(JSON.parse(await readFile(this.#statePath, "utf8")) as unknown, "manual footprint state");
      rejectUnknownFields(raw, new Set(["schemaVersion", "records"]), "manual footprint state");
      if (raw.schemaVersion !== MANUAL_FOOTPRINT_SCHEMA_VERSION || !Array.isArray(raw.records)) throw new Error("manual footprint state has an unsupported schema");
      const records = raw.records.map(parseRecord);
      if (new Set(records.map(identity)).size !== records.length) throw new Error("manual footprint state contains duplicate identities");
      for (const record of records) this.#validateReference(record);
      this.#state = { schemaVersion: MANUAL_FOOTPRINT_SCHEMA_VERSION, records };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  list(): ManualFootprintRecord[] {
    return this.#state.records.map((record) => ({ ...record, pixels: [...record.pixels] }));
  }

  get(surveyId: string, releaseId: string, product: string): ManualFootprintRecord {
    const record = this.#state.records.find((candidate) => identity(candidate) === identity({ surveyId, releaseId, product }));
    if (!record) throw new Error(`Manual footprint not found: ${identity({ surveyId, releaseId, product })}`);
    return { ...record, pixels: [...record.pixels] };
  }

  async create(value: unknown): Promise<ManualFootprintRecord> {
    return this.#mutate(async () => {
      const input = normalizeInput(value);
      this.#validateReference(input);
      if (this.#state.records.some((record) => identity(record) === identity(input))) throw new RangeError(`Manual footprint already exists: ${identity(input)}`);
      const timestamp = this.#now().toISOString();
      const record: ManualFootprintRecord = { ...input, status: "draft", revision: 1, createdAt: timestamp, updatedAt: timestamp };
      await this.#persist([...this.#state.records, record]);
      this.#state.records.push(record);
      return this.get(record.surveyId, record.releaseId, record.product);
    });
  }

  async update(surveyId: string, releaseId: string, product: string, revision: number, value: unknown): Promise<ManualFootprintRecord> {
    return this.#mutate(async () => {
      const current = this.#current(surveyId, releaseId, product, revision);
      const input = normalizeInput(value);
      if (identity(input) !== identity(current)) throw new RangeError("surveyId, releaseId, and product cannot be changed");
      this.#validateReference(input);
      const geometryChanged = input.ordering !== current.ordering || input.nside !== current.nside || JSON.stringify(input.pixels) !== JSON.stringify(current.pixels);
      const next: ManualFootprintRecord = {
        ...current,
        ...input,
        status: geometryChanged ? "draft" : current.status,
        revision: current.revision + 1,
        updatedAt: this.#now().toISOString(),
      };
      if (geometryChanged) {
        delete next.validatedAt;
        delete next.publishedAt;
      }
      await this.#replace(current, next);
      return this.get(surveyId, releaseId, product);
    });
  }

  async validate(surveyId: string, releaseId: string, product: string, revision: number): Promise<ManualFootprintRecord> {
    return this.#transition(surveyId, releaseId, product, revision, "validated");
  }

  async publish(surveyId: string, releaseId: string, product: string, revision: number, existing?: SurveyFootprintManifest): Promise<ManualFootprintRecord> {
    return this.#mutate(async () => {
      const current = this.#current(surveyId, releaseId, product, revision);
      this.#validateComplete(current);
      if (current.status !== "validated") throw new RangeError("Only a validated manual footprint can be published");
      if (existing?.footprints.some((footprint) => identity(footprint) === identity(current))) throw new RangeError(`Footprint identity conflicts with an active resource package: ${identity(current)}`);
      return this.#saveTransition(current, "published");
    });
  }

  async unpublish(surveyId: string, releaseId: string, product: string, revision: number): Promise<ManualFootprintRecord> {
    return this.#mutate(async () => {
      const current = this.#current(surveyId, releaseId, product, revision);
      if (current.status !== "published") throw new RangeError("Only a published manual footprint can be unpublished");
      return this.#saveTransition(current, "validated");
    });
  }

  publishedManifest(): SurveyFootprintManifest {
    const footprints = this.#state.records.filter((record) => record.status === "published").map((record) => ({
      surveyId: record.surveyId,
      releaseId: record.releaseId,
      product: record.product,
      label: record.label,
      nside: record.nside,
      pixels: [...record.pixels],
      quality: "moc" as const,
      sourceUrl: record.sourceUrl,
      retrievedAt: record.calculatedAt,
      notes: record.method,
    }));
    return { schemaVersion: 1, generatedAt: this.#now().toISOString(), coordinateFrame: "ICRS", nside: MANUAL_FOOTPRINT_NSIDE, footprints };
  }

  async #transition(surveyId: string, releaseId: string, product: string, revision: number, status: "validated"): Promise<ManualFootprintRecord> {
    return this.#mutate(async () => {
      const current = this.#current(surveyId, releaseId, product, revision);
      this.#validateComplete(current);
      if (current.status !== "draft") throw new RangeError("Only a draft manual footprint can be validated");
      return this.#saveTransition(current, status);
    });
  }

  async #saveTransition(current: ManualFootprintRecord, status: ManualFootprintStatus): Promise<ManualFootprintRecord> {
    const timestamp = this.#now().toISOString();
    const next: ManualFootprintRecord = { ...current, status, revision: current.revision + 1, updatedAt: timestamp };
    if (status === "validated") next.validatedAt = timestamp;
    if (status === "published") next.publishedAt = timestamp;
    await this.#replace(current, next);
    return this.get(next.surveyId, next.releaseId, next.product);
  }

  #validateComplete(input: ManualFootprintInput): void {
    normalizeInput({
      surveyId: input.surveyId,
      releaseId: input.releaseId,
      product: input.product,
      label: input.label,
      sourceUrl: input.sourceUrl,
      method: input.method,
      calculatedAt: input.calculatedAt,
      ordering: input.ordering,
      nside: input.nside,
      pixels: input.pixels,
    });
    this.#validateReference(input);
  }

  #validateReference(input: Pick<ManualFootprintInput, "surveyId" | "releaseId" | "product">): void {
    const survey = this.#resolveSurvey(input.surveyId);
    const release = survey?.releases.find((candidate) => candidate.id === input.releaseId && candidate.availability !== "planned");
    if (!survey || !release) throw new RangeError(`Survey release is not a non-planned registered release: ${input.surveyId}:${input.releaseId}`);
    if (!release.products.some((candidate) => candidate.name === input.product) && !this.#releaseProducts.has(identity(input))) {
      throw new RangeError(`Product is not registered for release: ${identity(input)}`);
    }
  }

  #current(surveyId: string, releaseId: string, product: string, revision: number): ManualFootprintRecord {
    const current = this.#state.records.find((record) => identity(record) === identity({ surveyId, releaseId, product }));
    if (!current) throw new Error(`Manual footprint not found: ${identity({ surveyId, releaseId, product })}`);
    if (current.revision !== revision) throw new ManualFootprintRevisionError(current.revision);
    return current;
  }

  async #replace(current: ManualFootprintRecord, next: ManualFootprintRecord): Promise<void> {
    const records = this.#state.records.map((record) => record === current ? next : record);
    await this.#persist(records);
    this.#state.records = records;
  }

  async #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutations.then(operation, operation);
    this.#mutations = result.then(() => undefined, () => undefined);
    return result;
  }

  async #persist(records: ManualFootprintRecord[]): Promise<void> {
    await mkdir(path.dirname(this.#statePath), { recursive: true });
    const temporary = `${this.#statePath}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({ schemaVersion: MANUAL_FOOTPRINT_SCHEMA_VERSION, records }, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      await rename(temporary, this.#statePath);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

export class ManualFootprintRevisionError extends Error {
  constructor(readonly currentRevision: number) {
    super(`Manual footprint revision does not match; current revision is ${currentRevision}`);
  }
}
