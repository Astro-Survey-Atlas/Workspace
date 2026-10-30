/** Small real NUNIQ tables; no projection logic is shared with production. */
export function nativeMocFits(cells: readonly { order: number; pixel: number | bigint }[], options: { frame?: string; format?: "1K" | "1J" } = {}): Buffer {
  const card = (key: string, value: string | number) => Buffer.from(`${key.padEnd(8)}= ${typeof value === "number" ? String(value).padStart(20) : `'${value}'`.padEnd(20)}`.padEnd(80), "ascii");
  const header = (cards: Buffer[]) => {
    const bytes = Buffer.concat([...cards, Buffer.from("END".padEnd(80), "ascii")]);
    return Buffer.concat([bytes, Buffer.alloc(Math.ceil(bytes.length / 2880) * 2880 - bytes.length, 32)]);
  };
  const width = options.format === "1J" ? 4 : 8;
  const primary = header([card("SIMPLE", "T"), card("BITPIX", 8), card("NAXIS", 0)]);
  const table = header([
    card("XTENSION", "BINTABLE"), card("BITPIX", 8), card("NAXIS", 2), card("NAXIS1", width), card("NAXIS2", cells.length),
    card("PCOUNT", 0), card("GCOUNT", 1), card("TFIELDS", 1), card("TTYPE1", "UNIQ"), card("TFORM1", options.format ?? "1K"),
    card("ORDERING", "NUNIQ"), card("COORDSYS", options.frame ?? "C"), card("MOCVERS", "2.0"), card("MOCDIM", "SPACE"),
  ]);
  const rows = Buffer.alloc(cells.length * width);
  cells.forEach((cell, index) => {
    const uniq = 4n * 4n ** BigInt(cell.order) + BigInt(cell.pixel);
    if (width === 8) rows.writeBigInt64BE(uniq, index * width);
    else rows.writeInt32BE(Number(uniq), index * width);
  });
  return Buffer.concat([primary, table, rows, Buffer.alloc((2880 - rows.length % 2880) % 2880)]);
}
