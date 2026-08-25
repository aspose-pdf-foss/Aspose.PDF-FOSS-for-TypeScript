// SVG <text>/<tspan> -> PDF text operators (issue 1gg0.8). Pure: imports no
// Document and allocates no objects. Fonts arrive through SvgFontProvider,
// which svgembed.ts implements because only it may allocate; paint arrives
// through TextSink, which svgdraw.ts implements over its gradient plumbing.
//
// Content here is in y-down viewBox units, like the rest of the SVG stack. PDF
// text space is y-up with glyphs upright, so the text matrix carries its own
// flip -- see textMatrix.
import type { FontDriver } from './layout.js';
import type { VMetrics } from './textdecor.js';
import type { StdFont } from './metrics.js';
import type { Matrix } from './text.js';
import type { XmlNode } from './xml.js';
import { resolveStyle, styleGetter, type Paint } from './svgstyle.js';
import type { CssMap } from './svgcss.js';
import type { SegBBox } from './svgpath.js';
import type { Poly } from './strokegeom.js';
import { num } from './pagecontent.js';
import { serializeString } from './serialize.js';
import type { PdfDict } from './types.js';

/** One resolved face, ready to measure, encode and reference. */
export interface SvgFace {
  /** Resource key within the Form XObject's /Font subdictionary. */
  key: string;
  driver: FontDriver;
  vmetrics: VMetrics;
  /** `ch`'s contours, flattened under `m` (em units, y-up → user space), or
   *  null when the face has no glyph for it. ABSENT on a face with no outline
   *  source at all, which is what makes textPath method="stretch" fall back to
   *  align — see svgtextstretch.ts. */
  outline?: (ch: string, m: Matrix, tol: number) => Poly[] | null;
}

// Deliberately no `Tc`/`Tw` anywhere in this module: letter- and word-spacing
// fold into the TJ adjustments that dx and textLength already need. Tw would be
// the compact spelling, but it applies only to the single-byte code 32 (PDF
// 32000-1 §9.3.3), so under a Type0 Identity-H face -- exactly the
// caller-supplied-handle path -- it is silently a no-op while still looking
// correct in the content stream. One always-right path beats two paths and a
// flag to choose between them.

/** Resolves a CSS font-family list to a usable face, registering it on demand. */
export interface SvgFontProvider {
  face(families: string[], bold: boolean, italic: boolean): SvgFace;
  /** Every face registered so far, keyed by resource name. Read when a content
   *  stream builds its own /Resources — the form and each pattern tile do so
   *  independently, and a tile cannot see the form's dictionary. */
  dict(): PdfDict;
}

/** Split a CSS font-family list into lower-cased, unquoted names. */
export function parseFamilies(v: string | undefined): string[] {
  if (!v) return [];
  return v.split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, '').trim().toLowerCase())
    .filter((s) => s !== '');
}

/** Which Standard-14 family a family list asks for, and whether anything in the
 *  list actually matched. `matched: false` means Helvetica is a pure guess,
 *  which is what lets a caller-supplied embedded handle take precedence. */
export interface FamilyMatch {
  family: 'Helvetica' | 'Times' | 'Courier';
  matched: boolean;
}

// Deliberately NOT extended with arial/verdana/segoe: a family this table does
// not name resolves with matched:false, which is what hands it to a
// caller-supplied embedded handle. Absent a handle it still lands on Helvetica,
// so widening the list would only take that choice away.
const SERIF = ['serif', 'times', 'georgia', 'garamond', 'book', 'roman'];
const MONO = ['monospace', 'courier', 'mono', 'consol'];
const SANS = ['sans-serif', 'helvetica', 'cursive', 'fantasy'];

export function resolveFamily(families: string[]): FamilyMatch {
  for (const f of families) {
    // Monospace first: "Courier New Roman"-style names would also match SERIF's
    // "roman", and mono is the more specific claim.
    if (MONO.some((k) => f.includes(k))) return { family: 'Courier', matched: true };
    // "sans-serif" contains "serif", so sans must win before serif is tried.
    if (SANS.some((k) => f.includes(k))) return { family: 'Helvetica', matched: true };
    if (SERIF.some((k) => f.includes(k))) return { family: 'Times', matched: true };
  }
  return { family: 'Helvetica', matched: false };
}

