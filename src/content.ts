import { Lexer, Token } from './lexer.js';
import { PdfObject, PdfDict } from './types.js';
import { serializeValue, escapeName, enc } from './serialize.js';

export interface ContentOp {
  readonly operator: string;
  readonly operands: PdfObject[];
  /** Present only when operator === 'BI' (inline image). */
  readonly inlineImage?: { readonly dict: PdfDict; readonly data: Uint8Array };
}

const WS = new Set([0, 9, 10, 12, 13, 32]);

/** Tokenize decoded content-stream bytes into an op stream. */
export function parseContentStream(buf: Uint8Array): ContentOp[] {
  const lx = new Lexer(buf);
  const ops: ContentOp[] = [];
  let operands: PdfObject[] = [];
  for (;;) {
    const tok = lx.next();
    if (tok.t === 'eof') break;
    if (tok.t === 'kw') {
      if (tok.v === 'true') { operands.push(true); continue; }
      if (tok.v === 'false') { operands.push(false); continue; }
      if (tok.v === 'null') { operands.push(null); continue; }
      if (tok.v === 'BI') { ops.push(readInlineImage(lx)); operands = []; continue; }
      ops.push({ operator: tok.v, operands });
      operands = [];
      continue;
    }
    if (tok.t === 'delim' && (tok.v === ']' || tok.v === '>>')) continue; // stray close
    operands.push(valueFromToken(lx, tok));
  }
  return ops;
}

/** Build an operand value from an already-read token. No indirect-ref
 *  detection: content streams contain none. */
function valueFromToken(lx: Lexer, tok: Token): PdfObject {
  switch (tok.t) {
    case 'num': return tok.v;
    case 'name': return { kind: 'name', name: tok.v };
    case 'str': return { kind: 'string', bytes: tok.v };
    case 'delim':
      if (tok.v === '[') return readArray(lx);
      if (tok.v === '<<') return readDict(lx);
      return null;
    case 'kw':
      if (tok.v === 'true') return true;
      if (tok.v === 'false') return false;
      return null; // 'null' and anything unexpected
    default: return null;
  }
}

function readArray(lx: Lexer): PdfObject[] {
  const arr: PdfObject[] = [];
  for (;;) {
    const tok = lx.next();
    if (tok.t === 'eof') break;
    if (tok.t === 'delim' && tok.v === ']') break;
    arr.push(valueFromToken(lx, tok));
  }
  return arr;
}

function readDict(lx: Lexer): PdfDict {
  const d: PdfDict = new Map();
  for (;;) {
    const k = lx.next();
    if (k.t === 'eof') break;
    if (k.t === 'delim' && k.v === '>>') break;
    if (k.t !== 'name') continue; // skip malformed
    d.set(k.v, valueFromToken(lx, lx.next()));
  }
  return d;
}

function matches(buf: Uint8Array, p: number, s: string): boolean {
  for (let i = 0; i < s.length; i++) if (buf[p + i] !== s.charCodeAt(i)) return false;
  return true;
}

/** Find the terminating `EI` for inline-image data starting at `start`.
 *  Heuristic: an `EI` preceded by whitespace and followed by whitespace/EOF
 *  (raw image bytes can legitimately contain "EI"). Returns the data end
 *  (excluding the single delimiter whitespace) and the position just past EI. */
function findEI(buf: Uint8Array, start: number): { end: number; after: number } {
  for (let p = start + 1; p < buf.length - 1; p++) {
    if (buf[p] === 0x45 /*E*/ && buf[p + 1] === 0x49 /*I*/ && WS.has(buf[p - 1])) {
      const next = buf[p + 2];
      if (next === undefined || WS.has(next)) return { end: p - 1, after: p + 2 };
    }
  }
  return { end: buf.length, after: buf.length };
}

function readInlineImage(lx: Lexer): ContentOp {
  const dict: PdfDict = new Map();
  for (;;) {
    const k = lx.next();
    if (k.t === 'eof' || (k.t === 'kw' && k.v === 'ID')) break;
    if (k.t !== 'name') continue; // skip malformed
    dict.set(k.v, valueFromToken(lx, lx.next()));
  }
  const buf = lx.buf;
  let start = lx.pos;
  if (start < buf.length && WS.has(buf[start])) start++; // single whitespace after ID
  // Honor an explicit length (/L or /Length) when it lands on a whitespace-delimited EI.
  const len = dict.get('L') ?? dict.get('Length');
  if (typeof len === 'number' && len >= 0) {
    let q = start + len;
    while (q < buf.length && WS.has(buf[q])) q++;
    if (matches(buf, q, 'EI')) {
      lx.pos = q + 2;
      return { operator: 'BI', operands: [], inlineImage: { dict, data: buf.slice(start, start + len) } };
    }
  }
  const { end, after } = findEI(buf, start);
  lx.pos = after;
  return { operator: 'BI', operands: [], inlineImage: { dict, data: buf.slice(start, end) } };
}

