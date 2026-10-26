export const FITS_RECORD_BYTES = 2_880;
const FITS_CARD_BYTES = 80;
const MAX_FITS_HEADER_BYTES = 1024 * 1024;
const MAX_FITS_HDU_COUNT = 100_000;

export interface FitsHeaderRecord {
  file_id: string;
  source_uri: string;
  file_name: string;
  hdu_index: number;
  header: string;
  primary_header: string;
}

export interface FitsByteSource {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

function cardValue(card: string): unknown {
  if (card.slice(8, 10) !== "= ") return undefined;
  const text = card.slice(10);
  let quoted = false;
  let end = text.length;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "'") {
      if (quoted && text[index + 1] === "'") { index += 1; continue; }
      quoted = !quoted;
    } else if (text[index] === "/" && !quoted) {
      end = index;
      break;
    }
  }
  const value = text.slice(0, end).trim();
  if (value.startsWith("'")) return value.slice(1, value.lastIndexOf("'")).replaceAll("''", "'").trimEnd();
  if (value === "T") return true;
  if (value === "F") return false;
  if (/^[+-]?\d+$/.test(value)) return Number(value);
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[EeDd][+-]?\d+)?$/.test(value)) return Number(value.replace(/[Dd]/, "E"));
  return undefined;
}

function dataLength(header: ReadonlyMap<string, unknown>): number {
  const naxis = Number(header.get("NAXIS") ?? 0);
  const bitpix = Math.abs(Number(header.get("BITPIX") ?? 0));
  if (!Number.isInteger(naxis) || naxis < 0 || naxis > 999 || !Number.isInteger(bitpix) || bitpix % 8 !== 0) {
    throw new Error("FITS Header contains an invalid BITPIX or NAXIS value");
  }
  let elements = naxis === 0 ? 0n : 1n;
  for (let axis = 1; axis <= naxis; axis += 1) {
    const length = Number(header.get(`NAXIS${axis}`));
    if (!Number.isSafeInteger(length) || length < 0) throw new Error(`FITS Header contains an invalid NAXIS${axis}`);
    elements *= BigInt(length);
  }
  const pcount = BigInt(Number(header.get("PCOUNT") ?? 0));
  const gcount = BigInt(Number(header.get("GCOUNT") ?? 1));
  if (pcount < 0 || gcount < 1) throw new Error("FITS Header contains invalid PCOUNT or GCOUNT values");
  const byteCount = (elements * BigInt(bitpix / 8) + pcount) * gcount;
  if (byteCount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("FITS data unit exceeds the supported file range");
  return Number(byteCount);
}

async function readHeader(source: FitsByteSource, offset: number): Promise<{ raw: string; values: Map<string, unknown>; dataOffset: number } | undefined> {
  const cards: string[] = [];
  const values = new Map<string, unknown>();
  let bytesRead = 0;
  for (;;) {
    if (offset + bytesRead + FITS_RECORD_BYTES > source.size) throw new Error("FITS Header is truncated before its END card");
    const block = Buffer.from(await source.read(offset + bytesRead, FITS_RECORD_BYTES));
    if (bytesRead === 0 && block.byteLength === 0) return undefined;
    if (block.byteLength !== FITS_RECORD_BYTES) throw new Error("FITS Header range response was truncated");
    bytesRead += FITS_RECORD_BYTES;
    for (let position = 0; position < block.byteLength; position += FITS_CARD_BYTES) {
      const card = block.toString("ascii", position, position + FITS_CARD_BYTES);
      cards.push(card);
      if (card.slice(0, 8).trim() === "END") {
        return { raw: cards.join(""), values, dataOffset: offset + bytesRead };
      }
      const key = card.slice(0, 8).trim();
      if (key) {
        const value = cardValue(card);
        if (value !== undefined) values.set(key, value);
      }
    }
    if (bytesRead >= MAX_FITS_HEADER_BYTES) throw new Error(`FITS Header exceeds ${MAX_FITS_HEADER_BYTES} bytes`);
  }
}

export async function readFitsHeaders(
  source: FitsByteSource,
  identity: Pick<FitsHeaderRecord, "file_id" | "source_uri" | "file_name">,
): Promise<FitsHeaderRecord[]> {
  const result: FitsHeaderRecord[] = [];
  let offset = 0;
  let primaryHeader = "";
  while (offset < source.size) {
    if (result.length >= MAX_FITS_HDU_COUNT) throw new Error(`FITS file contains more than ${MAX_FITS_HDU_COUNT} HDUs`);
    const parsed = await readHeader(source, offset);
    if (!parsed) break;
    if (result.length === 0) {
      if (parsed.values.get("SIMPLE") !== true) throw new Error("FITS primary HDU does not contain SIMPLE = T");
      primaryHeader = parsed.raw;
    }
    result.push({
      ...identity,
      hdu_index: result.length,
      header: parsed.raw,
      primary_header: primaryHeader,
    });
    const dataBytes = dataLength(parsed.values);
    const paddedDataBytes = Math.ceil(dataBytes / FITS_RECORD_BYTES) * FITS_RECORD_BYTES;
    offset = parsed.dataOffset + paddedDataBytes;
    if (offset > source.size) throw new Error("FITS data unit extends beyond the end of the file");
    if (dataBytes === 0 && offset === source.size) break;
  }
  if (offset === 0 && !result.length) throw new Error("FITS file has no HDUs");
  if (!result.length) throw new Error("FITS file has no HDUs");
  return result;
}
