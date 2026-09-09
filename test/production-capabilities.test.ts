import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { listProductionCapabilities } from "../src/production-capabilities.js";

const execFileAsync = promisify(execFile);

function find(list: ReturnType<typeof listProductionCapabilities>, key: string) {
  const descriptor = list.find((capability) => capability.key === key);
  assert.ok(descriptor, `missing capability ${key}`);
  return descriptor;
}

test("capability registry reflects pipelines, resolvers, transfer, and handoffs", () => {
  const disabled = listProductionCapabilities({ warehouseEnabled: false });
  const enabled = listProductionCapabilities({ warehouseEnabled: true });

  assert.equal(disabled.filter((capability) => capability.kind === "pipeline").length, 3);
  assert.equal(find(disabled, "overlap-download").kind, "pipeline");
  assert.equal(find(disabled, "overlap-download").availability, "available");
  assert.equal(find(disabled, "training-data-preparation").availability, "planned");

  assert.equal(find(disabled, "direct-file").kind, "resolver");
  assert.equal(find(disabled, "http-directory").kind, "resolver");
  assert.equal(find(disabled, "desi-tile").kind, "resolver");
  assert.equal(find(disabled, "builtin-http-download").kind, "transfer");
  assert.equal(find(disabled, "workspace-local-connector").kind, "handoff");

  assert.equal(find(disabled, "warehouse-scan").availability, "unavailable");
  assert.equal(find(enabled, "warehouse-scan").availability, "available");

  assert.ok(disabled.every((capability) => capability.responsibility.length > 0 && capability.sourcePath.length > 0));
  if (!process.env.ASTRO_BUILD_COMMIT) {
    assert.ok(disabled.every((capability) => capability.sourceUrl === null));
  }
});

test("capability permalinks bind to the build commit baked into the process", async () => {
  const commit = "abcdef0123456789abcdef0123456789abcdef01";
  const probe = path.resolve("test/helpers/capabilities-probe.ts");
  const tsx = path.resolve("node_modules/.bin/tsx");

  const withCommit = await execFileAsync(tsx, [probe], { env: { ...process.env, ASTRO_BUILD_COMMIT: commit } });
  const parsed = JSON.parse(withCommit.stdout) as {
    provenance: { commit: string | null; permalinkBase: string | null };
    firstCapability: { key: string; sourcePath: string; sourceUrl: string | null };
  };
  assert.equal(parsed.provenance.commit, commit);
  assert.match(parsed.provenance.permalinkBase ?? "", new RegExp(`/blob/${commit}$`));
  assert.equal(parsed.firstCapability.key, "overlap-download");
  assert.match(parsed.firstCapability.sourceUrl ?? "", new RegExp(`/blob/${commit}/src/production\\.ts$`));

  const withoutCommit = await execFileAsync(tsx, [probe], { env: { ...process.env, ASTRO_BUILD_COMMIT: "" } });
  const bare = JSON.parse(withoutCommit.stdout) as typeof parsed;
  assert.equal(bare.provenance.commit, null);
  assert.equal(bare.provenance.permalinkBase, null);
  assert.equal(bare.firstCapability.sourceUrl, null);
});