/** The Standard-14 face name for a family plus weight and style. */
export function std14Face(
  family: FamilyMatch['family'], bold: boolean, italic: boolean,
): StdFont {
  // Times is the odd one out: its roman is "Times-Roman", not "Times", and its
  // slanted variants are Italic where the other two are Oblique.
  if (family === 'Times')
    return (bold && italic ? 'Times-BoldItalic' : bold ? 'Times-Bold'
      : italic ? 'Times-Italic' : 'Times-Roman') as StdFont;
  const suffix = bold && italic ? '-BoldOblique' : bold ? '-Bold' : italic ? '-Oblique' : '';
  return `${family}${suffix}` as StdFont;
}

export function isBold(weight: string | undefined): boolean {
  if (!weight) return false;
  const w = weight.trim().toLowerCase();
  if (w === 'bold' || w === 'bolder') return true;
  const n = parseInt(w, 10);
  return Number.isFinite(n) && n >= 600;
}

export function isItalic(style: string | undefined): boolean {
  const s = (style ?? '').trim().toLowerCase();
  return s === 'italic' || s === 'oblique';
}

/** The text matrix placing a glyph run at (x, y) rotated `deg` degrees.
 *
 *  PDF and SVG both use row vectors, so composition is left-to-right. Glyph
 *  space is y-up and this content stream is y-down, so the flip comes FIRST and
 *  the SVG rotation second:
 *
 *    M_flip · M_rot = [1,0,0,-1] · [cos, sin, -sin, cos] = [cos, sin, sin, -cos]
 *
 *  At deg = 0 that is [1, 0, 0, -1, x, y]. The negative `d` is load-bearing:
 *  without it every glyph is mirrored, which still reads as text at a glance.
 *  Asserted from outside this file too, by rasterizing an L and comparing ink
 *  top against bottom -- a matrix-vs-matrix test cannot catch a mirror. */
export function textMatrix(x: number, y: number, deg: number): Matrix {
  if (deg === 0) return [1, 0, 0, -1, x, y];
  const t = (deg * Math.PI) / 180;
  const cos = Math.cos(t), sin = Math.sin(t);
  return [cos, sin, sin, -cos, x, y];
}

/** One element's resolved text properties. */
export interface SvgTextStyle {
  face: SvgFace;
  size: number;
  paint: Paint;
  letterSpacing: number;
  wordSpacing: number;
  /** Em fraction added to the baseline, positive up. Applied in y-down space
   *  by SUBTRACTING size * this. */
  baselineShift: number;
  anchor: 'start' | 'middle' | 'end';
  decoration: ReadonlySet<'underline' | 'overline' | 'line-through'>;
}

/** One addressable character, with its positioning-list entries resolved. */
export interface SvgChar {
  ch: string;
  style: SvgTextStyle;
  x?: number;
  y?: number;
  dx?: number;
  dy?: number;
  /** Degrees. The rotate list's last value repeats, so this is never absent. */
  rot: number;
  /** The owning element chain, outermost first, as indices into
   *  FlatText.owners. An element's x/y/dx/dy/rotate lists address every
   *  character in its subtree, not just its own, so the whole chain is needed
   *  to resolve them — and textLength groups on subtree membership too. */
  chain: number[];
  /** The innermost owner: `chain[chain.length - 1]`. */
  owner: number;
}

/** A `<textPath>`'s own attributes, recorded on its owner. Resolving `href` to
 *  geometry needs the element index, which lives in svgdraw.ts — this module
 *  stays Document-free, so it only carries the request. */
export interface TextPathSpec {
  /** Same-document id from href / xlink:href, '#' stripped. null when absent or
   *  when the value is not a local reference — this library performs no I/O. */
  href: string | null;
  /** SVG 2 inline path data. Wins over href when both are present. */
  inline: string | null;
  /** Raw attribute text, resolved against the path length at map time so a
   *  percentage does not need the geometry here. */
  startOffset: string;
  side: 'left' | 'right';
  /** method="stretch": warp the glyph outlines instead of placing glyphs. */
  stretch: boolean;
}

