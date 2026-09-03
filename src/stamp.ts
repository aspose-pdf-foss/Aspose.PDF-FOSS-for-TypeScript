import type { Document } from './document.js';
import type { Page } from './page.js';
import { PdfObject, PdfDict, isDict, isName, isRef, name, ref } from './types.js';
import { StdFont } from './metrics.js';
import {
  layoutText, layoutRuns, LaidLine, LaidSegment, FontDriver, winAnsiDriver,
  type LayoutRun, type RunSlice, isAtomicRun,
} from './layout.js';
import { EmbeddedFont } from './embeddedfont.js';
import { emitLine } from './otemit.js';
import { shapeText, type ShapeOpts } from './shape.js';
import { enc, serializeString } from './serialize.js';
import type { StructElement } from './struct.js';
import { drawBuiltImage, type BuiltImage } from './imageembed.js';
import { allocContentMcid, reserveContentMcid } from './structwrite.js';
import {
  num, freshKey, ensureOwnResources, ensureOwnSubdict, registerExtGState, appendContent,
  prependContent, wrapMarkedContent, wrapArtifact,
} from './pagecontent.js';
import {
  resolveDecor, decorRects, vmetricsFor, isTextRunList,
  type DecorationOptions, type ResolvedDecor, type LineBox, type TextRun,
} from './textdecor.js';
import { placeRunLinks, type RunLinkBox } from './runlink.js';
import { UnsupportedFeatureError } from './errors.js';
import { coverageOf, drawsNothing, type Undrawable } from './textcoverage.js';

/** The 12 Latin Standard-14 fonts authoring supports (WinAnsi-encodable).
 *  Symbol/ZapfDingbats are excluded: their width tables exist but their
 *  text->byte encoders (built-in encodings, not WinAnsi) do not. */
export const AUTHORING_FONTS: readonly StdFont[] = [
  'Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique',
  'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic',
  'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique',
];

/** A font for the text-authoring API: one of the 12 Latin Standard-14 faces (by
 *  name) or an embedded font handle from {@link Document.AddFont}. */
export type AuthoringFont = StdFont | EmbeddedFont;

/** Resolve an authoring `font` option to its measuring/encoding driver. */
function driverFor(font: AuthoringFont): FontDriver {
  return font instanceof EmbeddedFont ? font.driver() : winAnsiDriver(font);
}

/** Options for stamping text onto a page. */
export interface StampOptions extends DecorationOptions {
  /** Standard-14 base font (one of the 12 Latin faces) or an embedded font
   *  handle from {@link Document.AddFont}. Default 'Helvetica'. */
  font?: AuthoringFont;
  /** Font size in points. Default 12. */
  fontSize?: number;
  /** Fill color as RGB components in 0..1. Default [0, 0, 0]. */
  color?: [number, number, number];
  /** Rotation in degrees, counter-clockwise about (x, y). Default 0. */
  rotate?: number;
  /** Fill opacity in 0..1. Default 1 (no /ExtGState emitted). */
  opacity?: number;
  /** Which point of the baseline (x, y) anchors. Default 'left'. */
  align?: 'left' | 'center' | 'right';
  /** When set, wrap this text in a marked-content sequence and attach it to the
   *  given structure element (emits `/<type> << /MCID n >> BDC … EMC`). */
  tag?: StructElement;
  /** @internal Mark this stamp as an /Artifact: content that belongs to no
   *  structure element (`/Artifact BMC … EMC`). Mutually exclusive with `tag`. */
  artifact?: boolean;
  /** Enable/disable complex-text shaping for this call, overriding the font's
   *  default. Ignored for Standard-14 fonts. */
  shape?: boolean;
  /** Base paragraph direction for shaping. Default 'auto' (first-strong). */
  dir?: 'auto' | 'ltr' | 'rtl';
  /** OpenType script tag override (default: auto per script itemization). */
  script?: string;
  /** OpenType language-system tag (default: 'dflt'). */
  language?: string;
  /** Draw this stamp beneath existing page content instead of on top of it.
   *  Default false. On a page with nothing to sink beneath this is a plain draw. */
  behind?: boolean;
  /** Called when the resolved face cannot draw some or all of this text.
   *  Opt-in: a caller who passes nothing gets the previous silence. Fires once
   *  per drawn block — never from a measure pass, which the flow engine runs
   *  speculatively many times per element. */
  onUndrawable?: (u: Undrawable) => void;
}

/** True when `font` is an embedded handle AND shaping is effectively on. */
function effectiveShape(font: AuthoringFont, callShape: boolean | undefined): font is EmbeddedFont {
  return font instanceof EmbeddedFont && (callShape ?? font.shape);
}

/** Fire `onUndrawable` for a DIRECT page-level draw, where the call IS the
 *  paint. Deliberately not called from measureTextBlock, wrapLines or
 *  flowTextBlock: the flow engine measures speculatively many times per
 *  element, and a flow block has already reported at BUILD time through its
 *  builder — firing here too would report every flowed paragraph twice.
 *  @internal */
export function reportUndrawable(
  content: string | TextRun[],
  // Structural rather than StampOptions: TextBlockOptions Omits `align` and
  // redeclares it with 'justify', so it is not assignable to StampOptions —
  // and this needs only the three fields named here from either.
  options: {
    font?: AuthoringFont;
    shape?: boolean;
    onUndrawable?: (u: Undrawable) => void;
  },
): void {
  if (options.onUndrawable === undefined) return;
  const font = options.font ?? 'Helvetica';
  const u = coverageOf(content, font, effectiveShape(font, options.shape));
  if (u !== undefined) options.onUndrawable(u);
}

function shapeOptsFrom(o: { dir?: 'auto' | 'ltr' | 'rtl'; script?: string; language?: string }): ShapeOpts {
  return { dir: o.dir, script: o.script, language: o.language };
}

/** Rendered width of `text` in points for `font` (default Helvetica) at `fontSize`.
 *  Reflects shaping when `font` is an embedded handle with shaping effectively on. */
export function measureText(
  text: string, fontSize: number, font: AuthoringFont = 'Helvetica',
  shape?: boolean, dir?: StampOptions['dir'], script?: string, language?: string,
): number {
  if (effectiveShape(font, shape)) return font.measureShaped(text, fontSize, { dir, script, language });
  return driverFor(font).measure(text, fontSize);
}

interface NormalizedOptions {
  font: AuthoringFont;
  fontSize: number;
  color: [number, number, number];
  rotate: number;
  opacity: number;
  align: 'left' | 'center' | 'right';
  behind: boolean;
  decor: ResolvedDecor | undefined;
}

export function validateFont(font: AuthoringFont): void {
  if (font instanceof EmbeddedFont) return;
  if (typeof font !== 'string' || !AUTHORING_FONTS.includes(font))
    throw new TypeError(
      `font must be one of the 12 Latin Standard-14 fonts or a Document.AddFont handle, got ${JSON.stringify(font)}`);
}

