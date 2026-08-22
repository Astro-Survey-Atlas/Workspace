import { readFile } from "node:fs/promises";

import { parse } from "csv-parse/sync";
import { Healpix, Pointing } from "healpixjs";

import type { MocCoreAdapter, MocCoreCatalogInput, MocCoreCatalogResult } from "../../src/moc-core-adapter.js";

/** Test-only adapter. Production always invokes the pinned Assets Core CLI. */
export const mockMocCore: MocCoreAdapter = {
  async buildCatalog(input: MocCoreCatalogInput): Promise<MocCoreCatalogResult> {
    const rows = parse(await readFile(input.inputPath, "utf8"), { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true, skip_records_with_error: true }) as Array<Record<string, string>>;
    const healpix = new Healpix(256);
    const queryPixels = [...new Set(rows.flatMap((row) => {
      const ra = Number(row[input.raColumn]);
      const dec = Number(row[input.decColumn]);
      if (!Number.isFinite(ra) || !Number.isFinite(dec) || ra < 0 || ra > 360 || dec < -90 || dec > 90) return [];
      return [healpix.ang2pix(new Pointing(null, false, ((90 - dec) * Math.PI) / 180, (ra === 360 ? 0 : ra) * Math.PI / 180))];
    }))].sort((left, right) => left - right);
    return { layerId: input.layerId, maxOrder: 10, queryOrder: 8, previewOrder: 4, queryPixels, previewPixels: [...new Set(queryPixels.map((pixel) => pixel >> 8))].sort((left, right) => left - right) };
  },
};