export interface OwnerSpec {
  textLength?: number;
  spacingAndGlyphs: boolean;
  path?: TextPathSpec;
}

/** The innermost textPath owner in `chain`, or null when the character is not
 *  inside one. Innermost-first, so a textPath nested in a textPath wins. */
export function pathOwnerOf(chain: number[], owners: OwnerSpec[]): number | null {
  for (let i = chain.length - 1; i >= 0; i--)
    if (owners[chain[i]].path !== undefined) return chain[i];
  return null;
}

function textPathSpec(n: XmlNode): TextPathSpec {
  const raw = (n.attrs.get('href') ?? n.attrs.get('xlink:href') ?? '').trim();
  const inline = n.attrs.get('path');
  return {
    href: raw.startsWith('#') && raw.length > 1 ? raw.slice(1) : null,
    inline: inline !== undefined && inline.trim() !== '' ? inline : null,
    startOffset: n.attrs.get('startOffset') ?? '0',
    side: n.attrs.get('side') === 'right' ? 'right' : 'left',
    stretch: n.attrs.get('method') === 'stretch',
  };
}

export interface FlatText {
  chars: SvgChar[];
  owners: OwnerSpec[];
  skipped: string[];
}

const numList = (v: string | undefined): number[] =>
  (v ?? '').split(/[\s,]+/).map(parseFloat).filter((n) => Number.isFinite(n));

const numOr = (v: string | undefined, dflt: number): number => {
  if (v === undefined) return dflt;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : dflt;
};

/** The baseline shift for `dominant-baseline`, as an em fraction, positive up.
 *  `hanging` and `mathematical` are approximations: their true values live in
 *  the font's BASE table, which neither the AFMs nor sfnt.ts expose. */
function baselineShift(v: string | undefined, m: VMetrics): number {
  switch ((v ?? '').trim()) {
    case 'middle': return m.xHeight / 2;
    case 'central': return (m.ascent + m.descent) / 2;
    case 'hanging': return 0.8 * m.ascent;
    case 'mathematical': return 0.5 * m.ascent;
    case 'text-before-edge': return m.ascent;
    case 'text-after-edge': case 'ideographic': return m.descent;
    default: return 0;                   // auto, alphabetic, no-change, unknown
  }
}

type Decoration = ReadonlySet<'underline' | 'overline' | 'line-through'>;

function decorationOf(v: string | undefined, inherited: Decoration): Decoration {
  if (v === undefined) return inherited;
  const out = new Set<'underline' | 'overline' | 'line-through'>();
  for (const w of v.trim().toLowerCase().split(/\s+/))
    if (w === 'underline' || w === 'overline' || w === 'line-through') out.add(w);
  return out;
}

/** Collapse per SVG's default whitespace rules: newlines vanish, tabs become
 *  spaces, runs collapse to one. Trimming at the element's ends happens once
 *  across the whole flattened result, in flattenText. */
const collapse = (s: string): string =>
  s.replace(/\r\n?|\n/g, '').replace(/\t/g, ' ').replace(/ +/g, ' ');

/** Under xml:space="preserve" everything is kept, but newlines and tabs still
 *  become spaces (SVG 1.1 §10.15). */
const preserveWs = (s: string): string => s.replace(/[\r\n\t]/g, ' ');

/** One element's positioning lists, kept aside during the walk because they can
 *  only be applied after whitespace trimming has settled which characters
 *  exist. */
interface PosLists {
  xs: number[];
  ys: number[];
  dxs: number[];
  dys: number[];
  rots: number[];
}

interface FlattenCtx {
  provider: SvgFontProvider;
  chars: SvgChar[];
  owners: OwnerSpec[];
  lists: PosLists[];
  skipped: Set<string>;
  /** Per-element stylesheet declarations, keyed by node identity. */
  css?: CssMap;
}