function normalizeOptions(o: StampOptions): NormalizedOptions {
  const font = o.font ?? 'Helvetica';
  validateFont(font);
  const fontSize = o.fontSize ?? 12;
  if (!Number.isFinite(fontSize) || fontSize <= 0)
    throw new TypeError('fontSize must be a positive finite number');
  const rotate = o.rotate ?? 0;
  if (!Number.isFinite(rotate)) throw new TypeError('rotate must be a finite number');
  const opacity = o.opacity ?? 1;
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1)
    throw new TypeError('opacity must be in 0..1');
  const color = o.color ?? [0, 0, 0];
  if (!Array.isArray(color) || color.length !== 3 ||
      !color.every((c) => Number.isFinite(c) && c >= 0 && c <= 1))
    throw new TypeError('color must be [r, g, b] with each component in 0..1');
  const align = o.align ?? 'left';
  if (align !== 'left' && align !== 'center' && align !== 'right')
    throw new TypeError("align must be 'left', 'center', or 'right'");
  const behind = o.behind ?? false;
  if (typeof behind !== 'boolean') throw new TypeError('behind must be a boolean');
  const decor = resolveDecor(o, color, fontSize, vmetricsFor(font));
  return { font, fontSize, color, rotate, opacity, align, behind, decor };
}

function isFontWinAnsi(doc: Document, d: PdfDict, font: StdFont): boolean {
  const bf = doc.resolve(d.get('BaseFont'));
  const en = doc.resolve(d.get('Encoding'));
  return isName(bf) && bf.name === font && isName(en) && en.name === 'WinAnsiEncoding';
}

/** Register (or reuse) `font` on the page; returns its resource key. Standard-14
 *  faces become a WinAnsi Type1 dict; an embedded handle reserves a Type0 object
 *  (filled by the document's finalize pass at Save) shared across all its draws. */
function registerFont(doc: Document, page: Page, font: AuthoringFont): string {
  const res = ensureOwnResources(doc, page);
  const fonts = ensureOwnSubdict(doc, res, 'Font');

  if (font instanceof EmbeddedFont) {
    if (font.objNum === undefined) font.objNum = doc.allocObject(new Map<string, PdfObject>()).num;
    for (const [k, v] of fonts) if (isRef(v) && v.num === font.objNum) return k;
    const key = freshKey(fonts, 'F');
    fonts.set(key, ref(font.objNum));
    return key;
  }

  for (const [k, v] of fonts) {
    const d = doc.resolve(v);
    if (isDict(d) && isFontWinAnsi(doc, d, font)) return k;
  }
  const fontDict: PdfDict = new Map<string, PdfObject>([
    ['Type', name('Font')],
    ['Subtype', name('Type1')],
    ['BaseFont', name(font)],
    ['Encoding', name('WinAnsiEncoding')],
  ]);
  const key = freshKey(fonts, 'F');
  fonts.set(key, doc.allocObject(fontDict));
  return key;
}

function buildStampBody(
  bytes: Uint8Array, x: number, y: number, o: NormalizedOptions,
  fontKey: string, width: number, gsKey: string | undefined,
): Uint8Array {
  const f = o.align === 'center' ? 0.5 : o.align === 'right' ? 1 : 0;
  const theta = (o.rotate * Math.PI) / 180;
  const cos = Math.cos(theta), sin = Math.sin(theta);
  const tx = x - f * width * cos;
  const ty = y - f * width * sin;
  const [r, g, b] = o.color;
  const mat = `${num(cos)} ${num(sin)} ${num(-sin)} ${num(cos)} ${num(tx)} ${num(ty)}`;
  const dec = o.decor ? decorRects([{ x: 0, baseline: 0, width }], o.decor) : undefined;
  let s = 'q\n';
  if (gsKey) s += `/${gsKey} gs\n`;
  if (dec?.beneath) s += `q\n${mat} cm\n${dec.beneath}Q\n`;
  s += 'BT\n';
  s += `/${fontKey} ${num(o.fontSize)} Tf\n`;
  s += `${num(r)} ${num(g)} ${num(b)} rg\n`;
  s += `${mat} Tm\n`;
  s += `${serializeString(bytes)} Tj\n`;
  s += 'ET\n';
  if (dec?.above) s += `q\n${mat} cm\n${dec.above}Q\n`;
  s += 'Q';
  return enc(s);
}

/** Like {@link buildStampBody} but injects pre-built shaped show-ops (`inner`,
 *  the `TJ`/`Ts`/`Tj` body from {@link emitLine}) instead of a single `Tj`. */
function buildShapedStampBody(
  inner: string, x: number, y: number, o: NormalizedOptions,
  fontKey: string, width: number, gsKey: string | undefined,
): Uint8Array {
  const f = o.align === 'center' ? 0.5 : o.align === 'right' ? 1 : 0;
  const theta = (o.rotate * Math.PI) / 180;
  const cos = Math.cos(theta), sin = Math.sin(theta);
  const tx = x - f * width * cos;
  const ty = y - f * width * sin;
  const [r, g, b] = o.color;
  const mat = `${num(cos)} ${num(sin)} ${num(-sin)} ${num(cos)} ${num(tx)} ${num(ty)}`;
  const dec = o.decor ? decorRects([{ x: 0, baseline: 0, width }], o.decor) : undefined;
  let s = 'q\n';
  if (gsKey) s += `/${gsKey} gs\n`;
  if (dec?.beneath) s += `q\n${mat} cm\n${dec.beneath}Q\n`;
  s += 'BT\n';
  s += `/${fontKey} ${num(o.fontSize)} Tf\n`;
  s += `${num(r)} ${num(g)} ${num(b)} rg\n`;
  s += `${mat} Tm\n`;
  s += inner; // ends with a newline
  s += 'ET\n';
  if (dec?.above) s += `q\n${mat} cm\n${dec.above}Q\n`;
  s += 'Q';
  return enc(s);
}

/** @internal How a stamp body is spliced into /Contents. Defaults to
 *  appendContent (draw on top); decorate.ts passes prependContent for an
 *  underlay watermark. */
export type ContentSplice = (doc: Document, page: Page, body: Uint8Array) => void;

/** Reject the one nonsensical marking combination up front: content is either
 *  some element's or no one's. Called before anything is drawn. */
function validateMarking(options: StampOptions | TextBlockOptions): void {
  if (options.artifact && options.tag)
    throw new TypeError('artifact and tag are mutually exclusive');
}

/** Apply the caller's marked-content choice to a built stamp body. */
function markContent(
  doc: Document, page: Page, options: StampOptions | TextBlockOptions, body: Uint8Array,
  mcid?: number,
): Uint8Array {
  if (options.artifact) return wrapArtifact(body);
  return options.tag
    ? wrapMarkedContent(options.tag.Type, mcid ?? allocContentMcid(doc, options.tag, page), body)
    : body;
}

