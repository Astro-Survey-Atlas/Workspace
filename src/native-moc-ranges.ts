import { MAX_OVERLAP_ORDER, unionHealpixRanges, type HealpixRange } from "./healpix-ranges.js";

/**
 * Read verified ICRS/NUNIQ geometry using the same interval projection as
 * Assets (server/native-moc.ts and display-coverage.ts). Intersect intervals
 * before expanding cells, so an all-sky MOC never allocates an O13 sky grid.
 * This reads existing authority; MOC generation remains in MOC Core.
 */
export function nativeMocHealpixRanges(bytes: Uint8Array, order: number): HealpixRange[] {
  if (!Number.isInteger(order) || order < 0 || order > MAX_OVERLAP_ORDER) throw new RangeError("Unsupported MOC display order");
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!buffer.length || buffer.length % 2880 || buffer.toString("ascii", 0, 8) !== "SIMPLE  ") throw new Error("Invalid FITS MOC");
  const ranges: HealpixRange[] = [];
  let offset = 0, found = false;
  while (offset < buffer.length) {
    const header = new Map<string, string>();
    let cursor = offset, ended = false;
    while (cursor + 80 <= buffer.length) {
      const card = buffer.toString("ascii", cursor, cursor + 80); cursor += 80;
      const key = card.slice(0, 8).trim();
      if (key === "END") { ended = true; break; }
      if (card[8] === "=") header.set(key, card.slice(10).split("/", 1)[0]!.trim().replace(/^'|'$/g, "").trim());
    }
    if (!ended) throw new Error("Truncated FITS MOC header");
    const start = offset + Math.ceil((cursor - offset) / 2880) * 2880;
    const axes = Number(header.get("NAXIS") ?? 0);
    let elements = axes ? 1 : 0;
    for (let axis = 1; axis <= axes; axis += 1) elements *= Number(header.get(`NAXIS${axis}`));
    const size = elements * Math.abs(Number(header.get("BITPIX"))) / 8 * Number(header.get("GCOUNT") ?? 1) + Number(header.get("PCOUNT") ?? 0);
    if (!Number.isSafeInteger(size) || size < 0 || start + size > buffer.length) throw new Error("Truncated FITS MOC data");
    if (header.get("XTENSION") === "BINTABLE") {
      const fields = Number(header.get("TFIELDS"));
      let columnOffset = 0, uniqOffset = -1, uniqWidth = 0;
      for (let field = 1; field <= fields; field += 1) {
        const form = /^(\d*)([A-Z])$/.exec(header.get(`TFORM${field}`) ?? "");
        const width = form && ({ A: 1, B: 1, L: 1, I: 2, J: 4, K: 8, E: 4, D: 8, C: 8, M: 16 } as Record<string, number>)[form[2]!];
        if (!form || !width) throw new Error("Unsupported FITS MOC column format");
        const repeat = Number(form[1] || 1);
        if (["UNIQ", "NUNIQ"].includes(header.get(`TTYPE${field}`) ?? "")) {
          if (repeat !== 1 || !["J", "K"].includes(form[2]!)) throw new Error("Invalid FITS MOC UNIQ column");
          uniqOffset = columnOffset; uniqWidth = width;
        }
        columnOffset += repeat * width;
      }
      if (uniqOffset >= 0) {
        if (header.get("ORDERING") !== "NUNIQ" || header.get("COORDSYS") !== "C") throw new Error("MOC must use ICRS/NUNIQ");
        const rows = Number(header.get("NAXIS2")), stride = Number(header.get("NAXIS1"));
        if (!Number.isSafeInteger(rows) || rows < 0 || !Number.isSafeInteger(stride) || stride < columnOffset || rows * stride > size) throw new Error("Invalid FITS MOC table dimensions");
        found = true;
        for (let row = 0; row < rows; row += 1) {
          const position = start + row * stride + uniqOffset;
          const uniq = uniqWidth === 8 ? buffer.readBigInt64BE(position) : BigInt(buffer.readInt32BE(position));
          if (uniq < 4n) throw new Error("Invalid NUNIQ cell");
          const nativeOrder = Math.floor((uniq.toString(2).length - 3) / 2);
          const pixel = uniq - 4n * 4n ** BigInt(nativeOrder);
          if (nativeOrder > 29 || pixel < 0n || pixel >= 12n * 4n ** BigInt(nativeOrder)) throw new Error("Invalid NUNIQ cell");
          const scale = 4n ** BigInt(Math.abs(order - nativeOrder));
          const low = nativeOrder <= order ? pixel * scale : pixel / scale;
          const high = nativeOrder <= order ? (pixel + 1n) * scale : low + 1n;
          ranges.push({ start: Number(low), end: Number(high) });
        }
      }
    }
    offset = start + Math.ceil(size / 2880) * 2880;
  }
  if (!found) throw new Error("FITS MOC has no UNIQ table");
  return unionHealpixRanges(ranges);
}