function walkText(
  ctx: FlattenCtx, n: XmlNode, parentPaint: Paint, parentStyle: SvgTextStyle,
  preserve: boolean, chain: number[], opacityGrouped = false,
): void {
  const css = ctx.css?.get(n);
  const get = styleGetter(n.attrs, css);
  const { paint, groupOpacity } = resolveStyle(parentPaint, n.attrs, css);
  // A tspan cannot get its own transparency group: it lives inside the single
  // BT/ET run svgdraw emits for the whole <text>. Folding is what this module
  // has always done and is exact for one span.
  //
  // `opacityGrouped` is set only for the ROOT <text> when svgdraw has already
  // wrapped it in a real transparency group. Folding there too would apply the
  // same alpha twice.
  if (groupOpacity < 1 && !opacityGrouped) {
    paint.fillOpacity *= groupOpacity;
    paint.strokeOpacity *= groupOpacity;
  }

  // Only ask the provider when this element says something about its font;
  // otherwise inherit, so one <text> of plain tspans registers one face.
  const families = parseFamilies(get('font-family'));
  const face = families.length === 0 && get('font-weight') === undefined
      && get('font-style') === undefined
    ? parentStyle.face
    : ctx.provider.face(families, isBold(get('font-weight')), isItalic(get('font-style')));

  const anchorRaw = get('text-anchor');
  const db = get('dominant-baseline');
  const style: SvgTextStyle = {
    face,
    size: numOr(get('font-size'), parentStyle.size),
    paint,
    letterSpacing: numOr(get('letter-spacing'), parentStyle.letterSpacing),
    wordSpacing: numOr(get('word-spacing'), parentStyle.wordSpacing),
    baselineShift: db === undefined
      ? parentStyle.baselineShift : baselineShift(db, face.vmetrics),
    anchor: anchorRaw === 'middle' || anchorRaw === 'end' || anchorRaw === 'start'
      ? anchorRaw : parentStyle.anchor,
    decoration: decorationOf(get('text-decoration'), parentStyle.decoration),
  };

  const sp = n.attrs.get('xml:space') ?? n.attrs.get('space');
  const ws = sp === 'preserve' ? true : sp === 'default' ? false : preserve;

  const owner = ctx.owners.length;
  const tl = numOr(n.attrs.get('textLength'), NaN);
  ctx.owners.push({
    textLength: Number.isFinite(tl) ? tl : undefined,
    spacingAndGlyphs: n.attrs.get('lengthAdjust') === 'spacingAndGlyphs',
    path: n.name === 'textPath' ? textPathSpec(n) : undefined,
  });
  // Reported HERE only for the cases this module can see. svgdraw.ts reports
  // the rest — a dangling href, or path data that parses to nothing — because
  // only it can resolve an id. Both render on the baseline.
  if (n.name === 'textPath') {
    const spec = ctx.owners[owner].path!;
    if (spec.href === null && spec.inline === null) ctx.skipped.add('textPath');
    // method="stretch" is NOT reported here: whether it can be honoured depends
    // on the faces supplying outlines, which only svgdraw.ts can weigh.
  }
  ctx.lists.push({
    xs: numList(n.attrs.get('x')),
    ys: numList(n.attrs.get('y')),
    dxs: numList(n.attrs.get('dx')),
    dys: numList(n.attrs.get('dy')),
    rots: numList(n.attrs.get('rotate')),
  });
  const here = [...chain, owner];

  for (const kid of n.nodes) {
    if (typeof kid === 'string') {
      // Positions are NOT assigned here: whitespace trimming can still delete
      // characters, and the lists address post-trim positions.
      for (const ch of ws ? preserveWs(kid) : collapse(kid))
        ctx.chars.push({ ch, style, rot: 0, chain: here, owner });
    } else if (kid.name === 'tspan' || kid.name === 'textPath') {
      // A textPath recurses exactly like a tspan, so style inheritance, nested
      // tspans, the position lists and textLength all keep working. What makes
      // it different is recorded on its owner and applied after layout.
      walkText(ctx, kid, paint, style, ws, here);
    } else if (kid.name === 'title' || kid.name === 'desc' || kid.name === 'metadata') {
      // Non-rendering: not a fidelity loss, so not reported.
    } else {
      ctx.skipped.add(kid.name);
    }
  }
}

