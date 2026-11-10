// `doc.ReplaceFont(from, to)` (g0ky.3, g0ky.5): every glyph a document draws
// in one font, written in another -- in page content, Form XObjects,
// annotation appearances, and the form's default appearances.
//
// **Invariant: a font replacement is a RENAMING.** Every `Tf` that selects
// `from` (in a scope on the way to one of its glyphs) is rewritten to select
// `to`, every ExtGState whose /Font selects `from` is repointed at `to`, and
// every show string drawn in `from` is re-encoded for `to` from its Unicode
// text. Because the text state is renamed wherever it held `from`, every
// operator that inherits it -- after a `q`/`Q`, in a form drawn under it
// (mih4) -- is drawn in `to` and nothing else moves. `ReplaceText` switches
// font around ONE run; this renames the state itself, which is what lets the
// old font leave the file.
//
// **Invariant: one planner, two kinds of target.** A page (its content
// streams and the forms they draw, through `EditableContent`) and a
// STANDALONE target -- an annotation appearance, a tiling pattern's cell, or a
// Type 3 font's glyph procedures (g0ky.8), with the forms each draws -- are
// each a `Scope` to read and an `Edit` to write. The renaming rules cannot
// differ between them. The content walk does not enter a pattern or a glyph
// procedure as part of the content painting with it, so `subTargets` finds
// them in the resource graph and they are rewritten BEFORE that content: each
// copies the resources it reads on its first write, so the page's prune cannot
// remove a name a pattern sharing the page's /Resources still uses.
//
// **Invariant: no character is dropped.** A glyph `to` cannot draw is written
// in the first `fallbackFonts` entry that can, else in `from` again (a `Tf`
// there and back, `showsplit.ts`) and reported. `from` is registered in the
// glyph's own scope when that scope cannot name it -- a form inheriting the
// font, or a font an ExtGState set -- so no shape of inheritance refuses a
// page any more.
//
// **Invariant:** glyph positions are kept by default. After each re-encoded
// glyph a `TJ` kern of `(new advance - old advance) x 1000` puts the pen where
// the old glyph left it, `Tc` and `Tw` included -- `Tw` reaches only the
// one-byte code 32 (32000-1 9.3.3), so a space moving between a simple and a
// Type0 encoding gains or loses it. `positions: 'natural'` keeps only the `Tw`
// correction and lets the new advances stand.
//
// **Invariant: plan fully, then apply, per target.** Everything is decided by
// a read-only walk; a target that cannot be renamed consistently (vertical
// text with a Standard-14 `to`, a form drawn under `from` and under another
// font) is refused whole and reported, and nothing in it changes.
//
// **Invariant (g0ky.8):** vertical text is written in the VERTICAL TWIN of an
// embedded `to` or fallback -- the same descendant under `/Identity-V`
// (`registerVerticalFontIn`, built at Save by `finalizeEmbeddedFonts`) --
// and never in a Standard-14 face, which has no vertical form. Every `Tf`,
// ExtGState and run switch decides which twin from the writing mode of the
// `from` it replaces, so one font name used both ways becomes two dicts over
// one descendant. The twin states `/DW2 [880 -1000]`, so each new glyph
// advances 1 em down and the kept-position kern makes up the old advance.

import type { Document } from './document.js';
import type { Page } from './page.js';
import {
  isArray, isDict, isName, isRef, isStream, isString, name, ref,
  type PdfDict, type PdfObject, type PdfStream,
} from './types.js';
import { visitContent, visitFormContent, contentStreamBytes, type GlyphEvent } from './text.js';
import type { ContentAddr } from './editcontent.js';
import { parseContentStream, serializeContentStream, type ContentOp } from './content.js';
import { inflateStream } from './flate.js';
import { budgetFor } from './decodebudget.js';
import { EditableContent } from './editcontent.js';
import { ensureOwnResources, ensureOwnSubdict } from './pagecontent.js';
import { splitShowOp, type ShowPiece } from './showsplit.js';
import { AUTHORING_FONTS, driverFor, registerFontIn, registerVerticalFontIn, type AuthoringFont } from './stamp.js';
import { TextFont } from './font.js';
import { EmbeddedFont } from './embeddedfont.js';
import { documentFonts, type DocumentFont } from './fontinventory.js';
import { referencedNames, pruneCandidates } from './resprune.js';
import { inheritedRefs } from './artifactremove.js';
import { rethrowLimit } from './errors.js';

/** Options for {@link Document.ReplaceFont}. */
export interface ReplaceFontOptions {
  /** `'keep'` (the default) keeps every glyph where it was, with a kern after
   *  each one making up the difference in width. `'natural'` lets the new
   *  font's advances stand, so text after a wider glyph moves. */
  positions?: 'keep' | 'natural';
  /** Fonts to write a glyph in when `to` cannot draw it, tried in order: a
   *  Standard-14 face or a font from `AddFont`/`LoadFontByName`. A glyph none
   *  of them draws stays in the old font. */
  fallbackFonts?: AuthoringFont[];
}

/** Why a page, one of its annotation appearances, or a part of either was
 *  left as it was. */
export type ReplaceFontRefusal =
  | 'vertical'              // the font writes vertically; `to` cannot
  | 'shared-form'           // one form is drawn under `from` and under another font
  | 'type3-glyph'           // a Type 3 font's glyph procedures draw in `from` but the
                            // font states no /Resources of its own to name `to` in
  | 'pattern';              // a tiling pattern states no /Resources and is painted
                            // under several, which may name its fonts differently

/** Characters no font offered could draw, kept in `from`. */
export interface ReplaceFontUndrawable {
  /** 1-based page. */
  page: number;
  /** The character code in `from`. */
  code: number;
  /** Its Unicode text; `''` when the font maps it to none. */
  text: string;
  /** How many glyphs on the page (its annotations included) drew it. */
  count: number;
}

/** What {@link Document.ReplaceFont} did. */
export interface ReplaceFontReport {
  /** How many font dictionaries `from` named. 0 means nothing matched. */
  fonts: number;
  /** 1-based pages rewritten: their content or an annotation appearance. */
  pages: number[];
  /** Glyphs now drawn in `to` or a fallback font. */
  glyphs: number;
  /** Annotation appearance streams rewritten. */
  appearances: number;
  /** Tiling patterns whose cell content was rewritten. */
  patterns: number;
  /** Type 3 glyph procedures rewritten. */
  glyphProcedures: number;
  /** `/DA` default-appearance strings rewritten to name `to`. Always 0 when
   *  `to` is an embedded font: a field typed into later would be drawn in a
   *  subset that lacks the new characters. */
  defaultAppearances: number;
  /** Glyphs left in `from` because no font offered can draw them. */
  undrawable: ReplaceFontUndrawable[];
  /** Pages, or the annotation appearances, tiling patterns and Type 3 glyph
   *  procedures they reach, left untouched, and why. `annotation` marks one
   *  reached through an annotation appearance, and `part` one that is a
   *  pattern or a Type 3 font rather than the content itself; the rest of the
   *  page was still rewritten, so `from` stays in the file. */
  refused: { page: number; reason: ReplaceFontRefusal; annotation?: true; part?: 'pattern' | 'type3-glyph' }[];
}

