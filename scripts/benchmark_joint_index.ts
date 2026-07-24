import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import { Healpix, Pointing } from "healpixjs";

import { AtlasCatalog } from "../src/atlas.js";
import { decodeVolumePoints } from "../src/volume-format.js";

interface Scenario {
  name: string;
  nside: number;
  radialBins: number;
  radialMinMpc: number;
  radialMaxMpc: number;
  parentNside?: number;
  parentPixel?: number;
}

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing required option: ${name}`);
  return value;
}

function asArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

function pointing(raDeg: number, decDeg: number): Pointing {
  return new Pointing(null, false, ((90 - decDeg) * Math.PI) / 180, (raDeg * Math.PI) / 180);
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

async function main(): Promise<void> {
  const atlasRoot = option("--atlas-root");
  const atlasId = option("--atlas-id");
  const volumePointsPath = option("--volume-points");
  const output = option("--output");
  const catalog = new AtlasCatalog(atlasRoot);
  const manifest = await catalog.get(atlasId);
  const rawPoints = await readFile(volumePointsPath);
  const points = decodeVolumePoints(asArrayBuffer(rawPoints));
  const domainMaxMpc = manifest.jointIndex.radialCoordinate.domainMaxMpc;

  const overview = await catalog.queryJoint(atlasId, { surveyId: "desi", nside: 32, radialBins: 8 });
  const seed = [...overview.cells].sort((left, right) => right.count - left.count)[0]!;
  const scenarios: Scenario[] = [
    { name: "overview", nside: 8, radialBins: 4, radialMinMpc: 0, radialMaxMpc: domainMaxMpc },
    {
      name: "angular-drill",
      nside: 64,
      radialBins: 8,
      radialMinMpc: seed.radialMinMpc,
      radialMaxMpc: seed.radialMaxMpc,
      parentNside: 32,
      parentPixel: seed.pixel,
    },
    {
      name: "joint-drill",
      nside: 128,
      radialBins: 16,
      radialMinMpc: seed.radialMinMpc,
      radialMaxMpc: seed.radialMaxMpc,
      parentNside: 32,
      parentPixel: seed.pixel,
    },
  ];

  const results = [];
  for (const scenario of scenarios) {
    const hp = new Healpix(scenario.parentNside ?? scenario.nside);
    const pointScan = (): number => {
      let count = 0;
      for (let index = 0; index < points.count; index += 1) {
        const distance = points.comovingDistanceMpc[index]!;
        if (distance < scenario.radialMinMpc || distance >= scenario.radialMaxMpc) continue;
        if (scenario.parentPixel != null) {
          const pixel = hp.ang2pix(pointing(points.raDeg[index]!, points.decDeg[index]!));
          if (pixel !== scenario.parentPixel) continue;
        }
        count += 1;
      }
      return count;
    };

    const baselineTimes: number[] = [];
    let baselineCount = 0;
    for (let repeat = 0; repeat < 12; repeat += 1) {
      const started = performance.now();
      baselineCount = pointScan();
      baselineTimes.push(performance.now() - started);
    }
    const indexedTimes: number[] = [];
    let indexed = await catalog.queryJoint(atlasId, { surveyId: "desi", ...scenario });
    for (let repeat = 0; repeat < 60; repeat += 1) {
      const started = performance.now();
      indexed = await catalog.queryJoint(atlasId, { surveyId: "desi", ...scenario });
      indexedTimes.push(performance.now() - started);
    }
    if (indexed.representedObjects !== baselineCount) {
      throw new Error(`${scenario.name} count mismatch: point scan ${baselineCount}, joint index ${indexed.representedObjects}`);
    }
    results.push({
      scenario,
      exactCount: baselineCount,
      countConserved: true,
      pointScan: {
        recordsExamined: points.count,
        medianMs: median(baselineTimes),
        estimatedPayloadBytes: baselineCount * 28,
      },
      sparseJointIndex: {
        cellsExamined: indexed.metrics.examinedCellCount,
        cellsReturned: indexed.metrics.returnedCellCount,
        medianMs: median(indexedTimes),
        encodedCellBytes: indexed.metrics.returnedCellCount * 20,
      },
      reduction: {
        examinedUnitRatio: indexed.metrics.examinedCellCount / points.count,
        encodedPayloadRatio: (indexed.metrics.returnedCellCount * 20) / Math.max(1, baselineCount * 28),
      },
    });
  }

  const report = {
    schemaVersion: 1,
    experiment: "sparse-healpix-radial-drilldown",
    generatedAt: new Date().toISOString(),
    environment: { hostname: os.hostname(), platform: os.platform(), arch: os.arch(), node: process.version },
    dataset: { atlasId, pointCount: points.count, angularLevels: manifest.jointIndex.angularLevels, radialLevels: manifest.jointIndex.radialLevels },
    methodology: {
      pointScanRepeats: 12,
      jointIndexRepeats: 60,
      payloadAssumptions: "28 bytes per point from astro-volume-v1; 20 bytes per sparse joint cell from astro-atlas-joint-v1",
      limitation: "Catalog occupancy only; no survey completeness or selection function is inferred.",
    },
    seedCell: { nside: 32, radialBins: 8, pixel: seed.pixel, radialBin: seed.radialBin, count: seed.count },
    results,
  };
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ output, scenarios: results.map((result) => ({ name: result.scenario.name, ...result.reduction })) }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
