import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";
import { Router, type Response } from "express";
import yazl from "yazl";

import { responseCancellation } from "./http-request-cancellation.js";
import type { WorkflowStore } from "./workflow-store.js";
import type { WorkflowArtifact } from "./workflow.js";

export interface WorkflowCutoutDownload extends WorkflowArtifact {
  downloadUrl: string;
  objectId?: string;
  rowIndex?: number;
  telescope?: string;
  band?: string;
}

export interface WorkflowCutoutDownloads {
  runId: string;
  files: WorkflowCutoutDownload[];
  failures: Array<{ objectId: string; telescope: string; band: string; error: string }>;
  totalBytes: number;
  archiveUrl?: string;
}

function artifactUrl(runId: string, name: string): string {
  return `/api/workflow-runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(name)}`;
}

async function cutoutDownloads(store: WorkflowStore, runId: string): Promise<WorkflowCutoutDownloads> {
  const run = await store.get(runId);
  const files: WorkflowCutoutDownload[] = run.artifacts.filter(artifact => artifact.mediaType === "application/fits")
    .map(artifact => ({ ...artifact, downloadUrl: artifactUrl(run.id, artifact.name) }));
  const byUrl = new Map(files.map(file => [file.downloadUrl, file]));
  const failures: WorkflowCutoutDownloads["failures"] = [];
  if (run.artifacts.some(artifact => artifact.name === "cutouts.json")) {
    const index = JSON.parse(await store.readArtifact(run.id, "cutouts.json")) as { records?: unknown };
    if (!Array.isArray(index.records)) throw new Error("Workflow cutout index has no records");
    for (const value of index.records) {
      if (!value || typeof value !== "object") continue;
      const record = value as Record<string, unknown>;
      const file = typeof record.outputUri === "string" ? byUrl.get(record.outputUri) : undefined;
      if (file) {
        for (const key of ["objectId", "telescope", "band"] as const) if (typeof record[key] === "string") file[key] = record[key];
        if (Number.isSafeInteger(record.rowIndex)) file.rowIndex = Number(record.rowIndex);
      } else {
        failures.push({ objectId: String(record.objectId ?? ""), telescope: String(record.telescope ?? ""),
          band: String(record.band ?? ""), error: String(record.error ?? "FITS 文件尚未登记") });
      }
    }
  }
  files.sort((a, b) => (a.rowIndex ?? Infinity) - (b.rowIndex ?? Infinity) || a.name.localeCompare(b.name));
  return { runId: run.id, files, failures, totalBytes: files.reduce((sum, file) => sum + file.byteLength, 0),
    ...(files.length ? { archiveUrl: `/api/workflow-runs/${encodeURIComponent(run.id)}/cutouts.zip` } : {}) };
}

export function createWorkflowDownloadsRouter(store: WorkflowStore, sendError: (response: Response, error: unknown) => void): Router {
  const router = Router();
  router.get("/:id/cutouts", async (request, response) => {
    try {
      response.set("Cache-Control", "private, no-store");
      response.json(await cutoutDownloads(store, String(request.params.id)));
    } catch (error) { sendError(response, error); }
  });
  router.get("/:id/cutouts.zip", async (request, response) => {
    const signal = responseCancellation(response);
    try {
      const run = await store.get(String(request.params.id));
      if (!run.artifacts.some(artifact => artifact.mediaType === "application/fits")) throw new RangeError("此任务尚无可下载的 FITS cutout");
      const selected = run.artifacts.filter(artifact => artifact.mediaType === "application/fits"
        || ["filtered.csv", "cutouts.json", "result.json"].includes(artifact.name));
      // Check every selected file before sending headers, without reloading the run for each file.
      const files = await store.artifactPaths(run.id, selected.map(artifact => artifact.name));
      signal.throwIfAborted();
      const zip = new yazl.ZipFile();
      const output = zip.outputStream as Readable;
      const cancel = () => output.destroy();
      signal.addEventListener("abort", cancel, { once: true });
      output.once("close", () => signal.removeEventListener("abort", cancel));
      zip.on("error", error => { output.destroy(); if (!response.destroyed) response.destroy(error); });
      output.on("error", error => { if (!response.destroyed) response.destroy(error); });
      for (const { artifact, filePath } of files) zip.addReadStreamLazy(artifact.name, {
        size: artifact.byteLength, mtime: new Date(artifact.createdAt), compressionLevel: 1,
      }, callback => {
        callback(null, createReadStream(filePath, { signal }));
      });
      zip.addBuffer(Buffer.from(JSON.stringify({ runId: run.id, files: selected.map(({ name, byteLength, sha256 }) => ({ name, byteLength, sha256 })) }, null, 2)), "manifest.json");
      response.set({ "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${run.id}-cutouts.zip"`,
        "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
      output.pipe(response);
      zip.end();
    } catch (error) { sendError(response, error); }
  });
  return router;
}
