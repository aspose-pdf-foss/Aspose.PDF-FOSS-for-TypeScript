/** The glyphs a document shows, deduplicated — the walk ISO 14289-2's glyph
 *  rules share (`q7hc.4.3`'s font rules and `q7hc.4.4`'s PUA rule).
 *
 *  **Invariant:** a near-LEAF. It imports `text.js` for the walk and
 *  `uarule.js` for `UaCtx`, and it imports NEITHER rule module — which is what
 *  lets `uafont.ts` and `uatext.ts` both reach it without reaching each other.
 *  The extraction `colornames.ts`, `preformat.ts`, `bordersides.ts`,
 *  `datauri.ts` and `langmatch.ts` each already made.
 *
 *  **Invariant: this key is FINER than `uafont.ts` uses, deliberately.**
 *  `GFGlyph.getGlyph` caches by `(fontId, fontName, glyphCode, renderingMode,
 *  markedContent, structElem, isRealContent)`. `q7hc.4.3` dropped the last
 *  three, on the reasoning that doing so only ever MERGES findings veraPDF
 *  would separate. 8.4.3-1 cannot accept that merge: the same PUA code drawn
 *  once under an element carrying `/Alt` and once under an element carrying
 *  none must stay distinguishable, or a real defect hides behind a conformant
 *  sibling — a MISSED DEFECT rather than a smaller report. So the walk yields
 *  the fine granularity and `uafont.ts` collapses `mcid` and `artifact` away on
 *  its own side, which is what keeps its report byte-identical. @internal */
import { visitContent } from './text.js';
import type { PdfDict } from './types.js';
import type { TextFont } from './font.js';
import type { StructElement } from './struct.js';
import type { UaCtx } from './uarule.js';

/** One distinct glyph the document shows. */
export interface DistinctGlyph {
  font: TextFont;
  fontDict: PdfDict;
  code: number;
  cid: number;
  text: string;
  renderMode: number;
  /** The `/MCID` in force, when the glyph sits in marked content. */
  mcid?: number;
  /** True when the glyph sits inside an `/Artifact` scope. veraPDF's
   *  `isRealContent` is its negation — transcribed by INFERENCE rather than
   *  quotation, since that term is a constructor parameter threaded down from
   *  the operator layer rather than a quotable expression. */
  artifact?: boolean;
  /** `/ActualText`, `/Alt` and `/Lang` inherited from the marked-content
   *  stack, when any BDC in scope states one. */
  mcProps?: { actualText?: string; alt?: string; lang?: string };
  /** The structure element this glyph's `/MCID` resolves to.
   *
   *  **Invariant: resolved HERE, in the walk, and never re-derived by a rule.**
   *  `StructTreeRoot.ElementFor(structParentsKey, mcid)` needs the PAGE's
   *  `/StructParents`, and the walk is the only place that knows which page it
   *  is on — a rule holding only a `DistinctGlyph` would have to find the page
   *  again, which is a second answer to "which element marked this glyph". */
  element?: StructElement;
}

const GLYPHS = new WeakMap<UaCtx, DistinctGlyph[]>();

/** A stable id per dict, so the dedup key can be a string. A `Map` keyed by the
 *  dict itself cannot also carry the code, the mode and the MCID. */
const OBJ_IDS = new WeakMap<PdfDict, number>();
let nextObjId = 0;
function objKey(d: PdfDict): number {
  let id = OBJ_IDS.get(d);
  if (id === undefined) { id = nextObjId++; OBJ_IDS.set(d, id); }
  return id;
}

/** Every distinct glyph the document shows, memoized per run.
 *
 *  **Invariant:** `code` and `cid` come off the `GlyphEvent` rather than being
 *  re-derived from `byteStart`/`byteLen`. CLAUDE.md records that every consumer
 *  which re-derived them that way "drew the right glyph for `/Identity-H` and
 *  the wrong one for every other CMap, silently". */
export function distinctGlyphs(ctx: UaCtx): DistinctGlyph[] {
  let out = GLYPHS.get(ctx);
  if (out !== undefined) return out;
  const seen = new Map<string, DistinctGlyph>();
  const tree = ctx.doc.GetStructTree();
  for (const page of ctx.doc.Pages) {
    // The page's /StructParents is what ElementFor keys on, and this walk is
    // the only place that knows which page we are on.
    const spRaw = ctx.doc.resolve(page.Dict.get('StructParents'));
    const sp = typeof spRaw === 'number' ? spRaw : undefined;
    visitContent(ctx.doc, page, {
      glyph: (e) => {
        const renderMode = e.renderMode ?? 0;
        const fontDict = e.font.dict;
        const key = `${objKey(fontDict)}|${e.code}|${renderMode}`
          + `|${e.mcid ?? -1}|${e.artifact === true ? 1 : 0}`;
        if (seen.has(key)) return;
        const element = tree !== null && sp !== undefined && e.mcid !== undefined
          ? tree.ElementFor(sp, e.mcid)
          : undefined;
        seen.set(key, {
          font: e.font, fontDict, code: e.code, cid: e.cid,
          text: e.text, renderMode,
          ...(e.mcid !== undefined ? { mcid: e.mcid } : {}),
          ...(e.artifact === true ? { artifact: true } : {}),
          ...(e.mcProps !== undefined ? { mcProps: e.mcProps } : {}),
          ...(element !== undefined ? { element } : {}),
        });
      },
    });
  }
  out = [...seen.values()];
  GLYPHS.set(ctx, out);
  return out;
}
