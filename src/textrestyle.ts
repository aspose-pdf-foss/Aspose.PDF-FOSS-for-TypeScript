// Restyle found text (u3l5.6): page.RestyleText / doc.RestyleText. Colour, size
// and font go through planReplace's restyle mode — each match rewritten as its
// own text — and decorations through textdecor.ts's geometry, in the text's own
// scope. Holds no content walk of its own.
import type { Document } from './document.js';
import type { Page } from './page.js';
import type { ContentAddr } from './editcontent.js';
import type { AuthoringFont } from './stamp.js';
import type { HyphenationOptions } from './hyphenate.js';
import {
  checkReplaceOptions, type ReplaceAdjust, type ReplaceTextOptions, type UndrawableText, type UnreflowableText,
} from './replacefont.js';
import { pageLabel, planReplace, scopeStream,type DecorateContext, type RestyleRequest, type SearchOptions } from './textedit.js';
import { UnsupportedFeatureError } from './errors.js';
import { parseContentStream, type ContentOp } from './content.js';
import { apply, invert, mul, type GlyphEvent, type Matrix } from './text.js';
import { name, isArray, isDict, isName, type PdfDict, type PdfStream } from './types.js';
import {
  decorRects, resolveDecor, vmetricsFor, validateBackground, validateDecoration, type DecorationOptions, sfntVMetrics, std14VMetricsFor, FALLBACK_VMETRICS, type VMetrics,
} from './textdecor.js';
import { runsAdvance, glyphAdvance } from './replaceadjust.js';
import { loadEmbeddedProgram } from './glyphprogram.js';
import { matchStd14 } from './metrics.js';
import { inflateStream } from './flate.js';

/** How `RestyleText` changes matched text. Every property is optional, but at
 *  least one must change something. */
export interface TextRestyle extends DecorationOptions {
  /** Write the match in this font (re-encoding it); characters it cannot
   *  draw go to `fallbackFonts`. */
  font?: AuthoringFont;
  /** Size in points as rendered (the match's own scaling applies). */
  fontSize?: number;
  /** Fill colour [r, g, b] in 0..1; the previous fill is put back after. */
  color?: [number, number, number];
}

/** The `ReplaceText` options that still mean something when only the style
 *  changes. */
export interface RestyleTextOptions {
  region?: SearchOptions['region'];
  ignoreCase?: boolean;
  wholeWord?: boolean;
  fallbackFonts?: AuthoringFont[];
  matchRegisteredFonts?: boolean;
  onUndrawable?: (r: UndrawableText) => void;
  adjust?: ReplaceAdjust;
  onUnreflowable?: (r: UnreflowableText) => void;
  /** See `ReplaceTextOptions.hyphenate`. */
  hyphenate?: HyphenationOptions | false;
}

/** Validate a restyle before any page is read. @internal */
export function checkRestyle(
  doc: Document, style: TextRestyle, options: RestyleTextOptions | undefined,
): { opts: ReplaceTextOptions; request: RestyleRequest; style: TextRestyle } {
  if (typeof style !== 'object' || style === null || Array.isArray(style)) throw new TypeError('RestyleText: style must be an object');
  if (options !== undefined && (typeof options !== 'object' || options === null)) throw new TypeError('RestyleText options must be an object');
  validateDecoration('RestyleText: underline', style.underline);
  validateDecoration('RestyleText: strikethrough', style.strikethrough);
  validateBackground('RestyleText: background', style.background);
  const rewrite = style.font !== undefined || style.fontSize !== undefined || style.color !== undefined;
  const decorated = !!style.underline || !!style.strikethrough || style.background !== undefined;
  if (!rewrite && !decorated) throw new TypeError('RestyleText: style changes nothing');
  const opts = checkReplaceOptions({ ...(options ?? {}), font: style.font, fontSize: style.fontSize, color: style.color }, 'RestyleText');
  const request: RestyleRequest = { rewrite };
  if (decorated) request.decorate = (ctx) => planDecorations(doc, style, opts, ctx);
  return { opts, request, style };
}

