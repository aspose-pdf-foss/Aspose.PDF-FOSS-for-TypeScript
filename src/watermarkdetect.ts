// Heuristic watermark detection (krf2.3): UNTAGGED content repeated across
// pages, reported as candidates for removal. Two shapes, because watermarks
// arrive both ways: the same Form or image XObject drawn at the same place, or
// the same text at the same place (`Page 3 of 10` and `Page 4 of 10` alike --
// digit runs match any digits).
//
// **Invariant:** "untagged" means outside every `/Artifact` sequence and every
// marked-content sequence carrying an /MCID. A tagged document's content is in
// its structure tree, and an artifact is already removable by krf2.2, so
// neither is a candidate; reporting either would offer to delete something the
// document says is meaningful, or duplicate `RemoveArtifacts`.
//
// **Invariant:** only TOP-LEVEL page content is examined. A draw inside a form
// is part of that form, which is itself the repeated thing when it repeats --
// so text inside a placed template is reported once, as the XObject.
//
// Only an XObject candidate removes. Repeated text is reported: cutting glyphs
// out of a text object shared with body text is redaction-grade surgery.

import type { Document } from './document.js';
import type { Page } from './page.js';
import { isArray, isDict, isName, isStream, type PdfObject, type PdfStream } from './types.js';
import { EditableContent, type ContentAddr } from './editcontent.js';
import { imageCutSet, type ContentOp } from './content.js';
import {
  apply, mul, IDENTITY, layoutLines, runFromGlyph, visitContent,
  type GlyphEvent, type Matrix, type Rect, type RefRun,
} from './text.js';
import { resolvePages } from './pagerange.js';
import { cutAndPrune } from './artifactremove.js';
import { rethrowLimit } from './errors.js';

/** Options for {@link Document.FindWatermarks}. */
export interface FindWatermarksOptions {
  /** 1-based pages, or a range string like '1-5,8'. Default: every page. */
  pages?: number[] | string;
  /** Distinct pages something must appear on. Default: half the pages in
   *  scope, rounded up, and never fewer than 2. */
  minPages?: number;
  /** How far, in points, an edge of two occurrences' boxes may differ and
   *  still be "the same place". Default 2. */
  tolerance?: number;
}

/** One place a candidate was found. */
export interface WatermarkOccurrence {
  /** 1-based page number. */
  page: number;
  /** Extent in the page's default user space. */
  bbox: Rect;
  /** This occurrence's own text (text candidates only). */
  text?: string;
  /** The `Do` operator (XObject candidates only). */
  addr?: ContentAddr;
}

interface CandidateBase {
  /** The pages it was found on, ascending. */
  pages: number[];
  /** The first occurrence's extent. */
  bbox: Rect;
  occurrences: WatermarkOccurrence[];
}

/** The same Form or image XObject drawn at the same place on several pages. */
export interface XObjectWatermark extends CandidateBase {
  kind: 'xobject';
  subtype: 'Form' | 'Image';
  /** Delete every occurrence -- the `Do`, and the `q … cm … Q` around it where
   *  that wraps nothing else -- and any resource only it used, so `Save`
   *  drops the XObject itself once no page draws it. Every occurrence is
   *  checked first, and a page that changed since detection makes this throw
   *  `RangeError` with nothing removed. Returns the number removed. */
  Remove(): number;
}

/** The same text at the same place on several pages, digit runs matching any
 *  digits. Reported only: text cannot be removed through a candidate. */
export interface TextWatermark extends CandidateBase {
  kind: 'text';
  /** The first occurrence's text. */
  text: string;
}

export type WatermarkCandidate = XObjectWatermark | TextWatermark;

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

interface XOcc { page: number; pageObj: Page; bbox: Rect; addr: ContentAddr; stream: PdfStream }

