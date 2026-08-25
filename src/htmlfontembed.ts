import type { Document } from './document.js';
import { PdfDict, PdfObject, isDict, isName, isStream, isArray } from './types.js';
import { Rgb, rgbHex } from './colorspace.js';
import { TextRunInfo } from './pagerender.js';
import { buildGlyphSource, gidForCode, GlyphSource } from './raster.js';
import { buildCmap, replaceTable, otfFromCff, OtfMetrics } from './sfntwrite.js';
import { sfntToWoff } from './woffwrite.js';
import { Type1Font } from './type1.js';
import { type1ToCff, newGidByOldGid } from './type1cff.js';

const PUA_BASE = 0xe000;

/** Per-embedded-program accumulation: GID→rendering codepoint, GID→advance. */
interface ProgramState {
  key: number;                          // stable family index (pf<key>)
  src: GlyphSource;
  gidToCp: Map<number, number>;
  claimed: Set<number>;                 // Unicode scalars already taken by some GID
  advances: Map<number, number>;        // gid -> font-unit advance
  nextPua: number;                      // next free PUA codepoint
  embeddable: boolean;
}

/** Accumulates embedded font programs used by fixed-mode spans and emits, per
 *  distinct program, one base64 WOFF `@font-face` with a freshly built Unicode
 *  cmap. See docs/superpowers/specs/2026-07-16-html-font-embedding-design.md. */
export class EmbeddedFontRegistry {
  private programs = new Map<PdfDict, ProgramState>();
  private classes = new Map<string, string>();   // "pf<key>|hex" -> ".eN"
  private classRules: string[] = [];
  private nextProgram = 0;

  constructor(private doc: Document, private allowRestricted: boolean) {}

  /** Rendering characters + CSS class for `info`, or null to fall back to map
   *  mode.
   *
   *  `chars` is PER GLYPH and parallel to `info.font.decodeGlyphs(info.bytes)`,
   *  not a single string: a vertical run positions every glyph itself
   *  (`htmlfixed.ts`, `kf8h.4`) and needs them separably, while the horizontal
   *  path simply joins them. One method rather than two, so the gid→codepoint
   *  assignment below — which mutates `prog` — cannot be duplicated and drift. */
  run(info: TextRunInfo): { cls: string; chars: string[] } | null {
    const dict = info.fontDict;
    if (!dict) return null;
    const prog = this.program(dict);
    if (!prog.embeddable) return null;

    const glyphs = info.font.decodeGlyphs(info.bytes);
    const unitsPerEm = programUnitsPerEm(prog);
    const chars: string[] = [];
    for (const g of glyphs) {
      // A composite font selects its glyph by CID, not by the code — they are
      // the same number only under Identity encoding.
      const key = prog.src.isType0 ? g.cid : codeOf(info.bytes, g.byteStart, g.byteLen);
      const gid = gidForCode(prog.src, key, g.text) ?? 0;
      let cp = prog.gidToCp.get(gid);
      if (cp === undefined) {
        cp = this.assign(prog, g.text);
        prog.gidToCp.set(gid, cp);
        prog.advances.set(gid, Math.round(g.width * unitsPerEm));
      }
      chars.push(String.fromCodePoint(cp));
    }
    return { cls: this.classFor(prog, info.color), chars };
  }

  /** Every `@font-face` rule (base64 WOFF) plus every `.eN` class rule. */
  css(): string {
    const faces: string[] = [];
    for (const prog of this.programs.values()) {
      if (!prog.embeddable || prog.gidToCp.size === 0) continue;
      try {
        const woff = sfntToWoff(buildProgramSfnt(prog));
        const b64 = Buffer.from(woff).toString('base64');
        faces.push(`@font-face{font-family:pf${prog.key};src:url(data:font/woff;base64,${b64}) format("woff")}`);
      } catch { /* drop this font — its runs already carry embedded classes; a
                   missing @font-face degrades to the class's absent family */ }
    }
    return faces.join('') + this.classRules.join('');
  }

  /** Assign a stable rendering codepoint: real Unicode when it is a single,
   *  unclaimed scalar; else the next Private-Use codepoint. */
  private assign(prog: ProgramState, text: string): number {
    const cps = [...text];
    if (cps.length === 1) {
      const u = cps[0].codePointAt(0)!;
      if (!prog.claimed.has(u)) { prog.claimed.add(u); return u; }
    }
    return prog.nextPua++;
  }

  private classFor(prog: ProgramState, color: Rgb): string {
    const hex = rgbHex(color);
    const key = `pf${prog.key}|${hex}`;
    let cls = this.classes.get(key);
    if (!cls) {
      cls = `e${this.classes.size}`;
      // No synthetic weight/style: the embedded program is the exact face.
      this.classRules.push(`.${cls}{font-family:pf${prog.key};color:${hex}}`);
      this.classes.set(key, cls);
    }
    return cls;
  }

  private program(dict: PdfDict): ProgramState {
    let prog = this.programs.get(dict);
    if (prog) return prog;
    const src = buildGlyphSource(this.doc, dict);
    prog = {
      key: this.nextProgram, src,
      gidToCp: new Map(), claimed: new Set(), advances: new Map(),
      nextPua: PUA_BASE, embeddable: this.probe(dict, src),
    };
    if (prog.embeddable) this.nextProgram++;   // only embeddable programs get a family
    this.programs.set(dict, prog);
    return prog;
  }

