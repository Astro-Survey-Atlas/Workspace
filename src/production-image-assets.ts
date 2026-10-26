import type { ConnectorRecord } from "./connectors.js";
import type { DataAssetRecord, DataAssetRegistrationInput, DataCatalogRegistry } from "./data-catalog.js";
import { parsePublicSourceId } from "./public-source-identity.js";
import { computeInventoryDigest, type SourceFileInventory, type SourceInventoryFile } from "./source-crawler.js";

export interface ProductionImageSource {
  sourceId: string;
  files: SourceInventoryFile[];
  sourcePath: string;
  surveyId: string;
  releaseId: string;
  product: string;
  modality: string;
}

export function productionImageSources(inventory: SourceFileInventory, verifiedRelativePaths: readonly string[]): ProductionImageSource[] {
  const verified = new Set(verifiedRelativePaths);
  const grouped = new Map<string, SourceInventoryFile[]>();
  for (const file of inventory.files) {
    if (!verified.has(file.relativePath) || !/\.fits?(?:\.gz)?$/i.test(file.relativePath)) continue;
    const files = grouped.get(file.sourceId) ?? [];
    files.push(file);
    grouped.set(file.sourceId, files);
  }

  const sources: ProductionImageSource[] = [];
  for (const [sourceId, files] of grouped) {
    const identity = parsePublicSourceId(sourceId);
    const modality = files.map((file) => file.modality).find((value) => value?.trim()) ?? identity?.product ?? "";
    if (!identity || !/(?:^|[^a-z])imag(?:e|es|ing)(?:$|[^a-z])/i.test(modality)) continue;
    if (identity.surveyId.length > 120 || identity.releaseId.length > 120 || identity.product.length > 160) continue;
    const roots = files.map((file) => {
      const segments = file.relativePath.split("/");
      if (segments.length < 3 || segments[0] !== "sources" || segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\\"))) return undefined;
      return segments.slice(0, 2).join("/");
    });
    if (roots.some((root) => !root) || new Set(roots).size !== 1) continue;
    sources.push({ sourceId, files, sourcePath: roots[0]!, surveyId: identity.surveyId, releaseId: identity.releaseId, product: identity.product, modality });
  }
  return sources.sort((left, right) => left.sourceId.localeCompare(right.sourceId));
}

export async function registerProductionImageAssets(
  connector: ConnectorRecord,
  inventory: SourceFileInventory,
  verifiedRelativePaths: readonly string[],
  dataCatalog: DataCatalogRegistry,
): Promise<Array<{ source: ProductionImageSource; asset: DataAssetRecord }>> {
  const existingAssets = await dataCatalog.list();
  const registered: Array<{ source: ProductionImageSource; asset: DataAssetRecord }> = [];
  for (const source of productionImageSources(inventory, verifiedRelativePaths)) {
    const asset = existingAssets.find((candidate) => candidate.origin === "user"
      && candidate.kind === "image"
      && candidate.surveyId === source.surveyId
      && candidate.releaseId === source.releaseId
      && candidate.product === source.product
      && candidate.sourceRelativePath === source.sourcePath
      && ((candidate.connectorIds ?? []).includes(connector.id) || (candidate.connectorLocationKeys ?? []).includes(connector.locationKey)));
    const access = { connector: connector.kind, uri: connector.displayPath, format: "directory", connectorId: connector.id, label: "Verified Workspace download" };
    const input: DataAssetRegistrationInput = {
      name: `${source.surveyId} ${source.product} (${source.releaseId})`.slice(0, 120),
      description: `Workspace automatically registered verified FITS image files from ${source.sourceId}.`,
      surveyId: source.surveyId,
      releaseId: source.releaseId,
      product: source.product,
      kind: "image",
      modalities: [source.modality],
      tags: ["downloaded", "FITS image"],
      connector: connector.kind,
      sourceUri: connector.displayPath,
      format: "directory",
      accesses: [access],
      connectorIds: [connector.id],
      connectorLocationKeys: [connector.locationKey],
      sourceRelativePath: source.sourcePath,
      status: "ready",
      projectState: "acquired",
      scanSpec: { format: "fits", modality: source.modality, product: source.product },
    };
    const saved = asset
      ? asset.scanSpec?.format === "fits" ? asset : await dataCatalog.update(asset.id, {
          ...input,
          name: asset.name,
          description: asset.description,
          modalities: asset.modalities,
          tags: asset.tags,
          status: asset.status,
          projectState: asset.projectState,
          projectStates: asset.projectStates,
          lineage: asset.lineage,
        })
      : await dataCatalog.register(input);
    if (!existingAssets.some((candidate) => candidate.id === saved.id)) existingAssets.push(saved);
    registered.push({ source, asset: saved });
  }
  return registered;
}

export function verifyProductionImageInventory(inventory: SourceFileInventory, expectedSha256: string): void {
  if (inventory.schemaVersion !== 1 || !Array.isArray(inventory.files) || !Array.isArray(inventory.units)) {
    throw new RangeError("Production inventory is invalid");
  }
  const digest = computeInventoryDigest(inventory.files, inventory.units);
  if (inventory.inventorySha256 !== expectedSha256 || digest !== expectedSha256) throw new RangeError("Production inventory digest changed before scan handoff");
}