/** See `Page.RestyleText`. */
export function restyleText(
  doc: Document, page: Page, find: string | RegExp, style: TextRestyle, options?: RestyleTextOptions,
): number {
  const { opts, request } = checkRestyle(doc, style, options);
  const pageNumber = doc.Pages.findIndex((p) => p.Dict === page.Dict) + 1;
  const plan = planReplace(doc, page, pageNumber, find, request, opts);
  plan.apply();
  return plan.count;
}

/** See `Document.RestyleText`: every page is planned before any changes, and
 *  each is RE-planned just before it is applied (`doc.ReplaceText`'s rule). */
export function restyleDocument(
  doc: Document, find: string | RegExp, style: TextRestyle, options?: RestyleTextOptions,
): number {
  const { opts, request } = checkRestyle(doc, style, options);
  doc.Pages.forEach((p, i) => planReplace(doc, p, i + 1, find, request, opts));
  // A form restyled through one page is the same form another page reaches
  // through a shared /Resources dict; it is restyled once (u3l5.6 review).
  const skipForms = new Set<PdfStream>();
  const req: RestyleRequest = { ...request, skipForms };
  let total = 0;
  doc.Pages.forEach((p, i) => {
    const plan = planReplace(doc, p, i + 1, find, req, opts);
    plan.apply();
    total += plan.count;
    for (const path of plan.restyledPaths ?? []) {
      const form = scopeStream(doc, p, path);
      if (form) skipForms.add(form);
    }
  });
  return total;
}

/** Vertical metrics of the font a glyph was DRAWN in: its embedded sfnt
 *  program's own `post`/OS/2 values, else a Standard-14 name's AFM family,
 *  else the descriptor's /Ascent and /Descent with the fallback rule
 *  fractions. One owner of each fraction stays `textdecor.ts`. */
export function documentVMetrics(doc: Document, g: GlyphEvent): VMetrics {
  const dict = g.font.dict;
  let fdHolder: PdfDict | undefined = dict;
  const desc = doc.resolve(dict.get('DescendantFonts'));
  if (isArray(desc)) { const d0 = doc.resolve(desc[0]); fdHolder = isDict(d0) ? d0 : undefined; }
  const fdObj = fdHolder?.get('FontDescriptor');
  const prog = loadEmbeddedProgram(fdObj, (o) => doc.resolve(o), (s) => inflateStream(s as PdfStream));
  if (prog.sfnt) return sfntVMetrics(prog.sfnt);
  const base = doc.resolve(dict.get('BaseFont'));
  const std = isName(base) ? matchStd14(base.name) : undefined;
  if (std) return std14VMetricsFor(std);
  const fd = doc.resolve(fdObj);
  if (isDict(fd)) {
    const a = doc.resolve(fd.get('Ascent')), d = doc.resolve(fd.get('Descent'));
    if (typeof a === 'number' && typeof d === 'number' && a > 0) {
      return { ...FALLBACK_VMETRICS, ascent: a / 1000, descent: -Math.abs(d) / 1000 };
    }
  }
  return FALLBACK_VMETRICS;
}

/** Plan every piece's decoration (u3l5.6). One box per piece — a piece lies in
 *  one show-string element, so on one line — at its FINAL origin (the reflow
 *  target when reflowed), in a frame along its own baseline: the glyph's
 *  `Tm x CTM` with its scale taken out, origin at the baseline (rise
 *  excluded), so `decorRects` draws in rendered points.
 *
 *  **Invariant:** the paint goes in the text's OWN scope — the background
 *  immediately before the text object's `BT`, the rules immediately after its
 *  `ET` — so it is under or over the glyphs and nothing else moves.
 *
 *  **Invariant:** a piece is decorated once by its anchor's place in the
 *  content, so a form drawn twice gets one decoration, which both drawings
 *  show. */
