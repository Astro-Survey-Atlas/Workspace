export function workspaceLayerIdForAsset(assetId: string): string {
  return `workspace-${assetId}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 180) || "workspace-asset";
}

