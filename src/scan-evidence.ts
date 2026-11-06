import { mkdir, open, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

const CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_RECORD_BYTES = 4 * 1024 * 1024;

/** Append-only chunks; index references permit bounded detail reads. */
export class ScanEvidenceWriter {
  #handle?: FileHandle;
  #offset = 0;
  #chunk = 0;
  #name = '';
  constructor(readonly root: string, readonly prefix: string) {}
  async write(value: unknown): Promise<string> {
    const bytes = Buffer.from(JSON.stringify(value) + '\n');
    if (bytes.length > MAX_RECORD_BYTES) throw new RangeError('Scientific evidence record exceeds 4 MiB');
    if (!this.#handle || this.#offset + bytes.length > CHUNK_BYTES) {
      await this.close();
      this.#name = `${this.prefix}-${this.#chunk++}.ndjson`;
      const filename = safeEvidencePath(this.root, this.#name);
      await mkdir(path.dirname(filename), { recursive: true });
      this.#handle = await open(filename, 'w');
      this.#offset = 0;
    }
    const start = this.#offset;
    await this.#handle.writeFile(bytes);
    this.#offset += bytes.length;
    return `${this.#name}@${start}:${bytes.length}`;
  }
  async close(): Promise<void> {
    if (this.#handle) { await this.#handle.sync(); await this.#handle.close(); this.#handle = undefined; }
  }
}

function safeEvidencePath(root: string, relative: string): string {
  if (!/^[a-zA-Z0-9_./-]+$/.test(relative) || relative.split('/').includes('..') || path.isAbsolute(relative)) throw new RangeError('Invalid evidence reference');
  return path.join(root, relative);
}

export async function readScanEvidence(root: string, reference: string): Promise<Record<string, unknown>> {
  const match = /^(.*?)@(\d+):(\d+)$/.exec(reference);
  if (!match) throw new RangeError('Invalid evidence reference');
  const offset = Number(match[2]);
  const length = Number(match[3]);
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || length < 1 || length > MAX_RECORD_BYTES) throw new RangeError('Invalid evidence bounds');
  const file = await open(safeEvidencePath(root, match[1]!), 'r');
  try {
    const bytes = Buffer.alloc(length);
    const { bytesRead } = await file.read(bytes, 0, length, offset);
    if (bytesRead !== length) throw new Error('Scientific evidence is incomplete');
    return JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
  } finally { await file.close(); }
}
