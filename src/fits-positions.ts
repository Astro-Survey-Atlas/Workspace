import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Healpix, Hploc } from "healpixjs";
import { ASTRO_IMAGE_FOOTPRINT_INDEX, ASTRO_OBJECT_INDEX, type AstroImageFootprintDocument, type AstroObjectRecord } from "./astro-object-index.js";
import type { ConnectorIngestRunRecord } from "./connector-history.js";
import type { LocalObjectIndexDocument } from "./local-scan.js";
import { injectActiveTrace, withSpan } from "./telemetry.js";
export interface HeaderPoint extends Record<string, unknown> {
  file_id: string; source_uri: string; file_name: string; hdu_index: number; ra_deg: number; dec_deg: number;
  position_role?: string; footprint_bounds?: number[][];
  moc_header?: Record<string, unknown>;
  header_scope?: string; selected_hdu_index?: number;
}

async function runCoordinateScript<T>(mode: "headers" | "contains", input: string, parse: (output: string) => T): Promise<T> {
  return withSpan("subprocess sky-point-coordinates", { "asa.component": "scan" }, async (span) => new Promise<T>((resolve, reject) => {
    const script = fileURLToPath(new URL("./sky-point-coordinates.py", import.meta.url));
    const carrier: Record<string, string> = {};
    injectActiveTrace(carrier);
    const environment = { ...process.env };
    delete environment.TRACEPARENT;
    delete environment.TRACESTATE;
    if (carrier.traceparent) environment.TRACEPARENT = carrier.traceparent;
    if (carrier.tracestate) environment.TRACESTATE = carrier.tracestate;
    const child = spawn(process.env.ASTRO_PYTHON ?? "python3", [script, ...(mode === "contains" ? ["--contains"] : [])], {
      stdio: ["pipe", "pipe", "pipe"],
      env: environment,
    });
    let output = "";
    let errors = "";
    let timedOut = false;
    let outputExceeded = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 120_000);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > 64 * 1024 * 1024) { outputExceeded = true; child.kill(); }
    });
    child.stderr.on("data", (chunk: Buffer) => { if (errors.length < 4_000) errors += chunk.toString(); });
    child.once("error", (error) => {
      clearTimeout(timer);
      span.setAttribute("process.exit.code", -1);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      span.setAttribute("process.exit.code", code ?? -1);
      if (timedOut) { reject(new Error(mode === "contains" ? "WCS containment check timed out" : "Header coordinate conversion timed out")); return; }
      if (outputExceeded) { reject(new Error("Coordinate subprocess output exceeded 64 MiB")); return; }
      if (code !== 0) {
        const label = mode === "contains" ? "WCS containment check" : "Header coordinate conversion";
        reject(new Error(`${label} failed (${code}): ${errors.slice(0, 2_000)}`));
        return;
      }
      try { resolve(parse(output)); } catch (error) { reject(error); }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  }));
}