const SHOW = new Set(['Tj', 'TJ', "'", '"']);
/** How many times a target's shared forms are split before it is refused. */
const MAX_SPLIT_ROUNDS = 4;
const IDENTITY: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0];
const opKey = (path: readonly string[], stream: number, op: number): string => `${path.join('\0')}\u0001${stream}\u0001${op}`;
const pathKey = (path: readonly string[]): string => path.join('\0');

/** What the planner reads. */
interface Scope {
  /** Every glyph drawn, in content order. */
  glyphs(): GlyphEvent[];
  /** The /Resources the content at `path` looks names up in; with `own`, only
   *  one that content holds itself. */
  resources(path: readonly string[], own: boolean): PdfDict | undefined;
  /** Read-only op lists of the content at `path`, one per stream. */
  ops(path: readonly string[]): ContentOp[][];
}

/** What the applier writes. */
interface Edit {
  ops(path: readonly string[], stream: number): readonly ContentOp[];
  setOps(path: readonly string[], stream: number, ops: ContentOp[]): void;
  /** Writable own /Resources of the content at `rp`. */
  ownRes(rp: readonly string[]): PdfDict;
  commit(): void;
  /** After `commit`: the /Resources and ops of the content at `rp`. */
  liveRes(rp: readonly string[]): PdfDict | undefined;
  liveOps(rp: readonly string[]): ContentOp[];
}

/** Walk `path` from `root` through /Resources /XObject: each form's stream and
 *  its effective /Resources. */
function walkForms(doc: Document, root: PdfDict | undefined, path: readonly string[]): { stream?: PdfStream; res?: PdfDict; own: boolean } {
  let res = root;
  let stream: PdfStream | undefined;
  let own = true;
  for (const n of path) {
    const xobjs = doc.resolve(res?.get('XObject'));
    const xo = isDict(xobjs) ? doc.resolve(xobjs.get(n)) : undefined;
    if (!isStream(xo)) return { own: false };
    stream = xo;
    const r = doc.resolve(xo.dict.get('Resources'));
    own = isDict(r);
    if (isDict(r)) res = r;
  }
  return { stream, res, own };
}

function pageScope(doc: Document, page: Page): Scope {
  return {
    glyphs: () => { const out: GlyphEvent[] = []; visitContent(doc, page, { glyph: (e) => { out.push(e); } }); return out; },
    resources: (path, own) => { const w = walkForms(doc, page.Resources, path); return own && !w.own ? undefined : w.res; },
    ops: (path) => {
      if (path.length === 0) return contentStreamBytes(doc, page).map((b) => parseContentStream(b, doc.loadLimits));
      const { stream } = walkForms(doc, page.Resources, path);
      return stream ? [parseContentStream(inflateStream(stream), budgetFor(stream).limits)] : [];
    },
  };
}

function pageEdit(doc: Document, page: Page): Edit {
  // A shared /Resources becomes this page's own first: registering `to` and
  // pruning `from` must not reach another page still drawing in `from`.
  const own = page.Dict.get('Resources');
  if (isRef(own)) {
    const d = doc.resolve(own);
    if (isDict(d)) page.Dict.set('Resources', new Map(d));
  }
  const ec = new EditableContent(doc, page);
  return {
    ops: (path, stream) => (path.length === 0 ? ec.topOps(stream) : ec.xobjectOps(path)),
    setOps: (path, stream, ops) => { if (path.length === 0) ec.setTopOps(stream, ops); else ec.setXobjectOps(path, ops); },
    ownRes: (rp) => (rp.length === 0 ? ensureOwnResources(doc, page) : ec.ownXObjectResources(rp)),
    commit: () => ec.commit(),
    liveRes: (rp) => (rp.length === 0 ? ensureOwnResources(doc, page) : ec.xobjectResources(rp)),
    liveOps: (rp) => (rp.length === 0 ? Array.from({ length: ec.streamCount }, (_, i) => ec.topOps(i)).flat() : [...ec.xobjectOps(rp)]),
  };
}

/** One root content stream of a standalone target, kept at `place`: the slot
 *  holding it (its own object number when indirect, else the dict and key). */
interface Root { stream: PdfStream; place: { num: number } | { dict: PdfDict; key: string } }

/** Content the page walk does not reach as part of the page, rewritten on its
 *  own: an annotation appearance (g0ky.5), a tiling pattern's cell, or a Type 3
 *  font's glyph procedures (g0ky.8). Its root streams read names from ONE
 *  /Resources, held by `holder` -- a stream's own dict, except a Type 3 font,
 *  whose glyph procedures all read the FONT's -- else from `fallback`.
 *
 *  **Invariant:** a Type 3 font is ONE target with every glyph procedure a
 *  root stream, never one target per procedure. The procedures share the
 *  font's /Resources, and pruning `from` there after one procedure is
 *  rewritten would cut a name a sibling still draws with. */
interface Standalone { roots: Root[]; holder: PdfDict; fallback?: PdfDict }

/** The glyphs one root stream draws, its addresses renumbered to the root's
 *  index -- a root is to its target what a content stream is to a page. */
function rootGlyphs(doc: Document, s: PdfStream, res: PdfDict | undefined, index: number, out: GlyphEvent[]): void {
  visitFormContent(doc, s, res, IDENTITY, {
    glyph: (e) => {
      if (index === 0) { out.push(e); return; }
      out.push({
        ...e,
        addr: e.addr.path.length === 0 ? { ...e.addr, streamIndex: index } : e.addr,
        ...(e.drawnBy && e.drawnBy.length > 0 ? { drawnBy: [{ ...e.drawnBy[0], streamIndex: index }, ...e.drawnBy.slice(1)] } : {}),
      });
    },
  });
}

function standaloneScope(doc: Document, t: Standalone): Scope {
  const ownRoot = (): PdfDict | undefined => { const r = doc.resolve(t.holder.get('Resources')); return isDict(r) ? r : undefined; };
  const root = (): PdfDict | undefined => ownRoot() ?? t.fallback;
  return {
    glyphs: () => { const out: GlyphEvent[] = []; t.roots.forEach((r, i) => rootGlyphs(doc, r.stream, root(), i, out)); return out; },
    resources: (path, own) => {
      if (path.length === 0) return own ? ownRoot() : root();
      const w = walkForms(doc, root(), path);
      return own && !w.own ? undefined : w.res;
    },
    ops: (path) => {
      if (path.length === 0) return t.roots.map((r) => parseContentStream(inflateStream(r.stream), budgetFor(r.stream).limits));
      const s = walkForms(doc, root(), path).stream;
      return s ? [parseContentStream(inflateStream(s), budgetFor(s).limits)] : [];
    },
  };
}

