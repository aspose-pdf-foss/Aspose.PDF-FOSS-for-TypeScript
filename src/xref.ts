import { Lexer } from './lexer.js';
import { ObjectParser } from './object-parser.js';
import { inflateStream } from './flate.js';
import { PdfParseError } from './errors.js';
import { PdfDict, isDict, isStream } from './types.js';

export type XrefEntry =
  | { type: 'offset'; offset: number; gen: number }
  | { type: 'compressed'; streamObj: number; index: number }
  // A FREE entry, recorded rather than dropped. It must OCCUPY the slot: the
  // merge in readXref is newest-wins by "already present", so a dropped
  // tombstone lets an OLDER section's offset entry fill the gap and the object
  // comes back from the dead. `gen` is the generation it would take on reuse.
  | { type: 'free'; gen: number };
/** One revision of a PDF: the document as it stood at a `%%EOF`.
 *
 *  A file that was never incrementally updated has exactly one. Each later
 *  revision appends to the previous one, so `length` grows monotonically and
 *  `bytes.subarray(0, length)` is that revision's complete document. */
export interface PdfRevision {
  /** Byte offset of this revision's cross-reference section. */
  xrefOffset: number;
  /** The file's byte length as of this revision, i.e. the end of its `%%EOF`. */
  length: number;
}

export interface XrefResult {
  entries: Map<number, XrefEntry>;
  trailer: PdfDict;
  /** Every revision the `/Prev` chain names, OLDEST FIRST — so index is the
   *  revision number and `[0]` is the original document. The walk itself runs
   *  newest first, because that is the direction `/Prev` points. */
  revisions: PdfRevision[];
}

export function readXref(buf: Uint8Array): XrefResult {
  const start = findStartXref(buf);
  const entries = new Map<number, XrefEntry>();
  let trailer: PdfDict | undefined;
  const seen = new Set<number>();
  const revisions: PdfRevision[] = [];
  let pos: number | undefined = start;

  while (pos !== undefined && !seen.has(pos)) {
    seen.add(pos);
    const section = readXrefSection(buf, pos);
    // earlier sections must not overwrite newer entries
    for (const [num, e] of section.entries) if (!entries.has(num)) entries.set(num, e);
    if (!trailer) trailer = section.trailer;
    revisions.push({ xrefOffset: pos, length: revisionEnd(buf, section.end) });
    // Hybrid: /XRefStm points to a parallel xref stream
    const xrefStm = section.trailer.get('XRefStm');
    if (typeof xrefStm === 'number' && !seen.has(xrefStm)) {
      const hs = readXrefSection(buf, xrefStm);
      for (const [num, e] of hs.entries) if (!entries.has(num)) entries.set(num, e);
    }
    const prev = section.trailer.get('Prev');
    pos = typeof prev === 'number' ? prev : undefined;
  }
  if (!trailer) throw new PdfParseError('no trailer found');
  return { entries, trailer, revisions: revisions.reverse() };
}

/** Byte length of the revision whose cross-reference section ENDS at `from`:
 *  the offset just past its `%%EOF`, including a trailing EOL.
 *
 *  It scans from the section's parsed END rather than from its offset, and that
 *  is load-bearing rather than tidy: a cross-reference STREAM's payload is
 *  compressed binary that may contain the bytes `%%EOF`, so scanning from the
 *  offset would find that and report a truncated revision. Falls back to the
 *  whole buffer when no marker follows — a file whose last revision lost its
 *  `%%EOF` still has a length. */
function revisionEnd(buf: Uint8Array, from: number): number {
  const marker = [0x25, 0x25, 0x45, 0x4f, 0x46]; // %%EOF
  for (let i = Math.max(0, from); i + marker.length <= buf.length; i++) {
    let hit = true;
    for (let j = 0; j < marker.length; j++) if (buf[i + j] !== marker[j]) { hit = false; break; }
    if (!hit) continue;
    let end = i + marker.length;
    if (buf[end] === 0x0d) end++;
    if (buf[end] === 0x0a) end++;
    return end;
  }
  return buf.length;
}

