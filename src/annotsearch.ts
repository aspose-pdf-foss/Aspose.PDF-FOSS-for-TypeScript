// Search the text an annotation DRAWS: the words inside its /AP appearance
// stream — a /FreeText's visible text, a filled form field's value — which
// `searchText` cannot see, because `visitContent` walks page content only.
//
// Its own module rather than part of textedit.ts for the reason redactannots.ts
// is its own module rather than part of redact.ts: textedit.ts is
// content-stream search and edit, and this is /Annots object-graph work that
// happens to end in a search. It also holds textedit.ts free of a dependency on
// annotation.ts, the way runlink.ts holds stamp.ts's to one symbol.
import type { Document } from './document.js';
import type { Page } from './page.js';
import type { GlyphEvent, Rect, RefRun } from './text.js';
import { visitFormContent, layoutLines, runFromGlyph } from './text.js';
import { isAnnotVisible, resolveAppearance } from './annotappearance.js';
import { Annotation, wrapAnnotation, readTextString } from './annotation.js';
import { findRanges, buildMatch, type SearchOptions } from './textedit.js';
import { isArray, isDict } from './types.js';
import { readRichTextMarkup } from './formfield.js';
import { richTextToPlain } from './richtext.js';
import type { PdfDict } from './types.js';

/** A match in the text one annotation's appearance stream draws.
 *
 *  Deliberately carries no `GlyphEvent`, unlike {@link TextMatch}: an /AP
 *  stream is not addressable by `ContentAddr`, so any provenance here would be
 *  a value no consumer could act on. */
export interface AnnotationMatch {
  /** The annotation whose appearance drew the matched text. */
  annot: Annotation;
  /** The matched substring of that annotation's assembled appearance text. */
  text: string;
  /** Page-space boxes [x0,y0,x1,y1], one per line the match spans. */
  quads: Rect[];
}

const centroidOf = (q: Rect): [number, number] => [(q[0] + q[2]) / 2, (q[1] + q[3]) / 2];
const inRect = (r: Rect, x: number, y: number): boolean =>
  x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];

/** Find every occurrence of `find` in the text drawn by the page's annotations.
 *  A string is matched literally; a RegExp is always applied globally. Results
 *  come back in /Annots order, reading order within each annotation.
 *
 *  Only annotations a static render would draw are searched (`isAnnotVisible`:
 *  not Hidden, not NoView, not a /Popup), so this agrees with `ToImage`,
 *  `ToSvg` and `FlattenAnnotations` about exactly which annotations count.
 *
 *  **Invariant:** ONE `layoutLines` assembly per annotation, never one shared
 *  across annotations or with page content. `layoutLines` groups runs by
 *  baseline Y and orders them by X, so a note drawn over a paragraph shares its
 *  line: a shared assembly would splice the note's words into the paragraph's
 *  and match a query spanning both — a phantom match, not a feature.
 *
 *  **Invariant:** no `GlyphEvent` escapes this module. `buildMatch` produces
 *  `hits`, and they are dropped here; see `visitFormContent` for why an
 *  appearance stream has no honest `ContentAddr`. */
export function searchAnnotations(
  doc: Document, page: Page, find: string | RegExp, opts: SearchOptions = {},
): AnnotationMatch[] {
  const annots = doc.resolve(page.Dict.get('Annots'));
  if (!isArray(annots)) return [];
  const region = opts.region;
  const out: AnnotationMatch[] = [];

  for (const e of annots) {
    const dict = doc.resolve(e);
    if (!isDict(dict) || !isAnnotVisible(doc, dict)) continue;
    const ap = resolveAppearance(doc, dict);
    if (ap === undefined) continue;

    const runs: RefRun<GlyphEvent>[] = [];
    try {
      visitFormContent(doc, ap.stream, page.Resources, ap.place, {
        glyph: (g) => {
          if (!g.text) return;
          if (region && !inRect(region, ...centroidOf(g.quad))) return;
          runs.push(runFromGlyph(g, g));
        },
      });
    } catch {
      // Degrade exactly as pagerender.ts's drawAnnots does: a malformed
      // appearance costs only itself and must not drop the ones after it.
      continue;
    }
    if (runs.length === 0) continue;

    const { text, refs } = layoutLines(runs);
    if (text.length === 0) continue;
    const annot = wrapAnnotation(doc, dict);
    for (const [start, end] of findRanges(text, find)) {
      const m = buildMatch(text, refs, start, end);
      out.push({ annot, text: m.text, quads: m.quads });
    }
  }
  return out;
}

// --- The other reading: text an annotation CARRIES ---------------------------

