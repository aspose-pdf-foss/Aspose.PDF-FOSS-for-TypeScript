import { PdfDict, PdfObject, PdfStream, isDict, isName, isArray, isStream, isString } from './types.js';
import type { Matrix } from './text.js';
import {
  baseEncodingByName, baseEncodingNamesByName, encodeWinAnsi, glyphToUnicode,
  standardEncodingNames, winAnsi,
} from './encoding.js';
import { glyphWidth, normalizeFont } from './metrics.js';
import { parseCMap, CMap } from './cmap.js';
import { CidCMap, parseCidCMap } from './cidcmap.js';
import { getPredefinedCMap } from './predefcmap.js';
import { CidToUnicode, getCidToUnicode } from './cidunicode.js';
import { UnsupportedFeatureError } from './errors.js';
import { gidForProgram, gidForCid, loadEmbeddedProgram, programAdvance } from './glyphprogram.js';

type Resolve = (o: PdfObject | undefined) => PdfObject;
type Inflate = (s: { dict: PdfDict; raw: Uint8Array }) => Uint8Array;

/** One decoded character code: its text, em-width, byte span, and word-space flag. */
export interface Glyph {
  text: string;
  width: number;       // em units (glyph-space / 1000), excluding Tc/Tw
  byteStart: number;   // offset of this code within the show string
  byteLen: number;     // bytes consumed (may vary per code, see TextFont.codeWidth)
  isWordSpace: boolean;
  /**
   * The character code itself, as the show string spelled it.
   *
   * Carried rather than re-derived: reassembling it from `byteStart`/`byteLen`
   * is right only while every code is one byte, and every consumer that did so
   * had to be taught the composite case separately. A simple font's `/Widths`
   * and a Type 3 font's `/CharProcs` are both keyed by this; a composite font's
   * metrics are keyed by {@link Glyph.cid}.
   */
  code: number;
  /**
   * The CID this code selects, for a composite font; 0 for a simple font.
   *
   * **Invariant:** this, not the code, is what selects the glyph. They are
   * equal only under Identity encoding, so a consumer that re-derives the code
   * from `byteStart`/`byteLen` and looks a glyph up with it draws the right
   * glyph for `/Identity-H` and the wrong one for every other CMap — silently,
   * since both are valid glyph ids.
   */
  cid: number;
  /** Vertical-writing metrics, present only under `/WMode 1`. See
   *  {@link VerticalMetrics}; `width` stays the *horizontal* displacement. */
  vertical?: VerticalMetrics;
}

/**
 * A glyph's vertical-writing metrics, in em units (glyph space / 1000).
 *
 * Set vertically, a glyph is displaced down the page by `w1` and is *drawn*
 * offset by the negated position vector `(vx, vy)` — the translation from its
 * horizontal origin (on the left side bearing, at the baseline) to its vertical
 * origin (at the top centre). Ignoring the position vector leaves every glyph
 * about half an em too far right and a whole em too high: the column reads as a
 * diagonal smear rather than a line.
 */
export interface VerticalMetrics {
  /** `w1`: displacement along the writing direction. Normally *negative*,
   *  since the column runs down the page and PDF text space has Y up. */
  readonly w1: number;
  /** Position vector X: horizontal origin -> vertical origin. */
  readonly vx: number;
  /** Position vector Y. */
  readonly vy: number;
}

/**
 * The text-space displacement one glyph contributes (32000-1 9.4.4).
 *
 * **Invariant:** the three places that advance a text matrix — extraction,
 * the interpreter and the rasterizer — share this. They had the horizontal
 * formula written out three times, and adding a second writing direction to
 * each independently is how two of them end up disagreeing about a `Tz` or a
 * `Tc` on a page nobody looks at closely.
 *
 * Horizontal scaling multiplies the horizontal displacement only, so it does
 * not appear in the vertical case at all.
 */
export function glyphDisplacement(
  g: Glyph, fontSize: number, charSp: number, wordSp: number, hscale: number,
): [number, number] {
  const spacing = charSp + (g.isWordSpace ? wordSp : 0);
  if (g.vertical) return [0, g.vertical.w1 * fontSize + spacing];
  return [(g.width * fontSize + spacing) * hscale, 0];
}

/**
 * The text-space shift a `TJ` number contributes. Positive numbers move the
 * next glyph *backwards* along the writing direction, which is leftwards when
 * horizontal and upwards when vertical — the same rule, a different axis.
 */
export function tjShift(
  adjust: number, fontSize: number, hscale: number, vertical: boolean,
): [number, number] {
  const d = (-adjust / 1000) * fontSize;
  return vertical ? [0, d] : [d * hscale, 0];
}

/**
 * Where a glyph is *drawn*, given the pen position it advances from.
 *
 * Horizontally these are the same point. Vertically the pen sits at the glyph's
 * vertical origin while its outline is described from the horizontal one, so
 * the position vector is subtracted back off (32000-1 9.4.4). `vx` is a
 * horizontal text-space offset and so takes `Tz`, while `vy` does not.
 */
export function glyphOrigin(
  g: Glyph, penX: number, penY: number, fontSize: number, hscale: number,
): [number, number] {
  if (!g.vertical) return [penX, penY];
  return [penX - g.vertical.vx * fontSize * hscale, penY - g.vertical.vy * fontSize];
}