/** Stamp `text` at (x, y) on `page`. Existing content is preserved. */
export function stampText(
  doc: Document, page: Page, text: string, x: number, y: number, options: StampOptions = {},
  splice?: ContentSplice,
): void {
  validateMarking(options);
  const o = normalizeOptions(options);
  reportUndrawable(text, options);
  // An explicit caller-supplied splice wins: decorate.ts's underlay watermark is
  // a structural choice by that caller, not something `behind` should override.
  const put = splice ?? (o.behind ? prependContent : appendContent);
  if (effectiveShape(o.font, options.shape)) {
    const font = o.font;
    const so = shapeOptsFrom(options);
    const runs = font.shapeRuns(text, so);
    if (runs.every((r) => r.glyphs.length === 0)) return; // empty / all-unshapable: no-op
    const fontKey = registerFont(doc, page, font);
    const gsKey = o.opacity < 1 ? registerExtGState(doc, page, o.opacity) : undefined;
    const scale = o.fontSize / (font.sfnt.unitsPerEm || 1000);
    let width = 0;
    for (const r of runs) for (const g of r.glyphs) width += g.xAdvance * scale;
    const inner = emitLine(runs, o.fontSize, font.sfnt.unitsPerEm || 1000, (gid) => font.sfnt.advanceWidth(gid));
    const body = buildShapedStampBody(inner, x, y, o, fontKey, width, gsKey);
    put(doc, page, markContent(doc, page, options, body));
    return;
  }
  const driver = driverFor(o.font);
  const bytes = driver.encode(text);
  if (bytes.length === 0) return; // empty or all-unencodable: no-op
  const fontKey = registerFont(doc, page, o.font);
  const gsKey = o.opacity < 1 ? registerExtGState(doc, page, o.opacity) : undefined;
  const width = driver.measure(text, o.fontSize);
  const body = buildStampBody(bytes, x, y, o, fontKey, width, gsKey);
  put(doc, page, markContent(doc, page, options, body));
}

/** Options for flowing wrapped text into a rectangle. Inherits the typographic
 *  options of {@link StampOptions} (sans single-line `align` and `rotate`) and
 *  adds block layout: paragraph `align` (incl. `justify`), `valign`, `leading`. */
/** A box placed among a run block's runs — an image on a line of text.
 *
 *  At stamp.ts's level the image is already BUILT, because this module may
 *  allocate objects and layout.ts may not. flow.ts's FlowAtomic takes bytes
 *  and builds one of these. @internal */
export interface BlockAtomic {
  /** The run index this sits BEFORE; `runs.length` places it at the end. */
  beforeRun: number;
  built: BuiltImage;
  width: number;
  height: number;
  align: 'baseline' | 'top' | 'bottom';
}

export interface TextBlockOptions extends Omit<StampOptions, 'align' | 'rotate'> {
  /** Boxes to place among the runs — an image on a line of text. A PARALLEL
   *  channel rather than a field on TextRun, so textdecor.ts's model — read by
   *  mdruns.ts, tableauthor.ts, flowtable.ts and docmodel.ts — does not change
   *  and every existing caller is byte-identical by construction. Ignored for
   *  a string block. */
  atomics?: BlockAtomic[];
  /** Horizontal alignment of each line. Default 'left'. ('justify' spreads each
   *  line's slack across its inter-word gaps via the `Tw` operator; the final
   *  line and single-word lines fall back to 'left'.) */
  align?: 'left' | 'center' | 'right' | 'justify';
  /** Rotation in degrees, counter-clockwise about the rect's origin (its
   *  bottom-left corner) — the block analogue of {@link StampOptions.rotate}
   *  turning about its anchor point. Default 0.
   *
   *  The BOX turns with the text: wrapping, alignment and the overflow
   *  remainder are computed in the rect as given and the laid result is then
   *  rotated as a unit, so `measureTextBlock` and `wrapLines` are unaffected and
   *  a rotated block never reflows to a different line count. */
  rotate?: number;
  /** Vertical alignment of the laid block within the box. Default 'top'. */
  valign?: 'top' | 'center' | 'bottom';
  /** Baseline-to-baseline distance in points. Default 1.2 * fontSize. */
  leading?: number;
}

interface NormalizedBlockOptions {
  font: AuthoringFont;
  fontSize: number;
  color: [number, number, number];
  opacity: number;
  align: 'left' | 'center' | 'right' | 'justify';
  valign: 'top' | 'center' | 'bottom';
  leading: number;
  rotate: number;
  behind: boolean;
  decor: ResolvedDecor | undefined;
}

/** Wrap an already-laid block body in a rotation about (`px`, `py`), or return
 *  it untouched at 0 degrees.
 *
 *  The body draws in page coordinates, and rotation about a point is affine, so
 *  one `cm` around the whole thing is the entire implementation — the line
 *  layout, alignment and decoration code below never learns about rotation. The
 *  0-degree short-circuit is what keeps output byte-identical for every caller
 *  that does not ask for it. */
function rotateBody(body: Uint8Array, deg: number, px: number, py: number): Uint8Array {
  if (deg === 0) return body;
  const theta = (deg * Math.PI) / 180;
  const cos = Math.cos(theta), sin = Math.sin(theta);
  // The rotation fixing (px, py): translate to the origin, turn, translate back.
  const tx = px - px * cos + py * sin;
  const ty = py - px * sin - py * cos;
  const mat = `${num(cos)} ${num(sin)} ${num(-sin)} ${num(cos)} ${num(tx)} ${num(ty)}`;
  // Splice bytes; never round-trip `body` through a string. It carries WinAnsi
  // text in its Tj operands, and both halves of a string round trip corrupt
  // bytes above 127: TextDecoder('latin1') is really windows-1252 (0x80-0x9F
  // decode to other code points), and `enc` is UTF-8 (re-encoding anything
  // above 127 emits two bytes). Either one inflates the body and breaks the
  // stream that contains it.
  const head = enc(`q\n${mat} cm\n`);
  const tail = enc('\nQ');
  const out = new Uint8Array(head.length + body.length + tail.length);
  out.set(head, 0);
  out.set(body, head.length);
  out.set(tail, head.length + body.length);
  return out;
}

function normalizeBlockOptions(o: TextBlockOptions): NormalizedBlockOptions {
  const font = o.font ?? 'Helvetica';
  validateFont(font);
  const fontSize = o.fontSize ?? 12;
  if (!Number.isFinite(fontSize) || fontSize <= 0)
    throw new TypeError('fontSize must be a positive finite number');
  const opacity = o.opacity ?? 1;
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1)
    throw new TypeError('opacity must be in 0..1');
  const color = o.color ?? [0, 0, 0];
  if (!Array.isArray(color) || color.length !== 3 ||
      !color.every((c) => Number.isFinite(c) && c >= 0 && c <= 1))
    throw new TypeError('color must be [r, g, b] with each component in 0..1');
  let align = o.align ?? 'left';
  if (align !== 'left' && align !== 'center' && align !== 'right' && align !== 'justify')
    throw new TypeError("align must be 'left', 'center', 'right', or 'justify'");
  // Justification rides on the `Tw` operator, which only affects single-byte
  // code 32 — inert for 2-byte Identity-H text — so embedded fonts fall back to
  // left alignment.
  if (align === 'justify' && font instanceof EmbeddedFont) align = 'left';
  const valign = o.valign ?? 'top';
  if (valign !== 'top' && valign !== 'center' && valign !== 'bottom')
    throw new TypeError("valign must be 'top', 'center', or 'bottom'");
  const leading = o.leading ?? 1.2 * fontSize;
  if (!Number.isFinite(leading) || leading <= 0)
    throw new TypeError('leading must be a positive finite number');
  const behind = o.behind ?? false;
  if (typeof behind !== 'boolean') throw new TypeError('behind must be a boolean');
  const rotate = o.rotate ?? 0;
  if (typeof rotate !== 'number' || !Number.isFinite(rotate))
    throw new TypeError('rotate must be a finite number');
  const decor = resolveDecor(o, color, fontSize, vmetricsFor(font));
  return { font, fontSize, color, opacity, align, valign, leading, rotate, behind, decor };
}