/** Implementation of {@link Document.FindWatermarks}. */
export function findWatermarks(doc: Document, opts: FindWatermarksOptions = {}): WatermarkCandidate[] {
  const tolerance = opts.tolerance ?? 2;
  if (typeof tolerance !== 'number' || !Number.isFinite(tolerance)) throw new TypeError('tolerance must be a finite number');
  if (tolerance < 0) throw new RangeError('tolerance must not be negative');
  if (opts.minPages !== undefined) {
    if (!Number.isInteger(opts.minPages)) throw new TypeError('minPages must be an integer');
    if (opts.minPages < 2) throw new RangeError('minPages must be at least 2: one page repeats nothing');
  }
  const all = doc.Pages;
  const selected = resolvePages(opts.pages, all.length);
  const minPages = opts.minPages ?? Math.max(2, Math.ceil(selected.length / 2));
  if (selected.length < minPages) return [];

  const xoccs: XOcc[] = [];
  const toccs: { page: number; bbox: Rect; text: string; key: string }[] = [];
  for (const n of selected) {
    const page = all[n - 1];
    xoccs.push(...xobjectDraws(doc, page, n));
    toccs.push(...textLines(doc, page, n));
  }

  const out: WatermarkCandidate[] = [];
  // XObject: grouped by the drawn stream object, then by place.
  const byStream = new Map<PdfStream, XOcc[]>();
  for (const o of xoccs) { const l = byStream.get(o.stream) ?? []; l.push(o); byStream.set(o.stream, l); }
  for (const [stream, list] of byStream) {
    for (const group of byPlace(list, tolerance)) {
      const pages = distinctPages(group);
      if (pages.length < minPages) continue;
      const st = stream.dict.get('Subtype');
      out.push(xobjectCandidate(doc, isName(st) && st.name === 'Image' ? 'Image' : 'Form', stream, group, pages));
    }
  }
  // Text: grouped by text with digit runs folded, then by place.
  const byText = new Map<string, typeof toccs>();
  for (const o of toccs) { const l = byText.get(o.key) ?? []; l.push(o); byText.set(o.key, l); }
  for (const list of byText.values()) {
    for (const group of byPlace(list, tolerance)) {
      const pages = distinctPages(group);
      if (pages.length < minPages) continue;
      out.push({
        kind: 'text', text: group[0].text, pages, bbox: group[0].bbox,
        occurrences: group.map((o) => ({ page: o.page, bbox: o.bbox, text: o.text })),
      });
    }
  }
  // Most widespread first; ties by where they first occur.
  return out.sort((a, b) => b.pages.length - a.pages.length || a.pages[0] - b.pages[0]);
}

function distinctPages(group: { page: number }[]): number[] {
  return [...new Set(group.map((o) => o.page))].sort((a, b) => a - b);
}

/** Split `list` into groups whose boxes agree, edge by edge, within `tol` of
 *  the group's first box. First-come: a group is anchored where it was first
 *  seen, so it cannot drift by small steps across the page. */
function byPlace<T extends { bbox: Rect }>(list: T[], tol: number): T[][] {
  const groups: T[][] = [];
  for (const o of list) {
    const g = groups.find((x) => x[0].bbox.every((v, i) => Math.abs(v - o.bbox[i]) <= tol));
    if (g) g.push(o); else groups.push([o]);
  }
  return groups;
}

/** Top-level `Do`s of a Form or image XObject outside every artifact and
 *  every tagged sequence, with the box each draws. Read-only:
 *  `EditableContent` copies a form on write only when one is asked for, and
 *  only top-level ops are read here. */
function xobjectDraws(doc: Document, page: Page, n: number): XOcc[] {
  const out: XOcc[] = [];
  const res = page.Resources;
  const xobjs = res ? doc.resolve(res.get('XObject')) : undefined;
  const props = res ? doc.resolve(res.get('Properties')) : undefined;
  const ec = new EditableContent(doc, page);
  let ctm: Matrix = IDENTITY;
  const ctms: Matrix[] = [];
  const marked: boolean[] = [];
  for (let s = 0; s < ec.streamCount; s++) {
    let ops: readonly ContentOp[];
    try { ops = ec.topOps(s); } catch (caught) { rethrowLimit(caught); continue; }
    ops.forEach((op, i) => {
      switch (op.operator) {
        case 'q': ctms.push(ctm); break;
        case 'Q': ctm = ctms.pop() ?? IDENTITY; break;
        case 'cm': {
          const m = op.operands.map((o) => doc.resolve(o));
          if (m.length === 6 && m.every(isNumber)) ctm = mul(m as unknown as Matrix, ctm);
          break;
        }
        case 'BMC': marked.push(isTag(op, 'Artifact')); break;
        case 'BDC': marked.push(isTag(op, 'Artifact') || carriesMcid(doc, op, props)); break;
        case 'EMC': marked.pop(); break;
        case 'Do': {
          if (marked.some(Boolean) || !isName(op.operands[0]) || !isDict(xobjs)) break;
          const x = doc.resolve(xobjs.get(op.operands[0].name));
          if (!isStream(x)) break;
          const bbox = drawnBox(doc, x, ctm);
          if (bbox) out.push({ page: n, pageObj: page, bbox, addr: { path: [], streamIndex: s, opIndex: i }, stream: x });
          break;
        }
      }
    });
  }
  return out;
}

const isTag = (op: ContentOp, tag: string) => isName(op.operands[0]) && op.operands[0].name === tag;