export async function convertPositionHeaders(records: unknown[]): Promise<Record<string, unknown>[]> {
  if (!records.length) return [];
  const input = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
  return runCoordinateScript("headers", input, (output) => output.trim()
    ? output.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)
    : []);
}
export function pointDocument(point: HeaderPoint, asset: { id: string; surveyId?: string; releaseId?: string; product?: string }, run: ConnectorIngestRunRecord, sourceId?: string): LocalObjectIndexDocument {
  if (!Number.isFinite(point.ra_deg) || !Number.isFinite(point.dec_deg) || Math.abs(point.dec_deg) > 90 || point.ra_deg < 0 || point.ra_deg >= 360
    || !point.file_id || !Number.isInteger(point.hdu_index)) throw new Error("Invalid ICRS header coordinate");
  const id = createHash("sha256").update(`${asset.id}\n${point.file_id}\n${point.hdu_index}\n${point.position_role}${run.id ? `\n${run.id}` : ""}`).digest("hex");
  const loc = new Hploc(); loc.setZ(Math.cos((90 - point.dec_deg) * Math.PI / 180)); loc.phi = point.ra_deg * Math.PI / 180;
  return { _index: ASTRO_OBJECT_INDEX, _id: id, object_id: id, ra_deg: point.ra_deg, dec_deg: point.dec_deg,
    sky_position: { lat: point.dec_deg, lon: point.ra_deg > 180 ? point.ra_deg - 360 : point.ra_deg },
    healpix_order: 8, healpix_pixel: new Healpix(256).loc2pix(loc), survey: asset.surveyId ?? "user", release: asset.releaseId ?? "user",
    product: asset.product ?? "image", modality: point.position_role === "image_center" ? "image" : "pointing", asset_id: asset.id,
    source_file_id: point.file_id, scan_run_id: run.id, ...(run.id ? { data_batch_id: run.id } : {}), attributes: Object.fromEntries(Object.entries({ source_uri: point.source_uri, file_name: point.file_name,
      hdu_index: point.hdu_index, position_role: point.position_role, position_method: point.position_method, coordinate_frame: "ICRS",
      header_scope: point.header_scope, selected_hdu_index: point.selected_hdu_index,
      header: point.header, primary_header: point.primary_header, source_snapshot_sha256: run.sourceSnapshotSha256, source_id: sourceId }).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)])) };
}

export function imageFootprintDocuments(point: HeaderPoint, assetId: string, sourceId?: string, dataBatchId?: string): AstroImageFootprintDocument[] {
  if (point.position_role !== "image_center" || !Array.isArray(point.footprint_bounds)) return [];
  const pointId = createHash("sha256").update(`${assetId}\n${point.file_id}\n${point.hdu_index}\n${point.position_role}${dataBatchId ? `\n${dataBatchId}` : ""}`).digest("hex");
  return point.footprint_bounds.map((bounds, index) => {
    if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite)) throw new Error("Invalid WCS footprint bounds");
    const [raMin, raMax, decMin, decMax] = bounds;
    if (raMin! < 0 || raMax! > 360 || raMin! > raMax! || decMin! < -90 || decMax! > 90 || decMin! > decMax!) {
      throw new Error("Invalid WCS footprint bounds");
    }
    const id = createHash("sha256").update(`${pointId}\n${index}`).digest("hex");
    return { _id: id, _index: ASTRO_IMAGE_FOOTPRINT_INDEX, point_id: pointId, asset_id: assetId, ...(dataBatchId ? { data_batch_id: dataBatchId } : {}),
      ...(sourceId ? { source_id: sourceId } : {}), ra_min: raMin!, ra_max: raMax!, dec_min: decMin!, dec_max: decMax! };
  });
}

export async function imagePointsContainingCoordinate(
  points: readonly AstroObjectRecord[],
  raDeg: number,
  decDeg: number,
): Promise<AstroObjectRecord[]> {
  if (!Number.isFinite(raDeg) || raDeg < 0 || raDeg >= 360 || !Number.isFinite(decDeg) || decDeg < -90 || decDeg > 90) {
    throw new RangeError("query coordinates must be finite ICRS degrees");
  }
  const candidates = points.filter((point) => point.attributes?.position_role === "image_center"
    && typeof point.attributes.header === "string" && Number.isInteger(Number(point.attributes.hdu_index)));
  if (!candidates.length) return [];
  const input = candidates.map((point) => JSON.stringify({
      id: point.object_id,
      hdu_index: Number(point.attributes.hdu_index),
      header: point.attributes.header,
      ...(point.attributes.primary_header ? { primary_header: point.attributes.primary_header } : {}),
      query_ra: raDeg,
      query_dec: decDeg,
  })).join("\n") + "\n";
  const results = await runCoordinateScript("contains", input, (output) => output.trim()
    ? output.trim().split("\n").map((line) => JSON.parse(line) as { id: string; contains: boolean })
    : []);
  const contains = new Set(results.filter((result) => result.contains).map((result) => result.id));
  return candidates.filter((point) => contains.has(point.object_id));
}