/** A decoded run's text and the metrics needed to advance past it. */
export interface RunMetrics {
  text: string;
  /** Sum of horizontal displacements, em units. */
  width: number;
  /** Sum of vertical displacements, em units; 0 for a horizontal font. */
  vwidth: number;
  ncodes: number;
  nWordSpaces: number;
}

/** {@link glyphDisplacement} for a whole run at once — the interpreter advances
 *  by the run, the rasterizer glyph by glyph, and both must land in the same
 *  place or a `Tz`/`Tc` page renders in one and extracts from the other. */
export function runDisplacement(
  run: RunMetrics, fontSize: number, charSp: number, wordSp: number,
  hscale: number, vertical: boolean,
): [number, number] {
  const spacing = run.ncodes * charSp + run.nWordSpaces * wordSp;
  if (vertical) return [0, run.vwidth * fontSize + spacing];
  return [(run.width * fontSize + spacing) * hscale, 0];
}

/**
 * What a renderer needs to draw a Type 3 font: its glyphs are content streams,
 * not outlines, and they are described in a glyph space the font itself defines.
 *
 * **Invariant:** `/FontMatrix` is the only thing that says how big glyph space
 * is, and it is *not* 1/1000. Every other font's metrics are fixed at that
 * scale, so code that assumes it silently draws a Type 3 page at the wrong size
 * — and, since `/Widths` are in the same glyph space, spaces the glyphs by the
 * wrong amount too. Both scales come from here.
 */
export interface Type3Data {
  /** Glyph space -> text space. Defaults to 1/1000 only when the font omits it. */
  readonly fontMatrix: Matrix;
  /** The font's own `/Resources`; undefined means "inherit the showing stream's". */
  readonly resources?: PdfDict;
  /** Character code -> its glyph procedure, resolved through `/Encoding
   *  /Differences` and `/CharProcs`. A code with no procedure draws nothing. */
  readonly procs: ReadonlyMap<number, PdfStream>;
}

/** A font usable for text decoding. Built from a resolved font dict. */
/** A font's weight and slant, as the document declares them. */
export interface FontStyle { bold: boolean; italic: boolean }

/** The descriptor that describes `dict`'s outlines: a composite font keeps it
 *  on the descendant, not on the Type0 parent. */
function descriptorOf(dict: PdfDict, resolve: Resolve): PdfDict | undefined {
  const direct = resolve(dict.get('FontDescriptor'));
  if (isDict(direct)) return direct;
  const desc = resolve(dict.get('DescendantFonts'));
  if (!isArray(desc) || !desc.length) return undefined;
  const d0 = resolve(desc[0]);
  if (!isDict(d0)) return undefined;
  const fd = resolve(d0.get('FontDescriptor'));
  return isDict(fd) ? fd : undefined;
}

/** Is this font bold, and is it italic?
 *
 *  **Invariant:** ONE owner. Two consumers ask — the tagged path through
 *  `struct.ts` and the untagged path through `fragmentsFromGlyphs` — and a
 *  second copy is how the two come to disagree about whether a heading is bold
 *  on a document where only one of them runs. Same rule glyphprogram.ts records
 *  for `gidForCode`.
 *
 *  **Invariant:** every signal is POSITIVE evidence and they are OR-ed; a
 *  descriptor that merely omits `/FontWeight` says nothing and must not veto a
 *  `/BaseFont` name that says Bold. Most embedded subsets carry a name and an
 *  almost empty descriptor.
 *
 *  **Invariant:** the name test sees through a subset prefix.
 *  `/AAAAAB+Arial-BoldMT` is the everyday shape of an embedded face, so this is
 *  a substring search on the stripped name, never an equality test against a
 *  face list. */
export function fontStyleOf(dict: PdfDict, resolve: Resolve): FontStyle {
  let bold = false;
  let italic = false;

  const fd = descriptorOf(dict, resolve);
  if (fd) {
    const flags = resolve(fd.get('Flags'));
    if (typeof flags === 'number') {
      if (flags & 64) italic = true;         // bit 7, Italic
      if (flags & 262144) bold = true;       // bit 19, ForceBold
    }
    const angle = resolve(fd.get('ItalicAngle'));
    if (typeof angle === 'number' && angle !== 0) italic = true;
    const weight = resolve(fd.get('FontWeight'));
    if (typeof weight === 'number' && weight >= 600) bold = true;
  }

  const bf = resolve(dict.get('BaseFont'));
  if (isName(bf)) {
    const n = bf.name.replace(/^[A-Z]{6}\+/, '').toLowerCase();
    if (/bold|black|heavy/.test(n)) bold = true;
    if (/italic|oblique/.test(n)) italic = true;
  }
  return { bold, italic };
}

