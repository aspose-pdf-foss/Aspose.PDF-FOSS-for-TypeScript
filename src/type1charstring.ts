import { LoadLimits } from './loadlimits.js';
import type { Path, Seg } from './pagerender.js';
import { PdfParseError, rethrowLimit, UnsupportedFeatureError } from './errors.js';
import type { FontWork } from './fontwork.js';

/**
 * One interpreted Type 1 charstring.
 *
 * `width` and `sbx`/`sby` come from `hsbw`/`sbw`. The sidebearing is not merely
 * a metric: it is where the pen starts, so a glyph interpreted without it lands
 * displaced by its own left sidebearing — uniformly enough across a font to look
 * like a slightly wrong face rather than a bug.
 */
export interface Type1Glyph { path: Path; width: number; widthY?: number; sbx: number; sby: number; }

/** What a charstring can reach outside itself. */
export interface Type1Env {
  work?: FontWork;
  strict?: boolean;
  /** Decrypted `/Subrs`, indexed exactly as the font numbers them. Type 2's
   *  subr bias is a Type 2 invention and must not be applied here. */
  subrs: Uint8Array[];
  /** Decrypted charstring for a StandardEncoding code, for `seac`. Absent when
   *  the caller cannot resolve one, which makes `seac` draw nothing. */
  seacGlyph?(stdCode: number): Uint8Array | undefined;
  /** Bounds the operators one glyph may execute (`ibzo.12`). Default
   *  {@link LoadLimits.defaults}. */
  limits?: LoadLimits;
}

const MAX_DEPTH = 10;

interface T1Ctx {
  path: Path;
  x: number; y: number;
  stack: number[];
  /** The PostScript operand stack `callothersubr` writes and `pop` reads. */
  ps: number[];
  open: boolean;
  width: number; widthY: number; sbx: number; sby: number;
  env: Type1Env;
  depth: number;
  /** Non-undefined while an OtherSubrs 1 flex is being accumulated. */
  flex?: { x: number; y: number }[];
  /** Set by `seac`, applied once the charstring has stopped. */
  seac?: { asb: number; adx: number; ady: number; bchar: number; achar: number };
  done: boolean;
  /** Operators executed for this glyph, subroutines included (`ibzo.12`). */
  ops: number;
}

function emit(c: T1Ctx, segment: Seg): void {
  c.env.work?.items(c.path.length + 1, 'Type 1 path');
  c.env.work?.allocate(64, 'Type 1 path'); c.env.work?.work(1, 'Type 1 path');
  c.path.push(segment);
}

function moveTo(c: T1Ctx, x: number, y: number): void {
  if (c.open) { emit(c, { op: 'Z' }); c.open = false; }
  c.x = x; c.y = y;
  emit(c, { op: 'M', x, y });
  c.open = true;
}
function lineTo(c: T1Ctx, x: number, y: number): void {
  c.x = x; c.y = y;
  emit(c, { op: 'L', x, y });
}
function curveTo(c: T1Ctx, x1: number, y1: number, x2: number, y2: number, x: number, y: number): void {
  c.x = x; c.y = y;
  emit(c, { op: 'C', x1, y1, x2, y2, x, y });
}

/** Interpret one charstring. Never throws: a damaged charstring costs its own
 *  glyph, matching `CffFont.glyphPath`. */
export function runType1Charstring(code: Uint8Array, env: Type1Env): Type1Glyph {
  env.work?.allocate(256, 'Type 1 interpreter');
  const c: T1Ctx = {
    path: [], x: 0, y: 0, stack: [], ps: [], open: false,
    width: 0, widthY: 0, sbx: 0, sby: 0, env, depth: 0, done: false, ops: 0,
  };
  try { exec(code, c); } catch (caught) { rethrowLimit(caught); if (env.strict) throw caught; /* legacy salvage */ }
  if (env.strict && !c.done) throw new PdfParseError('Type1: missing endchar');
  if (c.seac && env.seacGlyph) applySeac(c, env);
  if (c.open) { emit(c, { op: 'Z' }); c.open = false; }
  return { path: c.path, width: c.width, widthY: c.widthY, sbx: c.sbx, sby: c.sby };
}

/**
 * Replace the composite's (empty) outline with base + translated accent.
 *
 * The accent's origin goes to `sbx - asb + adx`, which corrects for the two
 * glyphs' differing left sidebearings — dropping that correction shifts every
 * accent by the difference, which is small enough to look like bad kerning.
 */