/** A standalone target's editor. Each root stream is rewritten in its own
 *  slot; a form it draws is COPIED ON WRITE along the path that reaches it,
 *  exactly as `EditableContent` copies a page's forms -- a Form XObject a root
 *  draws may also be drawn by page content, or reached by two names, and
 *  rewriting the shared object would hand those drawings bytes re-encoded for
 *  a font their own text state does not select. */
function standaloneEdit(doc: Document, t: Standalone): Edit {
  interface Clone { num: number; stream: PdfStream; res?: PdfDict; ops?: ContentOp[]; dirty: boolean }
  const clones = new Map<string, Clone>();
  let rootRes: PdfDict | undefined;
  const rootOps = new Map<number, ContentOp[]>();
  const rootDirty = new Set<number>();
  const ownedXobjs = new Map<PdfDict, PdfDict>();

  // The roots' own /Resources, made a copy once. A target with none reads the
  // fallback's, so its copy keeps every name the fallback gave it.
  const ownRootRes = (): PdfDict => {
    if (!rootRes) {
      const r = doc.resolve(t.holder.get('Resources'));
      rootRes = new Map(isDict(r) ? r : t.fallback ?? []);
      t.holder.set('Resources', rootRes);
    }
    return rootRes;
  };
  /** The owned resources the content at `path` (already copied) reads. */
  const effective = (path: readonly string[]): PdfDict => {
    for (let n = path.length; n > 0; n--) { const c = clones.get(pathKey(path.slice(0, n))); if (c?.res) return c.res; }
    return ownRootRes();
  };
  const cow = (path: readonly string[]): Clone => {
    for (let n = 1; n <= path.length; n++) {
      const k = pathKey(path.slice(0, n));
      if (clones.has(k)) continue;
      const parentRes = effective(path.slice(0, n - 1));
      let xobjs = ownedXobjs.get(parentRes);
      if (!xobjs) { xobjs = ensureOwnSubdict(doc, parentRes, 'XObject'); ownedXobjs.set(parentRes, xobjs); }
      const cur = doc.resolve(xobjs.get(path[n - 1]));
      if (!isStream(cur)) throw new RangeError(`XObject /${path[n - 1]} not found`);
      const stream: PdfStream = { kind: 'stream', dict: new Map(cur.dict), raw: cur.raw };
      const r = doc.resolve(stream.dict.get('Resources'));
      const res = isDict(r) ? new Map(r) : undefined;
      if (res) stream.dict.set('Resources', res);
      const at = doc.allocObject(stream);
      xobjs.set(path[n - 1], at);
      clones.set(k, { num: at.num, stream, res, dirty: false });
    }
    return clones.get(pathKey(path))!;
  };
  const opsOf = (s: PdfStream): ContentOp[] => parseContentStream(inflateStream(s), budgetFor(s).limits);
  const rootOf = (i: number): ContentOp[] => {
    let o = rootOps.get(i);
    if (!o) { o = opsOf(t.roots[i].stream); rootOps.set(i, o); }
    return o;
  };
  const fresh = (dict: PdfDict, ops: ContentOp[]): PdfStream => {
    const raw = serializeContentStream(ops);
    const d: PdfDict = new Map(dict);
    d.delete('Filter'); d.delete('DecodeParms');
    d.set('Length', raw.length);
    return { kind: 'stream', dict: d, raw };
  };
  return {
    ops: (path, stream) => {
      if (path.length === 0) return rootOf(stream);
      const c = cow(path);
      return (c.ops ??= opsOf(c.stream));
    },
    setOps: (path, stream, ops) => {
      if (path.length === 0) { rootOps.set(stream, ops); rootDirty.add(stream); return; }
      const c = cow(path);
      c.ops = ops; c.dirty = true;
    },
    ownRes: (rp) => {
      if (rp.length === 0) return ownRootRes();
      const c = cow(rp);
      if (!c.res) { c.res = new Map(effective(rp.slice(0, -1))); c.stream.dict.set('Resources', c.res); }
      return c.res;
    },
    commit: () => {
      for (const c of clones.values()) {
        if (!c.dirty) continue;
        const next = fresh(c.stream.dict, c.ops!);
        doc.replaceObject(c.num, next);
        c.stream = next; c.dirty = false;
      }
      for (const i of rootDirty) {
        const r = t.roots[i];
        const next = fresh(r.stream.dict, rootOps.get(i)!);
        if ('num' in r.place) doc.replaceObject(r.place.num, next);
        else r.place.dict.set(r.place.key, next);
        r.stream = next;
      }
      rootDirty.clear();
    },
    liveRes: (rp) => {
      if (rp.length === 0) { const r = doc.resolve(t.holder.get('Resources')); return isDict(r) ? r : undefined; }
      return clones.get(pathKey(rp))?.res;
    },
    liveOps: (rp) => (rp.length === 0 ? t.roots.flatMap((_, i) => rootOf(i)) : (clones.get(pathKey(rp))?.ops ?? [])),
  };
}

/** The longest prefix of `path` whose content holds its own /Resources: where
 *  a font named in that content is registered. `[]` is the target's root. */
function resourcePath(scope: Scope, path: readonly string[]): string[] {
  for (let n = path.length; n > 0; n--) {
    if (scope.resources(path.slice(0, n), true)) return path.slice(0, n);
  }
  return [];
}

/** The font dicts `from` names. */
function fromDicts(doc: Document, from: string | DocumentFont): Set<PdfDict> {
  if (typeof from !== 'string') return new Set([from.dict]);
  const out = new Set<PdfDict>();
  const consider = (d: PdfDict): void => {
    const bf = doc.resolve(d.get('BaseFont'));
    if (isName(bf) && (bf.name === from || bf.name.replace(/^[A-Z]{6}\+/, '') === from)) out.add(d);
  };
  // The inventory sees direct font dicts; the object map sees a font reached
  // only through an annotation appearance or the form's /DR.
  for (const f of documentFonts(doc)) consider(f.dict);
  for (const [, obj] of doc.objectEntries()) {
    if (!isDict(obj) || (obj.get('Type') as { name?: string })?.name !== 'Font') continue;
    const sub = doc.resolve(obj.get('Subtype'));
    // A descendant CIDFont shares its parent's name and is never selected by a Tf.
    if (isName(sub) && sub.name.startsWith('CIDFontType')) continue;
    consider(obj);
  }
  return out;
}

const isAuthoringFont = (f: unknown): f is AuthoringFont => f instanceof EmbeddedFont
  || (typeof f === 'string' && (AUTHORING_FONTS as readonly string[]).includes(f));

