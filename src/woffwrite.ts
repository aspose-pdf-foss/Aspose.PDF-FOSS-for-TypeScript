import { deflateSync } from 'node:zlib';
import { PdfParseError } from './errors.js';

function tableChecksum(data: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    const b0 = data[i] ?? 0, b1 = data[i + 1] ?? 0, b2 = data[i + 2] ?? 0, b3 = data[i + 3] ?? 0;
    sum = (sum + (((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0)) >>> 0;
  }
  return sum >>> 0;
}

/** Compress an sfnt into a WOFF 1.0 container (per-table zlib). A table is stored
 *  uncompressed when deflate does not shrink it (compLength === origLength). */
export function sfntToWoff(sfnt: Uint8Array): Uint8Array {
  if (sfnt.length < 12) throw new PdfParseError('sfnt too short for WOFF');
  const dv = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength);
  const flavor = dv.getUint32(0);
  const numTables = dv.getUint16(4);
  const dir: { tag: string; origOffset: number; origLength: number }[] = [];
  let p = 12;
  for (let i = 0; i < numTables; i++) {
    const tag = String.fromCharCode(sfnt[p], sfnt[p + 1], sfnt[p + 2], sfnt[p + 3]);
    dir.push({ tag, origOffset: dv.getUint32(p + 8), origLength: dv.getUint32(p + 12) });
    p += 16;
  }
  // WOFF header (44) + table directory (20 per table), then compressed bodies.
  const headerLen = 44 + numTables * 20;
  let bodyOffset = headerLen;
  const bodies: {
    comp: Uint8Array;
    entry: { tag: string; offset: number; compLength: number; origLength: number; checksum: number };
  }[] = [];
  for (const t of dir) {
    const raw = sfnt.subarray(t.origOffset, t.origOffset + t.origLength);
    const deflated = new Uint8Array(deflateSync(Buffer.from(raw)));
    const comp = deflated.length < raw.length ? deflated : raw;
    const padded = (4 - (comp.length & 3)) & 3;
    bodies.push({
      comp,
      entry: { tag: t.tag, offset: bodyOffset, compLength: comp.length, origLength: raw.length, checksum: tableChecksum(raw) },
    });
    bodyOffset += comp.length + padded;
  }
  const total = bodyOffset;
  const out = new Uint8Array(total);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, 0x774f4646);                 // 'wOFF'
  ov.setUint32(4, flavor >>> 0);
  ov.setUint32(8, total);                       // length
  ov.setUint16(12, numTables);
  ov.setUint16(14, 0);                          // reserved
  ov.setUint32(16, 12 + numTables * 16);        // totalSfntSize (uncompressed offset+dir)
  ov.setUint16(20, 1); ov.setUint16(22, 0);     // major/minor version
  ov.setUint32(24, 0); ov.setUint32(28, 0); ov.setUint32(32, 0); // meta off/len/origLen
  ov.setUint32(36, 0); ov.setUint32(40, 0);     // priv off/len
  let q = 44;
  for (const b of bodies) {
    for (let k = 0; k < 4; k++) out[q + k] = b.entry.tag.charCodeAt(k);
    ov.setUint32(q + 4, b.entry.offset);
    ov.setUint32(q + 8, b.entry.compLength);
    ov.setUint32(q + 12, b.entry.origLength);
    ov.setUint32(q + 16, b.entry.checksum);
    out.set(b.comp, b.entry.offset);
    q += 20;
  }
  return out;
}
