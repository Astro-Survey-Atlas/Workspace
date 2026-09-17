import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { normalizePersistedSurvey, normalizeRelease, surveyCardFor, type SurveyRecord, type SurveyRelease } from "./survey-registry.js";
import type { MetadataStore, SurveyIdentityRecord } from "./storage/types.js";

/** Source identities stay separate until an explicit, reversible association. */
export class SurveyDirectory {
  constructor(private readonly store: MetadataStore) {}

  async importLegacy(filename: string): Promise<void> {
    if (await this.store.getImportMarker("survey-registrations-v1")) return;
    let values: unknown = [];
    try { values = JSON.parse(await readFile(filename, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!Array.isArray(values)) throw new Error("survey registry state must be an array");
    const records = values.map(normalizePersistedSurvey);
    const ids = records.flatMap((record) => [record.id, ...record.releases.map((release) => release.id)]);
    if (new Set(ids).size !== ids.length) throw new Error("Duplicate survey or release identity in legacy registry");
    await this.store.transaction(async (tx) => {
      if (await tx.getImportMarker("survey-registrations-v1")) return;
      if ((await tx.listSurveyIdentities()).some((entry) => entry.source === "user")) throw new Error("Survey migration would overwrite existing registrations");
      for (const survey of records) await tx.putSurveyIdentity({ id: survey.id, source: "user", sourceId: survey.id, survey, localReleases: [], history: [] });
      await tx.setImportMarker("survey-registrations-v1", new Date().toISOString());
    });
  }

  async syncPublic(records: SurveyRecord[]): Promise<void> {
    await this.store.transaction(async (tx) => {
      const identities = await tx.listSurveyIdentities();
      for (const survey of records) {
        const existing = identities.find((entry) => entry.source === "assets" && entry.sourceId === survey.id);
        const id = existing?.id ?? (identities.some((entry) => entry.id === survey.id) ? `assets-${randomUUID()}` : survey.id);
        const cachedSurvey = existing ? { ...survey, releases: [...survey.releases, ...existing.survey.releases.filter((release) => !survey.releases.some((current) => current.id === release.id))] } : survey;
        const entry: SurveyIdentityRecord = existing ? { ...existing, survey: cachedSurvey } : { id, source: "assets", sourceId: survey.id, survey, localReleases: [], history: [] };
        await tx.putSurveyIdentity(entry);
        if (!existing) identities.push(entry);
      }
    });
  }

  async records(): Promise<SurveyRecord[]> {
    const entries = await this.store.listSurveyIdentities();
    return entries.filter((entry) => !entry.linkedTo).map((entry) => this.project(entry, entries));
  }

  async list() { return (await this.records()).map(surveyCardFor); }

  async get(id: string): Promise<SurveyRecord> {
    const entries = await this.store.listSurveyIdentities();
    const entry = entries.find((entry) => entry.id === id);
    if (!entry) throw new RangeError(`Survey not found: ${id}`);
    return this.project(entries.find((candidate) => candidate.id === entry.linkedTo) ?? entry, entries);
  }

  async aliases(id: string): Promise<string[]> {
    const entries = await this.store.listSurveyIdentities();
    const canonical = entries.find((entry) => entry.id === id)?.linkedTo ?? id;
    return entries.filter((entry) => entry.id === canonical || entry.linkedTo === canonical).map((entry) => entry.id);
  }

  async validateReference(surveyId?: string, releaseId?: string): Promise<void> {
    if (!surveyId) { if (releaseId) throw new RangeError("releaseId requires surveyId"); return; }
    const survey = await this.get(surveyId);
    if (releaseId && !survey.releases.some((release) => release.id === releaseId)) throw new RangeError("Release does not belong to the selected survey");
  }

  async addRelease(id: string, value: SurveyRelease): Promise<SurveyRelease> {
    const release = normalizeRelease(value);
    await this.store.transaction(async (tx) => {
      const entries = await tx.listSurveyIdentities();
      const entry = entries.find((entry) => entry.id === id);
      if (!entry) throw new RangeError(`Survey not found: ${id}`);
      if (entries.some((entry) => [...entry.survey.releases, ...entry.localReleases].some((item) => item.id === release.id))) throw new RangeError("Release id already exists");
      await tx.putSurveyIdentity({ ...entry, localReleases: [...entry.localReleases, release] });
    });
    return release;
  }

  async link(localId: string, publicId: string, unlink = false): Promise<void> {
    await this.store.transaction(async (tx) => {
      const entries = await tx.listSurveyIdentities();
      const local = entries.find((entry) => entry.id === localId && entry.source === "user");
      const target = entries.find((entry) => entry.id === publicId && entry.source === "assets");
      if (!local || !target) throw new RangeError("An association requires a local survey and an Assets survey");
      if (unlink ? local.linkedTo !== publicId : Boolean(local.linkedTo)) throw new RangeError("Survey association has changed; refresh and retry");
      const releaseIds = new Set(this.project(target, entries).releases.map((release) => release.id));
      if (!unlink && [...local.survey.releases, ...local.localReleases].some((release) => releaseIds.has(release.id))) throw new RangeError("Release identities conflict; resolve them before associating surveys");
      await tx.putSurveyIdentity({ ...local, linkedTo: unlink ? undefined : publicId, history: [...local.history, { action: unlink ? "unlink" : "link", targetId: publicId, at: new Date().toISOString() }] });
    });
  }

  private project(entry: SurveyIdentityRecord, entries: SurveyIdentityRecord[]): SurveyRecord {
    const members = [entry, ...entries.filter((candidate) => candidate.linkedTo === entry.id)];
    return { ...entry.survey, id: entry.id, modalities: [...new Set(members.flatMap((member) => [...member.survey.modalities, ...member.localReleases.flatMap((release) => release.modalities)]))], releases: members.flatMap((member) => [...member.survey.releases, ...member.localReleases]) };
  }
}