function checkArgs(from: unknown, to: unknown, opts: unknown): ReplaceFontOptions {
  if (typeof from !== 'string' && !(typeof from === 'object' && from !== null && isDict((from as DocumentFont).dict)))
    throw new TypeError('ReplaceFont: from must be a font name or an entry of doc.Fonts');
  if (!isAuthoringFont(to))
    throw new TypeError(`ReplaceFont: to ${String(to)} is neither a Standard-14 authoring face nor a font from AddFont`);
  const o = (opts ?? {}) as ReplaceFontOptions;
  if (typeof o !== 'object' || o === null) throw new TypeError('ReplaceFont options must be an object');
  if (o.positions !== undefined) {
    if (typeof o.positions !== 'string') throw new TypeError('ReplaceFont: positions must be a string');
    if (o.positions !== 'keep' && o.positions !== 'natural')
      throw new RangeError(`ReplaceFont: positions must be 'keep' or 'natural', got ${o.positions}`);
  }
  if (o.fallbackFonts !== undefined) {
    if (!Array.isArray(o.fallbackFonts)) throw new TypeError('ReplaceFont: fallbackFonts must be an array of fonts');
    for (const f of o.fallbackFonts) {
      if (!isAuthoringFont(f)) throw new TypeError(`ReplaceFont: fallbackFonts entry ${String(f)} is neither a Standard-14 authoring face nor a font from AddFont`);
    }
  }
  return o;
}

/** The indirect reference a dict or stream is stored under, when it is one. */
function refOf(doc: Document, d: PdfDict | PdfStream): ({ kind: 'ref'; num: number; gen: number }) | undefined {
  for (const [r, o] of doc.objectEntries()) if (o === d) return r as { kind: 'ref'; num: number; gen: number };
  return undefined;
}

/** One glyph's rewrite. */
interface GlyphPlan {
  g: GlyphEvent;
  /** The text to write; undefined keeps the glyph in `from`. */
  text?: string;
  /** The font it is written in: `to`, or a fallback. */
  font?: AuthoringFont;
  /** The kern written after it, in 1/1000 text space units. */
  kern: number;
}

/** What one target needs. */
interface Plan {
  /** Show ops to rewrite, by `opKey`: their glyphs in byte order per element. */
  shows: Map<string, { path: string[]; stream: number; op: number; glyphs: GlyphPlan[] }>;
  /** `Tf` ops selecting `from`, by `opKey`; `vertical` when that `from`
   *  writes vertically, so the op selects `to`'s vertical twin. */
  tfs: Map<string, { path: string[]; stream: number; op: number; vertical: boolean }>;
  undrawable: Map<number, { text: string; count: number }>;
  glyphs: number;
  /** Every content scope on the way to one of its glyphs. */
  scopes: string[][];
  /** How many of the target's root streams draw in `from`. */
  roots: number;
}

/** A `Do` drawing a form under `from` that another drawing of the same form
 *  draws under another font (or other text state). */
interface Split { at: ContentAddr }

const sameAddr = (a: ContentAddr, b: ContentAddr): boolean =>
  a.streamIndex === b.streamIndex && a.opIndex === b.opIndex && pathKey(a.path) === pathKey(b.path);

/** Where two drawings of one op part: the first `Do` their chains disagree
 *  on, taken from `g`'s chain. */
function splitBetween(g: GlyphEvent, other: GlyphEvent): Split | undefined {
  const c = g.drawnBy ?? [], o = other.drawnBy ?? [];
  for (let i = 0; i < c.length; i++) {
    if (i >= o.length || !sameAddr(c[i], o[i])) return { at: c[i] };
  }
  return undefined;
}

function plan(
  doc: Document, scope: Scope, from: Set<PdfDict>, fonts: readonly AuthoringFont[], natural: boolean,
): Plan | ReplaceFontRefusal | { split: Split[] } | undefined {
  const all = scope.glyphs();
  const mine = all.filter((g) => from.has(g.font.dict));
  if (mine.length === 0) return undefined;
  // Vertical text needs a font that can write vertically: an embedded face,
  // registered as its /Identity-V twin (g0ky.8). A Standard-14 face cannot,
  // and a `Tf` selecting a vertical `from` must select a vertical `to`.
  if (typeof fonts[0] === 'string' && mine.some((g) => g.vertical)) return 'vertical';
  // A form drawn under `from` and under another font cannot be rewritten one
  // way: its drawings under `from` are pointed at a copy of the form first.
  const byOp = new Map<string, GlyphEvent[]>();
  for (const g of all) {
    const k = opKey(g.addr.path, g.addr.streamIndex, g.addr.opIndex);
    const list = byOp.get(k);
    if (list) list.push(g); else byOp.set(k, [g]);
  }
  const splits: Split[] = [];
  for (const g of mine) {
    const other = byOp.get(opKey(g.addr.path, g.addr.streamIndex, g.addr.opIndex))!.find((o) => !from.has(o.font.dict));
    if (!other) continue;
    const s = splitBetween(g, other);
    if (!s) return 'shared-form';
    splits.push(s);
  }
  if (splits.length > 0) return { split: splits };

  const roots = new Set(mine.map((g) => (g.addr.path.length === 0 ? g.addr.streamIndex : g.drawnBy?.[0]?.streamIndex ?? 0)));
  const out: Plan = { shows: new Map(), tfs: new Map(), undrawable: new Map(), glyphs: 0, scopes: [], roots: roots.size };
  const seen = new Map<string, GlyphPlan>();
  for (const g of mine) {
    const k = opKey(g.addr.path, g.addr.streamIndex, g.addr.opIndex);
    const chars = [...g.text];
    // `to` first, then each fallback in order.
    const font = chars.length === 0 ? undefined
      : fonts.find((f) => (!g.vertical || typeof f !== 'string') && chars.every((c) => driverFor(f).probe(c) > 0));
    const size = g.tfSize;
    const oldTw = g.byteLen === 1 && g.code === 32 ? g.wordSpacing : 0;
    let kern = 0;
    if (font !== undefined && size !== 0) {
      const driver = driverFor(font);
      const newTw = typeof font === 'string' ? chars.filter((c) => c === ' ').length * g.wordSpacing : 0;
      if (natural) kern = ((newTw - oldTw) / size) * 1000;
      else {
        // The width the font dict will STATE: an embedded face's /W is written
        // in whole 1/1000 em, and the reader measures by that.
        // A vertical glyph advances by what its twin states: /W2 from the
        // face's vmtx, else the /DW2 default of 1 em down (g0ky.10).
        const width = g.vertical
          ? (font as EmbeddedFont).verticalAdvance(g.text)
          : chars.reduce((s, c) => s + Math.round(driver.measure(c, 1000)) / 1000, 0);
        const newAdvance = width + (chars.length * g.charSpacing) / size + newTw / size;
        kern = (newAdvance - g.advance) * 1000;
      }
      kern = Math.round(kern * 1000) / 1000;
    }
    // One stream drawn twice must be rewritten one way.
    const gk = `${k}\u0001${g.elementIndex}\u0001${g.byteStart}`;
    const prev = seen.get(gk);
    if (prev) {
      if (prev.kern !== kern || prev.font !== font) {
        // Two drawings under `from` needing different kerns (another Tc, Tw
        // or size inherited): this drawing gets a copy of its own.
        const s = splitBetween(g, prev.g);
        if (!s) return 'shared-form';
        splits.push(s);
      }
      continue;
    }
    const gp: GlyphPlan = { g, ...(font !== undefined ? { text: g.text, font } : {}), kern };
    seen.set(gk, gp);
    let show = out.shows.get(k);
    if (!show) { show = { path: [...g.addr.path], stream: g.addr.streamIndex, op: g.addr.opIndex, glyphs: [] }; out.shows.set(k, show); }
    show.glyphs.push(gp);
    if (font !== undefined) out.glyphs++;
    else {
      const u = out.undrawable.get(g.code) ?? { text: g.text, count: 0 };
      u.count++;
      out.undrawable.set(g.code, u);
    }
  }

  if (splits.length > 0) return { split: splits };

  // Every `Tf` selecting `from` in a scope on the way to one of its glyphs:
  // the glyph's own, and each one drawing it (a form inherits the font).
  const scopes = new Map<string, string[]>();
  for (const s of out.shows.values()) {
    for (let n = 0; n <= s.path.length; n++) scopes.set(pathKey(s.path.slice(0, n)), s.path.slice(0, n));
  }
  out.scopes = [...scopes.values()];
  for (const path of out.scopes) {
    const fontsHere = doc.resolve(scope.resources(path, false)?.get('Font'));
    let streams: ContentOp[][];
    try { streams = scope.ops(path); } catch (caught) { rethrowLimit(caught); continue; }
    streams.forEach((ops, stream) => ops.forEach((op, i) => {
      if (op.operator !== 'Tf' || !isName(op.operands[0]) || !isDict(fontsHere)) return;
      const f = doc.resolve(fontsHere.get(op.operands[0].name));
      if (!isDict(f) || !from.has(f)) return;
      const vertical = verticalFont(doc, f);
      // A Standard-14 `to` has no vertical form. Vertical TEXT was refused
      // above; a vertical `from` this `Tf` selects draws nothing, so the op
      // is left selecting it rather than renamed to a font that cannot exist.
      if (vertical && typeof fonts[0] === 'string') return;
      out.tfs.set(opKey(path, stream, i), { path: [...path], stream, op: i, vertical });
    }));
  }
  for (const s of out.shows.values()) s.glyphs.sort((a, b) => a.g.elementIndex - b.g.elementIndex || a.g.byteStart - b.g.byteStart);
  return out;
}