/** A piece's place in the content: a form drawn twice puts two drawings' pieces
 *  at one place. */
const pieceKey = (g: GlyphEvent): string =>
  `${g.addr.path.join('\0')}|${g.addr.streamIndex}|${g.addr.opIndex}|${g.elementIndex}|${g.byteStart}`;

export function planDecorations(doc: Document, style: TextRestyle, opts: ReplaceTextOptions, ctx: DecorateContext): void {
  const tagged = doc.GetStructTree() !== null;
  const done = new Set<string>();
  const opsCache = new Map<string, ContentOp[][]>();
  const vmCache = new Map<PdfDict, VMetrics>();
  const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
  for (const piece of ctx.pieces) {
    const g = piece.anchor;
    const key = pieceKey(g);
    if (done.has(key)) continue;
    done.add(key);
    if (g.vertical) throw new UnsupportedFeatureError(`RestyleText: ${pageLabel(ctx.pageNumber)}: cannot decorate vertical text`);
    const pathKey = g.addr.path.join('\0');
    let scope = opsCache.get(pathKey);
    if (!scope) { scope = ctx.scopeOps(g.addr.path); opsCache.set(pathKey, scope); }
    // **Invariant (u3l5.12):** a Form XObject drawn more than once is ONE
    // stream, so a decoration written there shows in EVERY drawing. Where the
    // matches cover this text in only some of them — a match running from one
    // drawing into the next — decorating would mark text nobody matched.
    const drawn = ctx.drawings(g);
    if (drawn > 1 && ctx.pieces.filter((p) => pieceKey(p.anchor) === key).length < drawn) {
      throw new UnsupportedFeatureError(
        `RestyleText: ${pageLabel(ctx.pageNumber)}: a decoration in a Form XObject drawn ${drawn} times shows in every drawing, but the match covers this text in only some of them`);
    }
    const at = textObject(scope, g.addr.streamIndex, g.addr.opIndex);
    if (at === 'split') {
      throw new UnsupportedFeatureError(
        `RestyleText: ${pageLabel(ctx.pageNumber)}: the text object holding a match is split across content streams, so its decoration has nowhere to go`);
    }
    // **Invariant (u3l5.12):** in a CLIPPING render mode (Tr 4-7) the text
    // object's ET adds its glyphs to the clip, and a rule painted after it is
    // cut down to the glyph outlines — a strikethrough all but vanishes. The
    // clip cannot be closed with q/Q around the text object, since content
    // after it relies on it; so there the rules go before BT, under the glyphs.
    const clips = (g.renderMode ?? 0) >= 4 || at.ops.some((o) => o.operator === 'Tr' && typeof o.operands[0] === 'number' && o.operands[0] >= 4);

    // Width as drawn after the restyle: the piece's written runs, else its glyphs.
    const written = piece.runs?.filter((r) => r.style !== undefined || r.font !== 'original');
    const width = written && written.length > 0 ? runsAdvance(written, g) : piece.glyphs.reduce((s, x) => s + glyphAdvance(x), 0);
    /** Paint the decorations for a run of the piece starting at `gx`, drawn
     *  from `t` (a reflow target; absent, where its pen chain put it) and
     *  `width` wide. */
    const decorateAt = (gx: GlyphEvent, t: [number, number] | undefined, width: number): void => {
      // The frame: Tm x CTM with its scale removed, at the baseline origin.
      const m: Matrix = mul(gx.tm, gx.ctm);
      const [bx, by] = apply(m, 0, 0);
      const sx = Math.hypot(m[0], m[1]) || 1, sy = Math.hypot(m[2], m[3]) || 1;
      // Without a reflow target, the piece starts where the edits and kerns
      // before it in its pen chain moved it, along its own baseline.
      const shift = t ? 0 : ctx.shifts.get(gx) ?? 0;
      const ox = t ? t[0] - (gx.quad[0] - bx) : bx + shift * m[0] / sx;
      const oy = t ? t[1] - (gx.quad[1] - by) : by + shift * m[1] / sx;
      const cm = mul([m[0] / sx, m[1] / sx, m[2] / sy, m[3] / sy, ox, oy], invert(g.ctm));

      let vm = opts.font !== undefined ? vmetricsFor(opts.font) : vmCache.get(g.font.dict);
      if (!vm) { vm = documentVMetrics(doc, g); vmCache.set(g.font.dict, vm); }
      const d = resolveDecor(style, opts.color ?? (g.color ? [g.color[0] / 255, g.color[1] / 255, g.color[2] / 255] : [0, 0, 0]), opts.fontSize ?? g.fontSize, vm);
      if (!d) return;
      const box = [{ x: 0, baseline: 0, width }];
      const { beneath } = decorRects(box, d);
      // **Invariant (u3l5.12):** a rule in the TEXT's colour is drawn with the
      // text's own fill operators re-emitted, never `GlyphEvent.color`'s RGB
      // approximation, so a CMYK, spot or pattern fill stays one. A rule with a
      // colour of its own, or under a replacement `color`, keeps its `rg`.
      const rule = (which: 'underline' | 'strikethrough'): ContentOp[] => {
        const body = decorRects(box, { [which]: d[which] }).above;
        if (!body) return [];
        const ops = parseContentStream(new TextEncoder().encode(body));
        const own = style[which];
        const textColoured = opts.color === undefined && (own === true || (typeof own === 'object' && own.color === undefined));
        return textColoured ? ops.flatMap((o) => (o.operator === 'rg' ? ctx.fillOps(g) : [o])) : ops;
      };
      const above = [...rule('underline'), ...rule('strikethrough')];
      const wrap = (body: string | ContentOp[]): ContentOp[] => {
        const core: ContentOp[] = [
          { operator: 'q', operands: [] },
          { operator: 'cm', operands: cm.map(r6) },
          ...(typeof body === 'string' ? parseContentStream(new TextEncoder().encode(body)) : body),
          { operator: 'Q', operands: [] },
        ];
        return tagged
          ? [{ operator: 'BMC', operands: [name('Artifact')] }, ...core, { operator: 'EMC', operands: [] }]
          : core;
      };
      // An artifact may not sit inside structure content (ISO 14289-1 7.1), so
      // in a tagged document the paint goes outside the outermost structure
      // sequence enclosing the text object — before its BDC, after its EMC.
      // An optional-content or artifact sequence is kept around it: the
      // decoration belongs to the same layer, and nesting artifacts is legal.
      // **Invariant (u3l5.12):** that sequence may open in an EARLIER content
      // stream and close in a later one — a page's /Contents array is one
      // stream as far as marked content goes — so positions span streams.
      let before: Pos = at.bt, after: Pos = at.et;
      if (tagged) {
        const open = enclosingStructure(scope, at.bt);
        if (open !== undefined) {
          const close = matchingEmc(scope, open);
          if (close === undefined) {
            throw new UnsupportedFeatureError(
              `RestyleText: ${pageLabel(ctx.pageNumber)}: the marked content holding a match is never closed, so its decoration has nowhere to go`);
          }
          before = open;
          after = close;
        }
      }
      const addr = (p: Pos): ContentAddr => ({ path: g.addr.path, streamIndex: p.stream, opIndex: p.op });
      if (beneath) ctx.before(addr(before), wrap(beneath));
      if (above.length > 0) {
        if (clips) ctx.before(addr(before), wrap(above));
        else ctx.after(addr(after), wrap(above));
      }
    };
    // A piece a hyphenated reflow split is decorated once per line it sits
    // on, the head through its hyphen (6y39).
    const lineBoxes = piece.glyphs.flatMap((x) => (ctx.boxes.get(x) ?? []).map((bx) => ({ g: x, b: bx })));
    if (lineBoxes.length === 0) { decorateAt(g, ctx.targets.get(g), width); continue; }
    const byY = new Map<number, { g: GlyphEvent; x: number; y: number; right: number }>();
    for (const { g: x, b: bx } of lineBoxes) {
      const k = Math.round(bx.y * 1000);
      const cur = byY.get(k);
      if (!cur) byY.set(k, { g: x, x: bx.x, y: bx.y, right: bx.x + bx.width });
      else { cur.right = Math.max(cur.right, bx.x + bx.width); if (bx.x < cur.x) { cur.x = bx.x; cur.g = x; } }
    }
    for (const l of byY.values()) decorateAt(l.g, [l.x, l.y], l.right - l.x);
  }
}