function applySeac(c: T1Ctx, env: Type1Env): void {
  const { asb, adx, ady, bchar, achar } = c.seac!;
  const base = env.seacGlyph!(bchar);
  const accent = env.seacGlyph!(achar);
  c.path = [];
  c.open = false;
  if (env.strict && (!base || !accent)) throw new PdfParseError('Type1: missing seac component');
  const child = { subrs: env.subrs, limits: env.limits, work: env.work, strict: env.strict };
  if (base) for (const segment of runType1Charstring(base, child).path) emit(c, segment);
  if (accent) {
    const g = runType1Charstring(accent, child);
    const dx = c.sbx - asb + adx, dy = ady;
    for (const s of g.path) {
      if (s.op === 'Z') emit(c, s);
      else if (s.op === 'C') {
        emit(c, { op: 'C', x1: s.x1 + dx, y1: s.y1 + dy, x2: s.x2 + dx, y2: s.y2 + dy, x: s.x + dx, y: s.y + dy });
      } else emit(c, { op: s.op, x: s.x + dx, y: s.y + dy });
    }
  }
}

function exec(code: Uint8Array, c: T1Ctx): void {
  c.env.work?.depth(c.depth + 1, 'Type 1 subroutine');
  if (c.depth > MAX_DEPTH) { if (c.env.strict) throw new PdfParseError('Type1: subroutine nesting'); return; }
  let i = 0;
  while (i < code.length && !c.done) {
    const b = code[i++];
    c.env.work?.work(1, 'Type 1 byte');
    if (b >= 32) {                                            // operand
      const extra = b <= 246 ? 0 : b <= 254 ? 1 : 4;
      c.env.work?.work(extra, 'Type 1 operand bytes');
      if (c.env.strict && i + extra > code.length) throw new PdfParseError('Type1: truncated operand');
      c.env.work?.items(c.stack.length + 1, 'Type 1 operands'); c.env.work?.allocate(16, 'Type 1 operand');
      if (b <= 246) c.stack.push(b - 139);
      else if (b <= 250) { c.stack.push((b - 247) * 256 + code[i] + 108); i += 1; }
      else if (b <= 254) { c.stack.push(-(b - 251) * 256 - code[i] - 108); i += 1; }
      else {                                                  // 255: 32-bit integer, NOT 16.16
        c.stack.push(((code[i] << 24) | (code[i + 1] << 16) | (code[i + 2] << 8) | code[i + 3]) | 0);
        i += 4;
      }
      continue;
    }
    (c.env.limits ?? LoadLimits.defaults).enforce('maxGlyphOperations', ++c.ops, 'Type 1 charstring');
    const s = c.stack;
    if (c.env.strict) {
      const arity: Record<number, number> = { 1: 2, 3: 2, 4: 1, 5: 2, 6: 1, 7: 1, 8: 6, 9: 0, 13: 2, 14: 0, 21: 2, 22: 1, 30: 4, 31: 4 };
      if (arity[b] !== undefined && s.length !== arity[b] || b === 10 && !s.length)
        throw new PdfParseError('Type1: invalid operand count');
    }
    switch (b) {
      case 1: case 3: s.length = 0; break;                                             // hstem / vstem
      case 4: rmove(c, 0, s[0] ?? 0); s.length = 0; break;                             // vmoveto
      case 5: lineTo(c, c.x + (s[0] ?? 0), c.y + (s[1] ?? 0)); s.length = 0; break;    // rlineto
      case 6: lineTo(c, c.x + (s[0] ?? 0), c.y); s.length = 0; break;                  // hlineto
      case 7: lineTo(c, c.x, c.y + (s[0] ?? 0)); s.length = 0; break;                  // vlineto
      case 8: rrcurve(c, s[0], s[1], s[2], s[3], s[4], s[5]); s.length = 0; break;     // rrcurveto
      case 9: if (c.open) { emit(c, { op: 'Z' }); c.open = false; } s.length = 0; break;  // closepath
      case 10: {                                              // callsubr — unbiased
        const idx = s.pop() ?? 0;
        const sub = c.env.subrs[idx];
        if (c.env.strict && (!Number.isInteger(idx) || !sub)) throw new PdfParseError('Type1: missing subroutine');
        if (sub) { c.depth++; exec(sub, c); c.depth--; }
        break;
      }
      case 11: return;                                        // return
      case 13:                                                // hsbw
        c.sbx = s[0] ?? 0; c.width = s[1] ?? 0;
        c.x = c.sbx; c.y = 0;
        s.length = 0; break;
      case 14: c.done = true; return;                         // endchar
      case 21: rmove(c, s[0] ?? 0, s[1] ?? 0); s.length = 0; break;                    // rmoveto
      case 22: rmove(c, s[0] ?? 0, 0); s.length = 0; break;                            // hmoveto
      case 30: rrcurve(c, 0, s[0], s[1], s[2], s[3], 0); s.length = 0; break;          // vhcurveto
      case 31: rrcurve(c, s[0], 0, s[1], s[2], 0, s[3]); s.length = 0; break;          // hvcurveto
      case 12: c.env.work?.work(1, 'Type 1 escape'); escape(c, code[i++]); break;
      default: if (c.env.strict) throw new PdfParseError('Type1: unknown operator'); s.length = 0; break;
    }
  }
}