/** The pieces a show op draws once its glyphs are re-encoded: a glyph in `to`
 *  as plain bytes (the op's font after the renaming), one in a fallback or
 *  kept in `from` as a run switching font and back. */
function piecesOf(
  op: ContentOp, glyphs: GlyphPlan[], to: AuthoringFont,
  keyOf: (f: AuthoringFont, vertical: boolean) => string, fromKey: (g: GlyphEvent) => string,
): ShowPiece[] {
  const els: PdfObject[] = op.operator === 'TJ'
    ? (isArray(op.operands[0]) ? op.operands[0] : [])
    : [op.operands[op.operator === '"' ? 2 : 0]];
  const pieces: ShowPiece[] = [];
  els.forEach((el, idx) => {
    if (!isString(el)) { pieces.push({ kind: 'kern', value: el }); return; }
    for (const p of glyphs) {
      if (p.g.elementIndex !== idx) continue;
      if (p.text === undefined || p.font === undefined) {
        pieces.push({ kind: 'foreign', key: fromKey(p.g), bytes: el.bytes.subarray(p.g.byteStart, p.g.byteStart + p.g.byteLen) });
        continue;
      }
      // A vertical glyph is the face's vertical form (g0ky.10); only an
      // embedded face reaches here vertically.
      const bytes = p.g.vertical ? (p.font as EmbeddedFont).encodeVertical(p.text) : driverFor(p.font).encode(p.text);
      if (p.font === to) pieces.push({ kind: 'bytes', bytes });
      else pieces.push({ kind: 'foreign', key: keyOf(p.font, !!p.g.vertical), bytes });
      if (p.kern !== 0) pieces.push({ kind: 'kern', value: p.kern });
    }
  });
  return pieces;
}

/** The font dicts registered so far: horizontal, and vertical twins. */
interface SharedFonts { h: Map<AuthoringFont, PdfObject>; v: Map<AuthoringFont, PdfObject> }

/** Whether a font dict writes vertically (`/WMode 1`), memoized. */
const wmodeMemo = new WeakMap<PdfDict, boolean>();
function verticalFont(doc: Document, f: PdfDict): boolean {
  let v = wmodeMemo.get(f);
  if (v === undefined) {
    try { v = new TextFont(f, (o) => doc.resolve(o), (st) => inflateStream(st as PdfStream)).wmode === 1; } catch (caught) { rethrowLimit(caught); v = false; }
    wmodeMemo.set(f, v);
  }
  return v;
}

/** Register `font` in a /Font dict as ONE font dict for the whole call:
 *  `registerFontIn` makes a Standard-14 dict per scope it is asked in. */
function registerShared(doc: Document, fonts: PdfDict, font: AuthoringFont, shared: SharedFonts, vertical = false): string {
  const map = vertical ? shared.v : shared.h;
  const known = map.get(font);
  if (known === undefined) {
    // Only an embedded face reaches here vertically: `plan` gives a vertical
    // glyph no Standard-14 font.
    const key = vertical ? registerVerticalFontIn(doc, fonts, font as EmbeddedFont) : registerFontIn(doc, fonts, font);
    map.set(font, fonts.get(key)!);
    return key;
  }
  for (const [k, v] of fonts) if (isRef(v) && isRef(known) && v.num === known.num) return k;
  return freshFontKey(fonts, known);
}

function freshFontKey(fonts: PdfDict, value: PdfObject): string {
  let n = 1;
  while (fonts.has(`F${n}`)) n++;
  fonts.set(`F${n}`, value);
  return `F${n}`;
}

/** Give each split's `Do` a NEW NAME for the same form. That alone makes its
 *  drawing a different path, and both editors copy a form on write per path
 *  (`EditableContent`, `standaloneEdit`), so rewriting it leaves the other
 *  drawing's form as it was. Visually nothing changes. */
function applySplits(doc: Document, scope: Scope, edit: Edit, splits: Split[]): void {
  const byDo = new Map<string, ContentAddr>();
  for (const s of splits) byDo.set(opKey(s.at.path, s.at.streamIndex, s.at.opIndex), s.at);
  const streams = new Map<string, { path: readonly string[]; stream: number; ops: ContentOp[] }>();
  const xobjsOf = new Map<string, PdfDict>();
  for (const at of byDo.values()) {
    const sk = `${pathKey(at.path)}\u0001${at.streamIndex}`;
    let st = streams.get(sk);
    if (!st) { st = { path: at.path, stream: at.streamIndex, ops: [...edit.ops(at.path, at.streamIndex)] }; streams.set(sk, st); }
    const op = st.ops[at.opIndex];
    if (op?.operator !== 'Do' || !isName(op.operands[0])) continue;
    const res = scope.resources(at.path, false);
    const form = (doc.resolve(res?.get('XObject')) as PdfDict | undefined)?.get(op.operands[0].name);
    if (!isStream(doc.resolve(form))) continue;
    const rp = resourcePath(scope, at.path);
    let xobjs = xobjsOf.get(pathKey(rp));
    if (!xobjs) { xobjs = ensureOwnSubdict(doc, edit.ownRes(rp), 'XObject'); xobjsOf.set(pathKey(rp), xobjs); }
    let n = 1;
    while (xobjs.has(`Fm${n}`)) n++;
    xobjs.set(`Fm${n}`, form!);
    st.ops[at.opIndex] = { ...op, operands: [name(`Fm${n}`)] };
  }
  for (const st of streams.values()) edit.setOps(st.path, st.stream, st.ops);
  edit.commit();
}

