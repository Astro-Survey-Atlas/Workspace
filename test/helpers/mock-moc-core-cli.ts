import { mkdir, readFile, writeFile } from "node:fs/promises";

import { parse } from "csv-parse/sync";
import { Healpix, Hploc } from "healpixjs";

interface BuildSpec {
  mode: string;
  input: string;
  recipe: { raColumn: string; decColumn: string };
  maxOrder: number;
  queryOrder: number;
  previewOrder: number;
  layerId?: string;
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
    const location = new Hploc();
    location.setZ(Math.cos((90 - dec) * (Math.PI / 180)));
    location.phi = ((ra % 360) + 360) % 360 * (Math.PI / 180);
    return [healpix.loc2pix(location)];
  }))].sort((left, right) => left - right);
}

function optionValues(name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name && process.argv[index + 1]) values.push(process.argv[index + 1]!);
  }
  return values;
}

function card(key: string, value: string | number): Buffer {
  const rendered = typeof value === "number" ? String(value).padStart(20, " ") : `'${value}'`.padEnd(20, " ");
  return Buffer.from(`${key.padEnd(8, " ")}= ${rendered}`.padEnd(80, " "), "ascii");
}

function header(cards: Buffer[]): Buffer {
  const bytes = Buffer.concat([...cards, Buffer.from("END".padEnd(80, " "), "ascii")]);
  return Buffer.concat([bytes, Buffer.alloc(Math.ceil(bytes.length / 2880) * 2880 - bytes.length, 32)]);
}

function fitsMoc(values: bigint[]): Buffer {
  const primary = header([card("SIMPLE", "T"), card("BITPIX", 8), card("NAXIS", 0), card("EXTEND", "T")]);
  const extension = header([
    card("XTENSION", "BINTABLE"), card("BITPIX", 8), card("NAXIS", 2), card("NAXIS1", 8), card("NAXIS2", values.length),
    card("PCOUNT", 0), card("GCOUNT", 1), card("TFIELDS", 1), card("TTYPE1", "UNIQ"), card("TFORM1", "1K"),
    card("ORDERING", "NUNIQ"), card("COORDSYS", "C"), card("MOCVERS", "2.0"), card("MOCDIM", "SPACE"), card("THEAP", 0),
  ]);
  const rows = Buffer.alloc(values.length * 8);
  values.forEach((value, index) => rows.writeBigInt64BE(value, index * 8));
  const padding = (2880 - rows.length % 2880) % 2880;
  return Buffer.concat([primary, extension, rows, Buffer.alloc(padding)]);
}

async function readMoc(filename: string): Promise<bigint[]> {
  const bytes = await readFile(filename);
  let count: number | undefined;
  for (let offset = 2880; offset < 5760; offset += 80) {
    const line = bytes.toString("ascii", offset, offset + 80);
    if (line.slice(0, 8).trim() === "NAXIS2") count = Number(line.slice(10).trim());
    if (line.startsWith("END")) break;
  }
  if (!Number.isSafeInteger(count) || count! < 0 || 5760 + count! * 8 > bytes.length) throw new Error("mock MOC FITS is invalid");
  return Array.from({ length: count! }, (_, index) => bytes.readBigInt64BE(5760 + index * 8));
}

function decodeUniq(uniq: bigint): { order: number; pixel: number } {
  let order = 0;
  while (uniq >= 4n * 4n ** BigInt(order + 1)) order += 1;
  return { order, pixel: Number(uniq - 4n * 4n ** BigInt(order)) };
}

function project(values: bigint[], targetOrder: number): number[] {
  const result = new Set<number>();
  for (const uniq of values) {
    const { order, pixel } = decodeUniq(uniq);
    if (order >= targetOrder) result.add(Math.floor(pixel / 4 ** (order - targetOrder)));
    else {
      const start = pixel * 4 ** (targetOrder - order);
      const end = (pixel + 1) * 4 ** (targetOrder - order);
      for (let child = start; child < end; child += 1) result.add(child);
    }
  }
  return [...result].sort((left, right) => left - right);
}

const command = process.argv[2];
if (command === "build") {
  const spec = JSON.parse(await readFile(argument("--spec"), "utf8")) as BuildSpec;
  const output = argument("--output");
  const input = await readFile(spec.input, "utf8");
  // This fixture projects image centers only; scientific extent checks run
  // separately against the pinned Python MOC Core.
  const rows = spec.mode === "fits-wcs"
    ? (JSON.parse(input).headers as Array<Record<string, unknown>>).map(header => ({ ra: String(header.CRVAL1), dec: String(header.CRVAL2) }))
    : parse(input, { columns: true, skip_empty_lines: true, trim: true }) as Array<Record<string, string>>;
  if (spec.mode === "fits-wcs") spec.recipe = { raColumn: "ra", decColumn: "dec" };
  const queryPixels = pixels(rows, spec);
  const previewPixels = [...new Set(queryPixels.map((pixel) => Math.floor(pixel / 2 ** (2 * (spec.queryOrder - spec.previewOrder)))))].sort((left, right) => left - right);
  const factor = 4 ** (spec.maxOrder - spec.queryOrder);
  const cells = queryPixels.flatMap(pixel => Array.from({ length: factor }, (_, index) => BigInt(4) * 4n ** BigInt(spec.maxOrder) + BigInt(pixel * factor + index)));
  await mkdir(output, { recursive: true });
  await writeFile(pathFor(output, "query-order8.json"), JSON.stringify({ order: spec.queryOrder, ordering: "NESTED", pixels: queryPixels }));
  await writeFile(pathFor(output, "preview-order4.json"), JSON.stringify({ order: spec.previewOrder, ordering: "NESTED", pixels: previewPixels }));
  await writeFile(pathFor(output, "moc.fits"), fitsMoc(cells));
  process.stdout.write(`${JSON.stringify({ layerId: spec.layerId ?? "mock", maxOrder: spec.maxOrder })}\n`);
} else if (command === "merge") {
  const merged = new Set<bigint>();
  for (const input of optionValues("--input")) for (const value of await readMoc(input)) merged.add(value);
  await writeFile(argument("--output"), fitsMoc([...merged].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)));
  process.stdout.write(`${JSON.stringify({ maxOrder: Number(argument("--max-order")) })}\n`);
} else if (command === "project") {
  const order = Number(argument("--order"));
  const values = await readMoc(argument("--moc"));
  await writeFile(argument("--output"), JSON.stringify({ order, ordering: "NESTED", pixels: project(values, order) }));
} else {
  throw new Error(`unsupported mock MOC command: ${command ?? "missing"}`);
}

function pathFor(root: string, name: string): string {
  return `${root.replace(/[\\/]$/, "")}/${name}`;
}
