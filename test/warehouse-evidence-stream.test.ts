import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { streamWarehouseEvidence } from "../src/warehouse-evidence-stream.js";

test("streams file and coverage rows independently and validates late malformed input", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "warehouse-stream-"));
  try {
    const file = path.join(root, "scan.json");
    await writeFile(file, JSON.stringify({ phase: "COMPLETED", files: [{ file_id: "a" }, { file_id: "b" }], coverage: [{ healpix_order: 10, healpix_cell: 123 }], sourceSnapshot: { sha256: "a".repeat(64) } }));
    const rows: string[] = [];
    const result = await streamWarehouseEvidence(file, (kind, row) => rows.push(`${kind}:${JSON.stringify(row)}`));
    assert.equal(result.phase, "COMPLETED");
    assert.deepEqual(rows, ['files:{"file_id":"a"}', 'files:{"file_id":"b"}', 'coverage:{"healpix_order":10,"healpix_cell":123}']);
    assert.equal(result.files, undefined);
    assert.equal(result.coverage, undefined);
    await writeFile(file, (await readFile(file, "utf8")).slice(0, -1));
    await assert.rejects(streamWarehouseEvidence(file, () => {}));
    await writeFile(file, '{"phase":"COMPLETED","coverage":{}}');
    await assert.rejects(streamWarehouseEvidence(file, () => {}), /coverage must be an array/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("large evidence preserves escaped and UTF-8 rows across read boundaries without retaining arrays", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "warehouse-stream-boundaries-"));
  try {
    const file = path.join(root, "scan.json");
    const name = '巡天"\\' + "source/".repeat(100);
    const rows = Array.from({ length: 4000 }, (_, i) => ({ file_id: String(i), source_uri: name + i }));
    await writeFile(file, JSON.stringify({ phase: "COMPLETED", files: rows, coverage: [], sourceSnapshot: { sha256: "a".repeat(64) } }));
    let count = 0;
    const metadata = await streamWarehouseEvidence(file, (kind, row) => {
      assert.equal(kind, "files"); assert.equal(row.file_id, String(count)); assert.equal(row.source_uri, name + count); count++;
    });
    assert.equal(count, 4000); assert.equal(metadata.files, undefined); assert.equal(metadata.coverage, undefined);
    assert.deepEqual(metadata.sourceSnapshot, { sha256: "a".repeat(64) });
  } finally { await rm(root, { recursive: true, force: true }); }
});