/** The annotation entries that count as carried text.
 *
 *  /Contents is the body, /T the author label and /Subj the subject line, all
 *  plain PDF text strings. /RC — the markup rich-content entry, 32000-1
 *  12.5.6.2 — joined them in `k2k5`, reduced through `richtext.ts` first: a raw
 *  fragment would let a query for `p` match a tag name, and a naive
 *  concatenation would turn `<p>a</p><p>b</p>` into `ab` and match a query for
 *  that.
 *
 *  **Invariant:** a match's `value` is the entry AS SEARCHED — the reduced text
 *  for /RC, not its markup. The `text` field is a slice of `value`, so
 *  reporting the markup there would index a string the caller never saw.
 *
 *  **Note:** a push button's ROLLOVER CAPTION is also spelled /RC, but it is
 *  nested inside /MK and holds plain text (buttonap.ts). Different entry,
 *  different level; this sweep reads the annotation dict's own keys, so the two
 *  never meet. */
export type AnnotationTextKey = 'Contents' | 'T' | 'Subj' | 'RC';

const TEXT_KEYS: readonly AnnotationTextKey[] = ['Contents', 'T', 'Subj', 'RC'];

/** A match in the text an annotation CARRIES, rather than the text it draws.
 *
 *  Carries no quad, deliberately: this text is never drawn, so its only
 *  available geometry is the annotation's whole /Rect — and redacting that
 *  burns a box over whatever innocent content happens to sit under the
 *  annotation. A caller who wants the region reads `annot.Rect` and takes
 *  responsibility for it. */
export interface AnnotationTextMatch {
  /** The annotation carrying the text. */
  annot: Annotation;
  /** Which entry matched. */
  key: AnnotationTextKey;
  /** That entry's full value. */
  value: string;
  /** The matched substring of it. */
  text: string;
}

/** Find every occurrence of `find` in the text the page's annotations CARRY —
 *  a note's body (/Contents), its author (/T), its subject (/Subj) and its rich
 *  content (/RC, reduced to plain text) — none of which is drawn on the page. A
 *  string is matched literally; a RegExp is always applied globally. Results
 *  come back in /Annots order, then Contents/T/Subj/RC order, then position
 *  within the value.
 *
 *  **Invariant:** EVERY annotation is searched, including Hidden, NoView and
 *  /Popup — deliberately unlike `searchAnnotations`, which filters through
 *  `isAnnotVisible`. That function reports what a render draws; this one
 *  reports what the file carries, and a hidden annotation's text is still in
 *  the bytes and is still what redaction removes. The divergence reads like an
 *  inconsistency, so `test/annot-search-text.test.ts` asserts it directly.
 *
 *  **Invariant:** there is no options parameter, and in particular no `region`.
 *  Scoping would have to mean the annotation's /Rect, which is the geometry
 *  this result type refuses to carry for the reason above; accepting the key
 *  and ignoring it is the silent-acceptance trap `redactText` and
 *  `markRedactText` already have to guard against. */
export function searchAnnotationText(
  doc: Document, page: Page, find: string | RegExp,
): AnnotationTextMatch[] {
  const annots = doc.resolve(page.Dict.get('Annots'));
  if (!isArray(annots)) return [];
  const out: AnnotationTextMatch[] = [];

  for (const e of annots) {
    const dict = doc.resolve(e);
    if (!isDict(dict)) continue;
    let annot: Annotation | undefined;
    for (const key of TEXT_KEYS) {
      // /RC is markup and carries the string-or-stream duality /RV has, so it
      // takes formfield.ts's reader and richtext.ts's reduction rather than the
      // plain text-string route the other three use.
      const value = key === 'RC'
        ? richTextOf(doc, dict)
        : readTextString(doc, dict, key);
      if (value === undefined || value === '') continue;
      for (const [start, end] of findRanges(value, find)) {
        annot ??= wrapAnnotation(doc, dict);
        out.push({ annot, key, value, text: value.slice(start, end) });
      }
    }
  }
  return out;
}

/** An annotation's /RC as plain text, or undefined when absent or unparseable.
 *
 *  Two steps with two owners: `readRichTextMarkup` handles the
 *  string-or-stream duality that /RC shares with a field's /RV, and
 *  `richTextToPlain` handles the markup. Neither throws, which is what keeps a
 *  malformed fragment from taking down a whole page's search. */
function richTextOf(doc: Document, dict: PdfDict): string | undefined {
  const markup = readRichTextMarkup(doc, dict, 'RC');
  return markup === undefined ? undefined : richTextToPlain(markup);
}