/** A relative moveto — or, inside a flex, one of its seven accumulated points. */
function rmove(c: T1Ctx, dx: number, dy: number): void {
  const nx = c.x + dx, ny = c.y + dy;
  if (c.flex) { c.env.work?.items(c.flex.length + 1); c.env.work?.allocate(32, 'Type 1 flex'); c.flex.push({ x: nx, y: ny }); c.x = nx; c.y = ny; return; }
  moveTo(c, nx, ny);
}

function rrcurve(c: T1Ctx, dx1 = 0, dy1 = 0, dx2 = 0, dy2 = 0, dx3 = 0, dy3 = 0): void {
  const x1 = c.x + dx1, y1 = c.y + dy1;
  const x2 = x1 + dx2, y2 = y1 + dy2;
  curveTo(c, x1, y1, x2, y2, x2 + dx3, y2 + dy3);
}

function escape(c: T1Ctx, b1: number): void {
  const s = c.stack;
  if (c.env.strict) {
    const arity: Record<number, number> = { 0: 0, 1: 6, 2: 6, 6: 5, 7: 4, 33: 2 };
    if (arity[b1] !== undefined && s.length !== arity[b1] || b1 === 12 && s.length < 2 || b1 === 17 && !c.ps.length)
      throw new PdfParseError('Type1: invalid escape operands');
  }
  switch (b1) {
    case 0: case 1: case 2: s.length = 0; break;              // dotsection, vstem3, hstem3
    case 6:                                                   // seac
      c.seac = { asb: s[0] ?? 0, adx: s[1] ?? 0, ady: s[2] ?? 0, bchar: s[3] ?? 0, achar: s[4] ?? 0 };
      s.length = 0; c.done = true; break;
    case 7:                                                   // sbw
      c.sbx = s[0] ?? 0; c.sby = s[1] ?? 0; c.width = s[2] ?? 0; c.widthY = s[3] ?? 0;
      c.x = c.sbx; c.y = c.sby;
      s.length = 0; break;
    case 12: { const b = s.pop() ?? 1, a = s.pop() ?? 0; if (c.env.strict && !b) throw new PdfParseError('Type1: division by zero'); s.push(b === 0 ? 0 : a / b); break; }  // div
    case 16: othersubr(c); break;                             // callothersubr
    case 17: c.env.work?.allocate(16, 'Type 1 pop'); s.push(c.ps.pop() ?? 0); break; // pop
    case 33:                                                  // setcurrentpoint
      c.x = s[0] ?? c.x; c.y = s[1] ?? c.y; s.length = 0; break;
    default: if (c.env.strict) throw new PdfParseError('Type1: unknown escape'); s.length = 0; break;
  }
}

/**
 * `callothersubr`: `arg1 .. argn n othersubr# callothersubr`.
 *
 * 0/1/2 are the flex protocol and 3 is hint replacement. Anything else is a
 * font-specific PostScript procedure we cannot run, and the spec's rule is that
 * its arguments stay on the PostScript stack for the `pop`s that follow —
 * dropping them desynchronizes every operand after this point.
 */
function othersubr(c: T1Ctx): void {
  const s = c.stack;
  const idx = s.pop() ?? 0;
  const n = s.pop() ?? 0;
  if (c.env.strict && (!Number.isInteger(n) || n < 0 || n > s.length)) throw new PdfParseError('Type1: OtherSubr operands');
  if (c.env.strict && ![0, 1, 2, 3].includes(idx)) throw new UnsupportedFeatureError('Type1 custom OtherSubrs are unsupported');
  c.env.work?.items(n, 'Type 1 OtherSubr arguments'); c.env.work?.allocate(64 + Math.max(0, n) * 32, 'Type 1 OtherSubr');
  c.env.work?.work(Math.max(0, n), 'Type 1 OtherSubr');
  const args: number[] = [];
  for (let k = 0; k < n; k++) args.unshift(s.pop() ?? 0);

  if (idx === 1) { c.env.work?.allocate(64, 'Type 1 flex'); c.flex = []; return; } // begin flex
  if (idx === 2) return;                                      // flex point collected by rmove
  if (idx === 0) {                                            // end flex
    const p = c.flex;
    c.flex = undefined;
    if (c.env.strict && (!p || p.length !== 7 || n !== 3)) throw new PdfParseError('Type1: invalid flex');
    // p[0] is the reference point, which draws nothing; p[1..6] are the two
    // curves' control and end points, already absolute.
    if (p && p.length >= 7) {
      curveTo(c, p[1].x, p[1].y, p[2].x, p[2].y, p[3].x, p[3].y);
      curveTo(c, p[4].x, p[4].y, p[5].x, p[5].y, p[6].x, p[6].y);
    }
    // The trailing `pop pop setcurrentpoint` expects the end point back.
    c.ps.push(c.y, c.x);
    return;
  }
  if (idx === 3) { c.ps.push(args[0] ?? 3); return; }         // hint replacement: subr# back for pop
  for (let k = args.length - 1; k >= 0; k--) c.ps.push(args[k]);
}
