import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ScanRunCatalog, type ContentFingerprint, type ScanRun, type ScanRunOutput } from "../src/provenance.js";

const sha = (character: string): string => character.repeat(64);
const urn = (digest: string): string => `urn:sha256:${digest}`;

function input(role: string, fileName: string, digest: string): ContentFingerprint {
  return { role, uri: urn(digest), fileName, mediaType: "application/octet-stream", byteLength: 10, modifiedAt: "2026-07-23T00:00:00Z", sha256: digest };
}

function output(role: string, artifactId: string, fileName: string, digest: string): ScanRunOutput {
  return { role, artifactId, fileName, mediaType: "application/octet-stream", byteLength: 5, sha256: digest };
}

function run(id: string, kind: ScanRun["kind"], inputs: ContentFingerprint[], outputs: ScanRunOutput[]): ScanRun {
  return {
    schemaVersion: 1,
    id,
    kind,
    status: "succeeded",
    startedAt: "2026-07-23T00:00:00Z",
    completedAt: "2026-07-23T00:01:00Z",
    producer: { name: "fixture", version: "1", gitCommit: null, codeSha256: sha("f") },
    configSha256: sha("e"),
    parameters: {},
    inputs,
    outputs,
    lineage: inputs.flatMap((source) => outputs.map((artifact) => ({ from: source.uri, to: urn(artifact.sha256), relation: "derived_from" as const }))),
  };
}

test("loads scan runs and follows content hashes across derived artifacts", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "astro-provenance-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const volumeInput = input("fits", "source.fits", sha("a"));
  const volumeManifest = output("manifest", "volume-v1", "manifest.json", sha("b"));
  const volumePoints = output("points", "volume-v1", "points.bin", sha("c"));
  const volumeRun = run("volume-scan-1", "redshift-volume", [volumeInput], [volumeManifest, volumePoints]);
  const atlasOtherInput = input("csv", "survey.csv", sha("d"));
  const atlasOutput = output("joint", "atlas-v1", "joint.bin", sha("1"));
  const atlasRun = run("atlas-scan-1", "survey-atlas", [input("volume", "manifest.json", volumeManifest.sha256), atlasOtherInput], [atlasOutput]);
  for (const [directory, record] of [["volume-v1", volumeRun], ["atlas-v1", atlasRun]] as const) {
    await mkdir(path.join(root, directory));
    await writeFile(path.join(root, directory, "scan-run.json"), JSON.stringify(record));
  }

  const catalog = new ScanRunCatalog(root);
  assert.equal((await catalog.list()).length, 2);
  assert.equal((await catalog.get("atlas-scan-1")).kind, "survey-atlas");
  const graph = await catalog.lineage("atlas-v1");
  assert.deepEqual(new Set(graph.scanRuns.map((item) => item.id)), new Set(["atlas-scan-1", "volume-scan-1"]));
  assert.ok(graph.nodes.some((node) => node.sha256 === volumeInput.sha256 && node.kind === "source"));
  assert.ok(graph.nodes.some((node) => node.sha256 === atlasOutput.sha256 && node.artifactId === "atlas-v1"));
  assert.equal(graph.edges.length, 4);
});
