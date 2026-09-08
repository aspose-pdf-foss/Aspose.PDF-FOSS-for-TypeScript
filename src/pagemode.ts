// The two catalog entries that say how a document should OPEN — /PageMode and
// /PageLayout, 32000-1 Table 28. Direct catalog keys, not entries in the
// /ViewerPreferences dictionary Table 150 defines, which is why they are here
// rather than in viewerprefs.ts.
//
// A leaf like viewerprefs.ts and docaction.ts: Document arrives as a TYPE only,
// so every rule is drivable from a hand-built catalog.
//
// **Invariant:** this module owns the page-mode vocabulary, and viewerprefs.ts
// reaches for it rather than keeping a copy. /NonFullScreenPageMode IS "a page
// mode that is not full screen" -- the same four names -- so its type is an
// Exclude over PAGE_MODES and its permitted list is derived here. Two hand-kept
// lists is how the two come to disagree the first time one is edited.

import type { Document } from './document.js';
import { PdfObject, isName, name } from './types.js';

/** /PageMode — which of a viewer's panels is open when the document opens
 *  (Table 28). Default 'UseNone'.
 *
 *  'FullScreen' is what makes a viewer PRESENT the document rather than show it
 *  as a page in a window, which is what a slide deck built with `page.Transition`
 *  and `page.Duration` needs. */
export type PageMode =
  | 'UseNone' | 'UseOutlines' | 'UseThumbs' | 'FullScreen' | 'UseOC' | 'UseAttachments';

/** /PageLayout — how a viewer arranges pages when the document opens
 *  (Table 28). Default 'SinglePage'.
 *
 *  The `TwoColumn`/`TwoPage` pairs differ in which side the FIRST page falls
 *  on: `...Left` starts a spread on the left, `...Right` on the right, which is
 *  what puts a cover page opposite the right first page of a book. */
export type PageLayout =
  | 'SinglePage' | 'OneColumn'
  | 'TwoColumnLeft' | 'TwoColumnRight'
  | 'TwoPageLeft' | 'TwoPageRight';

/** Every /PageMode name, in Table 28's order. */
export const PAGE_MODES: readonly PageMode[] = [
  'UseNone', 'UseOutlines', 'UseThumbs', 'FullScreen', 'UseOC', 'UseAttachments',
];

/** Every /PageLayout name, in Table 28's order. */
export const PAGE_LAYOUTS: readonly PageLayout[] = [
  'SinglePage', 'OneColumn', 'TwoColumnLeft', 'TwoColumnRight',
  'TwoPageLeft', 'TwoPageRight',
];

/** The page modes /ViewerPreferences /NonFullScreenPageMode admits (Table 150).
 *
 *  Derived rather than transcribed: that entry answers "what to show on LEAVING
 *  full screen", so 'FullScreen' is excluded by its own meaning, and
 *  'UseAttachments' is excluded because Table 150 does not list it. */
export const NON_FULL_SCREEN_MODES: readonly string[] =
  PAGE_MODES.filter((m) => m !== 'FullScreen' && m !== 'UseAttachments');

/** Read a name-valued catalog key, reporting only a name the enumeration
 *  admits.
 *
 *  Lenient, `viewerprefs.ts`'s rule: a value of the wrong type or a name from
 *  outside the set reads as absent rather than throwing, and the narrow write
 *  below then leaves it in the file untouched.
 *
 *  **Note, measured, and it covers NOTHING — the obvious reading is wrong:**
 *  the `isName` half is a TYPE-level necessity rather than a runtime guard, and
 *  dropping it reddens no test and provably cannot. No other `PdfObject` shape
 *  carries a `name` property — a dict is a Map, a stream is `{ dict, raw }`, a
 *  ref, string and array have none — so `.name` is `undefined` for every one of
 *  them, and no enumeration contains `undefined`. The enumeration test alone
 *  decides every case; `isName` is what lets TypeScript reach `.name` at all.
 *  Same class as `incrementaldelta.ts`'s `Map.has` note. Do not cite the
 *  non-name fixture as covering it. */
function readEnum<T extends string>(
  doc: Document, key: string, allowed: readonly T[],
): T | undefined {
  const v = doc.resolve(doc.catalog().get(key));
  return isName(v) && (allowed as readonly string[]).includes(v.name)
    ? (v.name as T)
    : undefined;
}

/** Write, delete (`null`) or leave a name-valued catalog key.
 *
 *  Validated before anything is written, so a rejected call leaves the document
 *  byte-identical: TypeError for the wrong KIND of thing, RangeError for a name
 *  outside the allowed SET — `formcreate.ts`'s split, as `checkUpdate` makes it.
 *  Deleting a key the catalog does not carry touches nothing at all, so it does
 *  not mark the document modified either. */
function writeEnum<T extends string>(
  doc: Document, key: string, label: string, allowed: readonly T[], v: T | null,
): void {
  if (v !== null) {
    if (typeof v !== 'string') throw new TypeError(`${label} must be a string`);
    if (!(allowed as readonly string[]).includes(v))
      throw new RangeError(`${label} must be one of ${allowed.join(', ')}, got ${v}`);
  }
  const cat = doc.catalog();
  if (v === null) {
    if (!cat.has(key)) return;
    cat.delete(key);
  } else {
    cat.set(key, name(v) as PdfObject);
  }
  doc.markModified();
}

/** The catalog /PageMode, or undefined when the document states none. */
export function readPageMode(doc: Document): PageMode | undefined {
  return readEnum(doc, 'PageMode', PAGE_MODES);
}

/** Set or (with `null`) remove the catalog /PageMode. */
export function setPageMode(doc: Document, v: PageMode | null): void {
  writeEnum(doc, 'PageMode', 'PageMode', PAGE_MODES, v);
}

/** The catalog /PageLayout, or undefined when the document states none. */
export function readPageLayout(doc: Document): PageLayout | undefined {
  return readEnum(doc, 'PageLayout', PAGE_LAYOUTS);
}

/** Set or (with `null`) remove the catalog /PageLayout. */
export function setPageLayout(doc: Document, v: PageLayout | null): void {
  writeEnum(doc, 'PageLayout', 'PageLayout', PAGE_LAYOUTS, v);
}