export class TextFont {
  /**
   * The narrowest character code this font admits, in bytes: 1 for a simple
   * font, 2 for Identity-H and most composite fonts.
   *
   * Advisory only for a composite font. A predefined CMap's codes are *not* a
   * fixed width — `90ms-RKSJ-H` takes one byte for ASCII and half-width
   * katakana and two for the rest — so the truth for a given code is the
   * `byteLen` on its {@link Glyph}. Slicing a show string into fixed-width
   * codes was safe only while every composite font we understood was Identity.
   */
  readonly codeWidth: number;
  /**
   * Writing mode from the `/Encoding` CMap: 0 horizontal, 1 vertical. Always 0
   * for a simple font, which has no CMap and cannot be vertical.
   */
  readonly wmode: 0 | 1;
  /** The font's /BaseFont name (subset prefix preserved), or undefined if absent. */
  readonly name?: string;
  /** True when the document declares this font bold / italic. See fontStyleOf,
   *  which is the single owner of that question. */
  readonly bold: boolean;
  readonly italic: boolean;
  /** Set for a Type 3 font: its glyph procedures and the space they draw in.
   *  Undefined for every other font. */
  readonly type3?: Type3Data;
  private readonly isType0: boolean;
  /** The `/Encoding` CMap of a composite font: code -> CID. */
  private readonly encoding?: CidCMap;
  private readonly toUnicode?: CMap;
  /** Adobe's table for the collection `/CIDSystemInfo` names, when there is
   *  one — the route to characters for a composite font without `/ToUnicode`. */
  private readonly cidToUnicode?: CidToUnicode;
  private readonly simple?: (string | undefined)[]; // code(0..255) -> Unicode
  private readonly widths?: Map<number, number>;     // code/cid -> glyph-space width
  private readonly vmetrics?: VerticalWidths;        // /W2 + /DW2, WMode 1 only
  private readonly defaultWidth: number = 0;          // width for codes absent from `widths`
  private readonly hasWidths: boolean;                // false -> use `stdWidths`
  private readonly stdWidths?: readonly number[];     // code -> AFM width, no /Widths only
  /** Glyph space -> text space, for advances. 1/1000 for every font but Type 3,
   *  whose `/Widths` are in the glyph space its `/FontMatrix` defines (§9.6.5). */
  private readonly widthScale: number = 0.001;
  /** True when `/MissingWidth` was actually present, as opposed to defaulting
   *  to 0 — the two want opposite treatment when a program could answer. */
  private hasMissingWidth = false;
  /** Built on the first code `/Widths` cannot cover, so a font with complete
   *  `/Widths` never parses its `/FontFile*`. */
  private readonly loadProgramWidths?: () => ((code: number) => number | undefined) | undefined;
  private programWidthFn?: (code: number) => number | undefined;
  private programWidthInit = false;
  private inverse?: Map<string, number>;              // Unicode -> code (simple fonts, lazy)

  constructor(dict: PdfDict, resolve: Resolve, inflate: Inflate) {
    const subtype = resolve(dict.get('Subtype'));
    this.isType0 = isName(subtype) && subtype.name === 'Type0';

    const bf = resolve(dict.get('BaseFont'));
    if (isName(bf)) this.name = bf.name;

    const style = fontStyleOf(dict, resolve);
    this.bold = style.bold;
    this.italic = style.italic;

    const tu = resolve(dict.get('ToUnicode'));
    if (isStream(tu)) this.toUnicode = parseCMap(inflate(tu));

    if (this.isType0) {
      this.encoding = resolveEncodingCMap(resolve(dict.get('Encoding')), resolve, inflate, 0);
      const widths = this.encoding?.codespaces.map((c) => c.nbytes) ?? [];
      this.codeWidth = widths.length ? Math.min(...widths) : this.toUnicode?.codeWidth ?? 2;
      this.wmode = this.encoding?.wmode ?? 0;
      const wt = parseType0Widths(dict, resolve);
      this.widths = wt.widths;
      this.defaultWidth = wt.dw;
      this.hasWidths = true; // /DW always provides a default
      // An EXPLICIT /DW outranks the program, exactly as an explicit
      // /MissingWidth does; an absent one is a spec default the producer never
      // stated, so a CID outside /W falls through to the program first.
      this.hasMissingWidth = wt.hasDw;
      this.loadProgramWidths = () => buildCidProgramWidths(dict, resolve, inflate);
      if (this.wmode === 1) this.vmetrics = parseType0VerticalWidths(dict, resolve);
      // The descendant's own /CIDSystemInfo is the authority; when it is absent
      // or unusable, the /Encoding CMap states the collection it belongs to.
      const ordering = cidSystemOrdering(dict, resolve) ?? this.encoding?.ordering;
      if (ordering) this.cidToUnicode = getCidToUnicode(ordering);
    } else {
      this.codeWidth = 1;
      this.wmode = 0;
      this.simple = buildSimpleEncoding(dict, resolve);
      const wt = parseSimpleWidths(dict, resolve);
      if (wt) {
        this.widths = wt.widths; this.defaultWidth = wt.missing;
        this.hasWidths = true; this.hasMissingWidth = wt.hasMissing;
      } else { this.hasWidths = false; this.stdWidths = std14Widths(this.name, this.simple); }
      const simple = this.simple;
      this.loadProgramWidths = () => buildProgramWidths(dict, resolve, inflate, simple);
      if (isName(subtype) && subtype.name === 'Type3') {
        this.type3 = parseType3(dict, resolve);
        this.widthScale = this.type3.fontMatrix[0];
      }
    }
  }

  /**
   * Advance of one glyph in em units (glyph-space / 1000).
   *
   * **Invariant:** a composite font's `/W` array is keyed by **CID**, a simple
   * font's `/Widths` by character code. They coincide only under Identity
   * encoding, so this takes whichever key the font's own metrics use — pass a
   * code for a simple font and a CID for a composite one.
   */
  private advance(key: number): number {
    if (this.hasWidths) {
      const w = this.widths?.get(key);
      if (w !== undefined) return w * this.widthScale;
      if (this.hasMissingWidth) return this.defaultWidth * this.widthScale;
      const pw = this.programWidth(key);
      if (pw !== undefined) return pw * this.widthScale;
      return this.defaultWidth * this.widthScale;
    }
    const pw = this.programWidth(key);
    if (pw !== undefined) return pw * this.widthScale;
    // The AFM fallback is a Standard-14 table, always at 1/1000 — a Type 3 font
    // with no /Widths is malformed and gets the same guess as any other font.
    return (this.stdWidths?.[key & 0xff] ?? ESTIMATED_WIDTH) / 1000;
  }