/** Resolve every character's x/y/dx/dy/rotate from its ancestors' lists.
 *
 *  Runs after trimming, because a list addresses the characters that actually
 *  survive whitespace processing — index them before the trim and a single
 *  leading space shifts the entire run. Ancestors are visited outermost first
 *  so an inner tspan's list overrides the enclosing text's. */
function applyLists(chars: SvgChar[], lists: PosLists[]): void {
  const seen = new Map<number, number>();
  for (const c of chars) {
    for (const owner of c.chain) {
      const j = seen.get(owner) ?? 0;
      seen.set(owner, j + 1);
      const L = lists[owner];
      if (L.xs[j] !== undefined) c.x = L.xs[j];
      if (L.ys[j] !== undefined) c.y = L.ys[j];
      if (L.dxs[j] !== undefined) c.dx = L.dxs[j];
      if (L.dys[j] !== undefined) c.dy = L.dys[j];
      // Unique to rotate: past the end of the list the LAST value repeats.
      // The other lists simply stop applying.
      if (L.rots.length > 0) c.rot = L.rots[j] ?? L.rots[L.rots.length - 1];
    }
  }
}

/** Flatten a <text> subtree to addressable characters. `inheritedSize` is the
 *  font-size in force outside the element (SVG's initial value is 16).
 *
 *  `parent` is the paint in force OUTSIDE `node` — the parent's, not `node`'s
 *  own resolved paint. This walk resolves `node`'s attributes itself, so handing
 *  it an already-resolved paint applies every own-element property twice, which
 *  squared fill-opacity and opacity until it was fixed. */
export function flattenText(
  node: XmlNode, parent: Paint, provider: SvgFontProvider, inheritedSize: number,
  css?: CssMap, opacityGrouped = false,
): FlatText {
  const seed: SvgTextStyle = {
    face: provider.face([], false, false),
    size: inheritedSize,
    paint: parent,
    letterSpacing: 0,
    wordSpacing: 0,
    baselineShift: 0,
    anchor: 'start',
    decoration: new Set(),
  };
  const ctx: FlattenCtx = {
    provider, chars: [], owners: [], lists: [], skipped: new Set(), css,
  };
  walkText(ctx, node, parent, seed, false, [], opacityGrouped);

  // Trim once across the whole element rather than per chunk, so
  // "  a " + "<tspan>b</tspan>" keeps the space between a and b.
  if ((node.attrs.get('xml:space') ?? node.attrs.get('space')) !== 'preserve') {
    while (ctx.chars.length > 0 && ctx.chars[0].ch === ' ') ctx.chars.shift();
    while (ctx.chars.length > 0 && ctx.chars[ctx.chars.length - 1].ch === ' ') ctx.chars.pop();
  }
  // Only now, on the characters that survived, are the lists addressable.
  applyLists(ctx.chars, ctx.lists);
  return { chars: ctx.chars, owners: ctx.owners, skipped: [...ctx.skipped].sort() };
}

/** One glyph, positioned in y-down user units. `x`/`y` is its baseline origin. */
export interface PlacedGlyph {
  ch: string;
  x: number;
  y: number;
  /** Degrees. */
  rot: number;
  style: SvgTextStyle;
  /** The advance consumed after this glyph, spacing included. */
  adv: number;
  /** Anchored-chunk index: text-anchor applies per chunk, not per element. */
  chunk: number;
  /** Horizontal glyph scale, for lengthAdjust="spacingAndGlyphs". 1 otherwise. */
  hscale: number;
  /** Shown but not painted (Tr 3). Set for a stretched textPath run, whose ink
   *  is the warped outline svgtextstretch.ts produced: the text is emitted
   *  anyway so the run stays extractable and searchable. */
  invisible?: boolean;
  chain: number[];
  owner: number;
}