  /** Embeddable iff an embedded FontFile/FontFile2/FontFile3 backs it and
   *  fsType allows.
   *
   *  A `/FontFile` Type 1 qualifies since `m9on`: `buildProgramSfnt` converts
   *  it to OpenType-CFF through `type1cff.ts`. The conversion is NOT done here
   *  — this runs the first time a font is used, and interpreting every
   *  charstring in a face that may never reach `css()` is work for nothing. */
  private probe(dict: PdfDict, src: GlyphSource): boolean {
    const fd = descriptorOf(this.doc, dict);
    if (!isDict(fd)) return false;
    const hasFF2 = isStream(this.doc.resolve(fd.get('FontFile2')));
    const hasFF3 = isStream(this.doc.resolve(fd.get('FontFile3')));
    const hasFF1 = isStream(this.doc.resolve(fd.get('FontFile')));
    if (!hasFF1 && !hasFF2 && !hasFF3) return false;  // non-embedded
    if (!src.sfnt && !src.cff && !src.type1) return false;   // failed to parse
    // A Type 1 program carries no OS/2 table, so it states no fsType at all --
    // there are no embedding-permission bits to honour and `embed` behaves as
    // `embed-all` does. Structural, not an oversight.
    if (!this.allowRestricted && src.sfnt) {
      const os2 = src.sfnt.table('OS/2', false);
      if (os2 && os2.length >= 10) {
        const fsType = new DataView(os2.buffer, os2.byteOffset, os2.byteLength).getUint16(8);
        if (fsType & 0x0002) return false;
      }
    }
    return true;
  }
}

function codeOf(bytes: Uint8Array, start: number, len: number): number {
  let c = 0;
  for (let k = 0; k < len; k++) c = (c << 8) | (bytes[start + k] ?? 0);
  return c;
}

function descriptorOf(doc: Document, dict: PdfDict): PdfObject | undefined {
  const sub = doc.resolve(dict.get('Subtype'));
  if (isName(sub) && sub.name === 'Type0') {
    const dfs = doc.resolve(dict.get('DescendantFonts'));
    const df = isArray(dfs) ? doc.resolve(dfs[0]) : undefined;
    return isDict(df) ? doc.resolve(df.get('FontDescriptor')) : undefined;
  }
  return doc.resolve(dict.get('FontDescriptor'));
}

function programUnitsPerEm(prog: ProgramState): number {
  // A Type 1's units come from its /FontMatrix and are not always 1000 -- a
  // 2048/em face would otherwise have every advance scaled by half.
  return prog.src.sfnt?.unitsPerEm ?? prog.src.cff?.unitsPerEm
    ?? prog.src.type1?.unitsPerEm ?? 1000;
}

/** The browser-ready sfnt for a program: replace `cmap` on an existing sfnt,
 *  convert a Type 1 to OpenType-CFF, or wrap a bare CFF into an OTF. */
function buildProgramSfnt(prog: ProgramState): Uint8Array {
  const sf = prog.src.sfnt;
  if (sf) return replaceTable(sf.raw, 'cmap', buildCmap(prog.gidToCp));
  if (prog.src.type1 && !prog.src.cff) return buildType1Sfnt(prog, prog.src.type1);
  const cmap = buildCmap(prog.gidToCp);
  const cff = prog.src.cff!;
  const advances: number[] = [];
  for (const [gid, adv] of prog.advances) advances[gid] = adv;
  const m: OtfMetrics = {
    numGlyphs: cff.numGlyphs, unitsPerEm: cff.unitsPerEm || 1000,
    advances, bbox: [0, -200, cff.unitsPerEm || 1000, 800], ascent: 800, descent: -200,
  };
  return otfFromCff(cff.raw, cmap, m);
}

/**
 * A Type 1 program as an OpenType-CFF sfnt carrying this program's cmap.
 *
 * THE GLYPH IDS MUST BE TRANSLATED. `run()` collected `gidToCp` and `advances`
 * in the Type 1 program's OWN numbering — order of appearance in
 * `/CharStrings`, which is what `gidForCode` answers — while `type1ToCff`
 * renumbers so `.notdef` is gid 0, as CFF requires. The bundled
 * `NimbusSans-Regular.t1` lists `/.notdef` LAST, so every glyph shifts by one.
 * Both numbers are valid glyph ids, so skipping this remap throws nothing and
 * silently renders each character as its neighbour.
 */
function buildType1Sfnt(prog: ProgramState, t1: Type1Font): Uint8Array {
  const conv = type1ToCff(t1.raw);
  const remap = newGidByOldGid(conv.order);
  const at = (oldGid: number): number => remap.get(oldGid) ?? 0;

  const cmap = new Map<number, number>();
  for (const [oldGid, cp] of prog.gidToCp) cmap.set(cp, at(oldGid));

  const advances: number[] = [];
  for (const [oldGid, adv] of prog.advances) advances[at(oldGid)] = adv;

  return otfFromCff(conv.cff, buildCmap(cmap), {
    numGlyphs: conv.order.length,
    unitsPerEm: conv.header.unitsPerEm,
    advances,
    bbox: conv.bbox,
    ascent: conv.bbox[3],
    descent: conv.bbox[1],
    psName: conv.header.fontName ?? 'Type1Font',
  });
}
