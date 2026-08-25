import type { Path, Seg } from './pagerender.js';

/**
 * One interpreted Type 1 charstring.
 *
 * `width` and `sbx`/`sby` come from `hsbw`/`sbw`. The sidebearing is not merely
 * a metric: it is where the pen starts, so a glyph interpreted without it lands
 * displaced by its own left sidebearing — uniformly enough across a font to look
 * like a slightly wrong face rather than a bug.
 */
export interface Type1Glyph { path: Path; width: number; sbx: number; sby: number; }

/** What a charstring can reach outside itself. */
export interface Type1Env {
  /** Decrypted `/Subrs`, indexed exactly as the font numbers them. Type 2's
   *  subr bias is a Type 2 invention and must not be applied here. */
  subrs: Uint8Array[];
  /** Decrypted charstring for a StandardEncoding code, for `seac`. Absent when
   *  the caller cannot resolve one, which makes `seac` draw nothing. */
  seacGlyph?(stdCode: number): Uint8Array | undefined;
}

const MAX_DEPTH = 10;

interface T1Ctx {
  path: Path;
  x: number; y: number;
  stack: number[];
  /** The PostScript operand stack `callothersubr` writes and `pop` reads. */
  ps: number[];
  open: boolean;
  width: number; sbx: number; sby: number;
  env: Type1Env;
  depth: number;
  /** Non-undefined while an OtherSubrs 1 flex is being accumulated. */
  flex?: { x: number; y: number }[];
  /** Set by `seac`, applied once the charstring has stopped. */
  seac?: { asb: number; adx: number; ady: number; bchar: number; achar: number };
  done: boolean;
}

function moveTo(c: T1Ctx, x: number, y: number): void {
  if (c.open) { c.path.push({ op: 'Z' }); c.open = false; }
  c.x = x; c.y = y;
  c.path.push({ op: 'M', x, y });
  c.open = true;
}
function lineTo(c: T1Ctx, x: number, y: number): void {
  c.x = x; c.y = y;
  c.path.push({ op: 'L', x, y });
}
function curveTo(c: T1Ctx, x1: number, y1: number, x2: number, y2: number, x: number, y: number): void {
  c.x = x; c.y = y;
  c.path.push({ op: 'C', x1, y1, x2, y2, x, y } as Seg);
}

/** Interpret one charstring. Never throws: a damaged charstring costs its own
 *  glyph, matching `CffFont.glyphPath`. */
export function runType1Charstring(code: Uint8Array, env: Type1Env): Type1Glyph {
  const c: T1Ctx = {
    path: [], x: 0, y: 0, stack: [], ps: [], open: false,
    width: 0, sbx: 0, sby: 0, env, depth: 0, done: false,
  };
  try { exec(code, c); } catch { /* keep whatever was drawn */ }
  if (c.seac && env.seacGlyph) applySeac(c, env);
  if (c.open) { c.path.push({ op: 'Z' }); c.open = false; }
  return { path: c.path, width: c.width, sbx: c.sbx, sby: c.sby };
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
  if (base) c.path.push(...runType1Charstring(base, { subrs: env.subrs }).path);
  if (accent) {
    const g = runType1Charstring(accent, { subrs: env.subrs });
    const dx = c.sbx - asb + adx, dy = ady;
    for (const s of g.path) {
      if (s.op === 'Z') c.path.push(s);
      else if (s.op === 'C') {
        c.path.push({ op: 'C', x1: s.x1 + dx, y1: s.y1 + dy, x2: s.x2 + dx, y2: s.y2 + dy, x: s.x + dx, y: s.y + dy });
      } else c.path.push({ op: s.op, x: s.x + dx, y: s.y + dy });
    }
  }
}

