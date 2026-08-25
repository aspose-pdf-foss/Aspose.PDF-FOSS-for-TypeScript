# SVG-object embedding (`page.AddSVGObject`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `page.AddSVGObject(data, rect, opts)` parses an SVG asset and draws its
geometry and paint onto a page as a Form XObject fitted to `rect`, reporting any
elements it had to skip.

**Architecture:** Four pure modules plus a walker and a placer, following the
barcode stack's precedent (`barcode.ts` / `qr.ts` / `barcodeplace.ts`). The
walker consumes `XmlNode` from `xml.ts` directly — there is no parallel model
tree, because only the arithmetic benefits from being pure. Affine helpers are
reused from `text.ts`, not redefined.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. Zero runtime
dependencies.

Spec: [docs/superpowers/specs/2026-07-28-svg-embedding-design.md](../specs/2026-07-28-svg-embedding-design.md).
Issue: `aspose-pdf-foss-for-ts-1gg0.3`.

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext:** every import specifier carries the `.js` extension
  (`import { mul } from './text.js'`).
- **`strict` TypeScript.** `npm run typecheck` must pass.
- **TDD:** write the failing test first, watch it fail, then implement.
- **Reuse `text.ts`'s affine helpers** — `Matrix`, `IDENTITY`, `mul(m, n)`
  ("m followed by n"), `apply`. Do NOT define a second matrix type.
- **`svgpath.ts`, `svgstyle.ts`, `svgtransform.ts` and `svgdraw.ts` must not
  import `Document` or `Page`.** They deal in numbers, strings and `XmlNode`
  only. `/ExtGState` entries are emitted as **direct** dicts inside the Form
  XObject's own `/Resources`, so no object allocation is needed.
- **Public error types only:** `PdfParseError` (errors.ts) and `TypeError`.
- **Commit after each task.** Do not use TodoWrite; this project tracks work in
  `bd` (issue `aspose-pdf-foss-for-ts-1gg0.3`).
- Run `npx vitest run test/svg-*.test.ts` for this feature's suites;
  `npm test` for the full run.

## File Structure

| File | Responsibility |
|---|---|
| `src/svgpath.ts` (create) | `d` grammar → cubic segments; arc/quad conversion; basic-shape segment builders |
| `src/svgtransform.ts` (create) | `transform` lists; `viewBox` + `preserveAspectRatio` → placement matrix |
| `src/svgstyle.ts` (create) | colour parsing; presentation-attribute + `style=` cascade |
| `src/svgdraw.ts` (create) | walks `XmlNode`, emits a content stream + resources + skipped list |
| `src/svgembed.ts` (create) | `AddSVGOptions`, `AddSVGResult`, `addSvgObject` — XObject assembly and placement |
| `src/page.ts` (modify) | `Page.AddSVGObject` delegating to `addSvgObject` |
| `src/index.ts` (modify) | export `AddSVGOptions`, `AddSVGResult` |
| `test/svg-path.test.ts` (create) | Tasks 1-2 |
| `test/svg-transform.test.ts` (create) | Task 3 |
| `test/svg-style.test.ts` (create) | Task 4 |
| `test/svg-draw.test.ts` (create) | Tasks 5-6 |
| `test/svg-embed.test.ts` (create) | Tasks 7-8 |
| `README.md` (modify) | feature bullet + API table row |

### Things you must know before starting

**SVG's y axis points down; PDF's points up.** The design confines this to ONE
place: content is emitted in raw viewBox units with y still downward, and the
single placement matrix from `placementMatrix` composes the fit and the flip.
Never flip anywhere else.

**`xml.ts` is already the parser.** `parseXml(bytes: Uint8Array): XmlNode`
strips namespace prefixes, so `xlink:href` arrives as `href` and `<svg:rect>`
as `rect`. It throws `PdfParseError` on malformed input — do not catch it.

**`text.ts` owns the matrix type.** `mul(m, n)` is "m followed by n". SVG's
`transform="A B"` means A is applied to the coordinate system first from the
outside, i.e. a point is transformed by B then A. In `mul` terms that is
`mul(B, A)` — fold the list **right to left**. This is the single most common
transform bug; Task 3 tests it explicitly.

**`/ExtGState` goes in the XObject's own `/Resources`, as direct dicts.**
`registerExtGState` in pagecontent.ts is page-bound and sets `ca` and `CA` to the
same value; SVG needs them independent. Do not use it.

---

### Task 1: `svgpath.ts` — the `d` grammar and arc conversion

**Files:**
- Create: `src/svgpath.ts`
- Test: `test/svg-path.test.ts` (create)

**Interfaces:**
- Consumes: nothing. This module imports nothing.
- Produces:
  - `interface SvgSeg { op: 'M' | 'L' | 'C' | 'Z'; args: number[] }` — `M`/`L`
    carry `[x, y]`, `C` carries `[x1, y1, x2, y2, x, y]`, `Z` carries `[]`.
  - `parsePath(d: string): { segs: SvgSeg[]; truncated: boolean }`
  - `arcToCubics(x0, y0, rx, ry, phiDeg, fa, fs, x, y): number[][]` — each entry
    a 6-number cubic. Returns `[]` when the endpoints coincide.

- [x] **Step 1: Write the failing tests**

Create `test/svg-path.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parsePath, type SvgSeg } from '../src/svgpath.js';

/** Evaluate one coordinate of a cubic Bezier at t. */
const bez = (p0: number, p1: number, p2: number, p3: number, t: number): number => {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
};

const ops = (segs: SvgSeg[]) => segs.map((s) => s.op).join('');

describe('parsePath — commands', () => {
  it('parses absolute moveto and lineto', () => {
    const { segs, truncated } = parsePath('M 10 20 L 30 40');
    expect(truncated).toBe(false);
    expect(segs).toEqual([
      { op: 'M', args: [10, 20] },
      { op: 'L', args: [30, 40] },
    ]);
  });

  it('treats relative commands as offsets from the current point', () => {
    const { segs } = parsePath('m 10 10 l 5 5 l 5 5');
    expect(segs).toEqual([
      { op: 'M', args: [10, 10] },
      { op: 'L', args: [15, 15] },
      { op: 'L', args: [20, 20] },
    ]);
  });

  it('repeats the previous command for extra argument groups', () => {
    const { segs } = parsePath('M0 0 L1 1 2 2 3 3');
    expect(ops(segs)).toBe('MLLL');
    expect(segs[3].args).toEqual([3, 3]);
  });

  it('promotes a repeated moveto to a lineto', () => {
    const { segs } = parsePath('M0 0 1 1 2 2');
    expect(ops(segs)).toBe('MLL');
    expect(segs[1].args).toEqual([1, 1]);
  });

  it('expands H and V against the current point', () => {
    const { segs } = parsePath('M10 20 H30 V40 h5 v5');
    expect(segs.slice(1)).toEqual([
      { op: 'L', args: [30, 20] },
      { op: 'L', args: [30, 40] },
      { op: 'L', args: [35, 40] },
      { op: 'L', args: [35, 45] },
    ]);
  });

  it('closes a subpath and returns the pen to its start', () => {
    const { segs } = parsePath('M10 10 L20 20 Z L30 30');
    expect(ops(segs)).toBe('MLZL');
    // After Z the current point is the subpath start, so a relative move would
    // resume there; the absolute L just records its own point.
    expect(segs[3].args).toEqual([30, 30]);
  });

  it('accepts exponent notation and omitted separators', () => {
    const { segs } = parsePath('M1e2 2E1L-.5.5');
    expect(segs[0].args).toEqual([100, 20]);
    expect(segs[1].args).toEqual([-0.5, 0.5]);
  });

  it('reflects the previous control point for S', () => {
    const { segs } = parsePath('M0 0 C1 1 2 2 3 3 S5 5 6 6');
    // Reflection of (2,2) about (3,3) is (4,4).
    expect(segs[2].args).toEqual([4, 4, 5, 5, 6, 6]);
  });

  it('uses the current point as the S control when no cubic preceded', () => {
    const { segs } = parsePath('M1 1 S5 5 6 6');
    expect(segs[1].args).toEqual([1, 1, 5, 5, 6, 6]);
  });

  it('converts a quadratic to its exact cubic equivalent', () => {
    const { segs } = parsePath('M0 0 Q3 3 6 0');
    // c1 = p0 + 2/3 (q - p0) = (2,2) ; c2 = p1 + 2/3 (q - p1) = (4,2)
    expect(segs[1].args).toEqual([2, 2, 4, 2, 6, 0]);
  });

  it('reflects the previous quadratic control point for T', () => {
    const { segs } = parsePath('M0 0 Q3 3 6 0 T12 0');
    // Reflected q = (9,-3); c1 = (6,0)+2/3((9,-3)-(6,0)) = (8,-2)
    expect(segs[2].args).toEqual([8, -2, 10, -2, 12, 0]);
  });
});

describe('parsePath — arcs', () => {
  it('converts a quarter arc to a cubic that lies on the circle', () => {
    // fa=0, fs=1 puts the centre at the origin (radius 100).
    const { segs } = parsePath('M100 0 A100 100 0 0 1 0 100');
    expect(ops(segs)).toBe('MC');
    const a = segs[1].args;
    expect(a.slice(4)).toEqual([0, 100]);              // exact endpoint
    // Independent check: sample the cubic and assert it is on x^2+y^2=100^2.
    // NOT compared against our own converter.
    for (const t of [0.25, 0.5, 0.75]) {
      const x = bez(100, a[0], a[2], a[4], t);
      const y = bez(0, a[1], a[3], a[5], t);
      expect(Math.hypot(x, y)).toBeCloseTo(100, 1);
    }
  });

  it('splits an arc larger than 90 degrees into several cubics', () => {
    const { segs } = parsePath('M100 0 A100 100 0 1 1 -100 0');   // 180 degrees
    expect(segs.filter((s) => s.op === 'C').length).toBeGreaterThan(1);
    const last = segs[segs.length - 1].args;
    expect(last.slice(4)).toEqual([-100, 0]);
  });

  it('honours all four large-arc / sweep combinations', () => {
    const ends = ['0 0', '0 1', '1 0', '1 1'].map((f) => {
      const { segs } = parsePath(`M0 0 A50 50 0 ${f} 50 50`);
      return segs[segs.length - 1].args.slice(4);
    });
    for (const e of ends) expect(e).toEqual([50, 50]);   // all reach the endpoint
    // Small and large arcs bow to opposite sides, so their midpoints differ.
    const mid = (f: string) => {
      const { segs } = parsePath(`M0 0 A50 50 0 ${f} 50 50`);
      const a = segs[1].args;
      return bez(0, a[0], a[2], a[4], 0.5);
    };
    expect(mid('0 0')).not.toBeCloseTo(mid('1 0'), 3);
  });

  it('reads unseparated arc flags', () => {
    // "a1 1 0 011 1" packs largeArc=0, sweep=1, x=1, y=1 with no separators.
    // A number reader would swallow "011" as one token and lose the arc.
    const { segs, truncated } = parsePath('M0 0a1 1 0 011 1');
    expect(truncated).toBe(false);
    expect(segs[segs.length - 1].args.slice(4)).toEqual([1, 1]);
  });

  it('degrades a zero-radius arc to a line', () => {
    const { segs } = parsePath('M0 0 A0 50 0 0 1 100 0');
    expect(segs).toEqual([
      { op: 'M', args: [0, 0] },
      { op: 'L', args: [100, 0] },
    ]);
  });

  it('scales up radii too small to span the endpoints', () => {
    const { segs } = parsePath('M0 0 A1 1 0 0 1 100 0');
    expect(segs[segs.length - 1].args.slice(4)).toEqual([100, 0]);
  });
});

describe('parsePath — malformed input', () => {
  it('renders the valid prefix and reports truncation', () => {
    const { segs, truncated } = parsePath('M10 10 L20 20 L30');
    expect(ops(segs)).toBe('ML');
    expect(truncated).toBe(true);
  });

  it('stops at an unknown command', () => {
    const { segs, truncated } = parsePath('M0 0 L1 1 X9 9');
    expect(ops(segs)).toBe('ML');
    expect(truncated).toBe(true);
  });

  it('returns nothing for empty or leading-garbage data', () => {
    expect(parsePath('')).toEqual({ segs: [], truncated: false });
    expect(parsePath('   ').segs).toEqual([]);
    expect(parsePath('5 5 L1 1').truncated).toBe(true);
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/svg-path.test.ts`
Expected: FAIL — cannot resolve `../src/svgpath.js`.

- [x] **Step 3: Create `src/svgpath.ts`**