/** One run with every inherited property filled in and its driver built. */
interface ResolvedRun {
  layout: LayoutRun;
  font: AuthoringFont;
  color: [number, number, number];
  decor: ResolvedDecor | undefined;
  /** The /URI this run links to, or undefined. */
  link: string | undefined;
}

/** Resolve a run list against the block's options.
 *
 *  Validation runs over EVERY run before any byte is emitted, so a bad run late
 *  in the list leaves the document untouched — the rule every authoring entry
 *  point in this codebase follows.
 *
 *  A run inherits any property it does not state, so the common case (`{ text }`
 *  with one bold run among them) restates nothing. */
function resolveRuns(runs: TextRun[], o: NormalizedBlockOptions): ResolvedRun[] {
  const out: ResolvedRun[] = [];
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    if (typeof r?.text !== 'string') throw new TypeError(`run ${i}: text must be a string`);
    const font = r.font ?? o.font;
    validateFont(font);
    const fontSize = r.fontSize ?? o.fontSize;
    if (!Number.isFinite(fontSize) || fontSize <= 0)
      throw new TypeError(`run ${i}: fontSize must be a positive finite number`);
    const color = r.color ?? o.color;
    if (!Array.isArray(color) || color.length !== 3 ||
        !color.every((c) => Number.isFinite(c) && c >= 0 && c <= 1))
      throw new TypeError(`run ${i}: color must be [r, g, b] with each component in 0..1`);
    // Rejected before anything is emitted, like every other run property: a bad
    // link late in the list must leave the document byte-identical.
    if (r.link !== undefined && (typeof r.link !== 'string' || r.link === ''))
      throw new TypeError(`run ${i}: link must be a non-empty string`);
    // A run that states no decoration of its own inherits the block's, which is
    // what keeps a block-level underline spanning the whole line.
    const own = r.underline !== undefined || r.strikethrough !== undefined
      || r.background !== undefined;
    const decor = own ? resolveDecor(r, color, fontSize, vmetricsFor(font)) : o.decor;
    out.push({
      layout: { text: r.text, driver: driverFor(font), fontSize },
      font, color, decor, link: r.link,
    });
  }
  return out;
}

/** Justification rides on `Tw`, which moves only single-byte code 32 and is inert
 *  for 2-byte Identity-H text. One embedded run is enough to make the whole block
 *  fall back to left, exactly as one embedded font does for the string path. */
function justifiable(runs: ResolvedRun[]): boolean {
  return runs.every((r) => !(r.font instanceof EmbeddedFont));
}

/** Runs and atomics woven into ONE list, in document order, plus a map from
 *  woven index to the atomic that produced it.
 *
 *  Shared by flowTextBlock and measureTextBlock deliberately: they already
 *  share resolveRuns and layoutRuns, and a second weave is how a paragraph
 *  comes to measure one way and paint another — the failure the
 *  one-wrapping-engine rule exists to prevent.
 *
 *  With no atomics it returns `resolved` UNCHANGED, which is what keeps every
 *  existing caller's bytes identical. */
function weaveAtomics(
  resolved: ResolvedRun[], atomics: BlockAtomic[] | undefined,
): { woven: ResolvedRun[]; atomicOf: Map<number, BlockAtomic> } {
  const atomicOf = new Map<number, BlockAtomic>();
  if (atomics === undefined || atomics.length === 0)
    return { woven: resolved, atomicOf };
  const woven: ResolvedRun[] = [];
  const at = (i: number): void => {
    for (const a of atomics) {
      if (a.beforeRun !== i) continue;
      atomicOf.set(woven.length, a);
      woven.push({
        layout: { atomic: { width: a.width, height: a.height, align: a.align } },
        // An atomic has no font, colour, decoration or link of its own. These
        // are inert and exist only so the array stays homogeneous; the painter
        // returns before reading any of them.
        font: resolved[0]?.font ?? resolved[resolved.length - 1]?.font,
        color: [0, 0, 0],
        decor: undefined,
        link: undefined,
      } as ResolvedRun);
    }
  };
  for (let i = 0; i < resolved.length; i++) { at(i); woven.push(resolved[i]); }
  at(resolved.length);
  return { woven, atomicOf };
}

/** Is every run either an atomic or fully unencodable? An atomic draws without
 *  a glyph, so a block that is nothing but boxes must still reach the painter. */
function nothingDrawable(runs: ResolvedRun[]): boolean {
  return runs.every((r) => !isAtomicRun(r.layout) && drawsNothing(r.layout.text, r.layout.driver));
}

/** Runs plus shaping is not implemented: BiDi reorders across a whole paragraph,
 *  and how a bidi-run boundary should interact with a style boundary is an open
 *  question. Throwing beats silently dropping either the styles or the shaping. */
function rejectShapedRuns(o: TextBlockOptions, font: AuthoringFont): void {
  if (effectiveShape(font, o.shape))
    throw new UnsupportedFeatureError('complex-text shaping is not supported with a run list');
}

/** Rebuild the remainder's runs AND its atomics, with each atomic's
 *  `beforeRun` re-based onto the new list.
 *  Adjacent slices from the same run merge, so a remainder re-flows into the same
 *  number of runs it started with rather than one per line. */
function sliceContent(
  slices: RunSlice[], source: TextRun[], atomicOf: Map<number, BlockAtomic>,
  woven: ResolvedRun[],
): { runs: TextRun[]; atomics: BlockAtomic[] } {
  // `source` is indexed by the ORIGINAL run list and `slices` by the woven
  // one, so a woven index has to be taken back to a source index.
  const sourceIndex: number[] = [];
  let n = 0;
  for (let i = 0; i < woven.length; i++) sourceIndex.push(atomicOf.has(i) ? -1 : n++);

  const runs: TextRun[] = [];
  const atomics: BlockAtomic[] = [];
  let lastRun = -1;
  for (const s of slices) {
    const a = atomicOf.get(s.run);
    if (a !== undefined) {
      // Re-based onto the REBUILT list: it sits before whatever run comes
      // next there. Carrying the original index forward lands the image in
      // the wrong place, or off the end where it vanishes.
      atomics.push({ ...a, beforeRun: runs.length });
      lastRun = -1;                       // an atomic breaks the merge run
      continue;
    }
    if (s.run === lastRun) { runs[runs.length - 1].text += s.text; continue; }
    runs.push({ ...source[sourceIndex[s.run]], text: s.text });
    lastRun = s.run;
  }
  return { runs, atomics };
}

function validateRect(rect: [number, number, number, number]): void {
  if (!Array.isArray(rect) || rect.length !== 4 || !rect.every((n) => Number.isFinite(n)))
    throw new TypeError('rect must be [x, y, w, h] of finite numbers');
  if (rect[2] <= 0 || rect[3] <= 0)
    throw new TypeError('rect width and height must be positive');
}

