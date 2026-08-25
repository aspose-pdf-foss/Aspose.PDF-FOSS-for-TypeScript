import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Seg } from '../src/pagerender.js';
import { Type1Font } from '../src/type1.js';
import { CffFont } from '../src/cff.js';
import { parseSfnt } from '../src/sfnt.js';
import { Document } from '../src/document.js';
import { TextFont } from '../src/font.js';
import { loadEmbeddedProgram, programAdvance } from '../src/glyphprogram.js';
import { PdfDict, PdfObject, PdfStream, name as pdfName } from '../src/types.js';
import { buildType1Pdf } from './helpers/build-type1-pdf.js';

const DIR = new URL('./fixtures/fonts/', import.meta.url);
const t1 = new Type1Font(new Uint8Array(readFileSync(new URL('NimbusSans-Regular.t1', DIR))));
const afm = readFileSync(new URL('NimbusSans-Regular.afm', DIR), 'latin1');

/** glyph name -> { wx, llx } from the AFM's CharMetrics lines. */
function afmMetrics(text: string): Map<string, { wx: number; llx: number }> {
  const out = new Map<string, { wx: number; llx: number }>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('C ')) continue;
    const wx = /WX\s+(-?\d+)/.exec(line);
    const n = /N\s+([^\s;]+)/.exec(line);
    const bb = /B\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)/.exec(line);
    if (wx && n && bb) out.set(n[1], { wx: +wx[1], llx: +bb[1] });
  }
  return out;
}
const metrics = afmMetrics(afm);

function bbox(path: Seg[]): [number, number, number, number] | undefined {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const see = (x: number, y: number): void => {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y);
    x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  };
  for (const s of path) {
    if (s.op === 'Z') continue;
    see(s.x, s.y);
    if (s.op === 'C') { see(s.x1, s.y1); see(s.x2, s.y2); }
  }
  return Number.isFinite(x0) ? [x0, y0, x1, y1] : undefined;
}

/** The on-curve start point of every subpath. Sharper than a bounding box: a
 *  flex that fails to assemble, or a subr that is never called, leaves the
 *  seven flex points as separate movetos — shredding the contour structure
 *  while barely moving the extent. */
function contourStarts(path: Seg[]): [number, number][] {
  const out: [number, number][] = [];
  for (const s of path) if (s.op === 'M') out.push([s.x, s.y]);
  return out;
}

describe('NimbusSans-Regular.t1 — a Type 1 program we did not produce', () => {
  it('reads the whole CharStrings dictionary', () => {
    // The AFM lists .notdef too, at C -1, so the correspondence is exactly 1:1
    // and the width case below covers every charstring in the program.
    expect(metrics.size).toBe(855);
    expect(t1.numGlyphs).toBe(metrics.size);
    expect(t1.unitsPerEm).toBe(1000);
  });

  it('numbers its glyphs by /CharStrings order, with no reserved slot', () => {
    // This face lists /A first and /.notdef LAST. Type 1 has no glyph-id space,
    // so a reader that assumes the CFF/TrueType convention of gid 0 = .notdef,
    // or that a code can index the program directly, is wrong by 854 here. The
    // glyph name is the only route in.
    expect(t1.glyphName(0)).toBe('A');
    expect(t1.gidForName('.notdef')).toBe(854);
    expect(t1.gidForName('nosuchglyph')).toBeUndefined();
  });

  // Oracle 1: the AFM. Nothing in type1.ts or type1charstring.ts reads it, so
  // an interpreter bug cannot corrupt both sides. This is the analogue of the
  // hmtx lsb cross-check that was the ONLY assertion to catch the CFF subr-bias
  // mutations — see test/fixtures/fonts/PROVENANCE.md.
  it('every hsbw width equals the AFM advance', () => {
    const bad: string[] = [];
    for (const [name, m] of metrics) {
      const gid = t1.gidForName(name);
      if (gid === undefined) { bad.push(`${name}: absent`); continue; }
      const w = t1.glyphWidth(gid);
      if (w !== m.wx) bad.push(`${name}: hsbw ${w} != AFM ${m.wx}`);
    }
    expect(bad).toEqual([]);
  });

  it('no control point starts left of the AFM bounding box', () => {
    // A charstring's control points bound its curves, so the minimum control x
    // can never exceed the true left extremum. minX > llx is impossible; minX
    // below it is ordinary curve-hull slack.
    const violations: string[] = [];
    let withOutlines = 0;
    for (const [name, m] of metrics) {
      const gid = t1.gidForName(name);
      if (gid === undefined) continue;
      const b = bbox(t1.glyphPath(gid));
      if (!b) continue;
      withOutlines++;
      if (b[0] > m.llx + 1) violations.push(`${name}: minX ${b[0]} > llx ${m.llx}`);
    }
    expect(violations).toEqual([]);
    expect(withOutlines).toBeGreaterThan(600);     // non-vacuity
  });

  // Oracle 2: the same design read through cff.ts's Type 2 interpreter, which
  // shares no code with the Type 1 one. PROVENANCE.md warns that a differential
  // between two copies of one font validates only the round-trip — that applies
  // when both sides run the same interpreter, which is exactly what these two
  // do not.
  it('agrees with the OTF of the same face on every shared glyph', () => {
    const otf = parseSfnt(new Uint8Array(readFileSync(new URL('NimbusSans-Regular.otf', DIR))));
    const cff = new CffFont(otf.table('CFF ', false)!);
    const cffNames = cff.charsetNames();
    let compared = 0;
    const bad: string[] = [];
    for (let gid = 1; gid < cffNames.length; gid++) {
      const name = cffNames[gid];
      if (!name) continue;
      const t1gid = t1.gidForName(name);
      if (t1gid === undefined) continue;
      const a = bbox(t1.glyphPath(t1gid));
      const b = bbox(cff.glyphPath(gid));
      if (!a || !b) continue;
      compared++;
      for (let k = 0; k < 4; k++) {
        if (Math.abs(a[k] - b[k]) > 2) { bad.push(`${name}: bbox [${a}] vs [${b}]`); break; }
      }
    }
    expect(compared).toBeGreaterThan(600);
    expect(bad).toEqual([]);
  });

  it('agrees with the OTF on contour structure, not merely on extent', () => {
    // The bounding box alone is far too coarse. A flex is a deliberately
    // shallow curve, so failing to assemble one — or never calling the subr
    // that starts it — leaves seven stray movetos whose extent is nearly
    // identical to the curve they should have formed. Contour starts catch it.
    const otf = parseSfnt(new Uint8Array(readFileSync(new URL('NimbusSans-Regular.otf', DIR))));
    const cff = new CffFont(otf.table('CFF ', false)!);
    const cffNames = cff.charsetNames();
    let compared = 0;
    const bad: string[] = [];
    for (let gid = 1; gid < cffNames.length; gid++) {
      const name = cffNames[gid];
      if (!name) continue;
      const t1gid = t1.gidForName(name);
      if (t1gid === undefined) continue;
      const a = contourStarts(t1.glyphPath(t1gid));
      const b = contourStarts(cff.glyphPath(gid));
      if (a.length === 0 && b.length === 0) continue;
      compared++;
      if (a.length !== b.length) {
        bad.push(`${name}: ${a.length} contours vs ${b.length}`);
        continue;
      }
      for (let k = 0; k < a.length; k++) {
        if (Math.abs(a[k][0] - b[k][0]) > 2 || Math.abs(a[k][1] - b[k][1]) > 2) {
          bad.push(`${name}: contour ${k} starts [${a[k]}] vs [${b[k]}]`);
          break;
        }
      }
    }
    expect(compared).toBeGreaterThan(600);
    expect(bad).toEqual([]);
  });
});