```ts
// SVG path data: the `d` grammar normalized to cubics (issue 1gg0.3). Pure —
// imports nothing, touches no PDF objects. Every command becomes M / L / C / Z,
// so the emitter in svgdraw.ts only ever has four cases to handle.

/** One normalized path segment. `M`/`L` carry [x, y]; `C` carries
 *  [x1, y1, x2, y2, x, y]; `Z` carries nothing. */
export interface SvgSeg {
  op: 'M' | 'L' | 'C' | 'Z';
  args: number[];
}

const NUM = /^[+-]?(\d*\.\d+|\d+\.?)([eE][+-]?\d+)?/;
const IS_CMD = /[MmLlHhVvCcSsQqTtAaZz]/;

class Reader {
  i = 0;
  constructor(readonly s: string) {}
  ws(): void { while (this.i < this.s.length && (this.s[this.i] === ',' || /\s/.test(this.s[this.i]))) this.i++; }
  eof(): boolean { this.ws(); return this.i >= this.s.length; }
  peek(): string { this.ws(); return this.s[this.i]; }
  num(): number | undefined {
    this.ws();
    const m = NUM.exec(this.s.slice(this.i));
    if (!m || m[0] === '' || m[0] === '.' || m[0] === '+' || m[0] === '-') return undefined;
    this.i += m[0].length;
    return parseFloat(m[0]);
  }
  /** An arc flag is a single '0' or '1' and may carry no separator at all
   *  ("a1 1 0 011 1"), so it cannot go through num(). */
  flag(): number | undefined {
    this.ws();
    const c = this.s[this.i];
    if (c !== '0' && c !== '1') return undefined;
    this.i++;
    return c === '1' ? 1 : 0;
  }
}

/** Convert an endpoint-parameterized elliptical arc to a list of cubics
 *  (SVG 1.1 F.6.5). Each entry is [x1, y1, x2, y2, x, y]. Returns [] when the
 *  endpoints coincide, which SVG defines as drawing nothing. Callers must
 *  handle rx or ry of 0 themselves — that degenerates to a straight line. */
export function arcToCubics(
  x0: number, y0: number, rx: number, ry: number, phiDeg: number,
  fa: number, fs: number, x: number, y: number,
): number[][] {
  if (x0 === x && y0 === y) return [];
  rx = Math.abs(rx); ry = Math.abs(ry);
  const phi = (phiDeg * Math.PI) / 180;
  const cosP = Math.cos(phi), sinP = Math.sin(phi);

  const dx2 = (x0 - x) / 2, dy2 = (y0 - y) / 2;
  const x1p = cosP * dx2 + sinP * dy2;
  const y1p = -sinP * dx2 + cosP * dy2;

  // F.6.6: scale the radii up when they cannot span the chord.
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) { const s = Math.sqrt(lambda); rx *= s; ry *= s; }

  const sign = fa === fs ? -1 : 1;
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const co = sign * Math.sqrt(Math.max(0, num / den));
  const cxp = (co * rx * y1p) / ry;
  const cyp = (-co * ry * x1p) / rx;
  const cx = cosP * cxp - sinP * cyp + (x0 + x) / 2;
  const cy = sinP * cxp + cosP * cyp + (y0 + y) / 2;

  const ang = (ux: number, uy: number, vx: number, vy: number): number => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let a = Math.acos(Math.min(1, Math.max(-1, len === 0 ? 1 : dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const ux = (x1p - cxp) / rx, uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx, vy = (-y1p - cyp) / ry;
  const theta1 = ang(1, 0, ux, uy);
  let dtheta = ang(ux, uy, vx, vy);
  if (!fs && dtheta > 0) dtheta -= 2 * Math.PI;
  if (fs && dtheta < 0) dtheta += 2 * Math.PI;

  // A cubic approximates at most a quarter turn well, so split first.
  const n = Math.max(1, Math.ceil(Math.abs(dtheta) / (Math.PI / 2)));
  const delta = dtheta / n;
  const k = (4 / 3) * Math.tan(delta / 4);
  const out: number[][] = [];
  let th = theta1, px = x0, py = y0;
  for (let i = 0; i < n; i++) {
    const th2 = th + delta;
    const cos1 = Math.cos(th), sin1 = Math.sin(th);
    const cos2 = Math.cos(th2), sin2 = Math.sin(th2);
    const ex = cosP * rx * cos2 - sinP * ry * sin2 + cx;
    const ey = sinP * rx * cos2 + cosP * ry * sin2 + cy;
    const d1x = cosP * -rx * sin1 - sinP * ry * cos1;
    const d1y = sinP * -rx * sin1 + cosP * ry * cos1;
    const d2x = cosP * -rx * sin2 - sinP * ry * cos2;
    const d2y = sinP * -rx * sin2 + cosP * ry * cos2;
    out.push([px + k * d1x, py + k * d1y, ex - k * d2x, ey - k * d2y, ex, ey]);
    px = ex; py = ey; th = th2;
  }
  return out;
}

/** Parse SVG path data into normalized segments. Malformed data is not an
 *  error: SVG's own rule is to render the valid prefix and stop, which is what
 *  `truncated` reports so the caller can flag the degradation. */
export function parsePath(d: string): { segs: SvgSeg[]; truncated: boolean } {
  const r = new Reader(d ?? '');
  const segs: SvgSeg[] = [];
  let cmd = '';
  let cx = 0, cy = 0;      // current point
  let sx = 0, sy = 0;      // start of the current subpath
  let lastC: [number, number] | undefined;   // previous cubic control, for S
  let lastQ: [number, number] | undefined;   // previous quadratic control, for T

  const cubic = (x1: number, y1: number, x2: number, y2: number, x: number, y: number): void => {
    segs.push({ op: 'C', args: [x1, y1, x2, y2, x, y] });
    cx = x; cy = y;
  };

  for (;;) {
    if (r.eof()) return { segs, truncated: false };
    const c = r.peek();
    if (/[A-Za-z]/.test(c)) {
      if (!IS_CMD.test(c)) return { segs, truncated: true };
      cmd = c; r.i++;
    } else if (cmd === '') {
      return { segs, truncated: true };     // numbers before any command
    } else if (cmd === 'M') { cmd = 'L'; }  // a repeated moveto is a lineto
    else if (cmd === 'm') { cmd = 'l'; }

    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? cx : 0, oy = rel ? cy : 0;

    switch (cmd.toUpperCase()) {
      case 'Z':
        segs.push({ op: 'Z', args: [] });
        cx = sx; cy = sy; lastC = lastQ = undefined;
        continue;
      case 'M': {
        const x = r.num(), y = r.num();
        if (x === undefined || y === undefined) return { segs, truncated: true };
        cx = x + ox; cy = y + oy; sx = cx; sy = cy;
        segs.push({ op: 'M', args: [cx, cy] });
        lastC = lastQ = undefined;
        continue;
      }
      case 'L': {
        const x = r.num(), y = r.num();
        if (x === undefined || y === undefined) return { segs, truncated: true };
        cx = x + ox; cy = y + oy;
        segs.push({ op: 'L', args: [cx, cy] });
        lastC = lastQ = undefined;
        continue;
      }
      case 'H': {
        const x = r.num();
        if (x === undefined) return { segs, truncated: true };
        cx = x + ox;
        segs.push({ op: 'L', args: [cx, cy] });
        lastC = lastQ = undefined;
        continue;
      }
      case 'V': {
        const y = r.num();
        if (y === undefined) return { segs, truncated: true };
        cy = y + oy;
        segs.push({ op: 'L', args: [cx, cy] });
        lastC = lastQ = undefined;
        continue;
      }
      case 'C': {
        const a = [r.num(), r.num(), r.num(), r.num(), r.num(), r.num()];
        if (a.some((v) => v === undefined)) return { segs, truncated: true };
        const [x1, y1, x2, y2, x, y] = a as number[];
        lastC = [x2 + ox, y2 + oy]; lastQ = undefined;
        cubic(x1 + ox, y1 + oy, x2 + ox, y2 + oy, x + ox, y + oy);
        continue;
      }
      case 'S': {
        const a = [r.num(), r.num(), r.num(), r.num()];
        if (a.some((v) => v === undefined)) return { segs, truncated: true };
        const [x2, y2, x, y] = a as number[];
        const rx1 = lastC ? 2 * cx - lastC[0] : cx;
        const ry1 = lastC ? 2 * cy - lastC[1] : cy;
        lastC = [x2 + ox, y2 + oy]; lastQ = undefined;
        cubic(rx1, ry1, x2 + ox, y2 + oy, x + ox, y + oy);
        continue;
      }
      case 'Q': {
        const a = [r.num(), r.num(), r.num(), r.num()];
        if (a.some((v) => v === undefined)) return { segs, truncated: true };
        const [qx, qy, x, y] = a as number[];
        const ax = qx + ox, ay = qy + oy, ex = x + ox, ey = y + oy;
        lastQ = [ax, ay]; lastC = undefined;
        cubic(cx + (2 / 3) * (ax - cx), cy + (2 / 3) * (ay - cy),
              ex + (2 / 3) * (ax - ex), ey + (2 / 3) * (ay - ey), ex, ey);
        continue;
      }
      case 'T': {
        const a = [r.num(), r.num()];
        if (a.some((v) => v === undefined)) return { segs, truncated: true };
        const [x, y] = a as number[];
        const ax = lastQ ? 2 * cx - lastQ[0] : cx;
        const ay = lastQ ? 2 * cy - lastQ[1] : cy;
        const ex = x + ox, ey = y + oy;
        lastQ = [ax, ay]; lastC = undefined;
        cubic(cx + (2 / 3) * (ax - cx), cy + (2 / 3) * (ay - cy),
              ex + (2 / 3) * (ax - ex), ey + (2 / 3) * (ay - ey), ex, ey);
        continue;
      }
      case 'A': {
        const rx = r.num(), ry = r.num(), rot = r.num();
        const fa = r.flag(), fs = r.flag();
        const x = r.num(), y = r.num();
        if ([rx, ry, rot, fa, fs, x, y].some((v) => v === undefined))
          return { segs, truncated: true };
        const ex = (x as number) + ox, ey = (y as number) + oy;
        if (rx === 0 || ry === 0) {
          cx = ex; cy = ey;
          segs.push({ op: 'L', args: [cx, cy] });
        } else {
          for (const cu of arcToCubics(cx, cy, rx as number, ry as number,
                                       rot as number, fa as number, fs as number, ex, ey))
            segs.push({ op: 'C', args: cu });
          cx = ex; cy = ey;
        }
        lastC = lastQ = undefined;
        continue;
      }
      default:
        return { segs, truncated: true };
    }
  }
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/svg-path.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [x] **Step 5: Commit**

```bash
git add src/svgpath.ts test/svg-path.test.ts
git commit -m "feat(svg): path data grammar normalized to cubics (1gg0.3)"
```

---

### Task 2: `svgpath.ts` — basic-shape segment builders

**Files:**
- Modify: `src/svgpath.ts` (append)
- Test: `test/svg-path.test.ts` (append a describe)

**Interfaces:**
- Consumes: `SvgSeg` (Task 1).
- Produces:
  - `rectSegs(x, y, w, h, rx, ry): SvgSeg[]`
  - `ellipseSegs(cx, cy, rx, ry): SvgSeg[]`
  - `polySegs(pts: number[], close: boolean): SvgSeg[]`
  - `parsePoints(s: string): number[]`

- [x] **Step 1: Write the failing tests**

Append to `test/svg-path.test.ts`, extending the import to
`import { parsePath, rectSegs, ellipseSegs, polySegs, parsePoints, type SvgSeg } from '../src/svgpath.js';`:

```ts
describe('shape segment builders', () => {
  it('builds a sharp rect as four lines and a close', () => {
    const segs = rectSegs(10, 20, 30, 40, 0, 0);
    expect(segs.map((s) => s.op).join('')).toBe('MLLLZ');
    expect(segs[0].args).toEqual([10, 20]);
    expect(segs[1].args).toEqual([40, 20]);
    expect(segs[2].args).toEqual([40, 60]);
    expect(segs[3].args).toEqual([10, 60]);
  });

  it('builds a rounded rect with four corner curves', () => {
    const segs = rectSegs(0, 0, 100, 50, 10, 10);
    expect(segs.filter((s) => s.op === 'C').length).toBe(4);
    expect(segs[segs.length - 1].op).toBe('Z');
    // The first point is the start of the top edge, past the corner radius.
    expect(segs[0].args).toEqual([10, 0]);
  });

  it('clamps corner radii to half the side', () => {
    const segs = rectSegs(0, 0, 20, 10, 50, 50);   // rx -> 10, ry -> 5
    expect(segs[0].args).toEqual([10, 0]);
  });

  it('defaults a missing ry to rx and vice versa', () => {
    expect(rectSegs(0, 0, 100, 50, 10, NaN)).toEqual(rectSegs(0, 0, 100, 50, 10, 10));
    expect(rectSegs(0, 0, 100, 50, NaN, 10)).toEqual(rectSegs(0, 0, 100, 50, 10, 10));
  });

  it('builds an ellipse from four cubics whose samples lie on the curve', () => {
    const segs = ellipseSegs(0, 0, 100, 50);
    expect(segs.filter((s) => s.op === 'C').length).toBe(4);
    // Independent check: the four on-curve endpoints are the axis extremes.
    const ends = segs.filter((s) => s.op === 'C').map((s) => s.args.slice(4));
    expect(ends).toContainEqual([0, 50]);
    expect(ends).toContainEqual([-100, 0]);
    expect(ends).toContainEqual([0, -50]);
    expect(ends).toContainEqual([100, 0]);
  });

  it('builds an open polyline and a closed polygon', () => {
    expect(polySegs([0, 0, 10, 0, 10, 10], false).map((s) => s.op).join('')).toBe('MLL');
    expect(polySegs([0, 0, 10, 0, 10, 10], true).map((s) => s.op).join('')).toBe('MLLZ');
  });

  it('returns nothing for fewer than two points', () => {
    expect(polySegs([5], false)).toEqual([]);
    expect(polySegs([], true)).toEqual([]);
  });

  it('parses point lists with commas, spaces or neither', () => {
    expect(parsePoints('0,0 10,0 10,10')).toEqual([0, 0, 10, 0, 10, 10]);
    expect(parsePoints('0 0 10 0')).toEqual([0, 0, 10, 0]);
    expect(parsePoints('1-2 3-4')).toEqual([1, -2, 3, -4]);
    expect(parsePoints('  ')).toEqual([]);
  });

  it('drops a trailing odd coordinate', () => {
    expect(parsePoints('0 0 10 0 5')).toEqual([0, 0, 10, 0]);
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/svg-path.test.ts -t "shape segment builders"`
Expected: FAIL — `rectSegs is not a function`.

- [x] **Step 3: Append the builders to `src/svgpath.ts`**

```ts
/** k for approximating a quarter ellipse with one cubic. */
const KAPPA = 0.5522847498307936;

/** A `<rect>` as segments. `rx`/`ry` may be NaN (absent): each defaults to the
 *  other, and both are clamped to half the corresponding side, per SVG 1.1. */
export function rectSegs(
  x: number, y: number, w: number, h: number, rx: number, ry: number,
): SvgSeg[] {
  if (!(w > 0) || !(h > 0)) return [];
  let a = Number.isFinite(rx) ? rx : (Number.isFinite(ry) ? ry : 0);
  let b = Number.isFinite(ry) ? ry : (Number.isFinite(rx) ? rx : 0);
  a = Math.min(Math.max(a, 0), w / 2);
  b = Math.min(Math.max(b, 0), h / 2);
  if (a === 0 || b === 0) {
    return [
      { op: 'M', args: [x, y] },
      { op: 'L', args: [x + w, y] },
      { op: 'L', args: [x + w, y + h] },
      { op: 'L', args: [x, y + h] },
      { op: 'Z', args: [] },
    ];
  }
  const ox = a * KAPPA, oy = b * KAPPA;
  return [
    { op: 'M', args: [x + a, y] },
    { op: 'L', args: [x + w - a, y] },
    { op: 'C', args: [x + w - a + ox, y, x + w, y + b - oy, x + w, y + b] },
    { op: 'L', args: [x + w, y + h - b] },
    { op: 'C', args: [x + w, y + h - b + oy, x + w - a + ox, y + h, x + w - a, y + h] },
    { op: 'L', args: [x + a, y + h] },
    { op: 'C', args: [x + a - ox, y + h, x, y + h - b + oy, x, y + h - b] },
    { op: 'L', args: [x, y + b] },
    { op: 'C', args: [x, y + b - oy, x + a - ox, y, x + a, y] },
    { op: 'Z', args: [] },
  ];
}

/** An `<ellipse>` (or `<circle>`, with rx === ry) as four cubics. */
export function ellipseSegs(cx: number, cy: number, rx: number, ry: number): SvgSeg[] {
  if (!(rx > 0) || !(ry > 0)) return [];
  const ox = rx * KAPPA, oy = ry * KAPPA;
  return [
    { op: 'M', args: [cx + rx, cy] },
    { op: 'C', args: [cx + rx, cy + oy, cx + ox, cy + ry, cx, cy + ry] },
    { op: 'C', args: [cx - ox, cy + ry, cx - rx, cy + oy, cx - rx, cy] },
    { op: 'C', args: [cx - rx, cy - oy, cx - ox, cy - ry, cx, cy - ry] },
    { op: 'C', args: [cx + ox, cy - ry, cx + rx, cy - oy, cx + rx, cy] },
    { op: 'Z', args: [] },
  ];
}

/** A `<polyline>` (close false) or `<polygon>` (close true) from a flat
 *  [x0, y0, x1, y1, …] list. Fewer than two points draws nothing. */
export function polySegs(pts: number[], close: boolean): SvgSeg[] {
  if (pts.length < 4) return [];
  const segs: SvgSeg[] = [{ op: 'M', args: [pts[0], pts[1]] }];
  for (let i = 2; i + 1 < pts.length; i += 2) segs.push({ op: 'L', args: [pts[i], pts[i + 1]] });
  if (close) segs.push({ op: 'Z', args: [] });
  return segs;
}

/** Parse a `points` attribute. Separators are optional, so "1-2 3-4" is four
 *  numbers. A trailing unpaired coordinate is dropped, per SVG error handling. */
export function parsePoints(s: string): number[] {
  const r = new Reader(s ?? '');
  const out: number[] = [];
  for (;;) {
    const n = r.num();
    if (n === undefined) break;
    out.push(n);
  }
  if (out.length % 2 === 1) out.pop();
  return out;
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/svg-path.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [x] **Step 5: Commit**

```bash
git add src/svgpath.ts test/svg-path.test.ts
git commit -m "feat(svg): basic-shape segment builders (1gg0.3)"
```

---

### Task 3: `svgtransform.ts` — transforms and the placement matrix

**Files:**
- Create: `src/svgtransform.ts`
- Test: `test/svg-transform.test.ts` (create)

**Interfaces:**
- Consumes: `Matrix`, `IDENTITY`, `mul` from `./text.js`.
- Produces:
  - `parseTransform(s: string | undefined): Matrix`
  - `interface ViewBox { minX: number; minY: number; w: number; h: number }`
  - `parseViewBox(s: string | undefined): ViewBox | undefined`
  - `placementMatrix(vb, rect, par, fit?): Matrix`

- [x] **Step 1: Write the failing tests**

Create `test/svg-transform.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseTransform, parseViewBox, placementMatrix } from '../src/svgtransform.js';
import { apply } from '../src/text.js';

const at = (m: ReturnType<typeof parseTransform>, x: number, y: number) =>
  apply(m, x, y).map((n) => Math.round(n * 1e6) / 1e6);

describe('parseTransform', () => {
  it('is the identity for an absent or empty value', () => {
    expect(parseTransform(undefined)).toEqual([1, 0, 0, 1, 0, 0]);
    expect(parseTransform('')).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it('translates, with a defaulted y', () => {
    expect(at(parseTransform('translate(10, 20)'), 0, 0)).toEqual([10, 20]);
    expect(at(parseTransform('translate(10)'), 0, 0)).toEqual([10, 0]);
  });

  it('scales, with a defaulted uniform y', () => {
    expect(at(parseTransform('scale(2, 3)'), 1, 1)).toEqual([2, 3]);
    expect(at(parseTransform('scale(2)'), 1, 1)).toEqual([2, 2]);
  });

  it('rotates about the origin', () => {
    expect(at(parseTransform('rotate(90)'), 1, 0)).toEqual([0, 1]);
  });

  it('rotates about an explicit centre', () => {
    expect(at(parseTransform('rotate(90, 10, 10)'), 10, 10)).toEqual([10, 10]);
    expect(at(parseTransform('rotate(90, 10, 10)'), 20, 10)).toEqual([10, 20]);
  });

  it('skews on each axis', () => {
    expect(at(parseTransform('skewX(45)'), 0, 1)).toEqual([1, 1]);
    expect(at(parseTransform('skewY(45)'), 1, 0)).toEqual([1, 1]);
  });

  it('takes a raw matrix', () => {
    expect(parseTransform('matrix(1 2 3 4 5 6)')).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('composes a list left to right, outermost first', () => {
    // translate then scale: the translation is NOT scaled.
    expect(at(parseTransform('translate(10 0) scale(2)'), 1, 0)).toEqual([12, 0]);
    // scale then translate: the translation IS scaled.
    expect(at(parseTransform('scale(2) translate(10 0)'), 1, 0)).toEqual([22, 0]);
  });

  it('tolerates commas, extra space and unknown functions', () => {
    expect(at(parseTransform('  translate( 10 , 20 )  '), 0, 0)).toEqual([10, 20]);
    expect(at(parseTransform('translate(10 0) bogus(1) scale(2)'), 1, 0)).toEqual([12, 0]);
  });
});

describe('parseViewBox', () => {
  it('parses four numbers', () => {
    expect(parseViewBox('0 0 100 50')).toEqual({ minX: 0, minY: 0, w: 100, h: 50 });
    expect(parseViewBox('-10,-20,30,40')).toEqual({ minX: -10, minY: -20, w: 30, h: 40 });
  });

  it('rejects a malformed or non-positive box', () => {
    expect(parseViewBox(undefined)).toBeUndefined();
    expect(parseViewBox('0 0 100')).toBeUndefined();
    expect(parseViewBox('0 0 0 50')).toBeUndefined();
    expect(parseViewBox('0 0 -5 50')).toBeUndefined();
  });
});

describe('placementMatrix', () => {
  const vb = { minX: 0, minY: 0, w: 100, h: 50 };
  const rect: [number, number, number, number] = [0, 0, 200, 200];

  it('flips the y axis: the viewBox top maps to the rect top', () => {
    // 'none' fills the rect exactly, so the mapping is easy to read.
    const m = placementMatrix(vb, rect, 'none');
    expect(at(m, 0, 0)).toEqual([0, 200]);       // SVG top-left  -> PDF top-left
    expect(at(m, 100, 50)).toEqual([200, 0]);    // SVG bottom-right -> PDF bottom-right
  });

  it('meet fits inside and centres on the short axis', () => {
    const m = placementMatrix(vb, rect, 'xMidYMid meet');
    // scale = min(200/100, 200/50) = 2 -> drawn 200x100, centred vertically.
    expect(at(m, 0, 0)).toEqual([0, 150]);
    expect(at(m, 100, 50)).toEqual([200, 50]);
  });

  it('slice covers the rect and overflows', () => {
    const m = placementMatrix(vb, rect, 'xMidYMid slice');
    // scale = max(200/100, 200/50) = 4 -> drawn 400x200, centred horizontally.
    expect(at(m, 0, 0)).toEqual([-100, 200]);
    expect(at(m, 100, 50)).toEqual([300, 0]);
  });

  it('honours each alignment corner', () => {
    expect(at(placementMatrix(vb, rect, 'xMinYMin meet'), 0, 0)).toEqual([0, 200]);
    expect(at(placementMatrix(vb, rect, 'xMaxYMax meet'), 0, 0)).toEqual([0, 100]);
    expect(at(placementMatrix(vb, rect, 'xMaxYMin meet'), 100, 0)).toEqual([200, 200]);
  });

  it('defaults to xMidYMid meet when preserveAspectRatio is absent', () => {
    expect(placementMatrix(vb, rect, undefined)).toEqual(placementMatrix(vb, rect, 'xMidYMid meet'));
  });

  it('lets fit override the file', () => {
    expect(placementMatrix(vb, rect, 'xMinYMin slice', 'meet'))
      .toEqual(placementMatrix(vb, rect, 'xMidYMid meet'));
    expect(placementMatrix(vb, rect, 'xMidYMid meet', 'fill'))
      .toEqual(placementMatrix(vb, rect, 'none'));
    expect(placementMatrix(vb, rect, 'none', 'slice'))
      .toEqual(placementMatrix(vb, rect, 'xMidYMid slice'));
  });

  it('offsets a viewBox whose origin is not zero', () => {
    const m = placementMatrix({ minX: 10, minY: 20, w: 100, h: 50 }, rect, 'none');
    expect(at(m, 10, 20)).toEqual([0, 200]);
  });

  it('honours a rect that is not at the origin', () => {
    const m = placementMatrix(vb, [50, 100, 200, 200], 'none');
    expect(at(m, 0, 0)).toEqual([50, 300]);
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/svg-transform.test.ts`
Expected: FAIL — cannot resolve `../src/svgtransform.js`.

- [x] **Step 3: Create `src/svgtransform.ts`**

```ts
// SVG geometry: transform lists, and the viewBox -> target-rect placement
// matrix that also carries the y-axis flip (issue 1gg0.3). Pure — imports only
// the shared affine helpers from text.ts, which owns the Matrix type.
import { IDENTITY, mul, type Matrix } from './text.js';

const NUMS = /[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/g;

function numbers(s: string): number[] {
  return (s.match(NUMS) ?? []).map(parseFloat);
}

/** Parse a `transform` attribute into a single matrix.
 *
 *  SVG applies a list left to right as nested coordinate-system changes, so a
 *  point is transformed by the RIGHTMOST function first. `mul(m, n)` is
 *  "m followed by n", so the list folds right to left. Getting this backwards
 *  makes `translate(...) scale(...)` scale its own translation. */
export function parseTransform(s: string | undefined): Matrix {
  if (!s) return [...IDENTITY];
  const fns: Matrix[] = [];
  const re = /([A-Za-z]+)\s*\(([^)]*)\)/g;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const a = numbers(m[2]);
    switch (m[1]) {
      case 'translate':
        fns.push([1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0]);
        break;
      case 'scale': {
        const sx = a[0] ?? 1;
        fns.push([sx, 0, 0, a[1] ?? sx, 0, 0]);
        break;
      }
      case 'rotate': {
        const t = ((a[0] ?? 0) * Math.PI) / 180;
        const c = Math.cos(t), si = Math.sin(t);
        const rot: Matrix = [c, si, -si, c, 0, 0];
        if (a.length >= 3) {
          const [, cx, cy] = a;
          // translate(cx,cy) rotate() translate(-cx,-cy), folded right to left.
          fns.push(mul(mul([1, 0, 0, 1, -cx, -cy], rot), [1, 0, 0, 1, cx, cy]));
        } else fns.push(rot);
        break;
      }
      case 'skewX':
        fns.push([1, 0, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 1, 0, 0]);
        break;
      case 'skewY':
        fns.push([1, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0]);
        break;
      case 'matrix':
        if (a.length >= 6) fns.push([a[0], a[1], a[2], a[3], a[4], a[5]]);
        break;
      default:
        break;   // unknown function: ignored, per SVG error handling
    }
  }
  let out: Matrix = [...IDENTITY];
  for (let i = fns.length - 1; i >= 0; i--) out = mul(out, fns[i]);
  return out;
}

/** A parsed `viewBox`. */
export interface ViewBox {
  minX: number;
  minY: number;
  w: number;
  h: number;
}

/** Parse a `viewBox`. Returns undefined when malformed or non-positive, so the
 *  caller can fall back to width/height and then to the target rect. */
export function parseViewBox(s: string | undefined): ViewBox | undefined {
  if (!s) return undefined;
  const a = numbers(s);
  if (a.length < 4) return undefined;
  const [minX, minY, w, h] = a;
  if (!(w > 0) || !(h > 0)) return undefined;
  return { minX, minY, w, h };
}

/** The align fraction for one axis: 0 for Min, 0.5 for Mid, 1 for Max. */
function frac(align: string, axis: 'x' | 'Y'): number {
  const i = align.indexOf(axis);
  if (i < 0) return 0.5;
  const kind = align.slice(i + 1, i + 4);
  return kind === 'Min' ? 0 : kind === 'Max' ? 1 : 0.5;
}

/** Map `vb` onto `rect` = [x, y, w, h], honouring `par` (a preserveAspectRatio
 *  value) unless `fit` overrides it, and flipping the y axis on the way.
 *
 *  Content is emitted in raw viewBox units with y pointing DOWN; this matrix is
 *  the only place that becomes PDF's y-up. */
export function placementMatrix(
  vb: ViewBox, rect: [number, number, number, number],
  par: string | undefined, fit?: 'meet' | 'slice' | 'fill',
): Matrix {
  const [rx, ry, rw, rh] = rect;
  let align = 'xMidYMid';
  let slice = false;
  if (par) {
    const t = par.trim().split(/\s+/);
    const a = t[0] === 'defer' ? t[1] : t[0];
    if (a) align = a;
    slice = t[t.length - 1] === 'slice';
  }
  if (fit === 'fill') align = 'none';
  else if (fit === 'meet') { align = 'xMidYMid'; slice = false; }
  else if (fit === 'slice') { align = 'xMidYMid'; slice = true; }

  let sx = rw / vb.w, sy = rh / vb.h;
  if (align !== 'none') {
    const s = slice ? Math.max(sx, sy) : Math.min(sx, sy);
    sx = s; sy = s;
  }
  const tx = align === 'none' ? 0 : frac(align, 'x') * (rw - vb.w * sx);
  const ty = align === 'none' ? 0 : frac(align, 'Y') * (rh - vb.h * sy);
  // ty is measured DOWNWARD from the rect's top edge, which is what lets it
  // compose with the flip below.
  return [sx, 0, 0, -sy, rx + tx - vb.minX * sx, ry + rh - ty + vb.minY * sy];
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/svg-transform.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [x] **Step 5: Commit**

```bash
git add src/svgtransform.ts test/svg-transform.test.ts
git commit -m "feat(svg): transform lists and viewBox placement matrix (1gg0.3)"
```

---

### Task 4: `svgstyle.ts` — colours and the style cascade

**Files:**
- Create: `src/svgstyle.ts`
- Test: `test/svg-style.test.ts` (create)

**Interfaces:**
- Consumes: nothing. This module imports nothing.
- Produces:
  - `type Rgb = [number, number, number]`
  - `interface Paint { fill: Rgb | null; stroke: Rgb | null; fillRule: 'nonzero' | 'evenodd'; strokeWidth: number; lineCap: 0 | 1 | 2; lineJoin: 0 | 1 | 2; miterLimit: number; dash: number[]; dashOffset: number; fillOpacity: number; strokeOpacity: number }`
  - `const INITIAL: Paint`
  - `parseColor(s: string): Rgb | null | undefined` — `null` is `none`, `undefined` is unparseable (including `url(...)`)
  - `resolveStyle(parent: Paint, attrs: Map<string, string>): { paint: Paint; refs: string[] }`

- [x] **Step 1: Write the failing tests**

Create `test/svg-style.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { INITIAL, parseColor, resolveStyle, type Paint } from '../src/svgstyle.js';

const attrs = (o: Record<string, string>) => new Map(Object.entries(o));
const res = (o: Record<string, string>, parent: Paint = INITIAL) => resolveStyle(parent, attrs(o));

describe('parseColor', () => {
  it('parses 3- and 6-digit hex', () => {
    expect(parseColor('#f00')).toEqual([1, 0, 0]);
    expect(parseColor('#ff0000')).toEqual([1, 0, 0]);
    expect(parseColor('#000')).toEqual([0, 0, 0]);
  });

  it('parses rgb() in absolute and percentage form', () => {
    expect(parseColor('rgb(255, 0, 0)')).toEqual([1, 0, 0]);
    expect(parseColor('rgb(100%, 0%, 0%)')).toEqual([1, 0, 0]);
  });

  it('clamps out-of-range components', () => {
    expect(parseColor('rgb(300, -20, 0)')).toEqual([1, 0, 0]);
  });

  it('parses named colours case-insensitively', () => {
    expect(parseColor('red')).toEqual([1, 0, 0]);
    expect(parseColor('ReD')).toEqual([1, 0, 0]);
    expect(parseColor('rebeccapurple')).toEqual([0.4, 0.2, 0.6]);
  });

  it('returns null for none and transparent', () => {
    expect(parseColor('none')).toBeNull();
    expect(parseColor('transparent')).toBeNull();
  });

  it('returns undefined for anything it cannot render', () => {
    expect(parseColor('url(#grad)')).toBeUndefined();
    expect(parseColor('not-a-colour')).toBeUndefined();
    expect(parseColor('')).toBeUndefined();
  });
});

describe('resolveStyle — initial values', () => {
  it("starts with SVG's black fill and no stroke", () => {
    expect(INITIAL.fill).toEqual([0, 0, 0]);
    expect(INITIAL.stroke).toBeNull();
    expect(INITIAL.strokeWidth).toBe(1);
    expect(INITIAL.fillRule).toBe('nonzero');
  });
});

describe('resolveStyle — cascade', () => {
  it('reads presentation attributes', () => {
    const { paint } = res({ fill: '#00ff00', stroke: 'blue', 'stroke-width': '3' });
    expect(paint.fill).toEqual([0, 1, 0]);
    expect(paint.stroke).toEqual([0, 0, 1]);
    expect(paint.strokeWidth).toBe(3);
  });

  it('lets an inline style= win over the same presentation attribute', () => {
    const { paint } = res({ fill: 'red', style: 'fill: blue' });
    expect(paint.fill).toEqual([0, 0, 1]);
  });

  it('parses a multi-declaration style with stray whitespace and a trailing ;', () => {
    const { paint } = res({ style: ' fill : red ; stroke-width : 4 ; ' });
    expect(paint.fill).toEqual([1, 0, 0]);
    expect(paint.strokeWidth).toBe(4);
  });

  it('inherits everything not set on the element', () => {
    const parent = res({ fill: 'red', 'stroke-width': '7' }).paint;
    const { paint } = res({ stroke: 'blue' }, parent);
    expect(paint.fill).toEqual([1, 0, 0]);
    expect(paint.strokeWidth).toBe(7);
    expect(paint.stroke).toEqual([0, 0, 1]);
  });

  it('maps linecap, linejoin and fill-rule to their PDF codes', () => {
    expect(res({ 'stroke-linecap': 'round' }).paint.lineCap).toBe(1);
    expect(res({ 'stroke-linecap': 'square' }).paint.lineCap).toBe(2);
    expect(res({ 'stroke-linejoin': 'bevel' }).paint.lineJoin).toBe(2);
    expect(res({ 'fill-rule': 'evenodd' }).paint.fillRule).toBe('evenodd');
  });

  it('parses a dash array and ignores an all-zero one', () => {
    expect(res({ 'stroke-dasharray': '4 2' }).paint.dash).toEqual([4, 2]);
    expect(res({ 'stroke-dasharray': '4,2' }).paint.dash).toEqual([4, 2]);
    expect(res({ 'stroke-dasharray': 'none' }).paint.dash).toEqual([]);
    expect(res({ 'stroke-dasharray': '0 0' }).paint.dash).toEqual([]);
  });

  it('folds group opacity into both fill and stroke alpha', () => {
    const { paint } = res({ opacity: '0.5', 'fill-opacity': '0.5' });
    expect(paint.fillOpacity).toBeCloseTo(0.25, 9);
    expect(paint.strokeOpacity).toBeCloseTo(0.5, 9);
  });

  it('multiplies opacity down the tree', () => {
    const parent = res({ opacity: '0.5' }).paint;
    const { paint } = res({ opacity: '0.5' }, parent);
    expect(paint.fillOpacity).toBeCloseTo(0.25, 9);
  });

  it('reports a url() paint and falls back to none', () => {
    const { paint, refs } = res({ fill: 'url(#grad)' });
    expect(refs).toEqual(['grad']);
    expect(paint.fill).toBeNull();          // never black
  });

  it('honours an explicit fallback colour after a url()', () => {
    const { paint, refs } = res({ fill: 'url(#grad) red' });
    expect(refs).toEqual(['grad']);
    expect(paint.fill).toEqual([1, 0, 0]);
  });

  it('leaves an unparseable value inherited rather than guessing', () => {
    const parent = res({ fill: 'red' }).paint;
    const { paint } = res({ fill: 'not-a-colour' }, parent);
    expect(paint.fill).toEqual([1, 0, 0]);
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/svg-style.test.ts`
Expected: FAIL — cannot resolve `../src/svgstyle.js`.

- [x] **Step 3: Create `src/svgstyle.ts`**

```ts
// SVG paint: colour parsing and the presentation-attribute + inline-style
// cascade (issue 1gg0.3). Pure — imports nothing, touches no PDF objects.

export type Rgb = [number, number, number];

/** A resolved paint state. `null` fill or stroke means "do not paint". */
export interface Paint {
  fill: Rgb | null;
  stroke: Rgb | null;
  fillRule: 'nonzero' | 'evenodd';
  strokeWidth: number;
  lineCap: 0 | 1 | 2;
  lineJoin: 0 | 1 | 2;
  miterLimit: number;
  dash: number[];
  dashOffset: number;
  fillOpacity: number;
  strokeOpacity: number;
}

/** SVG's initial values. The two that are routinely got backwards: the initial
 *  fill is BLACK (not none) and the initial stroke is NONE (not black). */
export const INITIAL: Paint = {
  fill: [0, 0, 0],
  stroke: null,
  fillRule: 'nonzero',
  strokeWidth: 1,
  lineCap: 0,
  lineJoin: 0,
  miterLimit: 4,
  dash: [],
  dashOffset: 0,
  fillOpacity: 1,
  strokeOpacity: 1,
};

// The CSS/SVG named colours, as "name hex" pairs.
const NAMED_SRC =
  'aliceblue f0f8ff antiquewhite faebd7 aqua 00ffff aquamarine 7fffd4 azure f0ffff ' +
  'beige f5f5dc bisque ffe4c4 black 000000 blanchedalmond ffebcd blue 0000ff ' +
  'blueviolet 8a2be2 brown a52a2a burlywood deb887 cadetblue 5f9ea0 chartreuse 7fff00 ' +
  'chocolate d2691e coral ff7f50 cornflowerblue 6495ed cornsilk fff8dc crimson dc143c ' +
  'cyan 00ffff darkblue 00008b darkcyan 008b8b darkgoldenrod b8860b darkgray a9a9a9 ' +
  'darkgreen 006400 darkgrey a9a9a9 darkkhaki bdb76b darkmagenta 8b008b ' +
  'darkolivegreen 556b2f darkorange ff8c00 darkorchid 9932cc darkred 8b0000 ' +
  'darksalmon e9967a darkseagreen 8fbc8f darkslateblue 483d8b darkslategray 2f4f4f ' +
  'darkslategrey 2f4f4f darkturquoise 00ced1 darkviolet 9400d3 deeppink ff1493 ' +
  'deepskyblue 00bfff dimgray 696969 dimgrey 696969 dodgerblue 1e90ff firebrick b22222 ' +
  'floralwhite fffaf0 forestgreen 228b22 fuchsia ff00ff gainsboro dcdcdc ' +
  'ghostwhite f8f8ff gold ffd700 goldenrod daa520 gray 808080 grey 808080 ' +
  'green 008000 greenyellow adff2f honeydew f0fff0 hotpink ff69b4 indianred cd5c5c ' +
  'indigo 4b0082 ivory fffff0 khaki f0e68c lavender e6e6fa lavenderblush fff0f5 ' +
  'lawngreen 7cfc00 lemonchiffon fffacd lightblue add8e6 lightcoral f08080 ' +
  'lightcyan e0ffff lightgoldenrodyellow fafad2 lightgray d3d3d3 lightgreen 90ee90 ' +
  'lightgrey d3d3d3 lightpink ffb6c1 lightsalmon ffa07a lightseagreen 20b2aa ' +
  'lightskyblue 87cefa lightslategray 778899 lightslategrey 778899 ' +
  'lightsteelblue b0c4de lightyellow ffffe0 lime 00ff00 limegreen 32cd32 linen faf0e6 ' +
  'magenta ff00ff maroon 800000 mediumaquamarine 66cdaa mediumblue 0000cd ' +
  'mediumorchid ba55d3 mediumpurple 9370db mediumseagreen 3cb371 ' +
  'mediumslateblue 7b68ee mediumspringgreen 00fa9a mediumturquoise 48d1cc ' +
  'mediumvioletred c71585 midnightblue 191970 mintcream f5fffa mistyrose ffe4e1 ' +
  'moccasin ffe4b5 navajowhite ffdead navy 000080 oldlace fdf5e6 olive 808000 ' +
  'olivedrab 6b8e23 orange ffa500 orangered ff4500 orchid da70d6 ' +
  'palegoldenrod eee8aa palegreen 98fb98 paleturquoise afeeee palevioletred db7093 ' +
  'papayawhip ffefd5 peachpuff ffdab9 peru cd853f pink ffc0cb plum dda0dd ' +
  'powderblue b0e0e6 purple 800080 rebeccapurple 663399 red ff0000 rosybrown bc8f8f ' +
  'royalblue 4169e1 saddlebrown 8b4513 salmon fa8072 sandybrown f4a460 ' +
  'seagreen 2e8b57 seashell fff5ee sienna a0522d silver c0c0c0 skyblue 87ceeb ' +
  'slateblue 6a5acd slategray 708090 slategrey 708090 snow fffafa ' +
  'springgreen 00ff7f steelblue 4682b4 tan d2b48c teal 008080 thistle d8bfd8 ' +
  'tomato ff6347 turquoise 40e0d0 violet ee82ee wheat f5deb3 white ffffff ' +
  'whitesmoke f5f5f5 yellow ffff00 yellowgreen 9acd32';

const NAMED: Map<string, Rgb> = (() => {
  const m = new Map<string, Rgb>();
  const t = NAMED_SRC.split(' ');
  for (let i = 0; i + 1 < t.length; i += 2) {
    const h = t[i + 1];
    m.set(t[i], [
      parseInt(h.slice(0, 2), 16) / 255,
      parseInt(h.slice(2, 4), 16) / 255,
      parseInt(h.slice(4, 6), 16) / 255,
    ]);
  }
  return m;
})();

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** Parse an SVG colour. Returns `null` for `none`/`transparent` (do not paint)
 *  and `undefined` when the value cannot be rendered — including `url(...)`
 *  references, which the caller reports rather than guessing a colour for. */
export function parseColor(s: string): Rgb | null | undefined {
  const v = (s ?? '').trim().toLowerCase();
  if (v === '' ) return undefined;
  if (v === 'none' || v === 'transparent') return null;
  if (v[0] === '#') {
    const h = v.slice(1);
    if (/^[0-9a-f]{3}$/.test(h))
      return [parseInt(h[0] + h[0], 16) / 255, parseInt(h[1] + h[1], 16) / 255,
              parseInt(h[2] + h[2], 16) / 255];
    if (/^[0-9a-f]{6}$/.test(h))
      return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255,
              parseInt(h.slice(4, 6), 16) / 255];
    return undefined;
  }
  const m = /^rgba?\(([^)]*)\)$/.exec(v);
  if (m) {
    const parts = m[1].split(/[\s,]+/).filter((p) => p !== '');
    if (parts.length < 3) return undefined;
    const comp = parts.slice(0, 3).map((p) => {
      const n = parseFloat(p);
      if (!Number.isFinite(n)) return NaN;
      return p.endsWith('%') ? n / 100 : n / 255;
    });
    if (comp.some((n) => Number.isNaN(n))) return undefined;
    return [clamp01(comp[0]), clamp01(comp[1]), clamp01(comp[2])];
  }
  return NAMED.get(v);
}

/** A paint value, which may be a url() reference with an optional fallback. */
function parsePaint(v: string, refs: string[]): Rgb | null | undefined {
  const m = /^url\(\s*#([^)\s]+)\s*\)\s*(.*)$/.exec(v.trim());
  if (!m) return parseColor(v);
  refs.push(m[1]);
  // SVG: fall back to the colour after the reference, else to none. Never to
  // black — a silently wrong solid fill is worse than a visibly missing one.
  return m[2].trim() === '' ? null : parseColor(m[2]);
}

function numOr(v: string | undefined, dflt: number): number {
  if (v === undefined) return dflt;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : dflt;
}

/** Declarations from an inline `style=""`, lower-cased property names. */
function parseInlineStyle(s: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!s) return out;
  for (const decl of s.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    out.set(decl.slice(0, i).trim().toLowerCase(), decl.slice(i + 1).trim());
  }
  return out;
}

/** Resolve one element's paint over its parent's. Presentation attributes are
 *  read first, then inline `style=` overrides them (CSS beats attributes).
 *  `refs` collects the ids of any url() paints, which the caller resolves to
 *  element names for its skipped list. */
export function resolveStyle(
  parent: Paint, attrs: Map<string, string>,
): { paint: Paint; refs: string[] } {
  const inline = parseInlineStyle(attrs.get('style'));
  const get = (k: string): string | undefined => inline.get(k) ?? attrs.get(k);
  const refs: string[] = [];
  const p: Paint = { ...parent, dash: [...parent.dash] };

  const fill = get('fill');
  if (fill !== undefined) {
    const c = parsePaint(fill, refs);
    if (c !== undefined) p.fill = c;
  }
  const stroke = get('stroke');
  if (stroke !== undefined) {
    const c = parsePaint(stroke, refs);
    if (c !== undefined) p.stroke = c;
  }

  const rule = get('fill-rule');
  if (rule === 'evenodd' || rule === 'nonzero') p.fillRule = rule;

  p.strokeWidth = Math.max(0, numOr(get('stroke-width'), parent.strokeWidth));
  p.miterLimit = Math.max(1, numOr(get('stroke-miterlimit'), parent.miterLimit));
  p.dashOffset = numOr(get('stroke-dashoffset'), parent.dashOffset);

  const cap = get('stroke-linecap');
  if (cap === 'butt') p.lineCap = 0;
  else if (cap === 'round') p.lineCap = 1;
  else if (cap === 'square') p.lineCap = 2;

  const join = get('stroke-linejoin');
  if (join === 'miter') p.lineJoin = 0;
  else if (join === 'round') p.lineJoin = 1;
  else if (join === 'bevel') p.lineJoin = 2;

  const dash = get('stroke-dasharray');
  if (dash !== undefined) {
    if (dash.trim() === 'none') p.dash = [];
    else {
      const a = dash.split(/[\s,]+/).map(parseFloat).filter((n) => Number.isFinite(n) && n >= 0);
      // An all-zero pattern is invalid and would emit a degenerate `d` array.
      p.dash = a.length > 0 && a.some((n) => n > 0) ? a : [];
    }
  }

  // Group opacity has no PDF equivalent short of a transparency group, so it is
  // folded into both child alphas. Exact for non-overlapping content; an
  // approximation where children overlap. Documented in the README.
  const groupOpacity = clamp01(numOr(get('opacity'), 1));
  p.fillOpacity = clamp01(numOr(get('fill-opacity'), 1)) * parent.fillOpacity * groupOpacity;
  p.strokeOpacity = clamp01(numOr(get('stroke-opacity'), 1)) * parent.strokeOpacity * groupOpacity;

  return { paint: p, refs };
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/svg-style.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [x] **Step 5: Commit**

```bash
git add src/svgstyle.ts test/svg-style.test.ts
git commit -m "feat(svg): colour parsing and the style cascade (1gg0.3)"
```

---

### Task 5: `svgdraw.ts` — shapes, transforms and paint

**Files:**
- Create: `src/svgdraw.ts`
- Test: `test/svg-draw.test.ts` (create)

**Interfaces:**
- Consumes: `XmlNode` from `./xml.js`; everything from `svgpath.ts`,
  `svgstyle.ts`, `svgtransform.ts`; `num` from `./pagecontent.js`;
  `PdfDict`/`PdfObject` from `./types.js`; `Matrix`/`mul`/`IDENTITY` from
  `./text.js`.
- Produces:
  - `interface DrawResult { content: string; resources: PdfDict; skipped: string[] }`
  - `drawSvg(root: XmlNode): DrawResult`

`clipPath` and `use` are Task 6 — this task draws shapes only.

- [x] **Step 1: Write the failing tests**

Create `test/svg-draw.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseXml } from '../src/xml.js';
import { drawSvg } from '../src/svgdraw.js';
import { isDict, type PdfDict } from '../src/types.js';

const draw = (svg: string) => drawSvg(parseXml(new TextEncoder().encode(svg)));
const body = (svg: string) => draw(svg).content;

describe('drawSvg — shapes', () => {
  it('emits a path as moveto/lineto and a fill', () => {
    const c = body('<svg><path d="M0 0 L10 0 L10 10 Z"/></svg>');
    expect(c).toContain('0 0 m');
    expect(c).toContain('10 0 l');
    expect(c).toContain('h');
    expect(c).toMatch(/\bf\b/);
  });

  it('emits a rect as a closed subpath', () => {
    const c = body('<svg><rect x="1" y="2" width="3" height="4"/></svg>');
    expect(c).toContain('1 2 m');
    expect(c).toContain('4 2 l');
    expect(c).toContain('4 6 l');
  });

  it('emits circle and ellipse as cubics', () => {
    expect(body('<svg><circle cx="0" cy="0" r="5"/></svg>')).toContain(' c');
    expect(body('<svg><ellipse cx="0" cy="0" rx="5" ry="2"/></svg>')).toContain(' c');
  });

  it('strokes a line, and emits no stroke op when it has no stroke', () => {
    // A line has no area, so the default black fill paints nothing. The fill
    // operator may still be emitted (harmless); what must not appear is S.
    expect(body('<svg><line x1="0" y1="0" x2="10" y2="10"/></svg>')).not.toMatch(/\bS\b/);
    const c = body('<svg><line x1="0" y1="0" x2="10" y2="10" stroke="red"/></svg>');
    expect(c).toContain('0 0 m');
    expect(c).toContain('10 10 l');
    expect(c).toMatch(/\bS\b/);
  });

  it('emits polyline open and polygon closed', () => {
    expect(body('<svg><polyline points="0,0 5,5" stroke="red"/></svg>')).not.toMatch(/\bh\b/);
    expect(body('<svg><polygon points="0,0 5,5 5,0"/></svg>')).toMatch(/\bh\b/);
  });
});

describe('drawSvg — paint', () => {
  it('fills black by default and does not stroke', () => {
    const c = body('<svg><rect width="10" height="10"/></svg>');
    expect(c).toContain('0 0 0 rg');
    expect(c).toMatch(/\bf\b/);
    expect(c).not.toMatch(/\bS\b/);
  });

  it('draws nothing for a shape with neither fill nor stroke', () => {
    const c = body('<svg><rect width="10" height="10" fill="none"/></svg>');
    expect(c).not.toMatch(/\b[fSB]\b/);
  });

  it('uses B when both fill and stroke are set', () => {
    const c = body('<svg><rect width="10" height="10" fill="red" stroke="blue"/></svg>');
    expect(c).toContain('1 0 0 rg');
    expect(c).toContain('0 0 1 RG');
    expect(c).toMatch(/\bB\b/);
  });

  it('selects the even-odd operators for fill-rule evenodd', () => {
    expect(body('<svg><rect width="9" height="9" fill-rule="evenodd"/></svg>')).toMatch(/\bf\*/);
    expect(body('<svg><rect width="9" height="9" fill-rule="evenodd" stroke="red"/></svg>'))
      .toMatch(/\bB\*/);
  });

  it('emits stroke width, cap, join and dash', () => {
    const c = body('<svg><path d="M0 0L9 9" stroke="red" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="bevel" stroke-dasharray="4 2" ' +
      'stroke-dashoffset="1"/></svg>');
    expect(c).toContain('2 w');
    expect(c).toContain('1 J');
    expect(c).toContain('2 j');
    expect(c).toContain('[4 2] 1 d');
  });

  it('registers an ExtGState for partial opacity and references it', () => {
    const r = draw('<svg><rect width="9" height="9" fill="red" fill-opacity="0.5"/></svg>');
    expect(r.content).toMatch(/\/GS\d+ gs/);
    const gs = r.resources.get('ExtGState');
    expect(isDict(gs)).toBe(true);
    const first = [...(gs as PdfDict).values()][0] as PdfDict;
    expect(first.get('ca')).toBeCloseTo(0.5, 9);
    expect(first.get('CA')).toBe(1);
  });

  it('reuses one ExtGState for equal alpha pairs', () => {
    const r = draw('<svg><rect width="9" height="9" opacity="0.5"/>' +
      '<rect width="9" height="9" opacity="0.5"/></svg>');
    expect((r.resources.get('ExtGState') as PdfDict).size).toBe(1);
  });

  it('emits no ExtGState at full opacity', () => {
    const r = draw('<svg><rect width="9" height="9"/></svg>');
    expect(r.resources.get('ExtGState')).toBeUndefined();
    expect(r.content).not.toContain(' gs');
  });
});

describe('drawSvg — structure and transforms', () => {
  it('emits a transform as a cm inside a q/Q pair', () => {
    const c = body('<svg><g transform="translate(10 20)"><rect width="1" height="1"/></g></svg>');
    expect(c).toContain('1 0 0 1 10 20 cm');
    expect(c).toMatch(/q[\s\S]*cm[\s\S]*Q/);
  });

  it('nests group transforms', () => {
    const c = body('<svg><g transform="translate(10 0)"><g transform="scale(2)">' +
      '<rect width="1" height="1"/></g></g></svg>');
    expect(c).toContain('1 0 0 1 10 0 cm');
    expect(c).toContain('2 0 0 2 0 0 cm');
  });

  it('applies a transform on the shape itself', () => {
    expect(body('<svg><rect width="1" height="1" transform="scale(3)"/></svg>'))
      .toContain('3 0 0 3 0 0 cm');
  });

  it('inherits paint from an enclosing group', () => {
    expect(body('<svg><g fill="red"><rect width="9" height="9"/></g></svg>'))
      .toContain('1 0 0 rg');
  });

  it('ignores non-rendering elements without reporting them', () => {
    const r = draw('<svg><title>T</title><desc>D</desc><metadata>M</metadata>' +
      '<rect width="9" height="9"/></svg>');
    expect(r.skipped).toEqual([]);
    expect(r.content).toMatch(/\bf\b/);
  });

  it('does not draw the contents of defs', () => {
    const r = draw('<svg><defs><rect width="9" height="9"/></defs></svg>');
    expect(r.content).not.toMatch(/\bf\b/);
    expect(r.skipped).toEqual([]);
  });
});

describe('drawSvg — skipped reporting', () => {
  it('reports an unsupported element once, sorted', () => {
    const r = draw('<svg><text>hi</text><rect width="9" height="9"/><text>again</text></svg>');
    expect(r.skipped).toEqual(['text']);
  });

  it('reports several unsupported elements in sorted order', () => {
    const r = draw('<svg><image href="x"/><text>hi</text></svg>');
    expect(r.skipped).toEqual(['image', 'text']);
  });

  it('reports the referenced element behind an unsupported paint', () => {
    const r = draw('<svg><defs><linearGradient id="g"/></defs>' +
      '<rect width="9" height="9" fill="url(#g)"/></svg>');
    expect(r.skipped).toContain('linearGradient');
    expect(r.content).not.toMatch(/\bf\b/);      // falls back to none, never black
  });

  it('reports an unresolvable paint reference as url()', () => {
    const r = draw('<svg><rect width="9" height="9" fill="url(#missing)"/></svg>');
    expect(r.skipped).toEqual(['url()']);
  });

  it('reports a path whose data was truncated', () => {
    const r = draw('<svg><path d="M0 0 L10 10 L20"/></svg>');
    expect(r.skipped).toEqual(['path']);
    expect(r.content).toContain('10 10 l');       // the valid prefix still drew
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/svg-draw.test.ts`
Expected: FAIL — cannot resolve `../src/svgdraw.js`.

- [x] **Step 3: Create `src/svgdraw.ts`**

```ts
// SVG -> PDF content stream (issue 1gg0.3). Walks the XmlNode tree from xml.ts
// and emits operators, maintaining the q/Q state stack and collecting the names
// of anything it could not render. Pure of PDF plumbing: it imports no Document
// and allocates no objects — /ExtGState entries are DIRECT dicts placed in the
// Form XObject's own /Resources by svgembed.ts.
//
// Content is emitted in raw viewBox units with y still pointing DOWN. The flip
// to PDF's y-up happens once, in svgtransform.ts's placementMatrix.
import type { XmlNode } from './xml.js';
import { num } from './pagecontent.js';
import { name, type PdfDict, type PdfObject } from './types.js';
import { IDENTITY } from './text.js';
import { parsePath, rectSegs, ellipseSegs, polySegs, parsePoints, type SvgSeg } from './svgpath.js';
import { INITIAL, resolveStyle, type Paint } from './svgstyle.js';
import { parseTransform } from './svgtransform.js';

/** What the walker produces: a content stream, the resources it needs, and the
 *  element names it could not render. */
export interface DrawResult {
  content: string;
  resources: PdfDict;
  skipped: string[];
}

/** Elements that render nothing and are not a fidelity loss when ignored. */
const NON_RENDERING = new Set(['title', 'desc', 'metadata']);

/** Elements the walker handles itself rather than treating as unsupported. */
const STRUCTURAL = new Set(['svg', 'g', 'defs', 'use', 'clipPath', 'symbol']);

const SHAPES = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);

const attrNum = (n: XmlNode, k: string, dflt = 0): number => {
  const v = n.attrs.get(k);
  if (v === undefined) return dflt;
  const f = parseFloat(v);
  return Number.isFinite(f) ? f : dflt;
};

const attrNumOrNaN = (n: XmlNode, k: string): number => {
  const v = n.attrs.get(k);
  if (v === undefined) return NaN;
  const f = parseFloat(v);
  return Number.isFinite(f) ? f : NaN;
};

/** The segments a shape element contributes, or [] when it draws nothing. */
export function shapeSegs(n: XmlNode): { segs: SvgSeg[]; truncated: boolean } {
  switch (n.name) {
    case 'path': {
      const { segs, truncated } = parsePath(n.attrs.get('d') ?? '');
      return { segs, truncated };
    }
    case 'rect':
      return {
        segs: rectSegs(attrNum(n, 'x'), attrNum(n, 'y'), attrNum(n, 'width'),
                       attrNum(n, 'height'), attrNumOrNaN(n, 'rx'), attrNumOrNaN(n, 'ry')),
        truncated: false,
      };
    case 'circle': {
      const r = attrNum(n, 'r');
      return { segs: ellipseSegs(attrNum(n, 'cx'), attrNum(n, 'cy'), r, r), truncated: false };
    }
    case 'ellipse':
      return {
        segs: ellipseSegs(attrNum(n, 'cx'), attrNum(n, 'cy'), attrNum(n, 'rx'), attrNum(n, 'ry')),
        truncated: false,
      };
    case 'line':
      return {
        segs: [
          { op: 'M', args: [attrNum(n, 'x1'), attrNum(n, 'y1')] },
          { op: 'L', args: [attrNum(n, 'x2'), attrNum(n, 'y2')] },
        ],
        truncated: false,
      };
    case 'polyline':
      return { segs: polySegs(parsePoints(n.attrs.get('points') ?? ''), false), truncated: false };
    case 'polygon':
      return { segs: polySegs(parsePoints(n.attrs.get('points') ?? ''), true), truncated: false };
    default:
      return { segs: [], truncated: false };
  }
}

/** Emit path-construction operators for `segs`. */
export function emitSegs(segs: SvgSeg[], out: string[]): void {
  for (const s of segs) {
    if (s.op === 'M') out.push(`${num(s.args[0])} ${num(s.args[1])} m`);
    else if (s.op === 'L') out.push(`${num(s.args[0])} ${num(s.args[1])} l`);
    else if (s.op === 'C') out.push(`${s.args.map(num).join(' ')} c`);
    else out.push('h');
  }
}

class Emitter {
  readonly out: string[] = [];
  readonly skipped = new Set<string>();
  readonly extg: PdfDict = new Map<string, PdfObject>();
  /** id -> element, for use/clipPath resolution (Task 6). */
  readonly ids = new Map<string, XmlNode>();

  /** Reuse one /ExtGState per (ca, CA) pair; returns its resource key. */
  gsKey(ca: number, CA: number): string {
    for (const [k, v] of this.extg) {
      const d = v as PdfDict;
      if (d.get('ca') === ca && d.get('CA') === CA) return k;
    }
    const key = `GS${this.extg.size}`;
    this.extg.set(key, new Map<string, PdfObject>([
      ['Type', name('ExtGState')], ['ca', ca], ['CA', CA],
    ]));
    return key;
  }
}

/** Index every element carrying an id, so use/clipPath can resolve references. */
function indexIds(n: XmlNode, into: Map<string, XmlNode>): void {
  const id = n.attrs.get('id');
  if (id !== undefined && !into.has(id)) into.set(id, n);
  for (const c of n.children) indexIds(c, into);
}

/** Paint a shape's segments with `p`, emitting only the operators it needs. */
function paintShape(e: Emitter, segs: SvgSeg[], p: Paint): void {
  const doFill = p.fill !== null;
  const doStroke = p.stroke !== null && p.strokeWidth > 0;
  if (!doFill && !doStroke) return;
  if (segs.length === 0) return;

  e.out.push('q');
  const ca = doFill ? p.fillOpacity : 1;
  const CA = doStroke ? p.strokeOpacity : 1;
  if (ca < 1 || CA < 1) e.out.push(`/${e.gsKey(ca, CA)} gs`);
  if (doFill) e.out.push(`${p.fill!.map(num).join(' ')} rg`);
  if (doStroke) {
    e.out.push(`${p.stroke!.map(num).join(' ')} RG`);
    e.out.push(`${num(p.strokeWidth)} w`);
    if (p.lineCap !== 0) e.out.push(`${p.lineCap} J`);
    if (p.lineJoin !== 0) e.out.push(`${p.lineJoin} j`);
    if (p.miterLimit !== 4) e.out.push(`${num(p.miterLimit)} M`);
    if (p.dash.length > 0) e.out.push(`[${p.dash.map(num).join(' ')}] ${num(p.dashOffset)} d`);
  }
  emitSegs(segs, e.out);
  const eo = p.fillRule === 'evenodd' ? '*' : '';
  e.out.push(doFill && doStroke ? `B${eo}` : doFill ? `f${eo}` : 'S');
  e.out.push('Q');
}

/** Walk one element. `inDefs` suppresses painting, so defs/symbol contents are
 *  indexed for later `use` but never drawn where they sit. */
function walk(e: Emitter, n: XmlNode, parent: Paint, inDefs: boolean): void {
  if (NON_RENDERING.has(n.name)) return;

  if (!STRUCTURAL.has(n.name) && !SHAPES.has(n.name)) {
    e.skipped.add(n.name);
    return;
  }

  const { paint, refs } = resolveStyle(parent, n.attrs);
  for (const id of refs) {
    const target = e.ids.get(id);
    e.skipped.add(target ? target.name : 'url()');
  }

  const tf = parseTransform(n.attrs.get('transform'));
  const hasTf = tf.some((v, i) => v !== IDENTITY[i]);
  if (hasTf) { e.out.push('q'); e.out.push(`${tf.map(num).join(' ')} cm`); }

  if (SHAPES.has(n.name)) {
    if (!inDefs) {
      const { segs, truncated } = shapeSegs(n);
      if (truncated) e.skipped.add(n.name);
      paintShape(e, segs, paint);
    }
  } else {
    const childrenInDefs = inDefs || n.name === 'defs' || n.name === 'symbol';
    for (const c of n.children) walk(e, c, paint, childrenInDefs);
  }

  if (hasTf) e.out.push('Q');
}

/** Render an `<svg>` tree to a content stream. The root's own viewBox is NOT
 *  applied here — svgembed.ts folds it into the placement matrix. */
export function drawSvg(root: XmlNode): DrawResult {
  const e = new Emitter();
  indexIds(root, e.ids);
  walk(e, root, INITIAL, false);
  const resources: PdfDict = new Map<string, PdfObject>();
  if (e.extg.size > 0) resources.set('ExtGState', e.extg);
  return {
    content: e.out.join('\n'),
    resources,
    skipped: [...e.skipped].sort(),
  };
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/svg-draw.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [x] **Step 5: Commit**

```bash
git add src/svgdraw.ts test/svg-draw.test.ts
git commit -m "feat(svg): content-stream emitter for shapes, transforms and paint (1gg0.3)"
```

---

### Task 6: `svgdraw.ts` — `clipPath` and `use`

**Files:**
- Modify: `src/svgdraw.ts` (`walk`, plus two helpers)
- Test: `test/svg-draw.test.ts` (append two describes)

**Interfaces:**
- Consumes: everything from Task 5.
- Produces: no new exported symbols.

- [x] **Step 1: Write the failing tests**

Append to `test/svg-draw.test.ts`:

```ts
describe('drawSvg — clipPath', () => {
  it('emits the clip geometry followed by W n before the clipped content', () => {
    const c = body('<svg><defs><clipPath id="c"><rect width="5" height="5"/></clipPath></defs>' +
      '<g clip-path="url(#c)"><rect width="10" height="10"/></g></svg>');
    expect(c).toMatch(/0 0 m[\s\S]*W n[\s\S]*\bf\b/);
  });

  it('does not report a clipPath as an unsupported paint reference', () => {
    const r = draw('<svg><defs><clipPath id="c"><rect width="5" height="5"/></clipPath></defs>' +
      '<rect width="10" height="10" clip-path="url(#c)"/></svg>');
    expect(r.skipped).toEqual([]);
  });

  it('uses the even-odd clip operator when the clip path asks for it', () => {
    const c = body('<svg><defs><clipPath id="c"><rect width="5" height="5" ' +
      'clip-rule="evenodd"/></clipPath></defs>' +
      '<rect width="10" height="10" clip-path="url(#c)"/></svg>');
    expect(c).toContain('W* n');
  });

  it('never paints the clip path geometry itself', () => {
    const c = body('<svg><defs><clipPath id="c"><rect width="5" height="5" fill="red"/></clipPath>' +
      '</defs><rect width="10" height="10" clip-path="url(#c)"/></svg>');
    expect(c).not.toContain('1 0 0 rg');
  });

  it('scopes the clip to the element that carries it', () => {
    const c = body('<svg><defs><clipPath id="c"><rect width="5" height="5"/></clipPath></defs>' +
      '<rect width="10" height="10" clip-path="url(#c)"/><rect width="20" height="20"/></svg>');
    // The clip is inside its own q/Q, so it is popped before the second rect.
    const upToClip = c.slice(0, c.indexOf('W n'));
    expect(upToClip).toContain('q');
    expect(c.indexOf('Q')).toBeGreaterThan(c.indexOf('W n'));
  });

  it('ignores an unresolvable clip-path reference rather than dropping content', () => {
    const r = draw('<svg><rect width="10" height="10" clip-path="url(#missing)"/></svg>');
    expect(r.content).toMatch(/\bf\b/);
    expect(r.skipped).toEqual([]);
  });
});

describe('drawSvg — use', () => {
  it('draws the referenced element in place', () => {
    const c = body('<svg><defs><rect id="r" width="4" height="4"/></defs>' +
      '<use href="#r"/></svg>');
    expect(c).toMatch(/\bf\b/);
    expect(c).toContain('0 0 m');
  });

  it('offsets by the use x and y', () => {
    const c = body('<svg><defs><rect id="r" width="4" height="4"/></defs>' +
      '<use href="#r" x="10" y="20"/></svg>');
    expect(c).toContain('1 0 0 1 10 20 cm');
  });

  it('resolves xlink:href, whose prefix xml.ts strips', () => {
    const c = body('<svg><defs><rect id="r" width="4" height="4"/></defs>' +
      '<use xlink:href="#r"/></svg>');
    expect(c).toMatch(/\bf\b/);
  });

  it('inherits paint from the use site', () => {
    const c = body('<svg><defs><rect id="r" width="4" height="4"/></defs>' +
      '<use href="#r" fill="red"/></svg>');
    expect(c).toContain('1 0 0 rg');
  });

  it('draws a referenced group', () => {
    const c = body('<svg><defs><g id="g"><rect width="4" height="4"/>' +
      '<rect x="5" width="4" height="4"/></g></defs><use href="#g"/></svg>');
    expect((c.match(/\bf\b/g) ?? []).length).toBe(2);
  });

  it('terminates on a self-referencing use instead of hanging', () => {
    const r = draw('<svg><g id="a"><use href="#a"/></g></svg>');
    expect(r.skipped).toContain('use');
  });

  it('terminates on a mutually recursive pair', () => {
    const r = draw('<svg><defs><g id="a"><use href="#b"/></g>' +
      '<g id="b"><use href="#a"/></g></defs><use href="#a"/></svg>');
    expect(r.skipped).toContain('use');
  });

  it('reports a use whose target does not exist', () => {
    const r = draw('<svg><use href="#nope"/></svg>');
    expect(r.skipped).toEqual(['use']);
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/svg-draw.test.ts -t clipPath`
Expected: FAIL — no `W n` is emitted; `clip-path` is currently just an unknown
attribute and `use` draws nothing.

- [x] **Step 3: Implement clipping and `use`**

In `src/svgdraw.ts`, add to the `Emitter` class:

```ts
  /** ids currently being expanded through <use>, to break reference cycles. */
  readonly active = new Set<string>();
```

Add these two helpers above `walk`:

```ts
/** The id in a `url(#id)` value, or undefined. */
function urlRef(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const m = /^url\(\s*#([^)\s]+)\s*\)$/.exec(v.trim());
  return m ? m[1] : undefined;
}

/** Emit the geometry of a <clipPath> followed by `W n`. Returns false when the
 *  reference does not resolve, in which case the caller draws unclipped rather
 *  than dropping the content. */
function emitClip(e: Emitter, node: XmlNode): boolean {
  let any = false;
  let evenOdd = false;
  for (const c of node.children) {
    if (!SHAPES.has(c.name)) continue;
    const { segs } = shapeSegs(c);
    if (segs.length === 0) continue;
    // A clip child's own transform still applies to the clip geometry.
    const tf = parseTransform(c.attrs.get('transform'));
    const hasTf = tf.some((v, i) => v !== IDENTITY[i]);
    if (hasTf) { e.out.push('q'); e.out.push(`${tf.map(num).join(' ')} cm`); }
    emitSegs(segs, e.out);
    if (hasTf) e.out.push('Q');
    if ((c.attrs.get('clip-rule') ?? node.attrs.get('clip-rule')) === 'evenodd') evenOdd = true;
    any = true;
  }
  if (!any) return false;
  e.out.push(evenOdd ? 'W* n' : 'W n');
  return true;
}
```

Then replace the body of `walk` with the version below. The changes are: a
`clip-path` block wrapping the element in its own `q`/`Q`, and a `use` branch.

```ts
function walk(e: Emitter, n: XmlNode, parent: Paint, inDefs: boolean): void {
  if (NON_RENDERING.has(n.name)) return;

  if (!STRUCTURAL.has(n.name) && !SHAPES.has(n.name)) {
    e.skipped.add(n.name);
    return;
  }

  const { paint, refs } = resolveStyle(parent, n.attrs);
  for (const id of refs) {
    const target = e.ids.get(id);
    e.skipped.add(target ? target.name : 'url()');
  }

  // A clip-path opens its own q/Q so the clip is popped with the element.
  const clipId = urlRef(n.attrs.get('clip-path'));
  const clipNode = clipId !== undefined ? e.ids.get(clipId) : undefined;
  let clipped = false;
  if (clipNode && clipNode.name === 'clipPath' && !inDefs) {
    e.out.push('q');
    clipped = emitClip(e, clipNode);
    if (!clipped) e.out.pop();      // nothing emitted: drop the stray q
  }

  const tf = parseTransform(n.attrs.get('transform'));
  const hasTf = tf.some((v, i) => v !== IDENTITY[i]);
  if (hasTf) { e.out.push('q'); e.out.push(`${tf.map(num).join(' ')} cm`); }

  if (n.name === 'clipPath') {
    // Only ever drawn through a clip-path reference, never in its own right.
  } else if (n.name === 'use') {
    const id = (n.attrs.get('href') ?? '').replace(/^#/, '');
    const target = id === '' ? undefined : e.ids.get(id);
    if (!target || e.active.has(id)) {
      e.skipped.add('use');          // missing target, or a reference cycle
    } else if (!inDefs) {
      const dx = attrNum(n, 'x'), dy = attrNum(n, 'y');
      const shift = dx !== 0 || dy !== 0;
      if (shift) { e.out.push('q'); e.out.push(`1 0 0 1 ${num(dx)} ${num(dy)} cm`); }
      e.active.add(id);
      walk(e, target, paint, false);
      e.active.delete(id);
      if (shift) e.out.push('Q');
    }
  } else if (SHAPES.has(n.name)) {
    if (!inDefs) {
      const { segs, truncated } = shapeSegs(n);
      if (truncated) e.skipped.add(n.name);
      paintShape(e, segs, paint);
    }
  } else {
    const childrenInDefs = inDefs || n.name === 'defs' || n.name === 'symbol';
    for (const c of n.children) walk(e, c, paint, childrenInDefs);
  }

  if (hasTf) e.out.push('Q');
  if (clipped) e.out.push('Q');
}
```

**No change is needed in `svgstyle.ts`.** Only `fill` and `stroke` go through
`parsePaint`, so a `clip-path="url(#c)"` never reaches `refs` and therefore never
lands in `skipped`. The test "does not report a clipPath as an unsupported paint
reference" is what pins that down — if you ever widen `resolveStyle` to run more
attributes through `parsePaint`, that test is the one that will catch it.

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/svg-draw.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [x] **Step 5: Commit**

```bash
git add src/svgdraw.ts test/svg-draw.test.ts
git commit -m "feat(svg): clipPath and use with a reference-cycle guard (1gg0.3)"
```

---

### Task 7: `svgembed.ts` and `page.AddSVGObject`

**Files:**
- Create: `src/svgembed.ts`
- Modify: `src/page.ts` (imports ~line 15; new method after `AddSVGObject`'s
  neighbours — put it directly after `AddBarcode`, ~line 492)
- Modify: `src/index.ts` (~line 102, beside the compose/booklet type exports)
- Test: `test/svg-embed.test.ts` (create)

**Interfaces:**
- Consumes: `drawSvg` (Tasks 5-6); `parseViewBox`, `placementMatrix`
  (Task 3); `parseXml` from `./xml.js`; `PdfParseError` from `./errors.js`;
  `enc` from `./serialize.js`; `num`, `ensureOwnResources`, `ensureOwnSubdict`,
  `freshKey`, `appendContent` from `./pagecontent.js`.
- Produces:
  - `interface AddSVGOptions { fit?: 'meet' | 'slice' | 'fill' }`
  - `interface AddSVGResult { skipped: string[] }`
  - `addSvgObject(doc, page, data, rect, opts): AddSVGResult`
  - `Page.AddSVGObject(data, rect, opts?): AddSVGResult`

- [x] **Step 1: Write the failing tests**

Create `test/svg-embed.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PdfParseError } from '../src/errors.js';
import { buildBlankPage } from './helpers/build-blank-page.js';
import { isDict, isStream, type PdfDict, type PdfStream } from '../src/types.js';

const svg = (s: string) => new TextEncoder().encode(s);
const dec = (u: Uint8Array) => new TextDecoder('latin1').decode(u);
const page = () => Document.Open(buildBlankPage()).Pages[0];

const RECT: [number, number, number, number] = [100, 200, 300, 150];
const DOC = '<svg viewBox="0 0 100 50"><rect width="100" height="50" fill="red"/></svg>';

/** The single Form XObject a successful AddSVGObject registers on the page. */
function theForm(doc: Document, p: ReturnType<typeof page>): PdfStream {
  const res = doc.resolve(p.Dict.get('Resources')) as PdfDict;
  const xo = doc.resolve(res.get('XObject')) as PdfDict;
  expect(xo.size).toBe(1);
  const v = doc.resolve([...xo.values()][0]);
  expect(isStream(v)).toBe(true);
  return v as PdfStream;
}

describe('page.AddSVGObject', () => {
  it('registers one Form XObject and draws it', () => {
    const p = page();
    const r = p.AddSVGObject(svg(DOC), RECT);
    expect(r.skipped).toEqual([]);
    const form = theForm(p.Document, p);
    expect(form.dict.get('Subtype')).toMatchObject({ name: 'Form' });
    expect(dec(p.Contents)).toMatch(/\/Fm\d+ Do/);
  });

  it('sets the BBox to the viewBox and leaves the Matrix identity', () => {
    const p = page();
    p.AddSVGObject(svg('<svg viewBox="10 20 100 50"><rect width="1" height="1"/></svg>'), RECT);
    const form = theForm(p.Document, p);
    expect(form.dict.get('BBox')).toEqual([10, 20, 110, 70]);
    expect(form.dict.get('Matrix')).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it('carries the walker resources into the form, not onto the page', () => {
    const p = page();
    p.AddSVGObject(svg('<svg viewBox="0 0 10 10"><rect width="9" height="9" ' +
      'fill="red" fill-opacity="0.5"/></svg>'), RECT);
    const form = theForm(p.Document, p);
    const res = p.Document.resolve(form.dict.get('Resources')) as PdfDict;
    expect(isDict(p.Document.resolve(res.get('ExtGState')))).toBe(true);
    const pageRes = p.Document.resolve(p.Dict.get('Resources')) as PdfDict;
    expect(pageRes.get('ExtGState')).toBeUndefined();
  });

  it('places the form with the fit matrix and clips to the rect', () => {
    const p = page();
    p.AddSVGObject(svg(DOC), [0, 0, 200, 100]);   // viewBox 100x50 -> scale 2
    const c = dec(p.Contents);
    expect(c).toContain('0 0 200 100 re');
    expect(c).toContain('W n');
    expect(c).toContain('2 0 0 -2 0 100 cm');     // y flipped
  });

  it('honours the fit override', () => {
    const p = page();
    p.AddSVGObject(svg(DOC), [0, 0, 200, 200], { fit: 'fill' });
    expect(dec(p.Contents)).toContain('2 0 0 -4 0 200 cm');
  });

  it('falls back to width/height when there is no viewBox', () => {
    const p = page();
    p.AddSVGObject(svg('<svg width="100" height="50"><rect width="1" height="1"/></svg>'),
      [0, 0, 200, 100]);
    expect(p.Document.resolve(theForm(p.Document, p).dict.get('BBox'))).toEqual([0, 0, 100, 50]);
  });

  it('falls back to the rect when the SVG declares no size at all', () => {
    const p = page();
    p.AddSVGObject(svg('<svg><rect width="1" height="1"/></svg>'), [0, 0, 200, 100]);
    expect(theForm(p.Document, p).dict.get('BBox')).toEqual([0, 0, 200, 100]);
  });

  it('surfaces the walker skipped list', () => {
    const p = page();
    const r = p.AddSVGObject(svg('<svg viewBox="0 0 10 10"><text>hi</text>' +
      '<rect width="9" height="9"/></svg>'), RECT);
    expect(r.skipped).toEqual(['text']);
  });

  it('preserves existing page content', () => {
    const p = page();
    p.AddText('Before', 10, 10);
    p.AddSVGObject(svg(DOC), RECT);
    const c = dec(p.Contents);
    expect(c).toContain('(Before) Tj');
    expect(c).toMatch(/\/Fm\d+ Do/);
  });

  it('round-trips through Save/Open', () => {
    const p = page();
    p.AddSVGObject(svg(DOC), RECT);
    const rt = Document.Open(p.Document.Save());
    expect(dec(rt.Pages[0].Contents)).toMatch(/\/Fm\d+ Do/);
  });

  it('draws two SVGs onto one page without collision', () => {
    const p = page();
    p.AddSVGObject(svg(DOC), [0, 0, 100, 50]);
    p.AddSVGObject(svg(DOC), [100, 0, 100, 50]);
    const res = p.Document.resolve(p.Dict.get('Resources')) as PdfDict;
    expect((p.Document.resolve(res.get('XObject')) as PdfDict).size).toBe(2);
  });
});

describe('page.AddSVGObject — validation', () => {
  it('throws PdfParseError for malformed XML', () => {
    expect(() => page().AddSVGObject(svg('<svg><rect'), RECT)).toThrow(PdfParseError);
  });

  it('throws PdfParseError when the root is not <svg>', () => {
    expect(() => page().AddSVGObject(svg('<html><body/></html>'), RECT)).toThrow(PdfParseError);
  });

  it('throws TypeError for a malformed rect', () => {
    expect(() => page().AddSVGObject(svg(DOC), [0, 0, 0, 100] as [number, number, number, number]))
      .toThrow(TypeError);
    expect(() => page().AddSVGObject(svg(DOC), [0, 0, 100] as unknown as
      [number, number, number, number])).toThrow(TypeError);
    expect(() => page().AddSVGObject(svg(DOC), [0, NaN, 100, 100])).toThrow(TypeError);
  });

  it('throws TypeError for an unknown fit', () => {
    expect(() => page().AddSVGObject(svg(DOC), RECT, { fit: 'cover' as 'meet' }))
      .toThrow(TypeError);
  });

  it('leaves the page byte-identical when a call is rejected', () => {
    const p = page();
    const before = p.Document.Save();
    expect(() => p.AddSVGObject(svg(DOC), RECT, { fit: 'cover' as 'meet' })).toThrow(TypeError);
    expect(() => p.AddSVGObject(svg('<html/>'), RECT)).toThrow(PdfParseError);
    expect(p.Document.Save()).toEqual(before);
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/svg-embed.test.ts`
Expected: FAIL — cannot resolve `../src/svgembed.js` / `AddSVGObject is not a function`.

- [x] **Step 3a: Create `src/svgembed.ts`**

```ts
// SVG placement (issue 1gg0.3): wrap the content stream from svgdraw.ts as a
// Form XObject and draw it into a target rect. This is the only module in the
// SVG stack that touches a Document.
import type { Document } from './document.js';
import type { Page } from './page.js';
import { PdfParseError } from './errors.js';
import { parseXml } from './xml.js';
import { enc } from './serialize.js';
import { num, ensureOwnResources, ensureOwnSubdict, freshKey, appendContent } from './pagecontent.js';
import { name, type PdfDict, type PdfObject } from './types.js';
import { drawSvg } from './svgdraw.js';
import { parseViewBox, placementMatrix, type ViewBox } from './svgtransform.js';

/** Options for {@link Page.AddSVGObject}. */
export interface AddSVGOptions {
  /** Override the file's own preserveAspectRatio: 'meet' fits the drawing
   *  inside the rect, 'slice' covers it, 'fill' stretches each axis
   *  independently. Default: whatever the SVG asks for (xMidYMid meet). */
  fit?: 'meet' | 'slice' | 'fill';
}

/** The outcome of {@link Page.AddSVGObject}. */
export interface AddSVGResult {
  /** Distinct element names whose rendering was skipped or incomplete, sorted —
   *  e.g. ['linearGradient', 'text']. Empty when the SVG rendered in full. */
  skipped: string[];
}

/** The user-unit box the content is expressed in: the viewBox, else the root
 *  width/height, else the target rect (an identity mapping). */
function resolveViewBox(
  attrs: Map<string, string>, rect: [number, number, number, number],
): ViewBox {
  const vb = parseViewBox(attrs.get('viewBox'));
  if (vb) return vb;
  const w = parseFloat(attrs.get('width') ?? '');
  const h = parseFloat(attrs.get('height') ?? '');
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0)
    return { minX: 0, minY: 0, w, h };
  return { minX: 0, minY: 0, w: rect[2], h: rect[3] };
}

/** Parse `data` as SVG and draw it into `rect` on `page`. Existing content is
 *  preserved. Validation runs before anything is allocated, so a rejected call
 *  leaves the document byte-identical. */
export function addSvgObject(
  doc: Document, page: Page, data: Uint8Array,
  rect: [number, number, number, number], opts: AddSVGOptions = {},
): AddSVGResult {
  if (!Array.isArray(rect) || rect.length !== 4 || !rect.every((n) => Number.isFinite(n)))
    throw new TypeError('rect must be [x, y, w, h] of finite numbers');
  if (!(rect[2] > 0) || !(rect[3] > 0))
    throw new TypeError('rect width and height must be positive');
  const fit = opts.fit;
  if (fit !== undefined && fit !== 'meet' && fit !== 'slice' && fit !== 'fill')
    throw new TypeError("fit must be 'meet', 'slice' or 'fill'");

  const root = parseXml(data);                 // throws PdfParseError if malformed
  if (root.name !== 'svg') throw new PdfParseError(`SVG: root element is <${root.name}>, not <svg>`);

  const vb = resolveViewBox(root.attrs, rect);
  const { content, resources, skipped } = drawSvg(root);

  const form: PdfDict = new Map<string, PdfObject>([
    ['Type', name('XObject')],
    ['Subtype', name('Form')],
    ['FormType', 1],
    ['BBox', [vb.minX, vb.minY, vb.minX + vb.w, vb.minY + vb.h]],
    ['Matrix', [1, 0, 0, 1, 0, 0]],
    ['Resources', resources],
  ]);
  const ref = doc.allocObject({ kind: 'stream', dict: form, raw: enc(content) });

  const res = ensureOwnResources(doc, page);
  const xobjs = ensureOwnSubdict(doc, res, 'XObject');
  const key = freshKey(xobjs, 'Fm');
  xobjs.set(key, ref);

  // Clip to the rect unconditionally: 'slice' deliberately overflows, and no
  // SVG should paint outside the rectangle it was handed.
  const [x, y, w, h] = rect;
  const m = placementMatrix(vb, rect, root.attrs.get('preserveAspectRatio'), fit);
  appendContent(doc, page, enc(
    `q\n${num(x)} ${num(y)} ${num(w)} ${num(h)} re\nW n\n` +
    `${m.map(num).join(' ')} cm\n/${key} Do\nQ`));

  return { skipped };
}
```

- [x] **Step 3b: Wire `Page.AddSVGObject`**

In `src/page.ts`, add to the imports (beside the `barcodeplace` import, line 14):

```ts
import { addSvgObject, AddSVGOptions, AddSVGResult } from './svgembed.js';
```

and add the method immediately after `AddBarcode` (~line 492):

```ts
  /** Parse `data` as SVG and draw its geometry and paint into `rect` =
   *  [x, y, w, h] as a Form XObject. The drawing is fitted per the file's own
   *  `preserveAspectRatio` (override with `opts.fit`) and always clipped to the
   *  rect. v1 covers shapes, paths, transforms, clipping and solid paint;
   *  anything it cannot render — text, gradients, images, masks, filters — is
   *  skipped and named in `result.skipped`. Existing content is preserved. */
  AddSVGObject(
    data: Uint8Array, rect: [number, number, number, number], opts?: AddSVGOptions,
  ): AddSVGResult {
    return addSvgObject(this.doc, this, data, rect, opts ?? {});
  }
```

- [x] **Step 3c: Export the public types**

In `src/index.ts`, beside the booklet export (~line 102):

```ts
export type { AddSVGOptions, AddSVGResult } from './svgembed.js';
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/svg-embed.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [x] **Step 5: Commit**

```bash
git add src/svgembed.ts src/page.ts src/index.ts test/svg-embed.test.ts
git commit -m "feat(svg): page.AddSVGObject places an SVG as a Form XObject (1gg0.3)"
```

---

### Task 8: Mutation proof, docs, and close-out

**Files:**
- Test: `test/svg-embed.test.ts` (append a describe)
- Modify: `README.md` (image-insertion bullet ~line 18; API table ~line 1306)

**Interfaces:**
- Consumes: everything from Tasks 1-7. Adds no source symbols.

- [x] **Step 1: Write the end-to-end test**

Append to `test/svg-embed.test.ts`:

```ts
describe('page.AddSVGObject — end to end', () => {
  it('renders a realistic icon without skipping anything', () => {
    const icon =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
      '<defs><clipPath id="c"><rect x="2" y="2" width="20" height="20" rx="4"/></clipPath>' +
      '<g id="tick"><path d="M6 12l4 4 8-8" fill="none" stroke="#fff" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round"/></g></defs>' +
      '<g clip-path="url(#c)">' +
      '<rect width="24" height="24" fill="#2d7"/>' +
      '<use href="#tick"/>' +
      '<circle cx="20" cy="4" r="3" fill="rgb(255,0,0)" opacity="0.75"/>' +
      '</g></svg>';
    const p = page();
    const r = p.AddSVGObject(svg(icon), [72, 500, 48, 48]);
    expect(r.skipped).toEqual([]);
    const form = theForm(p.Document, p);
    const c = dec(form.raw);
    expect(c).toContain('W n');            // the clip
    expect(c).toContain('0.133333 0.866667 0.466667 rg');   // #2d7
    expect(c).toContain('1 1 1 RG');       // the white tick stroke
    expect(c).toContain('2 w');
    expect(c).toContain('1 J');
    expect(c).toMatch(/\/GS\d+ gs/);       // the 0.75 circle
  });

  it('degrades a mixed SVG: draws what it can, names what it cannot', () => {
    const mixed =
      '<svg viewBox="0 0 10 10">' +
      '<rect width="10" height="10" fill="blue"/>' +
      '<text x="1" y="5">label</text>' +
      '<image href="pic.png" width="4" height="4"/>' +
      '</svg>';
    const p = page();
    const r = p.AddSVGObject(svg(mixed), RECT);
    expect(r.skipped).toEqual(['image', 'text']);
    expect(dec(theForm(p.Document, p).raw)).toContain('0 0 1 rg');   // the rect still drew
  });
});
```

- [x] **Step 2: Run it, then prove the y-flip and the paint defaults load-bearing**

Run: `npx vitest run test/svg-*.test.ts`
Expected: PASS.

Several of these assertions pass on the first run, so per this repo's rule prove
they are load-bearing. Make each mutation, confirm RED, then restore and confirm
GREEN:

1. **The y-flip.** In `svgtransform.ts`'s `placementMatrix`, change `-sy` to
   `sy` in the returned matrix. Expected RED: `placementMatrix` "flips the y
   axis" and the embed test's `2 0 0 -2 0 100 cm`.
2. **The initial fill.** In `svgstyle.ts`, change `INITIAL.fill` to `null`.
   Expected RED: "fills black by default".
3. **The initial stroke.** Change `INITIAL.stroke` to `[0, 0, 0]`. Expected
   RED: "fills black by default and does not stroke" and the line test.
4. **Transform fold order.** In `svgtransform.ts`'s `parseTransform`, fold the
   list left to right instead (`for (let i = 0; i < fns.length; i++)`). Expected
   RED: "composes a list left to right, outermost first".
5. **The url() fallback.** In `svgstyle.ts`'s `parsePaint`, return
   `[0, 0, 0]` instead of `null` for a reference with no fallback. Expected RED:
   "reports a url() paint and falls back to none".

- [x] **Step 3: Document the API in README.md**

In the **Image insertion** bullet's vicinity (~line 18), add a new bullet after it:

```markdown
- **SVG embedding** — `page.AddSVGObject(data, [x, y, w, h], opts?)` parses an SVG asset and draws it as a Form XObject fitted to the rectangle, honouring the file's own `viewBox`/`preserveAspectRatio` (override with `opts.fit`: `'meet'`/`'slice'`/`'fill'`) and always clipping to the rect. Covers paths (all commands including arcs), `rect`/`circle`/`ellipse`/`line`/`polyline`/`polygon`, `g`/`defs`/`use`, `clipPath`, `transform` lists, and solid paint (`fill`, `stroke`, widths, caps, joins, dashes, `fill-rule`, opacities) from presentation attributes and inline `style=`. Text, gradients, patterns, `<image>`, masks, filters, markers and CSS `<style>` selectors are **not** rendered — they are skipped and named in `result.skipped`, so a caller can detect the degradation. Group `opacity` is folded into child alphas, which is exact unless the children overlap.
```

In the API table, after the `page.AddImage(...)` row (~line 1306):

```markdown
| `page.AddSVGObject(data, rect, opts?)` | Parse an SVG and draw it into `[x, y, w, h]` as a Form XObject (`fit` overrides `preserveAspectRatio`); returns `{ skipped }` naming anything it could not render |
```

- [x] **Step 4: Run the full gates**

Run: `npm run typecheck && npm test`
Expected: both green. The full suite matters here: `Page` gained a method and
`index.ts` two type exports.

- [x] **Step 5: Commit and close the issue**

```bash
git add test/svg-embed.test.ts README.md
git commit -m "test(svg): end-to-end icon + mutation proof; docs(svg): README AddSVGObject (1gg0.3)"
bd close aspose-pdf-foss-for-ts-1gg0.3
git pull --rebase && git push && git status
```

Then file the seven follow-ups the spec deferred:

```bash
bd create "SVG gradients (linearGradient / radialGradient -> PDF shadings)" -t feature -p 3 --parent aspose-pdf-foss-for-ts-1gg0 -d "page.AddSVGObject skips gradient paints and reports them. Map <linearGradient>/<radialGradient> to PDF axial/radial shadings via colorspace.ts + pdffunction.ts: stops, gradientUnits, gradientTransform, and spreadMethod (repeat/reflect need synthesized stops - PDF has no direct equivalent). Deferred from 1gg0.3; see docs/superpowers/specs/2026-07-28-svg-embedding-design.md."
bd create "SVG text (<text> / <tspan>)" -t feature -p 3 --parent aspose-pdf-foss-for-ts-1gg0 -d "page.AddSVGObject skips <text>. Needs font-family resolution against the Standard-14 faces (anything else needs an embedded font the SVG cannot supply), text-anchor, dominant-baseline and per-glyph x/y/dx/dy. Deferred from 1gg0.3."
bd create "SVG <image> embedding" -t feature -p 3 --parent aspose-pdf-foss-for-ts-1gg0 -d "page.AddSVGObject skips <image>. Decode data: URIs (and reject or resolve external hrefs) and embed through imageembed.ts. Deferred from 1gg0.3."
bd create "SVG masks, filters and markers" -t feature -p 4 --parent aspose-pdf-foss-for-ts-1gg0 -d "page.AddSVGObject skips <mask>, <filter> and marker-start/mid/end. Masks map to PDF soft masks; most filters have no PDF equivalent and would need rasterizing. Deferred from 1gg0.3."
bd create "SVG CSS <style> selector support" -t feature -p 4 --parent aspose-pdf-foss-for-ts-1gg0 -d "page.AddSVGObject honours presentation attributes and inline style= only. Add a minimal CSS parser for <style> blocks with type/class/id selectors and specificity. Deferred from 1gg0.3."
bd create "SVG group opacity via transparency groups" -t feature -p 4 --parent aspose-pdf-foss-for-ts-1gg0 -d "page.AddSVGObject folds <g opacity> into child alphas, which is exact only when children do not overlap. Correct semantics need a transparency group (/Group /S /Transparency) around the subtree. Deferred from 1gg0.3."
bd create "Real-world SVG fixture with provenance" -t task -p 3 --parent aspose-pdf-foss-for-ts-1gg0 -d "test/svg-*.test.ts uses programmatic builders only, so our parser and our builders could agree with each other and both disagree with the format (implicit repeated commands, exponent notation, omitted separators). Add a third-party SVG under test/fixtures/svg/ with a PROVENANCE.md recording producer, version, command and SHA-256, per CLAUDE.md. Deferred from 1gg0.3."
```

---

## Notes for the implementer

- **The y-flip lives in exactly one place** — `placementMatrix`. The walker
  emits raw viewBox coordinates with y pointing down. If you find yourself
  negating a y anywhere in `svgdraw.ts`, something is wrong.
- **`mul(m, n)` is "m followed by n".** SVG transform lists fold RIGHT to LEFT.
  Task 3 has a test that fails if you get this backwards.
- **`svgpath.ts`, `svgstyle.ts`, `svgtransform.ts` and `svgdraw.ts` import no
  `Document`.** That is what lets four fifths of this feature be tested without
  building a PDF. `svgembed.ts` is the only module that allocates.
- **`/ExtGState` entries are direct dicts** inside the form's own `/Resources`.
  Do not use `registerExtGState` from pagecontent.ts: it is page-bound and ties
  `ca` and `CA` together, which SVG needs separate.
- **An unsupported paint never becomes black.** It becomes `none` (or the
  explicit fallback) and is reported. A silently wrong solid fill is worse than
  a visibly missing one.
- **`xml.ts` strips namespace prefixes**, so `xlink:href` arrives as `href` and
  `<svg:rect>` as `rect`. Do not write prefix-handling code.
- **Do not export the internal modules from `index.ts`.** The public surface is
  `AddSVGOptions`, `AddSVGResult` and `Page.AddSVGObject`.