/** Rewrite one target from its plan, then prune `from` where nothing names it. */
function apply(
  doc: Document, scope: Scope, edit: Edit, p: Plan, from: Set<PdfDict>, to: AuthoringFont,
  shared: SharedFonts,
): void {
  const resPaths = new Map<string, string[]>([['', []]]);
  // One owned copy of each resource scope's sub-dict, made once.
  const subs = new Map<string, PdfDict>();
  const sub = (rp: readonly string[], key: 'Font' | 'ExtGState'): PdfDict => {
    const k = `${key}\u0001${pathKey(rp)}`;
    let d = subs.get(k);
    if (!d) { d = ensureOwnSubdict(doc, edit.ownRes(rp), key); subs.set(k, d); }
    return d;
  };
  const fontsFor = (path: readonly string[]): PdfDict => {
    const rp = resourcePath(scope, path);
    resPaths.set(pathKey(rp), rp);
    return sub(rp, 'Font');
  };
  const keyIn = (path: readonly string[]) => (f: AuthoringFont, vertical = false): string => registerShared(doc, fontsFor(path), f, shared, vertical);
  // The key `from` goes by in a glyph's scope, registered there when that
  // scope cannot name it -- a form inheriting the font from the content
  // drawing it, or a font an ExtGState set.
  const fromKey = (g: GlyphEvent): string => {
    const fonts = fontsFor(g.addr.path);
    for (const [k, v] of fonts) if (doc.resolve(v) === g.font.dict) return k;
    return freshFontKey(fonts, refOf(doc, g.font.dict) ?? g.font.dict);
  };

  // An ExtGState whose /Font selects `from` selects `to` -- like a `Tf`, every
  // glyph drawn under it is re-encoded. A copy, so another page sharing the
  // ExtGState keeps it.
  for (const path of p.scopes) {
    const rp = resourcePath(scope, path);
    const egs = doc.resolve(scope.resources(rp, false)?.get('ExtGState'));
    if (!isDict(egs)) continue;
    for (const [nm, v] of egs) {
      const g = doc.resolve(v);
      const spec = isDict(g) ? doc.resolve(g.get('Font')) : undefined;
      const f = isArray(spec) ? doc.resolve(spec[0]) : undefined;
      if (!isDict(g) || !isArray(spec) || !isDict(f) || !from.has(f)) continue;
      // As for a `Tf`: no vertical form of a Standard-14 `to` exists, and a
      // vertical `from` that drew text here was refused in `plan`.
      if (typeof to === 'string' && verticalFont(doc, f)) continue;
      const fonts = fontsFor(rp);
      const key = registerShared(doc, fonts, to, shared, verticalFont(doc, f));
      const copy = new Map(g);
      copy.set('Font', [fonts.get(key)!, spec[1]]);
      sub(rp, 'ExtGState').set(nm, copy);
    }
  }

  const streams = new Map<string, { path: string[]; stream: number }>();
  for (const x of [...p.shows.values(), ...p.tfs.values()]) streams.set(`${pathKey(x.path)}\u0001${x.stream}`, { path: x.path, stream: x.stream });
  for (const { path, stream } of streams.values()) {
    const ops = edit.ops(path, stream);
    const out: ContentOp[] = [];
    ops.forEach((op, i) => {
      const k = opKey(path, stream, i);
      const tf = p.tfs.get(k);
      if (tf) { out.push({ operator: 'Tf', operands: [name(keyIn(path)(to, tf.vertical)), op.operands[1]] }); return; }
      const show = p.shows.get(k);
      if (!show || !SHOW.has(op.operator)) { out.push(op); return; }
      const pieces = piecesOf(op, show.glyphs, to, keyIn(path), fromKey);
      // The restoring `Tf` is needed only around a run in another font, and
      // only then is `to` registered in this scope for it.
      const restore = pieces.some((x) => x.kind === 'foreign')
        ? { key: keyIn(path)(to, !!show.glyphs[0].g.vertical), size: show.glyphs[0].g.tfSize }
        : { key: '', size: 0 };
      out.push(...splitShowOp(op, pieces, restore));
    });
    edit.setOps(path, stream, out);
  }
  edit.commit();

  // `from` leaves each resource scope where nothing names it any more: the
  // scope's ops, and every form it draws that has no /Resources of its own.
  for (const rp of resPaths.values()) {
    const resources = edit.liveRes(rp);
    const fonts = doc.resolve(resources?.get('Font'));
    if (!resources || !isDict(fonts)) continue;
    const names = new Set<string>();
    for (const [k, v] of fonts) { const f = doc.resolve(v); if (isDict(f) && from.has(f)) names.add(k); }
    if (names.size === 0) continue;
    const refs = referencedNames(edit.liveOps(rp));
    inheritedRefs(doc, resources, refs, 0, new Set());
    borrowedRefs(doc, resources, refs);
    pruneCandidates(doc, resources, new Map([['Font', names]]), refs);
  }
}

/** The names content stating no /Resources of its own draws with, added to
 *  `refs` -- a Type 3 font's glyph procedures (g0ky.9) and a tiling pattern's
 *  cell (g0ky.11): each reads THESE resources, so the prune must keep what it
 *  names, `inheritedRefs`' rule for a form with none. */
function borrowedRefs(doc: Document, resources: PdfDict, refs: Map<string, Set<string>>): void {
  const streams: PdfStream[] = [];
  const fonts = doc.resolve(resources.get('Font'));
  if (isDict(fonts)) {
    for (const v of fonts.values()) {
      const f = doc.resolve(v);
      if (!isDict(f) || (doc.resolve(f.get('Subtype')) as { name?: string })?.name !== 'Type3' || isDict(doc.resolve(f.get('Resources')))) continue;
      const procs = doc.resolve(f.get('CharProcs'));
      if (isDict(procs)) for (const pv of procs.values()) { const st = doc.resolve(pv); if (isStream(st)) streams.push(st); }
    }
  }
  const pats = doc.resolve(resources.get('Pattern'));
  if (isDict(pats)) {
    for (const v of pats.values()) {
      const pt = doc.resolve(v);
      if (isStream(pt) && doc.resolve(pt.dict.get('PatternType')) === 1 && !isDict(doc.resolve(pt.dict.get('Resources')))) streams.push(pt);
    }
  }
  for (const st of streams) {
    let ops: ContentOp[];
    try { ops = parseContentStream(inflateStream(st), budgetFor(st).limits); } catch (caught) { rethrowLimit(caught); continue; }
    for (const [cat, names] of referencedNames(ops)) {
      const into = refs.get(cat) ?? new Set<string>();
      for (const n of names) into.add(n);
      refs.set(cat, into);
    }
  }
}

