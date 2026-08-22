import { mkdir, readFile, writeFile } from "node:fs/promises";

import { parse } from "csv-parse/sync";
import { Healpix, Pointing } from "healpixjs";

interface BuildSpec {
  input: string;
  recipe: { raColumn: string; decColumn: string };
  maxOrder: number;
  queryOrder: number;
  previewOrder: number;
}

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function pixels(rows: Array<Record<string, string>>, spec: BuildSpec): number[] {
  const healpix = new Healpix(2 ** spec.queryOrder);
  return [...new Set(rows.flatMap((row) => {
    const ra = Number(row[spec.recipe.raColumn]);
    const dec = Number(row[spec.recipe.decColumn]);
    if (!Number.isFinite(ra) || !Number.isFinite(dec) || ra < 0 || ra > 360 || dec < -90 || dec > 90) return [];
    return [healpix.ang2pix(new Pointing(null, false, ((90 - dec) * Math.PI) / 180, (ra === 360 ? 0 : ra) * Math.PI / 180))];
  }))].sort((left, right) => left - right);
}

const spec = JSON.parse(await readFile(argument("--spec"), "utf8")) as BuildSpec;
const output = argument("--output");
const rows = parse(await readFile(spec.input, "utf8"), { columns: true, skip_empty_lines: true, trim: true }) as Array<Record<string, string>>;
const queryPixels = pixels(rows, spec);
const previewPixels = [...new Set(queryPixels.map((pixel) => Math.floor(pixel / 2 ** (2 * (spec.queryOrder - spec.previewOrder)))))].sort((left, right) => left - right);
await mkdir(output, { recursive: true });
await writeFile(pathFor(output, "query-order8.json"), JSON.stringify({ order: spec.queryOrder, ordering: "NESTED", pixels: queryPixels }));
await writeFile(pathFor(output, "preview-order4.json"), JSON.stringify({ order: spec.previewOrder, ordering: "NESTED", pixels: previewPixels }));
process.stdout.write(`${JSON.stringify({ layerId: (spec as BuildSpec & { layerId?: string }).layerId ?? "mock", maxOrder: spec.maxOrder })}\n`);

function pathFor(root: string, name: string): string {
  return `${root.replace(/[\\/]$/, "")}/${name}`;
}