function findStartXref(buf: Uint8Array): number {
  const tail = new TextDecoder('latin1').decode(buf.subarray(Math.max(0, buf.length - 2048)));
  const idx = tail.lastIndexOf('startxref');
  if (idx < 0) throw new PdfParseError('startxref not found');
  const m = /startxref\s+(\d+)/.exec(tail.slice(idx));
  if (!m) throw new PdfParseError('malformed startxref');
  return parseInt(m[1], 10);
}

interface Section {
  entries: Map<number, XrefEntry>;
  trailer: PdfDict;
  /** Byte offset just past this section, used to find its revision's %%EOF. */
  end: number;
}

function readXrefSection(buf: Uint8Array, pos: number): Section {
  // Classic table begins with keyword `xref`. Otherwise it's an xref stream (Task 8).
  const lx = new Lexer(buf, pos);
  const save = lx.pos;
  const first = lx.next();
  if (first.t === 'kw' && first.v === 'xref') return readClassicTable(buf, lx);
  // Not a classic table -> delegate to xref-stream reader (added in Task 8).
  return readXrefStream(buf, save);
}

function readClassicTable(buf: Uint8Array, lx: Lexer): Section {
  const entries = new Map<number, XrefEntry>();
  for (;;) {
    const t = lx.next();
    if (t.t === 'kw' && t.v === 'trailer') break;
    if (t.t !== 'num') throw new PdfParseError('expected subsection start', t.pos);
    const startObj = t.v as number;
    const count = lx.next();
    if (count.t !== 'num') throw new PdfParseError('expected subsection count', count.pos);
    for (let i = 0; i < (count.v as number); i++) {
      const off = lx.next(); const gen = lx.next(); const kind = lx.next();
      if (off.t !== 'num' || gen.t !== 'num' || kind.t !== 'kw')
        throw new PdfParseError('malformed xref entry', off.pos);
      const num = startObj + i;
      if (entries.has(num)) continue;
      if (kind.v === 'n') entries.set(num, { type: 'offset', offset: off.v as number, gen: gen.v as number });
      else if (kind.v === 'f') entries.set(num, { type: 'free', gen: gen.v as number });
    }
  }
  const trailer = new ObjectParser(lx).parseObject();
  if (!isDict(trailer)) throw new PdfParseError('trailer is not a dict');
  return { entries, trailer, end: lx.pos };
}

export function readXrefStream(buf: Uint8Array, pos: number): Section {
  // The lexer is held so its position can be read back: it lands past the
  // stream payload, which is where the revision-end scan must begin.
  const lx = new Lexer(buf, pos);
  const parser = new ObjectParser(lx);
  const { value } = parser.parseIndirectObject();
  if (!isStream(value)) throw new PdfParseError('xref stream object is not a stream', pos);
  const dict = value.dict;
  const data = inflateStream(value);
  const W = dict.get('W');
  if (!Array.isArray(W) || W.length !== 3) throw new PdfParseError('xref stream missing /W', pos);
  const [w0, w1, w2] = W as number[];
  const size = (dict.get('Size') as number) ?? 0;
  const indexArr = (dict.get('Index') as number[]) ?? [0, size];
  const rowLen = w0 + w1 + w2;
  const entries = new Map<number, XrefEntry>();
  let p = 0;
  const readField = (w: number): number => { let v = 0; for (let i = 0; i < w; i++) v = v * 256 + data[p++]; return v; };
  for (let s = 0; s < indexArr.length; s += 2) {
    let objNum = indexArr[s];
    const cnt = indexArr[s + 1];
    for (let i = 0; i < cnt; i++, objNum++) {
      if (p + rowLen > data.length) break;
      const f0 = w0 === 0 ? 1 : readField(w0); // default type 1 when W[0]=0
      const f1 = readField(w1);
      const f2 = readField(w2);
      if (entries.has(objNum)) continue;
      if (f0 === 1) entries.set(objNum, { type: 'offset', offset: f1, gen: f2 });
      else if (f0 === 2) entries.set(objNum, { type: 'compressed', streamObj: f1, index: f2 });
      else if (f0 === 0) entries.set(objNum, { type: 'free', gen: f2 });
    }
  }
  return { entries, trailer: dict, end: lx.pos };
}