  /** The embedded program's advance for `code`, loading the program on first use. */
  private programWidth(code: number): number | undefined {
    if (!this.programWidthInit) {
      this.programWidthInit = true;
      this.programWidthFn = this.loadProgramWidths?.();
    }
    return this.programWidthFn?.(code);
  }

  /**
   * Split a show string into character codes, resolving each to its CID.
   *
   * The single place that knows how wide a code is. A simple font's codes are
   * one byte; a composite font's come from its `/Encoding` CMap and may be 1 to
   * 4 bytes *within one string*, so the loop asks the CMap rather than stepping
   * by a fixed width. A composite font with no usable `/Encoding` falls back to
   * fixed-width codes, which is what this did for every font before predefined
   * CMaps existed.
   */
  private *codes(bytes: Uint8Array): Generator<{ code: number; cid: number; len: number }> {
    if (this.encoding) {
      for (let i = 0; i < bytes.length; ) {
        const u = this.encoding.next(bytes, i);
        yield { code: u.code, cid: u.matched ? this.encoding.cid(u.code, u.len) : 0, len: u.len };
        i += u.len;
      }
      return;
    }
    const w = this.codeWidth;
    for (let i = 0; i + w <= bytes.length || (w === 1 && i < bytes.length); i += w) {
      let code = 0;
      for (let k = 0; k < w; k++) code = (code << 8) | (bytes[i + k] ?? 0);
      yield { code, cid: code, len: w };
    }
  }

  /**
   * The vertical metrics of one CID, filling in the defaults `/W2` omits.
   *
   * **Invariant:** an absent position vector is *not* (0,0). It defaults to
   * (w0/2, `/DW2[0]`) — half the glyph's own horizontal width across, and the
   * default vertical origin up (32000-1 9.7.4.3). `/W2` is absent from most
   * real vertical fonts, since the default is right for nearly every glyph, so
   * the defaulted path is the one that runs and a zero vector would misplace
   * the entire page rather than a few glyphs.
   */
  private verticalOf(cid: number, w0: number): VerticalMetrics {
    const vm = this.vmetrics!;
    const w1 = (vm.w1.get(cid) ?? vm.dw2[1]) / 1000;
    const v = vm.v.get(cid);
    if (v) return { w1, vx: v[0] / 1000, vy: v[1] / 1000 };
    return { w1, vx: w0 / 2, vy: vm.dw2[0] / 1000 };
  }

  /**
   * The Unicode text one code contributes, or '' when nothing maps it.
   *
   * `/ToUnicode` is authoritative and tried first. For a composite font it is
   * also frequently absent — and frequently *partial* — so a code it cannot
   * answer for falls through to Adobe's table for the collection the font's
   * `/CIDSystemInfo` names, which is keyed by CID rather than by code.
   *
   * **Invariant:** a CID neither source can answer for contributes nothing,
   * never U+FFFD. Adobe's tables spell "no Unicode for this CID" as U+FFFD and
   * the generator drops those, so extracted text carries a gap rather than a
   * run of replacement characters that reads as a decoding bug.
   */
  private textOf(code: number, cid: number): string {
    const u = this.toUnicode?.lookup(code);
    if (u !== undefined) return u;
    if (!this.isType0 && this.simple) return this.simple[code & 0xff] ?? '';
    return this.cidToUnicode?.lookup(cid) ?? '';
  }

  /**
   * Word spacing applies to the single-byte code 32 only — including in a
   * composite font that defines 32 as a one-byte code (32000-1 9.3.3), which
   * the Shift-JIS and EUC CMaps all do. Keying this off the font's nominal
   * width instead of the code's own width silently applied `Tw` to a two-byte
   * code whose high byte happened to be 0x20.
   */
  private isWordSpace(code: number, len: number): boolean {
    return len === 1 && code === 0x20;
  }

  /** Decode bytes into text plus the run's advance metrics. `width` and
   *  `vwidth` are in em units (glyph-space sum / 1000), excluding Tc/Tw;
   *  `vwidth` is 0 unless the font is vertical. */
  decodeRun(bytes: Uint8Array): RunMetrics {
    let text = '';
    let width = 0;
    let vwidth = 0;
    let ncodes = 0;
    let nWordSpaces = 0;
    for (const { code, cid, len } of this.codes(bytes)) {
      text += this.textOf(code, cid);
      const w = this.advance(this.isType0 ? cid : code);
      width += w;
      if (this.vmetrics) vwidth += this.verticalOf(cid, w).w1;
      ncodes++;
      if (this.isWordSpace(code, len)) nWordSpaces++;
    }
    return { text, width, vwidth, ncodes, nWordSpaces };
  }

  /** Decode a show-string's bytes into Unicode text. */
  decode(bytes: Uint8Array): string {
    return this.decodeRun(bytes).text;
  }