/** Horizontal offset that aligns a line of `lineWidth` within a `boxWidth`. */
function alignOffset(align: NormalizedBlockOptions['align'], boxWidth: number, lineWidth: number): number {
  if (align === 'center') return (boxWidth - lineWidth) / 2;
  if (align === 'right') return boxWidth - lineWidth;
  return 0; // left, and justify (slack goes into Tw), both start at the left edge
}

/** Word spacing (the `Tw` operator value) that justifies `line` to `boxWidth` by
 *  spreading its slack across the inter-word gaps. Returns 0 — i.e. no
 *  justification, left fallback — for non-'justify' alignment, hard-break/final
 *  lines (the last-line rule), single-word lines (no gap), or non-positive
 *  slack. `Tw` is in unscaled text-space units, added to each space directly. */
function justifySpacing(
  align: NormalizedBlockOptions['align'], boxWidth: number, line: LaidLine,
): number {
  if (align !== 'justify' || line.hardBreak) return 0;
  let gaps = 0;
  for (const ch of line.text) if (ch === ' ') gaps++;
  if (gaps === 0) return 0;
  const slack = boxWidth - line.width;
  return slack > 0 ? slack / gaps : 0;
}

/** The decoration boxes for a laid block, in absolute user space (the block path
 *  has no rotation, so no `cm` is needed). A justified line is drawn to the full
 *  box width — `Tw` spreads its slack — so its decoration must span `w`, not the
 *  narrower measured `line.width`. */
function blockLineBoxes(
  lines: LaidLine[], x: number, w: number, baselines: number[], o: NormalizedBlockOptions,
): LineBox[] {
  return lines.map((line, i) => {
    const tw = justifySpacing(o.align, w, line);
    return {
      x: x + alignOffset(o.align, w, line.width),
      baseline: baselines[i],
      width: tw > 0 ? w : line.width,
    };
  });
}

/** A {@link FontDriver} whose `measure` shapes, so wrapping computes correct
 *  shaped line widths. `encode` is unused on the shaped path (emission goes
 *  through {@link emitLine}); `probe` counts shaped glyphs (>0 = drawable). */
function shapedDriver(font: EmbeddedFont, so: ShapeOpts): FontDriver {
  return {
    measure: (t, fs) => font.measureShaped(t, fs, so),
    encode: () => new Uint8Array(0),
    probe: (t) => (t.length ? shapeText(t, font.sfnt, so).reduce((n, r) => n + r.glyphs.length, 0) : 0),
  };
}

/** Per-line shaped block body: mirrors {@link buildBlockBody} but shapes each
 *  wrapped line (recording gids + /ToUnicode) and injects {@link emitLine} ops.
 *  `Tw` justification is not emitted (embedded fonts fall back to left). */
function buildShapedBlockBody(
  font: EmbeddedFont, lines: LaidLine[], x: number, y: number, w: number, h: number,
  o: NormalizedBlockOptions, fontKey: string, gsKey: string | undefined, so: ShapeOpts,
): Uint8Array {
  const baselines = lineBaselines(lines, blockTopOf(y, h, lines, o));
  const [r, g, b] = o.color;
  const dec = o.decor
    ? decorRects(blockLineBoxes(lines, x, w, baselines, o), o.decor)
    : undefined;
  let s = 'q\n';
  if (gsKey) s += `/${gsKey} gs\n`;
  if (dec?.beneath) s += dec.beneath;
  s += 'BT\n';
  s += `/${fontKey} ${num(o.fontSize)} Tf\n`;
  s += `${num(r)} ${num(g)} ${num(b)} rg\n`;
  let prevOffset = 0;
  for (let i = 0; i < lines.length; i++) {
    const offset = alignOffset(o.align, w, lines[i].width);
    if (i === 0) s += `${num(x + offset)} ${num(baselines[0])} Td\n`;
    else s += `${num(offset - prevOffset)} ${num(baselines[i] - baselines[i - 1])} Td\n`;
    prevOffset = offset;
    const runs = font.shapeRuns(lines[i].text, so);
    s += emitLine(runs, o.fontSize, font.sfnt.unitsPerEm || 1000, (gid) => font.sfnt.advanceWidth(gid));
  }
  s += 'ET\n';
  if (dec?.above) s += dec.above;
  s += 'Q';
  return enc(s);
}

/** One laid segment's box, in the frame `buildRunBlockBody` draws in. */
interface SegmentBox {
  run: number; x: number; baseline: number; width: number;
  /** Points of trailing space included in `width`.
   *
   *  The separator between two words belongs to the run that PAINTS it, which
   *  is the preceding one — so a linked run followed by more text paints a
   *  space after its last glyph. A link rect trims this; decoration does not,
   *  because it is shipped typography fenced by rich-runs-identity and because
   *  a clickable 3-6pt of blank space is felt where an underline's is not. */
  trailing: number;
}

/** Per-segment boxes for a laid run block.
 *
 *  ONE walk feeds both run decoration and link rects: both ask exactly "where
 *  did this segment land", and a second copy is how a justified line's
 *  underline and its link rect come to disagree.
 *
 *  A segment's DRAWN width is not `seg.width`. Under `justify` the emitter sets
 *  `Tw`, which widens every space in the segment, so reading the same
 *  `justifySpacing` the emitter reads is what keeps the boxes on the glyphs —
 *  and the drift accumulates, so the last run on a line is worst hit. Note the
 *  final line of a block is a `hardBreak` and never justified, so only a run on
 *  a MIDDLE line can show the difference. */
function segmentBoxes(
  lines: LaidLine[], x: number, w: number, baselines: number[],
  o: NormalizedBlockOptions, runs: ResolvedRun[],
): SegmentBox[] {
  const out: SegmentBox[] = [];
  lines.forEach((line, i) => {
    const tw = justifySpacing(o.align, w, line);
    const baseline = baselines[i];
    let dx = x + alignOffset(o.align, w, line.width);
    for (const seg of line.segments) {
      let spaces = 0;
      if (tw > 0) for (const ch of seg.text) if (ch === ' ') spaces++;
      const width = seg.width + tw * spaces;
      // U+0020 only — NOT \s, which in JavaScript also matches U+00A0, the
      // character a code block substitutes for every space so its indentation
      // survives `layoutRuns` collapsing runs of spaces. That is a glyph the
      // author asked for, not a separator. It also matches what justifySpacing
      // counts, which is `ch === ' '` exactly.
      const tail = seg.text.slice(seg.text.replace(/ +$/, '').length);
      const r = runs[seg.run];
      // `width` already includes the Tw those spaces gained, so the nominal
      // advance alone under-trims a justified line. An atomic has no text, so
      // no trailing space to trim.
      const trailing = tail === '' || isAtomicRun(r.layout) ? 0
        : r.layout.driver.measure(tail, r.layout.fontSize) + tw * tail.length;
      out.push({ run: seg.run, x: dx, baseline, width, trailing });
      dx += width;
    }
  });
  return out;
}