/** Walk the cursor over the flattened characters. Positions only — textLength
 *  redistribution and the anchor shift are applied afterwards, in that order. */
export function placeChars(f: FlatText): PlacedGlyph[] {
  const out: PlacedGlyph[] = [];
  let cx = 0, cy = 0, chunk = 0;
  let first = true;
  let prevPath: number | null = null;

  for (const c of f.chars) {
    // Entering or leaving a textPath starts a new anchored chunk and resets the
    // cursor: inside a textPath, x is distance ALONG THE PATH and y is the
    // perpendicular offset, so neither continues the enclosing <text>'s
    // position. Without this, "before<textPath>on path</textPath>" would anchor
    // both runs as one and start the path text dragged along by "before".
    const inPath = pathOwnerOf(c.chain, f.owners);
    if (inPath !== prevPath) {
      if (!first) chunk++;
      cx = 0; cy = 0;
      prevPath = inPath;
    }

    // Inside a textPath an ABSOLUTE x/y does not apply: the position comes from
    // the path. Honouring y in particular would be read as a perpendicular
    // offset and throw the whole run off the curve — an enclosing
    // <text y="150"> would push it 150 units clear of the path it names.
    // dx/dy below still apply, as SVG requires.
    const ax = inPath === null ? c.x : undefined;
    const ay = inPath === null ? c.y : undefined;

    // An absolute x or y begins a new anchored chunk. The first character
    // always begins chunk 0, whether or not it carries one.
    if (ax !== undefined || ay !== undefined) {
      if (!first) chunk++;
      if (ax !== undefined) cx = ax;
      if (ay !== undefined) cy = ay;
    }
    first = false;
    cx += c.dx ?? 0;
    cy += c.dy ?? 0;

    const w = c.style.face.driver.measure(c.ch, c.style.size);
    const adv = w + c.style.letterSpacing + (c.ch === ' ' ? c.style.wordSpacing : 0);
    out.push({
      ch: c.ch,
      x: cx,
      // A positive baselineShift raises the text, and this space is y-down.
      y: cy - c.style.baselineShift * c.style.size,
      rot: c.rot,
      style: c.style,
      adv,
      chunk,
      hscale: 1,
      chain: c.chain,
      owner: c.owner,
    });
    cx += adv;
  }
  return out;
}

/** Redistribute each textLength-declaring element's characters to span exactly
 *  the requested length. Mutates `glyphs`.
 *
 *  Membership is by SUBTREE (`chain.includes`), not by innermost owner: a
 *  textLength on a <text> governs the characters of its tspans too. */
export function applyTextLength(glyphs: PlacedGlyph[], owners: OwnerSpec[]): void {
  for (let o = 0; o < owners.length; o++) {
    const spec = owners[o];
    if (spec.textLength === undefined) continue;
    const idx: number[] = [];
    for (let i = 0; i < glyphs.length; i++) if (glyphs[i].chain.includes(o)) idx.push(i);
    if (idx.length < 2) continue;              // no gap to spread across

    const first = glyphs[idx[0]];
    const last = glyphs[idx[idx.length - 1]];
    const natural = last.x + last.adv - first.x;
    if (!(natural > 0)) continue;

    const origin = first.x;
    if (spec.spacingAndGlyphs) {
      // Scale the whole run, glyphs included, about its own origin.
      const k = spec.textLength / natural;
      for (const i of idx) {
        glyphs[i].x = origin + (glyphs[i].x - origin) * k;
        glyphs[i].adv *= k;
        glyphs[i].hscale *= k;
      }
    } else {
      // Spread the difference across the gaps between characters only.
      const delta = (spec.textLength - natural) / (idx.length - 1);
      for (let k = 0; k < idx.length; k++) glyphs[idx[k]].x += delta * k;
      last.adv = spec.textLength - (last.x - origin);
    }
  }
}

/** Shift each anchored chunk per the text-anchor in force at its first
 *  character. Mutates `glyphs`. */
