import assert from "node:assert/strict";
import test from "node:test";

import { buildJobManifest, compileScanExecutionPlan, validateAstroDataSource, validateAstroMetadataScanTask, validateSourcePaths } from "../src/astro-metadata-scan.js";

const source = { apiVersion: "org.zhejianglab.astro.metadata/v1alpha1", kind: "AstroDataSource" as const, metadata: { name: "euclid-oss" }, spec: { type: "s3" as const, endpoint: "https://oss.example", bucket: "science", prefix: "euclid/q1" } };

test("new scan task keeps handler order and compiles a Job plan", () => {
  const task = validateAstroMetadataScanTask({
    metadata: { name: "euclid-scan" },
    spec: {
      source: { dataSourceRef: { name: "euclid-oss" }, paths: ["s3://science/euclid/q1/mer.fits"] },
      handlers: ["default", "fits", "coverage"],
      userProperties: { assetId: "euclid-q1-mer" },
      extraEnv: { allowedSuffixes: ".fits" },
    },
  });
  const plan = compileScanExecutionPlan(task, source);
  assert.equal(plan.backend, "job");
  assert.deepEqual(plan.handlers, ["default", "fits", "coverage"]);
  assert.equal(plan.extraEnv.allowedSuffixes, ".fits");
});

test("data source validation rejects unmanaged paths and invalid endpoints", () => {
  assert.throws(() => validateAstroDataSource({ spec: { type: "s3", endpoint: "ftp://oss.example", bucket: "science" } }), /HTTP/);
  const task = validateAstroMetadataScanTask({ spec: { source: { dataSourceRef: { name: "euclid-oss" }, paths: ["s3://science/private/file.fits"] } } });
  assert.throws(() => validateSourcePaths(task, source), /outside DataSource/);
});

test("managed connector environment cannot be replaced through extraEnv", () => {
  assert.throws(() => validateAstroMetadataScanTask({ spec: { source: { paths: ["file:///data"] }, extraEnv: { ES_HOST: "attacker" } } }), /managed key/);
});

test("Job manifest carries only task environment and plan JSON", () => {
  const plan = compileScanExecutionPlan({ metadata: { name: "local-scan" }, spec: { source: { paths: ["file:///data"] }, extraEnv: { allowedSuffixes: ".fits" } } });
  const manifest = buildJobManifest(plan, { namespace: "warehouse", image: "astro/metadata-scan:latest" }) as { spec: { template: { spec: { containers: Array<{ env: Array<{ name: string; value: string }>; args: string[] }> } } } };
  const container = manifest.spec.template.spec.containers[0]!;
  assert.deepEqual(container.env, [{ name: "allowedSuffixes", value: ".fits" }]);
  assert.equal(container.args[0], "scan");
  assert.equal(container.args[1], "--plan-json");
});