  /** True for simple (1-byte) fonts whose encoding can be inverted for
   *  re-encoding replacement text. Type0/Identity-H fonts return false. */
  get canEncode(): boolean { return !this.isType0 && this.simple !== undefined; }

  /** Map one Unicode character to its 1-byte code in this font's encoding, or
   *  `undefined` if the font cannot represent it. Simple fonts only. */
  encodeChar(ch: string): number | undefined {
    if (!this.canEncode || !this.simple) return undefined;
    if (!this.inverse) {
      this.inverse = new Map();
      // Lower codes win on duplicate glyphs, matching typical encodings.
      for (let code = 255; code >= 0; code--) {
        const u = this.simple[code];
        if (u !== undefined) this.inverse.set(u, code);
      }
    }
    return this.inverse.get(ch);
  }

  /** Encode `text` to show-string bytes in this font's encoding. Throws
   *  {@link UnsupportedFeatureError} for a Type0 font or any character the
   *  encoding cannot represent. */
  encode(text: string): Uint8Array {
    if (!this.canEncode)
      throw new UnsupportedFeatureError('cannot re-encode text for a Type0/composite font');
    const out: number[] = [];
    for (const ch of text) {
      const code = this.encodeChar(ch);
      if (code === undefined)
        throw new UnsupportedFeatureError(`character ${JSON.stringify(ch)} is not representable in the font encoding`);
      out.push(code);
    }
    return Uint8Array.from(out);
  }

  /** Decode bytes into one record per character code (positions, em-widths). */
  decodeGlyphs(bytes: Uint8Array): Glyph[] {
    const out: Glyph[] = [];
    let i = 0;
    for (const { code, cid, len } of this.codes(bytes)) {
      const width = this.advance(this.isType0 ? cid : code);
      out.push({
        text: this.textOf(code, cid),
        width,
        byteStart: i,
        byteLen: len,
        code,
        isWordSpace: this.isWordSpace(code, len),
        cid: this.isType0 ? cid : 0,
        ...(this.vmetrics ? { vertical: this.verticalOf(cid, width) } : {}),
      });
      i += len;
    }
    return out;
  }
}

/**
 * Read a Type 3 font's glyph space and glyph procedures (32000-1 9.6.5).
 *
 * The `/Encoding /Differences` names are the only route from a character code to
 * a procedure — a Type 3 font has no built-in encoding to fall back on, so a
 * code the differences array never names simply has no glyph, which is why this
 * indexes the *names* rather than the Unicode `buildSimpleEncoding` derives from
 * them. `/square` and `/uni25A1` name the same character and generally do not
 * name the same procedure.
 *
 * A missing or malformed `/FontMatrix` falls back to 1/1000. That is a guess for
 * a font that is required to carry one, but it is the scale every other font
 * uses and it keeps a damaged font drawing at a plausible size instead of
 * collapsing to a point.
 */
function parseType3(dict: PdfDict, resolve: Resolve): Type3Data {
  const arr = resolve(dict.get('FontMatrix'));
  const fm = isArray(arr) ? arr.map((x) => asNum(resolve(x))) : [];
  const fontMatrix: Matrix = fm.length === 6 && fm.every((n) => n !== undefined)
    ? (fm as number[] as Matrix)
    : [0.001, 0, 0, 0.001, 0, 0];

  const procs = new Map<number, PdfStream>();
  const charProcs = resolve(dict.get('CharProcs'));
  if (isDict(charProcs)) {
    resolveSimpleEncoding(dict, resolve).names.forEach((name, code) => {
      if (name === undefined) return;
      const s = resolve(charProcs.get(name));
      if (isStream(s)) procs.set(code, s);
    });
  }

  const res = resolve(dict.get('Resources'));
  return { fontMatrix, resources: isDict(res) ? res : undefined, procs };
}

/**
 * The `/CIDSystemInfo /Ordering` of a composite font's descendant CIDFont —
 * `Japan1`, `GB1`, `CNS1`, `Korea1`, `KR` — or undefined when the font names
 * no usable collection.
 *
 * **Invariant:** the ordering only means anything under registry `Adobe`. The
 * name is a bare string chosen by the producer, and a private collection is
 * free to call its ordering `Japan1` while numbering its CIDs however it likes;
 * mapping those through Adobe's table would emit confident Japanese for a font
 * that contains none. A missing `/Registry` is read as Adobe's, since that is
 * the only registry with published collections and producers omit it.
 */
function cidSystemOrdering(dict: PdfDict, resolve: Resolve): string | undefined {
  const desc = resolve(dict.get('DescendantFonts'));
  const cidFont = isArray(desc) ? resolve(desc[0]) : undefined;
  if (!isDict(cidFont)) return undefined;
  const info = resolve(cidFont.get('CIDSystemInfo'));
  if (!isDict(info)) return undefined;

  const registry = resolve(info.get('Registry'));
  if (isString(registry) && decodeLatin1(registry.bytes) !== 'Adobe') return undefined;

  const ordering = resolve(info.get('Ordering'));
  return isString(ordering) ? decodeLatin1(ordering.bytes) : undefined;
}

