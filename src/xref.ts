import { Lexer } from './lexer.js';
import { ObjectParser } from './object-parser.js';
import { inflateStream } from './flate.js';
import { PdfParseError } from './errors.js';
import { PdfDict, isDict, isStream } from './types.js';

export type XrefEntry =
  | { type: 'offset'; offset: number; gen: number }
  | { type: 'compressed'; streamObj: number; index: number };
export interface XrefResult { entries: Map<number, XrefEntry>; trailer: PdfDict; }

export function readXref(buf: Uint8Array): XrefResult {
  const start = findStartXref(buf);
  const entries = new Map<number, XrefEntry>();
  let trailer: PdfDict | undefined;
  const seen = new Set<number>();
  let pos: number | undefined = start;

  while (pos !== undefined && !seen.has(pos)) {
    seen.add(pos);
    const section = readXrefSection(buf, pos);
    // earlier sections must not overwrite newer entries
    for (const [num, e] of section.entries) if (!entries.has(num)) entries.set(num, e);
    if (!trailer) trailer = section.trailer;
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
  return { entries, trailer };
}

function findStartXref(buf: Uint8Array): number {
  const tail = new TextDecoder('latin1').decode(buf.subarray(Math.max(0, buf.length - 2048)));
  const idx = tail.lastIndexOf('startxref');
  if (idx < 0) throw new PdfParseError('startxref not found');
  const m = /startxref\s+(\d+)/.exec(tail.slice(idx));
  if (!m) throw new PdfParseError('malformed startxref');
  return parseInt(m[1], 10);
}

interface Section { entries: Map<number, XrefEntry>; trailer: PdfDict; }

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
      if (kind.v === 'n' && !entries.has(num))
        entries.set(num, { type: 'offset', offset: off.v as number, gen: gen.v as number });
    }
  }
  const trailer = new ObjectParser(lx).parseObject();
  if (!isDict(trailer)) throw new PdfParseError('trailer is not a dict');
  return { entries, trailer };
}

export function readXrefStream(buf: Uint8Array, pos: number): Section {
  const parser = new ObjectParser(new Lexer(buf, pos));
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
      // f0 === 0 -> free, skip
    }
  }
  return { entries, trailer: dict };
}