/** The decoration boxes for a laid block when runs carry their own decoration.
 *  Each distinct ResolvedDecor gets its own box list, so a run-level underline
 *  spans exactly that run and a block-level one still spans the line.
 *
 *  The single-decor fast path is NOT routed through here: an unstyled block must
 *  emit the same bytes it always did, and `blockLineBoxes` is what produced them. */
function runDecorOps(
  boxes: SegmentBox[], runs: ResolvedRun[],
): { beneath: string; above: string } {
  const buckets = new Map<ResolvedDecor, LineBox[]>();
  for (const b of boxes) {
    const d = runs[b.run].decor;
    if (d === undefined) continue;
    const list = buckets.get(d) ?? [];
    list.push({ x: b.x, baseline: b.baseline, width: b.width });
    buckets.set(d, list);
  }
  let beneath = '';
  let above = '';
  for (const [d, list] of buckets) {
    const ops = decorRects(list, d);
    beneath += ops.beneath;
    above += ops.above;
  }
  return { beneath, above };
}

/** The first line's baseline for a block of `lineCount` lines in [y, y+h].
 *  Shared by the emitter and the link-box builder so the ink and the annotation
 *  cannot disagree about where line 0 sits. */
function linesHeight(lines: LaidLine[]): number {
  let n = 0;
  for (const l of lines) n += l.height;
  return n;
}

/** The top edge of the laid block within [y, y+h], after vertical alignment.
 *  The block's height is the sum of its line bands, not `lines * leading`. */
function blockTopOf(
  y: number, h: number, lines: LaidLine[], o: NormalizedBlockOptions,
): number {
  const blockHeight = linesHeight(lines);
  const valignOffset = o.valign === 'center' ? (h - blockHeight) / 2
    : o.valign === 'bottom' ? h - blockHeight : 0;
  return y + h - valignOffset;
}

/** Each line's baseline, top-down. A line occupies a band of its own height and
 *  sits `maxFontSize` below that band's top.
 *
 *  This reduces exactly to `blockTop - fontSize - i * leading` when every line
 *  is at the block size, which is the byte-identity argument — and `num()`
 *  rounds to 1e-6, so accumulating the bands prints the same as a constant
 *  step. Using `maxFontSize` rather than the block's `fontSize` is also what
 *  keeps an oversized run on line 0 inside the box. */
function lineBaselines(lines: LaidLine[], blockTop: number): number[] {
  const out: number[] = [];
  let bandTop = blockTop;
  for (const l of lines) {
    out.push(bandTop - l.maxFontSize);
    bandTop -= l.height;
  }
  return out;
}

/** The clickable boxes for a laid run block: one per (linked run, line).
 *
 *  The vertical extent is the run's own text-tight box — `vmetricsFor` scaled by
 *  the RUN's fontSize, not the block's — which is exactly the rect the
 *  `background` decoration paints. One geometry rule, so a link's clickable area
 *  and its underline cannot drift apart. */
function runLinkBoxes(
  boxes: SegmentBox[], runs: ResolvedRun[], linkMcids: (number | undefined)[],
): RunLinkBox[] {
  const out: RunLinkBox[] = [];
  boxes.forEach((b, i) => {
    const r = runs[b.run];
    // An atomic carries no link of its own — a linked image is zch2.12's, and
    // an inert atomic run would otherwise ask for a font size it has not got.
    if (r.link === undefined || isAtomicRun(r.layout)) return;
    const vm = vmetricsFor(r.font);
    const size = r.layout.fontSize;
    out.push({
      uri: r.link,
      rect: [
        b.x,
        b.baseline + vm.descent * size,
        b.x + b.width - b.trailing,
        b.baseline + vm.ascent * size,
      ],
      mcid: linkMcids[i],
    });
  });
  return out;
}

/** The laid segment at flat index `i` across all lines, with the line it is
 *  on — `boxes[i]`'s segment.
 *
 *  Both lists come from the same nested walk, which is what makes the index
 *  shared; a second walk is how a box and its segment come to disagree about
 *  where a picture goes. */
function segAt(
  lines: LaidLine[], i: number,
): { seg: LaidSegment; line: LaidLine } | undefined {
  let n = i;
  for (const line of lines) {
    if (n < line.segments.length) return { seg: line.segments[n], line };
    n -= line.segments.length;
  }
  return undefined;
}

/** Per-run block body: one text object, a `Tf` when the font or size changes and
 *  an `rg` when the colour changes, then one `Tj` per segment. No per-segment
 *  `Td` — `Tj` advances the pen by the string's own width. */
function buildRunBlockBody(
  lines: LaidLine[], runs: ResolvedRun[], fontKeys: string[],
  x: number, y: number, w: number, h: number,
  o: NormalizedBlockOptions, gsKey: string | undefined,
  boxes: SegmentBox[], linkMcids: (number | undefined)[],
): Uint8Array {
  // Recomputed rather than threaded from the caller: `boxes` already carries
  // the same baselines, but reading them back out of the segment list would
  // break on a line with no segments.
  const baselines = lineBaselines(lines, blockTopOf(y, h, lines, o));
  const dec = runDecorOps(boxes, runs);
  let s = 'q\n';
  if (gsKey) s += `/${gsKey} gs\n`;
  if (dec.beneath) s += dec.beneath;
  s += 'BT\n';

  let curFont = '';
  let curSize = -1;
  let curColor = '';
  let prevOffset = 0;
  let prevTw = 0; // Tw defaults to 0 in a fresh text object.
  // Walks `boxes`/`linkMcids` in step with the segments: all three are built by
  // the same nested iteration, so index i of one names index i of the others.
  let segIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const tw = justifySpacing(o.align, w, line);
    if (tw !== prevTw) { s += `${num(tw)} Tw\n`; prevTw = tw; }
    const offset = alignOffset(o.align, w, line.width);
    if (i === 0) s += `${num(x + offset)} ${num(baselines[0])} Td\n`;
    else s += `${num(offset - prevOffset)} ${num(baselines[i] - baselines[i - 1])} Td\n`;
    prevOffset = offset;
    for (const seg of line.segments) {
      const r = runs[seg.run];
      const key = fontKeys[seg.run];
      // A nested marked-content sequence inside BT/ET is legal (32000-1 14.6),
      // and is what puts the link's words INSIDE its /Link element rather than
      // leaving the element text-less. `undefined` for every segment of an
      // untagged block, so those bytes are exactly what they always were.
      const mcid = linkMcids[segIdx++];
      // Bound to a local so the type guard narrows it for the rest of the
      // loop body — a guard on `seg.atomic` would not, since it says nothing
      // about `r.layout`.
      const layout = r.layout;
      if (isAtomicRun(layout)) {
        // No Tj, so the pen would not advance and the following text would
        // overprint the image — buildRunBlockBody emits no per-segment Td, by
        // design ("Tj advances the pen by the string's own width"). A TJ with
        // a single negative number kerns by `n/1000 * fontSize`, so the
        // advance is exact at whatever size is in force. A block that OPENS
        // with an atomic has set no Tf yet, so it falls back to the block
        // size. The MCID wrap is skipped too: an image is not a link's text.
        const size = curSize > 0 ? curSize : o.fontSize;
        s += `[ ${num(-(seg.width * 1000) / size)} ] TJ\n`;
        continue;
      }
      if (mcid !== undefined) s += `/Span <</MCID ${mcid}>> BDC\n`;
      if (key !== curFont || layout.fontSize !== curSize) {
        s += `/${key} ${num(layout.fontSize)} Tf\n`;
        curFont = key;
        curSize = layout.fontSize;
      }
      const col = `${num(r.color[0])} ${num(r.color[1])} ${num(r.color[2])} rg`;
      if (col !== curColor) { s += `${col}\n`; curColor = col; }
      s += `${serializeString(seg.bytes)} Tj\n`;
      if (mcid !== undefined) s += 'EMC\n';
    }
  }
  s += 'ET\n';
  if (dec.above) s += dec.above;
  s += 'Q';
  return enc(s);
}