function decodeLatin1(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

/** `/W2` and `/DW2`, in glyph space. See {@link TextFont.verticalOf}. */
interface VerticalWidths {
  /** CID -> w1y. */
  w1: Map<number, number>;
  /** CID -> [vx, vy]. */
  v: Map<number, [number, number]>;
  /** `/DW2`: [default vertical origin y, default w1y]. */
  dw2: [number, number];
}

/**
 * Parse the descendant CIDFont's `/W2` (+ `/DW2`) for a vertical composite font.
 *
 * `/W2` has two entry shapes, and unlike `/W` they carry *three* numbers per
 * glyph rather than one:
 *
 *   `c [w1y vx vy  w1y vx vy  ...]`   consecutive CIDs from `c`
 *   `cFirst cLast w1y vx vy`          every CID in the range, sharing one vector
 *
 * The range form gives every CID the *same* position vector, which is the one
 * place the two shapes genuinely differ in meaning rather than in spelling: the
 * array form's triples advance with the CID.
 */
function parseType0VerticalWidths(dict: PdfDict, resolve: Resolve): VerticalWidths {
  const w1 = new Map<number, number>();
  const v = new Map<number, [number, number]>();
  // 32000-1 9.7.4.3: default position vector y 880, default displacement -1000.
  let dw2: [number, number] = [880, -1000];

  const desc = resolve(dict.get('DescendantFonts'));
  const cidFont = isArray(desc) ? resolve(desc[0]) : undefined;
  if (!isDict(cidFont)) return { w1, v, dw2 };

  const d2 = resolve(cidFont.get('DW2'));
  if (isArray(d2) && d2.length >= 2) {
    const a = asNum(resolve(d2[0])), b = asNum(resolve(d2[1]));
    if (a !== undefined && b !== undefined) dw2 = [a, b];
  }

  const w2 = resolve(cidFont.get('W2'));
  if (isArray(w2)) {
    for (let i = 0; i < w2.length; ) {
      const c = asNum(resolve(w2[i]));
      const next = resolve(w2[i + 1]);
      if (c !== undefined && isArray(next)) {
        for (let j = 0; j + 2 < next.length; j += 3) {
          const cid = c + j / 3;
          const a = asNum(resolve(next[j])), x = asNum(resolve(next[j + 1])), y = asNum(resolve(next[j + 2]));
          if (a !== undefined) w1.set(cid, a);
          if (x !== undefined && y !== undefined) v.set(cid, [x, y]);
        }
        i += 2;
      } else {
        const cLast = asNum(next);
        const a = asNum(resolve(w2[i + 2]));
        const x = asNum(resolve(w2[i + 3])), y = asNum(resolve(w2[i + 4]));
        if (c !== undefined && cLast !== undefined && a !== undefined) {
          for (let cid = c; cid <= cLast; cid++) {
            w1.set(cid, a);
            if (x !== undefined && y !== undefined) v.set(cid, [x, y]);
          }
          i += 5;
        } else { i += 1; }   // malformed entry: skip one token
      }
    }
  }
  return { w1, v, dw2 };
}

/**
 * The `/Encoding` of a composite font, as a code -> CID CMap.
 *
 * A name resolves to a bundled predefined CMap; a stream is parsed as CMap
 * text. Either may extend another through `usecmap`, and an embedded CMap may
 * also name its parent with a `/UseCMap` entry in the stream dict — the two
 * mechanisms are separate and a file may use either, so both are followed.
 *
 * **Invariant:** an `/Encoding` this function cannot make sense of degrades to
 * Identity rather than throwing or returning nothing. A name outside the
 * bundled set is a CMap we do not have, not a broken document, and Identity is
 * what viewers fall back to; returning undefined instead would drop the whole
 * font's text. `-V` picks Identity-V so a vertical font stays vertical.
 */
function resolveEncodingCMap(
  enc: PdfObject, resolve: Resolve, inflate: Inflate, depth: number,
): CidCMap | undefined {
  // `/UseCMap` chains are followed by reference, so a file can point one at
  // itself. Bound the walk rather than trusting the document not to.
  if (depth > 8) return undefined;

  if (isName(enc)) {
    return getPredefinedCMap(enc.name)
      ?? getPredefinedCMap(enc.name.endsWith('-V') ? 'Identity-V' : 'Identity-H');
  }

  if (isStream(enc)) {
    let parts;
    try { parts = parseCidCMap(inflate(enc)); } catch { return undefined; }
    // The stream dict's /UseCMap outranks the name inside the stream: it is the
    // PDF object the document actually points at.
    const useObj = resolve(enc.dict.get('UseCMap'));
    const parent = (isName(useObj) || isStream(useObj))
      ? resolveEncodingCMap(useObj, resolve, inflate, depth + 1)
      : parts.usecmap ? getPredefinedCMap(parts.usecmap) : undefined;
    return new CidCMap(parts, parent);
  }

  return undefined;
}

/** A simple font's `/Encoding`, taken apart so callers can choose how much to
 *  guess. See {@link resolveSimpleEncoding}. */
export interface SimpleEncoding {
  /** code -> Unicode from the base encoding alone, before `/Differences`. */
  base: (string | undefined)[];
  /** code -> Unicode after `/Differences`. `undefined` at a code whose
   *  `/Differences` name is outside the Adobe Glyph List — the name is in
   *  {@link names}, and no Unicode answer is available for it. */
  unicode: (string | undefined)[];
  /** code -> the glyph name `/Differences` assigns, for those codes only. */
  names: (string | undefined)[];
  /** code -> glyph name from the base encoding the font *named*, when we have a
   *  table for it. Undefined when the font named none, named one we have no
   *  table for, or carries no `/Encoding` at all — in each of those cases the
   *  font program's own encoding is the next authority, and substituting a
   *  default here would silently outrank it. */
  baseNames?: (string | undefined)[];
  /** True when the font dict carries no `/Encoding`: the font program's built-in
   *  encoding governs, and {@link base} is only this parser's default guess. */
  implicit: boolean;
}

/**
 * Resolve a simple font's `/Encoding` without collapsing the unknowns. A
 * `/Differences` name outside the AGL leaves `unicode` undefined at that code
 * rather than silently falling back to the base encoding's character: callers
 * that can follow a glyph-name chain (a `post` table, a CFF charset) need to know
 * the difference between "this code means U+00E9" and "this code means whatever
 * `uni00E9` names".
 */
export function resolveSimpleEncoding(dict: PdfDict, resolve: Resolve): SimpleEncoding {
  const enc = resolve(dict.get('Encoding'));
  const implicit = !isName(enc) && !isDict(enc);
  let base = winAnsi.slice();
  let baseNames: (string | undefined)[] | undefined;
  let differences: PdfObject[] | undefined;

  if (isName(enc)) {
    base = baseEncodingByName(enc.name).slice();
    baseNames = baseEncodingNamesByName(enc.name);
  } else if (isDict(enc)) {
    const b = resolve(enc.get('BaseEncoding'));
    base = baseEncodingByName(isName(b) ? b.name : undefined).slice();
    baseNames = baseEncodingNamesByName(isName(b) ? b.name : undefined);
    const diffs = resolve(enc.get('Differences'));
    if (isArray(diffs)) differences = diffs;
  }

  const unicode = base.slice();
  const names: (string | undefined)[] = new Array(256);
  if (differences) {
    let code = 0;
    for (const item of differences) {
      const it = resolve(item);
      if (typeof it === 'number') { code = it; }
      else if (isName(it)) {
        names[code & 0xff] = it.name;
        unicode[code & 0xff] = glyphToUnicode(it.name);
        code++;
      }
    }
  }
  return { base, unicode, names, baseNames, implicit };
}

/**
 * Resolve a character code to a glyph name, for a font whose glyph programs are
 * name-keyed — a Type 1 `/FontFile` or a name-keyed CFF charset.
 *
 * The order is 32000-1 9.6.6.2: `/Differences`, then the base encoding the font
 * named, then the font program's own encoding, then StandardEncoding. Note that
 * the program's encoding sits *below* an explicitly named base encoding but
 * *above* the default — a font dict with no `/Encoding` is exactly the case
 * where the program governs, which {@link SimpleEncoding.implicit} records.
 */
export function glyphNameResolver(
  enc: SimpleEncoding,
  builtin: Map<number, string> | undefined,
): (code: number) => string | undefined {
  return (code) => {
    const c = code & 0xff;
    return enc.names[c] ?? enc.baseNames?.[c] ?? builtin?.get(c) ?? standardEncodingNames[c];
  };
}

/** Build a code(0..255) -> Unicode table for a simple font. An unresolvable
 *  `/Differences` name falls back to the base encoding — a guess, but the best
 *  one available when the only goal is decoding text. */
function buildSimpleEncoding(dict: PdfDict, resolve: Resolve): (string | undefined)[] {
  const e = resolveSimpleEncoding(dict, resolve);
  return e.unicode.map((u, i) => u ?? e.base[i]);
}

/** Last-resort advance for a code no metrics source can answer for: half an em,
 *  which at least keeps glyphs from piling up on one another. */
const ESTIMATED_WIDTH = 500;

/**
 * Per-code advance table for a simple font that carries no `/Widths`. Only a
 * Standard-14 face may omit it (PDF 32000-1 9.6.2.2), so the Adobe AFM metrics
 * are the right answer — the same ones the authoring side stamps with, which is
 * why measuring text this library wrote used to disagree with the text itself.
 * `normalizeFont` substitutes Helvetica for a name outside the 14, matching what
 * a viewer does with a font it cannot find.
 *
 * Symbol and ZapfDingbats keep their built-in encodings and their tables are
 * indexed by the raw code. The Latin faces' tables are indexed by WinAnsi code,
 * which the font's own encoding — `/MacRomanEncoding`, a `/Differences` name,
 * anything — reaches through the Unicode `simple` already resolved for decoding.
 */
function std14Widths(baseFont: string | undefined, simple: (string | undefined)[]): number[] {
  const std = normalizeFont(baseFont ?? 'Helvetica');
  if (std === 'Symbol' || std === 'ZapfDingbats')
    return Array.from({ length: 256 }, (_, code) => glyphWidth(std, code));
  const out = new Array<number>(256).fill(ESTIMATED_WIDTH);
  for (let code = 0; code < 256; code++) {
    const ch = simple[code];
    if (ch === undefined) continue;
    const wa = encodeWinAnsi(ch);
    if (wa.length === 1) out[code] = glyphWidth(std, wa[0]!);
  }
  return out;
}

function asNum(o: PdfObject): number | undefined {
  return typeof o === 'number' ? o : undefined;
}

/** Parse /FirstChar + /Widths (+ /FontDescriptor /MissingWidth) for a simple font.
 *  Returns undefined when the font carries no /Widths (estimate path). */
function parseSimpleWidths(
  dict: PdfDict, resolve: Resolve,
): { widths: Map<number, number>; missing: number; hasMissing: boolean } | undefined {
  const arr = resolve(dict.get('Widths'));
  if (!isArray(arr)) return undefined;
  const firstChar = asNum(resolve(dict.get('FirstChar'))) ?? 0;
  const fd = resolve(dict.get('FontDescriptor'));
  const mw = isDict(fd) ? asNum(resolve(fd.get('MissingWidth'))) : undefined;
  const widths = new Map<number, number>();
  arr.forEach((w, i) => {
    const n = asNum(resolve(w));
    if (n !== undefined) widths.set(firstChar + i, n);
  });
  return { widths, missing: mw ?? 0, hasMissing: mw !== undefined };
}

/**
 * Per-code advances from the embedded font program, in glyph space, or
 * `undefined` when the descriptor embeds none we can read.
 *
 * Consulted only where `/Widths` and an explicit `/MissingWidth` are both
 * silent. The name route is the one built for Type 1 outlines —
 * {@link glyphNameResolver} over the font's `/Encoding`, with the program's own
 * encoding beneath it.
 */
function buildProgramWidths(
  dict: PdfDict, resolve: Resolve, inflate: Inflate, simple: (string | undefined)[] | undefined,
): ((code: number) => number | undefined) | undefined {
  const prog = loadEmbeddedProgram(dict.get('FontDescriptor'), resolve, inflate);
  if (!prog.sfnt && !prog.cff && !prog.type1) return undefined;
  const nameForCode = glyphNameResolver(
    resolveSimpleEncoding(dict, resolve), prog.type1?.builtinEncodingNames(),
  );
  const cache = new Map<number, number | undefined>();
  return (code) => {
    if (cache.has(code)) return cache.get(code);
    const gid = gidForProgram(prog, code, simple?.[code & 0xff] ?? '', nameForCode);
    const w = gid === undefined ? undefined : programAdvance(prog, gid);
    cache.set(code, w);
    return w;
  };
}

/** Parse the descendant CIDFont's /W array (+ /DW default) for a Type0 font.
 *  Assumes Identity (CID = code).
 *
 *  Reports whether `/DW` was PRESENT, not just its value. The two want opposite
 *  treatment: a stated `/DW` is a statement the producer made and outranks the
 *  embedded program, while an absent one leaves 1000 as a spec default the
 *  producer never said — so the program answers instead. Collapsing them into
 *  `?? 1000` loses exactly the distinction `parseSimpleWidths` records for
 *  `/MissingWidth`. */
function parseType0Widths(
  dict: PdfDict, resolve: Resolve,
): { widths: Map<number, number>; dw: number; hasDw: boolean } {
  const widths = new Map<number, number>();
  const desc = resolve(dict.get('DescendantFonts'));
  const cidFont = isArray(desc) ? resolve(desc[0]) : undefined;
  if (!isDict(cidFont)) return { widths, dw: 1000, hasDw: false };
  const dwRaw = asNum(resolve(cidFont.get('DW')));
  const dw = dwRaw ?? 1000;
  const hasDw = dwRaw !== undefined;
  const w = resolve(cidFont.get('W'));
  if (isArray(w)) {
    for (let i = 0; i < w.length; ) {
      const c = asNum(resolve(w[i]));
      const next = resolve(w[i + 1]);
      if (c !== undefined && isArray(next)) {
        next.forEach((wi, j) => {
          const n = asNum(resolve(wi));
          if (n !== undefined) widths.set(c + j, n);
        });
        i += 2;
      } else {
        const cLast = asNum(next);
        const ww = asNum(resolve(w[i + 2]));
        if (c !== undefined && cLast !== undefined && ww !== undefined) {
          for (let cid = c; cid <= cLast; cid++) widths.set(cid, ww);
          i += 3;
        } else { i += 1; } // malformed entry: skip one token
      }
    }
  }
  return { widths, dw, hasDw };
}

/**
 * A composite font's advance lookup over its embedded program, keyed by CID.
 *
 * Distinct from `buildProgramWidths` in two ways that both matter: the
 * descriptor hangs off the DESCENDANT CIDFont rather than the Type0 dict, and
 * the key is a CID, which selects a glyph through `/CIDToGIDMap` (or a CID-keyed
 * CFF's charset) rather than through an encoding and a glyph name.
 */
function buildCidProgramWidths(
  dict: PdfDict, resolve: Resolve, inflate: Inflate,
): ((cid: number) => number | undefined) | undefined {
  const desc = resolve(dict.get('DescendantFonts'));
  const cidFont = isArray(desc) ? resolve(desc[0]) : undefined;
  if (!isDict(cidFont)) return undefined;

  const prog = loadEmbeddedProgram(cidFont.get('FontDescriptor'), resolve, inflate);
  if (!prog.sfnt && !prog.cff && !prog.type1) return undefined;

  // /CIDToGIDMap is a stream of 2-byte gids, or the name /Identity. An
  // unreadable stream degrades to Identity rather than to no widths at all.
  let cidToGid: Uint8Array | undefined;
  const c2g = resolve(cidFont.get('CIDToGIDMap'));
  if (isStream(c2g)) {
    try { cidToGid = inflate(c2g as { dict: PdfDict; raw: Uint8Array }); } catch { cidToGid = undefined; }
  }

  const cache = new Map<number, number | undefined>();
  return (cid) => {
    if (cache.has(cid)) return cache.get(cid);
    const w = programAdvance(prog, gidForCid(prog, cid, cidToGid));
    cache.set(cid, w);
    return w;
  };
}