/** Every appearance stream of a page's annotations: /N, /R and /D, each a
 *  stream or a dict of states. */
function appearancesOf(doc: Document, page: Page): Root[] {
  const out: Root[] = [];
  const annots = doc.resolve(page.Dict.get('Annots'));
  if (!isArray(annots)) return out;
  const take = (holder: PdfDict, key: string): void => {
    const raw = holder.get(key);
    const s = doc.resolve(raw);
    if (!isStream(s)) return;
    out.push({ stream: s, place: isRef(raw) ? { num: raw.num } : { dict: holder, key } });
  };
  for (const a of annots) {
    const annot = doc.resolve(a);
    const ap = isDict(annot) ? doc.resolve(annot.get('AP')) : undefined;
    if (!isDict(ap)) continue;
    for (const k of ['N', 'R', 'D']) {
      const v = doc.resolve(ap.get(k));
      if (isStream(v)) take(ap, k);
      else if (isDict(v)) for (const state of v.keys()) take(v, state);
    }
  }
  return out;
}

/** The form's default resources, /AcroForm /DR. */
function formDR(doc: Document): PdfDict | undefined {
  const root = doc.resolve(doc.trailer.get('Root'));
  const acro = isDict(root) ? doc.resolve(root.get('AcroForm')) : undefined;
  const dr = isDict(acro) ? doc.resolve(acro.get('DR')) : undefined;
  return isDict(dr) ? dr : undefined;
}

const DA_TF = /\/([^\s/[\]()<>{}%]+)(\s+[-+.\d]+\s+Tf)/g;
const latin1 = (b: Uint8Array): string => String.fromCharCode(...b);

/** Rewrite every /DA that names `from` through /DR /Font to name `to`, then
 *  drop `from` from /DR where nothing names it. Returns the count rewritten. */
function replaceInDefaults(doc: Document, from: Set<PdfDict>, to: AuthoringFont, shared: SharedFonts): number {
  const dr = formDR(doc);
  const drFonts = doc.resolve(dr?.get('Font'));
  if (!dr || !isDict(drFonts)) return 0;
  const fromKeys = new Set<string>();
  for (const [k, v] of drFonts) { const f = doc.resolve(v); if (isDict(f) && from.has(f)) fromKeys.add(k); }
  if (fromKeys.size === 0) return 0;

  const holders: PdfDict[] = [];
  const root = doc.resolve(doc.trailer.get('Root'));
  const acro = isDict(root) ? doc.resolve(root.get('AcroForm')) : undefined;
  if (isDict(acro)) holders.push(acro);
  for (const [, obj] of doc.objectEntries()) if (isDict(obj) && obj !== acro && obj.has('DA')) holders.push(obj);

  let fonts: PdfDict | undefined;
  let toKey = '';
  let count = 0;
  for (const h of holders) {
    const da = doc.resolve(h.get('DA'));
    if (!isString(da)) continue;
    const text = latin1(da.bytes);
    let changed = false;
    const next = text.replace(DA_TF, (m, key: string, rest: string) => {
      if (!fromKeys.has(key)) return m;
      if (!fonts) { fonts = ensureOwnSubdict(doc, dr, 'Font'); toKey = registerShared(doc, fonts, to, shared); }
      changed = true;
      return `/${toKey}${rest}`;
    });
    if (!changed) continue;
    h.set('DA', { kind: 'string', bytes: Uint8Array.from(next, (c) => c.charCodeAt(0)) });
    count++;
  }

  // `from` leaves /DR when no /DA names it and no appearance reading /DR (one
  // with no /Resources of its own) still selects it.
  const live = doc.resolve(dr.get('Font'));
  if (!isDict(live)) return count;
  const still = new Set<string>();
  for (const h of holders) {
    const da = doc.resolve(h.get('DA'));
    if (isString(da)) for (const m of latin1(da.bytes).matchAll(DA_TF)) still.add(m[1]);
  }
  for (const page of doc.Pages) {
    for (const ap of appearancesOf(doc, page)) {
      if (ap.stream.dict.has('Resources')) continue;
      let ops: ContentOp[];
      try { ops = parseContentStream(inflateStream(ap.stream), budgetFor(ap.stream).limits); } catch (caught) { rethrowLimit(caught); continue; }
      for (const n of referencedNames(ops).get('Font') ?? []) still.add(n);
    }
  }
  for (const k of fromKeys) if (!still.has(k)) live.delete(k);
  return count;
}

/** A tiling pattern or a Type 3 font found in a resource graph. */
interface SubTarget {
  part: 'pattern' | 'type3-glyph';
  /** What makes it one target: the pattern's object slot (the commit
   *  REPLACES the stream, so the stream object is no key), or the Type 3 font
   *  dict, which is edited in place. */
  key: object | string;
  target: Standalone;
  /** A Type 3 font stating no /Resources: its procedures read the resources
   *  of whatever shows the font, which may differ page to page, so there is
   *  no one dict to register `to` in. Reported, never rewritten. */
  borrowed?: true;
}

/**
 * The tiling patterns and Type 3 fonts reachable from `res`, which the
 * content walk does not enter as part of the content drawing them (g0ky.8).
 * Forms are descended, and so is each target's own resources, so a pattern
 * inside a glyph procedure is found too. A resources dict is examined once,
 * which is also what stops a resource cycle.
 */
function subTargets(doc: Document, res: PdfDict | undefined): SubTarget[] {
  const out: SubTarget[] = [];
  const keys = new Set<object>();
  const seen = new Set<PdfDict>();
  const stack: PdfDict[] = [];
  const push = (r: PdfObject | undefined): void => {
    const d = doc.resolve(r);
    if (!isDict(d) || seen.has(d)) return;
    seen.add(d);
    stack.push(d);
  };
  const slot = (holder: PdfDict, key: string): Root['place'] => {
    const raw = holder.get(key);
    return isRef(raw) ? { num: raw.num } : { dict: holder, key };
  };
  push(res);
  while (stack.length > 0) {
    const r = stack.pop()!;
    const fonts = doc.resolve(r.get('Font'));
    if (isDict(fonts)) {
      for (const v of fonts.values()) {
        const f = doc.resolve(v);
        if (!isDict(f) || (doc.resolve(f.get('Subtype')) as { name?: string })?.name !== 'Type3' || keys.has(f)) continue;
        const procs = doc.resolve(f.get('CharProcs'));
        if (!isDict(procs)) continue;
        const roots: Root[] = [];
        for (const k of procs.keys()) {
          const s = doc.resolve(procs.get(k));
          if (isStream(s)) roots.push({ stream: s, place: slot(procs, k) });
        }
        if (roots.length === 0) continue;
        keys.add(f);
        const own = doc.resolve(f.get('Resources'));
        out.push({ part: 'type3-glyph', key: f, target: { roots, holder: f, fallback: isDict(own) ? undefined : r }, ...(isDict(own) ? {} : { borrowed: true as const }) });
        push(own);
      }
    }
    const xobjs = doc.resolve(r.get('XObject'));
    if (isDict(xobjs)) {
      for (const v of xobjs.values()) {
        const x = doc.resolve(v);
        if (isStream(x) && (doc.resolve(x.dict.get('Subtype')) as { name?: string })?.name === 'Form') push(x.dict.get('Resources'));
      }
    }
    const pats = doc.resolve(r.get('Pattern'));
    if (isDict(pats)) {
      for (const k of pats.keys()) {
        const pt = doc.resolve(pats.get(k));
        if (!isStream(pt) || doc.resolve(pt.dict.get('PatternType')) !== 1 || keys.has(pt)) continue;
        keys.add(pt);
        // A pattern stating no /Resources reads those it was found under.
        const place = slot(pats, k);
        out.push({ part: 'pattern', key: 'num' in place ? `obj ${place.num}` : pt, target: { roots: [{ stream: pt, place }], holder: pt.dict, fallback: r } });
        push(pt.dict.get('Resources'));
      }
    }
  }
  return out;
}