export function applyAnchors(glyphs: PlacedGlyph[]): void {
  let i = 0;
  while (i < glyphs.length) {
    const chunk = glyphs[i].chunk;
    let j = i;
    while (j < glyphs.length && glyphs[j].chunk === chunk) j++;
    const first = glyphs[i];
    const last = glyphs[j - 1];
    const width = last.x + last.adv - first.x;
    const f = first.style.anchor === 'middle' ? 0.5 : first.style.anchor === 'end' ? 1 : 0;
    if (f !== 0) for (let k = i; k < j; k++) glyphs[k].x -= f * width;
    i = j;
  }
}

/** Flattened characters to final positions: place, stretch, then anchor. The
 *  order is SVG's — the anchor applies to the ADJUSTED chunk. */
export function layoutText(f: FlatText): PlacedGlyph[] {
  const g = placeChars(f);
  applyTextLength(g, f.owners);
  applyAnchors(g);
  return g;
}

/** What svgtext.ts needs from the walker: an operator sink and paint setup.
 *  svgdraw.ts's Emitter satisfies this structurally. */
export interface TextSink {
  push(op: string): void;
  /** Emit the colour or pattern operators for `p` over `bbox`, and report
   *  whether fill and stroke should actually be painted. */
  setPaint(p: Paint, bbox: SegBBox | null, ctm: Matrix): { fill: boolean; stroke: boolean };
}

/** The ink box of a laid-out run, in y-down user units. `SegBBox` is
 *  {x, y, w, h} — an origin plus a size, not two corners. */