function buildBlockBody(
  lines: LaidLine[], x: number, y: number, w: number, h: number,
  o: NormalizedBlockOptions, fontKey: string, gsKey: string | undefined,
): Uint8Array {
  const baselines = lineBaselines(lines, blockTopOf(y, h, lines, o));

  const [r, g, b] = o.color;
  const dec = o.decor
    ? decorRects(blockLineBoxes(lines, x, w, baselines, o), o.decor)
    : undefined;
  let s = 'q\n';
  if (gsKey) s += `/${gsKey} gs\n`;
  if (dec?.beneath) s += dec.beneath;
  s += 'BT\n';
  s += `/${fontKey} ${num(o.fontSize)} Tf\n`;
  s += `${num(r)} ${num(g)} ${num(b)} rg\n`;

  let prevOffset = 0;
  let prevTw = 0; // Tw defaults to 0 in a fresh text object.
  for (let i = 0; i < lines.length; i++) {
    const tw = justifySpacing(o.align, w, lines[i]);
    if (tw !== prevTw) {
      s += `${num(tw)} Tw\n`;
      prevTw = tw;
    }
    const offset = alignOffset(o.align, w, lines[i].width);
    if (i === 0) {
      s += `${num(x + offset)} ${num(baselines[0])} Td\n`;
    } else {
      s += `${num(offset - prevOffset)} ${num(baselines[i] - baselines[i - 1])} Td\n`;
    }
    prevOffset = offset;
    s += `${serializeString(lines[i].bytes)} Tj\n`;
  }
  s += 'ET\n';
  if (dec?.above) s += dec.above;
  s += 'Q';
  return enc(s);
}

/** Flow `text` into the rectangle [x, y, w, h] on `page`, wrapping to the box
 *  width and clipping to its height. Returns the unconsumed `remainder` (`null`
 *  when everything fit or nothing was drawable) and `usedHeight`, the vertical
 *  space the drawn lines consumed (`linesDrawn * leading`, 0 when nothing was
 *  drawn). Existing content is preserved. */
export function flowTextBlock(
  doc: Document, page: Page, text: string,
  rect: [number, number, number, number], options?: TextBlockOptions,
): { remainder: string | null; usedHeight: number };
export function flowTextBlock(
  doc: Document, page: Page, runs: TextRun[],
  rect: [number, number, number, number], options?: TextBlockOptions,
): { remainder: TextRun[] | null; remainderAtomics?: BlockAtomic[]; usedHeight: number };
export function flowTextBlock(
  doc: Document, page: Page, content: string | TextRun[],
  rect: [number, number, number, number], options: TextBlockOptions = {},
): { remainder: string | TextRun[] | null; remainderAtomics?: BlockAtomic[]; usedHeight: number } {
  validateMarking(options);
  validateRect(rect);
  const o = normalizeBlockOptions(options);
  const put = o.behind ? prependContent : appendContent;
  const [x, y, w, h] = rect;

  if (isTextRunList(content)) {
    rejectShapedRuns(options, o.font);
    const { woven: resolved, atomicOf } = weaveAtomics(resolveRuns(content, o), options.atomics);
    if (nothingDrawable(resolved)) return { remainder: null, usedHeight: 0 };
    // Justification falls back to left when any run is embedded; `ro` is a local
    // copy so the block's own options are not mutated.
    const ro: NormalizedBlockOptions =
      o.align === 'justify' && !justifiable(resolved) ? { ...o, align: 'left' } : o;
    const { lines, remainder } = layoutRuns(
      resolved.map((r) => r.layout), w, h, ro.leading, ro.fontSize);
    if (lines.length > 0) {
      const fontKeys = resolved.map((r) => registerFont(doc, page, r.font));
      const gsKey = ro.opacity < 1 ? registerExtGState(doc, page, ro.opacity) : undefined;
      const boxes = segmentBoxes(
        lines, x, w, lineBaselines(lines, blockTopOf(y, h, lines, ro)), ro, resolved);
      // An artifacted block declares itself decorative, so its glyphs get no
      // MCID of any kind; an untagged one allocates nothing and emits no BDC,
      // leaving its bytes exactly what they were before links existed.
      const tag = options.artifact ? undefined : options.tag;
      // The block's own MCID first, so a dump reads in drawing order: the /P is
      // 0 and the links that follow are 1, 2, … MCIDs are identifiers rather
      // than an ordering, but a reversed one reads like a bug.
      const blockMcid = tag !== undefined ? allocContentMcid(doc, tag, page) : undefined;
      const linkMcids = boxes.map((b) =>
        tag !== undefined && resolved[b.run].link !== undefined
          ? reserveContentMcid(doc, tag, page)
          : undefined);
      const bodyBytes = buildRunBlockBody(
        lines, resolved, fontKeys, x, y, w, h, ro, gsKey, boxes, linkMcids);
      put(doc, page,
        markContent(doc, page, options, rotateBody(bodyBytes, ro.rotate, x, y), blockMcid));
      // After the ink, so the annotation lands on content that exists.
      // measureTextBlock, the dry run, never reaches here — which is what keeps
      // measurement free of side effects.
      const linkBoxes = runLinkBoxes(boxes, resolved, linkMcids);
      if (linkBoxes.length > 0) placeRunLinks(doc, page, linkBoxes, tag);
      // Each atomic's picture, through the EXISTING drawBuiltImage — which
      // already handles /SMask, resource registration and tagging, so
      // imageembed.ts needs no refactor. It cannot go inside BT…ET, so it is
      // its own q…cm…Do…Q; appended AFTER the text body, which is
      // unobservable because an inline atomic's box never overlaps the glyphs
      // it sits between.
      boxes.forEach((b, i) => {
        const at = segAt(lines, i);
        if (at === undefined || at.seg.atomic === undefined) return;
        const a = atomicOf.get(at.seg.run);
        if (a === undefined || at.seg.atomic.width <= 0 || at.seg.atomic.height <= 0) return;
        // `align: baseline` puts the box BOTTOM on the baseline, so the rect's
        // y IS the baseline. top/bottom align to the BAND: the baseline sits
        // `maxFontSize` (the line's ascent) below the band top, which is what
        // recovers the band from a box that only knows its baseline.
        //
        // The atomic on the SEGMENT rather than on `a`: layoutRuns may have
        // clamped an over-wide box, and the drawn rect must be the clamped one.
        const drawn = at.seg.atomic;
        const bandTop = b.baseline + at.line.maxFontSize;
        const y = drawn.align === 'baseline' ? b.baseline
          : drawn.align === 'top' ? bandTop - drawn.height
            : bandTop - at.line.height;
        drawBuiltImage(doc, page, a.built, [b.x, y, drawn.width, drawn.height],
          { artifact: options.artifact });
      });
    }
    const rest = sliceContent(remainder, content, atomicOf, resolved);
    return {
      remainder: remainder.length === 0 ? null : rest.runs,
      remainderAtomics: rest.atomics.length === 0 ? undefined : rest.atomics,
      usedHeight: linesHeight(lines),
    };
  }

  const text = content;
  if (effectiveShape(o.font, options.shape)) {
    const font = o.font;
    const so = shapeOptsFrom(options);
    const driver = shapedDriver(font, so);
    if (drawsNothing(text, driver)) return { remainder: null, usedHeight: 0 };
    const { lines, remainder } = layoutText(text, driver, o.fontSize, w, h, o.leading);
    if (lines.length > 0) {
      const fontKey = registerFont(doc, page, font);
      const gsKey = o.opacity < 1 ? registerExtGState(doc, page, o.opacity) : undefined;
      const body = buildShapedBlockBody(font, lines, x, y, w, h, o, fontKey, gsKey, so);
      put(doc, page, markContent(doc, page, options, rotateBody(body, o.rotate, x, y)));
    }
    return { remainder: remainder === '' ? null : remainder, usedHeight: linesHeight(lines) };
  }
  const driver = driverFor(o.font);
  if (drawsNothing(text, driver)) return { remainder: null, usedHeight: 0 };
  const { lines, remainder } = layoutText(text, driver, o.fontSize, w, h, o.leading);
  if (lines.length > 0) {
    const fontKey = registerFont(doc, page, o.font);
    const gsKey = o.opacity < 1 ? registerExtGState(doc, page, o.opacity) : undefined;
    const body = buildBlockBody(lines, x, y, w, h, o, fontKey, gsKey);
    put(doc, page, markContent(doc, page, options, rotateBody(body, o.rotate, x, y)));
  }
  return { remainder: remainder === '' ? null : remainder, usedHeight: linesHeight(lines) };
}