/** Serialize an op stream back to content-stream bytes. Not byte-identical to
 *  the source; the guarantee is that re-parsing yields the same ops. */
export function serializeContentStream(ops: ContentOp[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const NL = enc('\n');
  for (let i = 0; i < ops.length; i++) {
    if (i > 0) chunks.push(NL);
    const op = ops[i];
    if (op.inlineImage) {
      const { dict, data } = op.inlineImage;
      let head = 'BI';
      for (const [k, v] of dict) head += ` /${escapeName(k)} ${serializeValue(v)}`;
      head += '\nID ';
      chunks.push(enc(head));
      chunks.push(data);
      chunks.push(enc('\nEI'));
    } else {
      const operandsStr = op.operands.map(serializeValue).join(' ');
      chunks.push(enc(operandsStr ? `${operandsStr} ${op.operator}` : op.operator));
    }
  }
  return concat(chunks);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

/**
 * Operators the group walk-back may cross: those that MARK NOTHING.
 *
 * An allowlist rather than a denylist, and that direction is the safety
 * property. Everything here either sets graphics state that the group's own `Q`
 * restores, or constructs a path without painting it — so a `q … Do Q` whose
 * interior is drawn entirely from this set contributes the image and nothing
 * else, and taking the whole group deletes exactly the image. An operator
 * nobody has classified stops the walk, which degrades to cutting the `Do`
 * alone: the old behaviour, and always safe.
 *
 * Note what is deliberately ABSENT. Every painting operator (`f`, `S`, `B`,
 * `sh`, …) is out, which is what makes the path-construction ops safe to
 * include: `re W n` marks nothing and is crossed, while `re f` paints a
 * rectangle and is not — the terminator is the only difference. `Do` is out
 * because a form draws its own content. `BDC`/`BMC`/`EMC` are out on different
 * grounds: they mark no ink, but a `BDC` is optional-content membership, so
 * cutting one changes what the OCG covers rather than leaving residue.
 */
const NON_MARKING = new Set([
  // Graphics state (32000-1 8.4.4) — all restored by the group's own `Q`.
  'cm', 'gs', 'w', 'J', 'j', 'M', 'd', 'ri', 'i',
  // Colour (8.6.8).
  'cs', 'CS', 'sc', 'scn', 'SC', 'SCN', 'g', 'G', 'rg', 'RG', 'k', 'K',
  // Path construction and clipping (8.5.2, 8.5.4). `n` ends a path WITHOUT
  // painting it; the clip it may set is scoped to the enclosing q/Q.
  'm', 'l', 'c', 'v', 'y', 'h', 're', 'W', 'W*', 'n',
]);

/** Indices an image-draw removal takes with it: the enclosing `q … Do Q`
 *  group where there is one, otherwise the `Do` alone.
 *
 *  **Invariant:** one owner. Redaction (`removeImagesUnder`) and
 *  `imageedit.ts`'s `removeImage` both cut image draws, and two copies of this
 *  rule is how one of them comes to leave a stranded `q` the other takes.
 *
 *  **Invariant:** the group is cut only when EVERY op between the `q` and the
 *  `Do` marks nothing — see {@link NON_MARKING}. Anything else means the group
 *  draws something besides the image, so cutting it would delete visible
 *  content; the walk stops and only the `Do` goes.
 *
 *  Until `5ttj` the walk crossed `cm` and nothing else, so a `gs` or a clip
 *  degraded the cut and left an inert `q /GS0 gs … cm Q`. Harmless to render,
 *  but it kept the `/GS0` reference alive, so a targeted `Remove` could not
 *  orphan an ExtGState used only by the block it removed. */
export function imageCutSet(ops: readonly ContentOp[], remove: Set<number>): Set<number> {
  const cut = new Set<number>();
  for (const i of remove) {
    let p = i - 1;
    while (p >= 0 && NON_MARKING.has(ops[p].operator)) p--;
    const wrapped = p >= 0 && ops[p].operator === 'q'
      && i + 1 < ops.length && ops[i + 1].operator === 'Q';
    if (wrapped) for (let k = p; k <= i + 1; k++) cut.add(k);
    else cut.add(i);
  }
  return cut;
}