describe('embedded-program widths against the AFM', () => {
  const id = (o: PdfObject | undefined): PdfObject => (o ?? null) as PdfObject;
  const inflate = (s: { raw: Uint8Array }) => s.raw;
  const dict = (e: Record<string, PdfObject>): PdfDict => new Map(Object.entries(e));
  const stream = (raw: Uint8Array): PdfStream => ({ kind: 'stream', dict: new Map(), raw });
  const t1Bytes = new Uint8Array(readFileSync(new URL('NimbusSans-Regular.t1', DIR)));
  const otfBytes = new Uint8Array(readFileSync(new URL('NimbusSans-Regular.otf', DIR)));

  it('reports the AFM advance for every Type 1 glyph, normalised', () => {
    const prog = loadEmbeddedProgram(dict({ FontFile: stream(t1Bytes) }), id, inflate);
    const bad: string[] = [];
    for (const [glyph, m] of metrics) {
      const gid = prog.type1!.gidForName(glyph);
      if (gid === undefined) continue;
      const w = programAdvance(prog, gid)!;
      if (Math.abs(w - m.wx) > 0.5) bad.push(`${glyph}: ${w} != AFM ${m.wx}`);
    }
    expect(bad).toEqual([]);
  });

  it('reports the AFM advance through the CFF path too', () => {
    // The same design, same metrics, read through the charstring width prefix
    // rather than hsbw — a second program kind against one oracle.
    const prog = loadEmbeddedProgram(dict({ FontFile3: stream(otfBytes) }), id, inflate);
    const names = prog.cff!.charsetNames();
    const bad: string[] = [];
    let checked = 0;
    for (let gid = 1; gid < names.length; gid++) {
      const n = names[gid];
      const m = n ? metrics.get(n) : undefined;
      if (!m) continue;
      checked++;
      const w = programAdvance(prog, gid)!;
      if (Math.abs(w - m.wx) > 0.5) bad.push(`${n}: ${w} != AFM ${m.wx}`);
    }
    expect(checked).toBeGreaterThan(600);
    expect(bad).toEqual([]);
  });

  it('measures a /Widths-less font dict at the AFM advances', () => {
    const font = new TextFont(dict({
      Subtype: pdfName('Type1'), BaseFont: pdfName('AAAAAB+NimbusSans-Regular'),
      FontDescriptor: dict({ FontFile: stream(t1Bytes) }),
    }), id, inflate);
    for (const [glyph, code] of [['A', 0x41], ['i', 0x69], ['W', 0x57], ['space', 0x20]] as const) {
      const expected = metrics.get(glyph)!.wx / 1000;
      expect(font.decodeGlyphs(Uint8Array.from([code]))[0].width).toBeCloseTo(expected, 5);
    }
  });

  it('spaces GetTextFragments by the program advances, with no /Widths', () => {
    // The issue's acceptance criterion, end to end. GetTextFragments groups
    // 'AVA' into one fragment, so its pen span carries the three advances.
    const pdf = buildType1Pdf(t1Bytes, { text: 'AVA', size: 20, omitWidths: true });
    const frags = Document.Open(pdf).Pages[0].GetTextFragments();
    expect(frags).toHaveLength(1);
    expect(frags[0].text).toBe('AVA');
    const span = frags[0].quad[2] - frags[0].quad[0];
    const expected = ((metrics.get('A')!.wx * 2 + metrics.get('V')!.wx) / 1000) * 20;
    expect(span).toBeCloseTo(expected, 1);
    expect(frags[0].quad[0]).toBeCloseTo(10, 1);      // the Td in buildType1Pdf
  });
});