/** Non-destructive twin of {@link flowTextBlock}: run the identical layout for
 *  `text` in a `width` x `availHeight` box and report `usedHeight`
 *  (`linesDrawn * leading`, 0 when nothing fits) and the unconsumed `remainder`
 *  (`null` when everything fit or nothing was drawable), WITHOUT drawing. Because
 *  it calls the same `layoutText` with the same options, its result equals what a
 *  subsequent `flowTextBlock` draw of the same text/box would produce. */
export function measureTextBlock(
  text: string, width: number, availHeight: number, options?: TextBlockOptions,
): { usedHeight: number; remainder: string | null };
export function measureTextBlock(
  runs: TextRun[], width: number, availHeight: number, options?: TextBlockOptions,
): { usedHeight: number; remainder: TextRun[] | null; remainderAtomics?: BlockAtomic[] };
export function measureTextBlock(
  content: string | TextRun[], width: number, availHeight: number, options: TextBlockOptions = {},
): { usedHeight: number; remainder: string | TextRun[] | null; remainderAtomics?: BlockAtomic[] } {
  const o = normalizeBlockOptions(options);
  if (isTextRunList(content)) {
    rejectShapedRuns(options, o.font);
    const { woven: resolved, atomicOf } = weaveAtomics(resolveRuns(content, o), options.atomics);
    if (nothingDrawable(resolved)) return { usedHeight: 0, remainder: null };
    const { lines, remainder } = layoutRuns(
      resolved.map((r) => r.layout), width, availHeight, o.leading, o.fontSize);
    const rest = sliceContent(remainder, content, atomicOf, resolved);
    return {
      usedHeight: linesHeight(lines),
      remainder: remainder.length === 0 ? null : rest.runs,
      remainderAtomics: rest.atomics.length === 0 ? undefined : rest.atomics,
    };
  }
  let driver: FontDriver;
  if (effectiveShape(o.font, options.shape)) driver = shapedDriver(o.font, shapeOptsFrom(options));
  else driver = driverFor(o.font);
  if (drawsNothing(content, driver)) return { usedHeight: 0, remainder: null };
  const { lines, remainder } = layoutText(content, driver, o.fontSize, width, availHeight, o.leading);
  return { usedHeight: linesHeight(lines), remainder: remainder === '' ? null : remainder };
}

/** @internal Greedy-wrap `text` to `width` with no height limit, reporting each
 *  line's measured width. Shares `layoutText` — and its shaped-driver selection —
 *  with {@link flowTextBlock}, so lines drawn afterwards through {@link stampText}
 *  break identically. The width is what a caller needs to know where a line ends
 *  (toc.ts starts a dot leader there), which neither stampTextBlock nor
 *  measureTextBlock reports.
 *
 *  Note for embedded fonts: `layoutText` encodes each kept line, and an embedded
 *  font's `encode` records used glyphs. Measuring therefore retains glyphs for
 *  text that a caller may end up not drawing — a marginally larger subset, never
 *  a wrong one. */
export function wrapLines(
  text: string, width: number, options: TextBlockOptions = {},
): { text: string; width: number }[] {
  if (!Number.isFinite(width) || width <= 0)
    throw new TypeError('width must be a positive finite number');
  const o = normalizeBlockOptions(options);
  let driver: FontDriver;
  if (effectiveShape(o.font, options.shape)) driver = shapedDriver(o.font, shapeOptsFrom(options));
  else driver = driverFor(o.font);
  if (drawsNothing(text, driver)) return [];
  const { lines } = layoutText(text, driver, o.fontSize, width, Infinity, o.leading);
  return lines.map((l) => ({ text: l.text, width: l.width }));
}

/** Flow `text` into the rectangle [x, y, w, h] on `page`, wrapping to the box
 *  width and clipping to its height. Returns the unconsumed remainder (so a
 *  follow-on call can continue into another box), or `null` when everything fit
 *  or nothing was drawn (empty / all-unencodable text). Existing content is
 *  preserved. */
export function stampTextBlock(
  doc: Document, page: Page, text: string,
  rect: [number, number, number, number], options?: TextBlockOptions,
): string | null;
export function stampTextBlock(
  doc: Document, page: Page, runs: TextRun[],
  rect: [number, number, number, number], options?: TextBlockOptions,
): TextRun[] | null;
export function stampTextBlock(
  doc: Document, page: Page, content: string | TextRun[],
  rect: [number, number, number, number], options: TextBlockOptions = {},
): string | TextRun[] | null {
  reportUndrawable(content, options);
  // The two arms are identical on purpose: TypeScript resolves an overloaded
  // call by picking one signature, and a `string | TextRun[]` argument matches
  // neither. Narrowing first is what lets each arm pick its own. The same
  // two-armed shape appears in page.ts and flow.ts for the same reason — it is
  // not a copy-paste slip.
  return isTextRunList(content)
    ? flowTextBlock(doc, page, content, rect, options).remainder
    : flowTextBlock(doc, page, content, rect, options).remainder;
}