/** A BDC whose property list -- inline, or named in /Properties -- has /MCID. */
function carriesMcid(doc: Document, op: ContentOp, props: PdfObject | undefined): boolean {
  const p = op.operands[1];
  const d = isName(p) ? (isDict(props) ? doc.resolve(props.get(p.name)) : undefined) : doc.resolve(p);
  return isDict(d) && d.has('MCID');
}

/** The page-space box an XObject draws under `ctm`: an image's unit square,
 *  a form's /BBox through its /Matrix. Undefined for anything else. */
function drawnBox(doc: Document, x: PdfStream, ctm: Matrix): Rect | undefined {
  const st = x.dict.get('Subtype');
  let box: number[] = [0, 0, 1, 1];
  let m = ctm;
  if (isName(st) && st.name === 'Form') {
    const b = doc.resolve(x.dict.get('BBox'));
    if (!isArray(b) || b.length < 4) return undefined;
    box = b.slice(0, 4).map((v) => doc.resolve(v)) as number[];
    if (!box.every(isNumber)) return undefined;
    const fm = doc.resolve(x.dict.get('Matrix'));
    if (isArray(fm) && fm.length === 6 && fm.every((v) => isNumber(doc.resolve(v))))
      m = mul(fm.map((v) => doc.resolve(v)) as unknown as Matrix, ctm);
  } else if (!(isName(st) && st.name === 'Image')) return undefined;
  const pts = [[box[0], box[1]], [box[2], box[1]], [box[0], box[3]], [box[2], box[3]]].map(([px, py]) => apply(m, px, py));
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** Untagged top-level text, one entry per laid-out line. */
function textLines(doc: Document, page: Page, n: number): { page: number; bbox: Rect; text: string; key: string }[] {
  const runs: RefRun<GlyphEvent>[] = [];
  try {
    visitContent(doc, page, {
      glyph: (e) => {
        if (e.artifact || e.mcid !== undefined || e.addr.path.length > 0) return;
        runs.push(runFromGlyph(e, e));
      },
    });
  } catch (caught) { rethrowLimit(caught);
    return [];
  }
  const { text, refs } = layoutLines(runs);
  const out: { page: number; bbox: Rect; text: string; key: string }[] = [];
  let start = 0;
  for (const line of text.split('\n')) {
    const glyphs = refs.slice(start, start + line.length).filter((g): g is GlyphEvent => g !== undefined);
    start += line.length + 1;
    const t = line.trim().replace(/\s+/g, ' ');
    if (t === '' || glyphs.length === 0) continue;
    const bbox: Rect = [
      Math.min(...glyphs.map((g) => g.quad[0])), Math.min(...glyphs.map((g) => g.quad[1])),
      Math.max(...glyphs.map((g) => g.quad[2])), Math.max(...glyphs.map((g) => g.quad[3])),
    ];
    out.push({ page: n, bbox, text: t, key: t.replace(/\d+/g, '#') });
  }
  return out;
}

function xobjectCandidate(
  doc: Document, subtype: 'Form' | 'Image', stream: PdfStream, group: XOcc[], pages: number[],
): XObjectWatermark {
  return {
    kind: 'xobject', subtype, pages, bbox: group[0].bbox,
    occurrences: group.map((o) => ({ page: o.page, bbox: o.bbox, addr: o.addr })),
    Remove: () => removeDraws(doc, stream, group),
  };
}

/** Check every occurrence still names `stream` with a `Do`, on every page,
 *  before editing any; then cut each page's draws in one edit. */
function removeDraws(doc: Document, stream: PdfStream, group: XOcc[]): number {
  const byPage = new Map<Page, XOcc[]>();
  for (const o of group) { const l = byPage.get(o.pageObj) ?? []; l.push(o); byPage.set(o.pageObj, l); }
  for (const [page, list] of byPage) {
    const ec = new EditableContent(doc, page);
    const xobjs = page.Resources ? doc.resolve(page.Resources.get('XObject')) : undefined;
    for (const o of list) {
      const op = o.addr.streamIndex < ec.streamCount ? ec.topOps(o.addr.streamIndex)[o.addr.opIndex] : undefined;
      const nm = op?.operator === 'Do' ? op.operands[0] : undefined;
      if (!isName(nm) || !isDict(xobjs) || doc.resolve(xobjs.get(nm.name)) !== stream)
        throw new RangeError('the page changed since FindWatermarks; find the watermarks again');
    }
  }
  let removed = 0;
  for (const [page, list] of byPage) {
    removed += cutAndPrune(doc, page, (scopeOf) => {
      const s = scopeOf([]);
      const draws = new Set(list.map((o) => s.starts[o.addr.streamIndex] + o.addr.opIndex));
      for (const i of imageCutSet(s.ops, draws)) s.cut.add(i);
      return draws.size;
    });
  }
  return removed;
}