function exec(code: Uint8Array, c: T1Ctx): void {
  if (c.depth > MAX_DEPTH) return;
  let i = 0;
  while (i < code.length && !c.done) {
    const b = code[i++];
    if (b >= 32) {                                            // operand
      if (b <= 246) c.stack.push(b - 139);
      else if (b <= 250) { c.stack.push((b - 247) * 256 + code[i] + 108); i += 1; }
      else if (b <= 254) { c.stack.push(-(b - 251) * 256 - code[i] - 108); i += 1; }
      else {                                                  // 255: 32-bit integer, NOT 16.16
        c.stack.push(((code[i] << 24) | (code[i + 1] << 16) | (code[i + 2] << 8) | code[i + 3]) | 0);
        i += 4;
      }
      continue;
    }
    const s = c.stack;
    switch (b) {
      case 1: case 3: s.length = 0; break;                                             // hstem / vstem
      case 4: rmove(c, 0, s[0] ?? 0); s.length = 0; break;                             // vmoveto
      case 5: lineTo(c, c.x + (s[0] ?? 0), c.y + (s[1] ?? 0)); s.length = 0; break;    // rlineto
      case 6: lineTo(c, c.x + (s[0] ?? 0), c.y); s.length = 0; break;                  // hlineto
      case 7: lineTo(c, c.x, c.y + (s[0] ?? 0)); s.length = 0; break;                  // vlineto
      case 8: rrcurve(c, s[0], s[1], s[2], s[3], s[4], s[5]); s.length = 0; break;     // rrcurveto
      case 9: if (c.open) { c.path.push({ op: 'Z' }); c.open = false; } s.length = 0; break;  // closepath
      case 10: {                                              // callsubr — unbiased
        const idx = s.pop() ?? 0;
        const sub = c.env.subrs[idx];
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
      case 12: escape(c, code[i++]); break;
      default: s.length = 0; break;
    }
  }
}

/** A relative moveto — or, inside a flex, one of its seven accumulated points. */
function rmove(c: T1Ctx, dx: number, dy: number): void {
  const nx = c.x + dx, ny = c.y + dy;
  if (c.flex) { c.flex.push({ x: nx, y: ny }); c.x = nx; c.y = ny; return; }
  moveTo(c, nx, ny);
}

function rrcurve(c: T1Ctx, dx1 = 0, dy1 = 0, dx2 = 0, dy2 = 0, dx3 = 0, dy3 = 0): void {
  const x1 = c.x + dx1, y1 = c.y + dy1;
  const x2 = x1 + dx2, y2 = y1 + dy2;
  curveTo(c, x1, y1, x2, y2, x2 + dx3, y2 + dy3);
}

function escape(c: T1Ctx, b1: number): void {
  const s = c.stack;
  switch (b1) {
    case 0: case 1: case 2: s.length = 0; break;              // dotsection, vstem3, hstem3
    case 6:                                                   // seac
      c.seac = { asb: s[0] ?? 0, adx: s[1] ?? 0, ady: s[2] ?? 0, bchar: s[3] ?? 0, achar: s[4] ?? 0 };
      s.length = 0; c.done = true; break;
    case 7:                                                   // sbw
      c.sbx = s[0] ?? 0; c.sby = s[1] ?? 0; c.width = s[2] ?? 0;
      c.x = c.sbx; c.y = c.sby;
      s.length = 0; break;
    case 12: { const b = s.pop() ?? 1, a = s.pop() ?? 0; s.push(b === 0 ? 0 : a / b); break; }  // div
    case 16: othersubr(c); break;                             // callothersubr
    case 17: s.push(c.ps.pop() ?? 0); break;                  // pop
    case 33:                                                  // setcurrentpoint
      c.x = s[0] ?? c.x; c.y = s[1] ?? c.y; s.length = 0; break;
    default: s.length = 0; break;
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
  const args: number[] = [];
  for (let k = 0; k < n; k++) args.unshift(s.pop() ?? 0);

  if (idx === 1) { c.flex = []; return; }                     // begin flex
  if (idx === 2) return;                                      // flex point collected by rmove
  if (idx === 0) {                                            // end flex
    const p = c.flex;
    c.flex = undefined;
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