/** Implementation of {@link Document.ReplaceFont}. */
export function replaceFont(
  doc: Document, from: string | DocumentFont, to: AuthoringFont, opts?: ReplaceFontOptions,
): ReplaceFontReport {
  const o = checkArgs(from, to, opts);
  const dicts = fromDicts(doc, from);
  const report: ReplaceFontReport = {
    fonts: dicts.size, pages: [], glyphs: 0, appearances: 0, patterns: 0, glyphProcedures: 0,
    defaultAppearances: 0, undrawable: [], refused: [],
  };
  if (dicts.size === 0) return report;
  const shared: SharedFonts = { h: new Map(), v: new Map() };
  const fonts: AuthoringFont[] = [to, ...(o.fallbackFonts ?? [])];
  const natural = o.positions === 'natural';
  const dr = formDR(doc);
  // Every standalone target is rewritten once, whichever page reaches it first.
  const done = new Set<object | string>();
  // A pattern stating no /Resources reads those of whatever paints it. Painted
  // under one resources dict it is rewritten against that one; under several,
  // which may bind its font names differently, one rewrite would bind every
  // painter to the first one's names, so it is refused (g0ky.11).
  const borrowedBy = new Map<object | string, Set<PdfDict | undefined>>();
  const noteBorrowers = (res: PdfDict | undefined): void => {
    for (const s of subTargets(doc, res)) {
      if (s.part !== 'pattern' || isDict(doc.resolve(s.target.holder.get('Resources')))) continue;
      const set = borrowedBy.get(s.key) ?? new Set<PdfDict | undefined>();
      set.add(s.target.fallback);
      borrowedBy.set(s.key, set);
    }
  };
  for (const page of doc.Pages) {
    noteBorrowers(page.Resources);
    for (const ap of appearancesOf(doc, page)) {
      const apRes = doc.resolve(ap.stream.dict.get('Resources'));
      noteBorrowers(isDict(apRes) ? apRes : dr);
    }
  }

  doc.Pages.forEach((page, i) => {
    const pageNo = i + 1;
    const undrawable = new Map<number, { text: string; count: number }>();
    let changed = false;
    type Where = { annotation?: true; part?: 'pattern' | 'type3-glyph' };
    const refuse = (reason: ReplaceFontRefusal, where: Where): void => { report.refused.push({ page: pageNo, reason, ...where }); };
    /** Plan and apply one target; the number of root streams it rewrote. */
    const run = (scope: () => Scope, edit: () => Edit, where: Where): number => {
      let p = plan(doc, scope(), dicts, fonts, natural);
      // A split copies forms and plans again; nested sharing may need a few.
      for (let round = 0; round < MAX_SPLIT_ROUNDS && p !== undefined && typeof p === 'object' && 'split' in p; round++) {
        applySplits(doc, scope(), edit(), p.split);
        p = plan(doc, scope(), dicts, fonts, natural);
      }
      if (p !== undefined && typeof p === 'object' && 'split' in p) p = 'shared-form';
      if (p === undefined) return 0;
      if (typeof p === 'string') { refuse(p, where); return 0; }
      for (const [code, u] of p.undrawable) {
        const prev = undrawable.get(code) ?? { text: u.text, count: 0 };
        prev.count += u.count;
        undrawable.set(code, prev);
      }
      // No glyph can be written in `to` or a fallback: every one stays in
      // `from`, so renaming its state to `to` would only reference a font
      // that draws nothing (g0ky.11). The target is left as it is.
      if (p.glyphs === 0) return 0;
      apply(doc, scope(), edit(), p, dicts, to, shared);
      report.glyphs += p.glyphs;
      changed = true;
      return p.roots;
    };
    /** Patterns and Type 3 fonts under `res`, BEFORE the content drawing them:
     *  each copies the resources it reads on its first write, so rewriting it
     *  first keeps the page's prune from removing a name it still uses. */
    const runSubs = (res: PdfDict | undefined, annotation: boolean): void => {
      for (const s of subTargets(doc, res)) {
        if (done.has(s.key)) continue;
        const where: Where = { ...(annotation ? { annotation: true as const } : {}), part: s.part };
        // A borrowed Type 3 font reads the resources of whatever shows it, so
        // it is asked again wherever it is found: page 1 may lend it another
        // font under the same name.
        if (!s.borrowed) done.add(s.key);
        if ((borrowedBy.get(s.key)?.size ?? 0) > 1) { refuse('pattern', where); continue; }
        if (s.borrowed) {
          if (plan(doc, standaloneScope(doc, s.target), dicts, fonts, natural) !== undefined) refuse('type3-glyph', where);
          continue;
        }
        const n = run(() => standaloneScope(doc, s.target), () => standaloneEdit(doc, s.target), where);
        if (s.part === 'pattern') report.patterns += n > 0 ? 1 : 0;
        else report.glyphProcedures += n;
      }
    };
    runSubs(page.Resources, false);
    run(() => pageScope(doc, page), () => pageEdit(doc, page), {});
    for (const ap of appearancesOf(doc, page)) {
      // An appearance shared by several annotations is rewritten once.
      if (done.has(ap.stream)) continue;
      done.add(ap.stream);
      const target: Standalone = { roots: [ap], holder: ap.stream.dict, fallback: dr };
      const apRes = doc.resolve(ap.stream.dict.get('Resources'));
      runSubs(isDict(apRes) ? apRes : dr, true);
      if (run(() => standaloneScope(doc, target), () => standaloneEdit(doc, target), { annotation: true }) > 0) {
        report.appearances++;
        done.add(ap.stream);
      }
    }
    if (changed) report.pages.push(pageNo);
    for (const [code, u] of undrawable) report.undrawable.push({ page: pageNo, code, text: u.text, count: u.count });
  });

  // A field typed into later is drawn in its /DA font; an embedded `to` is a
  // subset that would lack the new characters, so /DA keeps `from` then.
  if (typeof to === 'string') report.defaultAppearances = replaceInDefaults(doc, dicts, to, shared);
  return report;
}
