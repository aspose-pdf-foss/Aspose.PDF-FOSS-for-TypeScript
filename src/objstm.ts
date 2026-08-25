import { Lexer } from './lexer.js';
import { ObjectParser } from './object-parser.js';
import { inflateStream } from './flate.js';
import { PdfObject, PdfStream } from './types.js';
import { PdfParseError } from './errors.js';

/** What one /ObjStm container yielded, and what it cost. Surfaced verbatim as
 *  RecoveryReport.objectStreams.
 *
 *  `lost` can only name numbers the header actually yielded. A truncation
 *  leaves the header intact — it sits at the front of the payload — so in
 *  practice the numbers are all known; a container whose header is itself short
 *  can only report the count discrepancy, which is what `detail` carries. */
export interface ObjStmDamage {
  /** Object number of the container itself. */
  container: number;
  /** Objects the container declared and this decode produced. */
  recovered: number[];
  /** Objects the container declared that did not survive the damage. */
  lost: number[];
  detail: string;
}

export interface ObjStmResult {
  objects: Map<number, PdfObject>;
  /** Undefined when the container decoded whole. */
  damage?: ObjStmDamage;
}

/** Decode an /ObjStm into a map of objectNumber -> PdfObject, degrading per
 *  object: an object wholly inside the surviving payload is recovered even when
 *  the container is damaged. Throws only when there is nothing to work with. */
export function decodeObjStm(s: PdfStream, container: number): ObjStmResult {
  const declaredN = s.dict.get('N');
  const declaredFirst = s.dict.get('First');
  const notes: string[] = [];

  // Inflate strictly first: the healthy path must stay exactly as it was, and a
  // partial inflate silently returns 0 bytes for a payload that is not DEFLATE
  // at all, which would turn a hard error into an empty container.
  let data: Uint8Array;
  try {
    data = inflateStream(s);
  } catch {
    // Z_SYNC_FLUSH salvages a payload that stopped mid-stream, but a payload
    // that is not DEFLATE at all fails its header check and throws a raw zlib
    // error — which must not escape as anything but a PdfParseError.
    try {
      data = inflateStream(s, { partial: true });
    } catch {
      throw new PdfParseError(`object stream ${container} payload did not decode`);
    }
    notes.push(`payload inflated to ${data.length} bytes before it stopped`);
  }
  if (data.length === 0)
    throw new PdfParseError(`object stream ${container} payload did not decode`);

  // Header: N pairs of "objNum offset". Read what is there rather than what /N
  // claims. The `break` below is what bounds this loop, not /N — which is only
  // a number in a dict and may say 2^31. It is a real bound because Lexer.next()
  // always advances or returns eof, so a non-pair token always arrives; that is
  // also why /N being absent can leave the count open.
  const want = typeof declaredN === 'number' && declaredN >= 0 ? declaredN : Infinity;
  if (typeof declaredN !== 'number') notes.push('no usable /N');
  const lx = new Lexer(data, 0);
  const pairs: Array<{ num: number; off: number }> = [];
  let headerEnd = 0;
  for (let i = 0; i < want; i++) {
    const a = lx.next(); const b = lx.next();
    if (a.t !== 'num' || b.t !== 'num') break;
    pairs.push({ num: a.v, off: b.v });
    headerEnd = lx.pos;
  }
  if (typeof declaredN === 'number' && pairs.length !== declaredN)
    notes.push(`header yielded ${pairs.length} of ${declaredN} declared pairs`);
  if (pairs.length === 0)
    throw new PdfParseError(`object stream ${container} has no readable header`);

  // Every object offset is relative to /First, so a wrong one lands every parse
  // in the middle of something else. The header's own end is a lower bound, and
  // the pair loop already computed it.
  let first = headerEnd;
  if (typeof declaredFirst === 'number'
    && declaredFirst >= headerEnd && declaredFirst <= data.length) {
    first = declaredFirst;
  } else {
    notes.push(`/First ${String(declaredFirst)} unusable, using header end ${headerEnd}`);
  }

  const objects = new Map<number, PdfObject>();
  const lost: number[] = [];
  for (const { num, off } of pairs) {
    const at = first + off;
    if (!Number.isFinite(at) || at < 0 || at >= data.length) { lost.push(num); continue; }
    try {
      objects.set(num, new ObjectParser(new Lexer(data, at)).parseObject());
    } catch {
      lost.push(num);
    }
  }
  if (lost.length > 0) notes.push(`${lost.length} of ${pairs.length} objects did not parse`);

  if (notes.length === 0) return { objects };
  return {
    objects,
    damage: { container, recovered: [...objects.keys()], lost, detail: notes.join('; ') },
  };
}