/** A place in a scope's content: which stream, which op. */
interface Pos { stream: number; op: number }
const lt = (a: Pos, b: Pos): boolean => a.stream < b.stream || (a.stream === b.stream && a.op < b.op);

/** The text object holding the show op at (stream, op): its `BT` and `ET`
 *  and the ops between, found by tracking BT/ET from the scope's start
 *  (u3l5.12) — a nearest-operator search attached a show op OUTSIDE any text
 *  object, in a malformed stream, to the previous one. Outside one, the op
 *  itself is both ends. `'split'` when it opens in another stream or never
 *  closes in this one. */
function textObject(scope: readonly ContentOp[][], stream: number, op: number): { bt: Pos; et: Pos; ops: ContentOp[] } | 'split' {
  let bt: Pos | undefined;
  for (let si = 0; si <= stream; si++) {
    const list = scope[si] ?? [];
    const end = si === stream ? op : list.length;
    for (let i = 0; i < end; i++) {
      if (list[i].operator === 'BT') bt = { stream: si, op: i };
      else if (list[i].operator === 'ET') bt = undefined;
    }
  }
  const list = scope[stream] ?? [];
  if (!bt) return { bt: { stream, op }, et: { stream, op }, ops: [list[op]] };
  if (bt.stream !== stream) return 'split';
  for (let i = op + 1; i < list.length; i++) {
    if (list[i].operator === 'ET') return { bt, et: { stream, op: i }, ops: list.slice(bt.op, i + 1) };
    if (list[i].operator === 'BT') return 'split';
  }
  return 'split';
}

