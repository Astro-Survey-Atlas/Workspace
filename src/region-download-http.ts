import type { Request, Response } from "express";
import { RegionDownloadPlanError, type RegionDownloadPlanService, type RegionDownloadPreviewEvent } from "./region-download-plan.js";

export function createRegionDownloadPreviewHandler(
  service: Pick<RegionDownloadPlanService, "preview">,
  sendError: (response: Response, error: unknown) => void,
  options: { heartbeatMs?: number } = {},
): (request: Request, response: Response) => Promise<void> {
  return async (request, response) => {
    const controller = new AbortController();
    const streamed = String(request.headers.accept ?? "").includes("text/event-stream");
    const started = Date.now();
    let lookupMs: number | undefined, firstFilesMs: number | undefined;
    let fileCount = 0, unavailableCount = 0;
    let outcome = "failed";
    const disconnect = () => { if (!response.writableEnded) controller.abort(); };
    request.once("aborted", disconnect);
    response.once("close", disconnect);
    const emit = (event: string, value: unknown) => {
      if (controller.signal.aborted || response.destroyed || response.writableEnded) return;
      if (!response.headersSent) {
        response.set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
        response.flushHeaders();
      }
      response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
    };
    const onUpdate = (event: RegionDownloadPreviewEvent) => {
      if (event.event === "progress") {
        if (event.value.stage === "metadata") lookupMs ??= Date.now() - started;
        fileCount = event.value.files;
        unavailableCount = event.value.unavailable;
      } else if (event.value.files.length) firstFilesMs ??= Date.now() - started;
      if (streamed) emit(event.event, event.value);
    };
    const heartbeat = streamed ? setInterval(() => {
      if (response.headersSent && !response.writableEnded && !response.destroyed) response.write(": keep-alive\n\n");
    }, options.heartbeatMs ?? 10_000) : undefined;
    try {
      response.set("Cache-Control", "no-store");
      const preview = await service.preview(request.body, { signal: controller.signal, onUpdate });
      controller.signal.throwIfAborted();
      outcome = "completed";
      fileCount = preview.inventory.files.length;
      unavailableCount = preview.unavailable.length;
      if (streamed) { emit("complete", { preview }); response.end(); }
      else response.json({ preview });
    } catch (error) {
      if (controller.signal.aborted) outcome = "cancelled";
      else if (streamed && response.headersSent) {
        emit("error", { error: error instanceof Error ? error.message : String(error),
          ...(error instanceof RegionDownloadPlanError ? { statusCode: error.statusCode, retryAfterSeconds: error.retryAfterSeconds } : {}) });
        response.end();
      } else sendError(response, error);
    } finally {
      clearInterval(heartbeat);
      request.removeListener("aborted", disconnect);
      response.removeListener("close", disconnect);
      // Aggregate timing only: never log selectors, source URLs or responses.
      console.info("[download-preview]", JSON.stringify({ outcome, lookupMs, firstFilesMs, totalMs: Date.now() - started, files: fileCount, unavailable: unavailableCount }));
    }
  };
}
