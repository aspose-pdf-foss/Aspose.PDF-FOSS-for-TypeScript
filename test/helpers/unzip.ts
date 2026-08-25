import { inflateRawSync } from 'node:zlib';

/** One entry read back out of an archive. */
export interface UnzippedEntry {
  path: string;
  bytes: Uint8Array;
  method: 'store' | 'deflate';
  /** The CRC-32 the archive CLAIMS, so a test can compare it with the truth. */
  crc: number;
}

const u16 = (b: Uint8Array, at: number): number => b[at] | (b[at + 1] << 8);
const u32 = (b: Uint8Array, at: number): number =>
  (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

/** Read an archive, written against APPNOTE rather than against src/zip.ts.
 *
 *  That independence is the point: a writer validated by its own reader proves
 *  only that the two agree. Deliberately strict — it throws rather than
 *  guessing, so a malformed archive fails the test that produced it instead of
 *  being quietly tolerated. */
export function unzip(bytes: Uint8Array): UnzippedEntry[] {
  // The EOCD is the last 22 bytes when there is no archive comment, which is
  // what src/zip.ts writes; scan backwards anyway so the helper is honest.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (u32(bytes, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('no end-of-central-directory record');

  const count = u16(bytes, eocd + 10);
  let at = u32(bytes, eocd + 16);          // central directory offset

  const out: UnzippedEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (u32(bytes, at) !== 0x02014b50) throw new Error(`bad central header at ${at}`);
    const method = u16(bytes, at + 10);
    const crc = u32(bytes, at + 16);
    const compSize = u32(bytes, at + 20);
    const nameLen = u16(bytes, at + 28);
    const extraLen = u16(bytes, at + 30);
    const commentLen = u16(bytes, at + 32);
    const localAt = u32(bytes, at + 42);
    const path = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen));

    if (u32(bytes, localAt) !== 0x04034b50) throw new Error(`bad local header for ${path}`);
    const localNameLen = u16(bytes, localAt + 26);
    const localExtraLen = u16(bytes, localAt + 28);
    const dataAt = localAt + 30 + localNameLen + localExtraLen;
    const raw = bytes.subarray(dataAt, dataAt + compSize);

    if (method !== 0 && method !== 8) throw new Error(`unsupported method ${method} for ${path}`);
    out.push({
      path,
      bytes: method === 8 ? new Uint8Array(inflateRawSync(Buffer.from(raw))) : new Uint8Array(raw),
      method: method === 8 ? 'deflate' : 'store',
      crc,
    });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** An entry by path, or undefined. */
export function entry(entries: UnzippedEntry[], path: string): UnzippedEntry | undefined {
  return entries.find((e) => e.path === path);
}

/** An entry's bytes decoded as UTF-8 text. */
export function textOf(entries: UnzippedEntry[], path: string): string {
  const e = entry(entries, path);
  if (!e) throw new Error(`no entry ${path}`);
  return new TextDecoder().decode(e.bytes);
}