export function glyphsBBox(glyphs: PlacedGlyph[]): SegBBox | null {
  if (glyphs.length === 0) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const g of glyphs) {
    x0 = Math.min(x0, g.x);
    x1 = Math.max(x1, g.x + g.adv);
    // Positive ascent is upward, which is -y here; descent is negative.
    y0 = Math.min(y0, g.y - g.style.face.vmetrics.ascent * g.style.size);
    y1 = Math.max(y1, g.y - g.style.face.vmetrics.descent * g.style.size);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** True when two glyphs can share one Tm and one show operator. */
function sameRun(a: PlacedGlyph, b: PlacedGlyph): boolean {
  return a.style === b.style && a.rot === b.rot && a.y === b.y && a.hscale === b.hscale
    && a.invisible === b.invisible;
}

/** The show operator for one run: a single Tj when every glyph sits at its
 *  natural advance, else a TJ carrying the differences.
 *
 *  The cursor advances by the FONT's glyph width, not by PlacedGlyph.adv. A Tj
 *  moves the text position by the width alone; adv also carries letter- and
 *  word-spacing, and tracking that here would compute every gap as zero and
 *  silently drop all spacing from the output. */
function showOps(run: PlacedGlyph[], st: SvgTextStyle): string {
  const parts: string[] = [];
  const hscale = run[0].hscale;
  let cursor = run[0].x;
  let buf = '';
  let adjusted = false;
  for (const g of run) {
    const gap = g.x - cursor;
    if (Math.abs(gap) > 1e-9) {
      if (buf !== '') { parts.push(serializeString(st.face.driver.encode(buf))); buf = ''; }
      // TJ units are thousandths of a text-space unit, and both the font size
      // and the horizontal scale apply to them. A POSITIVE gap is a NEGATIVE
      // adjustment.
      parts.push(num((-gap * 1000) / (st.size * hscale)));
      adjusted = true;
    }
    buf += g.ch;
    cursor = g.x + st.face.driver.measure(g.ch, st.size) * hscale;
  }
  if (buf !== '') parts.push(serializeString(st.face.driver.encode(buf)));
  return adjusted ? `[${parts.join(' ')}] TJ` : `${parts[0]} Tj`;
}

/** Decoration rules for a laid-out run, as content operators in y-down units.
 *  `beneath` is drawn before the glyphs and `above` after, matching AddText's
 *  split so a strike sits on top of the text and an underline behind it.
 *
 *  The rects are built here rather than through textdecor.ts's decorRects:
 *  that works in y-up baseline-relative space and carries its own option
 *  defaulting, and inverting both is longer than the four lines below. */
export function decorationOps(glyphs: PlacedGlyph[]): { beneath: string[]; above: string[] } {
  const beneath: string[] = [];
  const above: string[] = [];
  let i = 0;
  while (i < glyphs.length) {
    let j = i + 1;
    while (j < glyphs.length && glyphs[j].style === glyphs[i].style
           && glyphs[j].y === glyphs[i].y && glyphs[j].rot === glyphs[i].rot) j++;
    const run = glyphs.slice(i, j);
    i = j;
    const st = run[0].style;
    // A gradient-painted run has fill === null; a rule has no colour to take.
    if (st.decoration.size === 0 || st.paint.fill === null) continue;

    const x = run[0].x;
    const w = run[run.length - 1].x + run[run.length - 1].adv - x;
    const v = st.face.vmetrics;
    const rgb = st.paint.fill.map(num).join(' ');
    const rule = (offsetEm: number, thickEm: number, into: string[]): void => {
      const t = thickEm * st.size;
      // Emitted in the GLYPH frame, so the rule turns with the text — on a
      // textPath every glyph is its own run at its own tangent angle, and an
      // axis-aligned rect would lie flat across a curve. textMatrix is the same
      // frame emitGlyphs uses for the Tm, so local +x runs along the baseline
      // and local +y is glyph-up: exactly the space the vmetrics offsets are
      // already expressed in, which is why no y-down sign flip appears here.
      // At rot 0 this reduces to the previous axis-aligned rect exactly.
      const ly = offsetEm * st.size - t / 2;
      into.push('q', `${rgb} rg`,
        `${textMatrix(x, run[0].y, run[0].rot).map(num).join(' ')} cm`,
        `0 ${num(ly)} ${num(w)} ${num(t)} re`, 'f', 'Q');
    };
    if (st.decoration.has('underline')) rule(v.underlineOffset, v.underlineThickness, beneath);
    if (st.decoration.has('overline')) rule(v.ascent, v.underlineThickness, beneath);
    if (st.decoration.has('line-through')) rule(v.strikeOffset, v.strikeThickness, above);
  }
  return { beneath, above };
}

/** Emit BT/ET bodies for `glyphs`. Returns false when nothing was drawn.
 *
 *  Operators go straight to the sink and are never buffered here: `setPaint`
 *  pushes to the same sink, so buffering would land the text before the paint
 *  that applies to it. */
export function emitGlyphs(glyphs: PlacedGlyph[], sink: TextSink, ctm: Matrix): boolean {
  if (glyphs.length === 0) return false;
  // The bbox is the whole element's, which is what SVG's objectBoundingBox
  // gradient units are defined against — not the individual run's.
  const box = glyphsBBox(glyphs);
  let drew = false;

  let i = 0;
  while (i < glyphs.length) {
    let j = i + 1;
    while (j < glyphs.length && sameRun(glyphs[i], glyphs[j])) j++;
    const run = glyphs.slice(i, j);
    i = j;

    const st = run[0].style;
    if (st.face.driver.probe(run.map((g) => g.ch).join('')) === 0) continue;

    // q/Q per run so a pattern or colour cannot leak into the next one.
    sink.push('q');
    // An invisible run paints nothing, so it asks for nothing: running setPaint
    // would register a gradient or pattern that no operator ever uses.
    let mode = 3;
    if (run[0].invisible !== true) {
      const { fill, stroke } = sink.setPaint(st.paint, box, ctm);
      if (!fill && !stroke) { sink.push('Q'); continue; }
      mode = fill && stroke ? 2 : fill ? 0 : 1;
    }
    sink.push('BT');
    sink.push(`/${st.face.key} ${num(st.size)} Tf`);
    if (mode !== 0) sink.push(`${mode} Tr`);
    if (run[0].hscale !== 1) sink.push(`${num(run[0].hscale * 100)} Tz`);
    sink.push(`${textMatrix(run[0].x, run[0].y, run[0].rot).map(num).join(' ')} Tm`);
    sink.push(showOps(run, st));
    sink.push('ET');
    sink.push('Q');
    drew = true;
  }
  return drew;
}