/** The position of the OUTERMOST open marked-content sequence at `at` that
 *  is structure content — not `/OC` and not `/Artifact` — across every
 *  stream of the scope, or undefined. */
function enclosingStructure(scope: readonly ContentOp[][], at: Pos): Pos | undefined {
  const stack: { pos: Pos; tag: string }[] = [];
  for (let si = 0; si <= at.stream; si++) {
    const list = scope[si] ?? [];
    for (let i = 0; i < list.length && lt({ stream: si, op: i }, at); i++) {
      const op = list[i];
      if (op.operator === 'BDC' || op.operator === 'BMC') {
        const tag = op.operands[0];
        stack.push({ pos: { stream: si, op: i }, tag: isName(tag) ? tag.name : '' });
      } else if (op.operator === 'EMC') stack.pop();
    }
  }
  return stack.find((x) => x.tag !== 'OC' && x.tag !== 'Artifact')?.pos;
}

/** The EMC closing the sequence opened at `open`, in any later stream of the
 *  scope, or undefined. */
function matchingEmc(scope: readonly ContentOp[][], open: Pos): Pos | undefined {
  let depth = 0;
  for (let si = open.stream; si < scope.length; si++) {
    const list = scope[si] ?? [];
    for (let i = si === open.stream ? open.op : 0; i < list.length; i++) {
      const o = list[i].operator;
      if (o === 'BDC' || o === 'BMC') depth++;
      else if (o === 'EMC' && --depth === 0) return { stream: si, op: i };
    }
  }
  return undefined;
}
