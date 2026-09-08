// The catalog /ViewerPreferences dictionary — 32000-1 Table 150 in full. How a
// producer says a document should OPEN and PRINT: pure dictionary work, with no
// rendering consequence anywhere in this library.
//
// A leaf like docaction.ts: it imports Document as a TYPE only, so every rule
// here is drivable from a hand-built catalog. It is also the ONE owner of the
// dictionary — /DisplayDocTitle was reachable before this module and its
// ensure-the-dict dance had been copied into three places, which is how three
// callers come to disagree about whether an empty << >> should be left behind.
//
// PDF 2.0's /Enforce is deliberately absent: it is not Table 150, and it
// constrains a VIEWER rather than stating a preference. An entry we do not
// model still survives a write — see the merge rule below.
import type { Document } from './document.js';
import { PdfDict, PdfObject, isArray, isDict, isName, name } from './types.js';
import { NON_FULL_SCREEN_MODES, type PageMode } from './pagemode.js';

/** /NonFullScreenPageMode — what to show on leaving full-screen. Default UseNone.
 *
 *  An `Exclude` over {@link PageMode} rather than four names written out again:
 *  this entry IS "a page mode that is not full screen", so pagemode.ts owns the
 *  vocabulary and the subset is checked by the compiler. 'UseAttachments' is
 *  excluded because Table 150 does not list it. */
export type NonFullScreenPageMode = Exclude<PageMode, 'FullScreen' | 'UseAttachments'>;
/** /Direction — the predominant reading order. Default L2R. */
export type ReadingDirection = 'L2R' | 'R2L';
/** The page boundary a /ViewArea, /ViewClip, /PrintArea or /PrintClip names.
 *  Default CropBox for all four. Deprecated in PDF 2.0. */
export type PageBoundary = 'MediaBox' | 'CropBox' | 'BleedBox' | 'TrimBox' | 'ArtBox';
/** /PrintScaling — the default page-scaling a print dialog offers. Default AppDefault. */
export type PrintScaling = 'None' | 'AppDefault';
/** /Duplex — how a duplex-capable printer should be driven. No default. */
export type Duplex = 'Simplex' | 'DuplexFlipShortEdge' | 'DuplexFlipLongEdge';

/** An inclusive, 1-based `[first, last]` page sub-range of /PrintPageRange.
 *
 *  Pairs rather than the flat wire array on purpose: an odd-length or
 *  descending flat array is exactly the mistake that produces a plausible wrong
 *  print job rather than an error. The writer flattens; the reader re-pairs. */
export type PrintPageRange = readonly [number, number];

/** What a document STATES about how it should be opened and printed
 *  (32000-1 Table 150).
 *
 *  **A field the document does not state is `undefined`, never the spec
 *  default.** Absent means the producer said nothing, which is a different fact
 *  from a stated `false` or a stated `CropBox` — the present-versus-absent rule
 *  `parseSimpleWidths` records for `/MissingWidth`. Each field's default is
 *  documented on its type above; nothing here fills one in.
 *
 *  Read leniently: an entry of the wrong type, a name outside its enumeration
 *  or a malformed /PrintPageRange reads as `undefined` rather than throwing. */
export interface ViewerPreferences {
  /** Hide the viewer's tool bars. Default false. */
  hideToolbar?: boolean;
  /** Hide the viewer's menu bar. Default false. */
  hideMenubar?: boolean;
  /** Hide the viewer's chrome, leaving the page alone. Default false. */
  hideWindowUI?: boolean;
  /** Resize the window to the first displayed page. Default false. */
  fitWindow?: boolean;
  /** Centre the window on the screen. Default false. */
  centerWindow?: boolean;
  /** Show the document's title rather than its file name. Default false;
   *  PDF/UA requires it true. */
  displayDocTitle?: boolean;
  /** Pick the paper tray by page size rather than by the print dialog. */
  pickTrayByPDFSize?: boolean;
  /** What to show on leaving full-screen mode. Default 'UseNone'. */
  nonFullScreenPageMode?: NonFullScreenPageMode;
  /** Predominant reading order, which decides side-by-side page order. Default 'L2R'. */
  direction?: ReadingDirection;
  /** The boundary of the visible content on screen. Default 'CropBox'. */
  viewArea?: PageBoundary;
  /** The boundary content is clipped to on screen. Default 'CropBox'. */
  viewClip?: PageBoundary;
  /** The boundary of the visible content when printing. Default 'CropBox'. */
  printArea?: PageBoundary;
  /** The boundary content is clipped to when printing. Default 'CropBox'. */
  printClip?: PageBoundary;
  /** The page-scaling option a print dialog should offer. Default 'AppDefault'. */
  printScaling?: PrintScaling;
  /** How to drive a duplex-capable printer. No default. */
  duplex?: Duplex;
  /** The number of copies to print. A positive integer; default 1. */
  numCopies?: number;
  /** Inclusive, 1-based page sub-ranges to offer in the print dialog. */
  printPageRange?: readonly PrintPageRange[];
}

/** A merge over {@link ViewerPreferences}: `undefined` leaves the entry alone,
 *  `null` deletes it, a value sets it — `MetadataUpdate`'s convention, not a
 *  second one. */
export type ViewerPreferencesUpdate = {
  [K in keyof ViewerPreferences]?: ViewerPreferences[K] | null;
};

const NON_FULL_SCREEN = NON_FULL_SCREEN_MODES;
const DIRECTIONS: readonly string[] = ['L2R', 'R2L'];
const BOUNDARIES: readonly string[] = ['MediaBox', 'CropBox', 'BleedBox', 'TrimBox', 'ArtBox'];
const PRINT_SCALINGS: readonly string[] = ['None', 'AppDefault'];
const DUPLEXES: readonly string[] = ['Simplex', 'DuplexFlipShortEdge', 'DuplexFlipLongEdge'];

/** [field, /Key] for the seven boolean entries. */
const BOOLEANS: ReadonlyArray<readonly [keyof ViewerPreferences, string]> = [
  ['hideToolbar', 'HideToolbar'],
  ['hideMenubar', 'HideMenubar'],
  ['hideWindowUI', 'HideWindowUI'],
  ['fitWindow', 'FitWindow'],
  ['centerWindow', 'CenterWindow'],
  ['displayDocTitle', 'DisplayDocTitle'],
  ['pickTrayByPDFSize', 'PickTrayByPDFSize'],
];

/** [field, /Key, permitted names] for the eight name-valued entries. */
const NAMES: ReadonlyArray<readonly [keyof ViewerPreferences, string, readonly string[]]> = [
  ['nonFullScreenPageMode', 'NonFullScreenPageMode', NON_FULL_SCREEN],
  ['direction', 'Direction', DIRECTIONS],
  ['viewArea', 'ViewArea', BOUNDARIES],
  ['viewClip', 'ViewClip', BOUNDARIES],
  ['printArea', 'PrintArea', BOUNDARIES],
  ['printClip', 'PrintClip', BOUNDARIES],
  ['printScaling', 'PrintScaling', PRINT_SCALINGS],
  ['duplex', 'Duplex', DUPLEXES],
];

const isPositiveInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v > 0;

/** The live /ViewerPreferences dict, or undefined when the catalog has none. */
function viewerPrefsDict(doc: Document): PdfDict | undefined {
  const v = doc.resolve(doc.catalog().get('ViewerPreferences'));
  return isDict(v) ? v : undefined;
}

/** Re-pair a flat /PrintPageRange, or undefined when it is not one.
 *
 *  Every rejection here also renders: an odd length, a descending or zero-based
 *  pair and a non-integer entry all describe a print job no dialog can offer. */
function readPageRange(doc: Document, raw: PdfObject | undefined): PrintPageRange[] | undefined {
  const arr = doc.resolve(raw);
  if (!isArray(arr) || arr.length === 0 || arr.length % 2 !== 0) return undefined;
  const out: PrintPageRange[] = [];
  for (let i = 0; i < arr.length; i += 2) {
    const first = doc.resolve(arr[i]), last = doc.resolve(arr[i + 1]);
    if (!isPositiveInt(first) || !isPositiveInt(last) || first > last) return undefined;
    out.push([first, last]);
  }
  return out;
}

/** Read the catalog /ViewerPreferences. An empty object when there is none.
 *
 *  Only what the document STATES appears; see {@link ViewerPreferences}. */
export function readViewerPreferences(doc: Document): ViewerPreferences {
  const vp = viewerPrefsDict(doc);
  const out: ViewerPreferences = {};
  if (!vp) return out;
  const field = out as unknown as Record<string, unknown>;

  for (const [prop, key] of BOOLEANS) {
    const v = doc.resolve(vp.get(key));
    if (typeof v === 'boolean') field[prop] = v;
  }
  for (const [prop, key, allowed] of NAMES) {
    const v = doc.resolve(vp.get(key));
    if (isName(v) && allowed.includes(v.name)) field[prop] = v.name;
  }
  const copies = doc.resolve(vp.get('NumCopies'));
  if (isPositiveInt(copies)) out.numCopies = copies;
  const range = readPageRange(doc, vp.get('PrintPageRange'));
  if (range) out.printPageRange = range;
  return out;
}

/** Validate the whole update, throwing before anything is written.
 *
 *  TypeError for the wrong KIND of thing, RangeError for a value outside the
 *  allowed SET — `formcreate.ts`'s split. It runs over every key first so a
 *  rejected call leaves the document byte-identical; validating as we wrote
 *  would leave half an update applied, which is a document nobody asked for and
 *  no error names. */
function checkUpdate(doc: Document, update: ViewerPreferencesUpdate): void {
  const u = update as Record<string, unknown>;
  for (const [field] of BOOLEANS) {
    const v = u[field];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'boolean') throw new TypeError(`viewer preference ${field} must be a boolean`);
  }
  for (const [field, , allowed] of NAMES) {
    const v = u[field];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string') throw new TypeError(`viewer preference ${field} must be a string`);
    if (!allowed.includes(v))
      throw new RangeError(`viewer preference ${field} must be one of ${allowed.join(', ')}, got ${v}`);
  }
  const copies = u.numCopies;
  if (copies !== undefined && copies !== null) {
    if (typeof copies !== 'number' || !Number.isInteger(copies))
      throw new TypeError('viewer preference numCopies must be an integer');
    if (copies < 1) throw new RangeError(`viewer preference numCopies must be >= 1, got ${copies}`);
  }
  const range = u.printPageRange;
  if (range !== undefined && range !== null) {
    if (!Array.isArray(range))
      throw new TypeError('viewer preference printPageRange must be an array of [first, last] pairs');
    const pages = doc.Pages.length;
    for (const pair of range) {
      if (!Array.isArray(pair) || pair.length !== 2)
        throw new TypeError('each printPageRange entry must be a [first, last] pair');
      const [first, last] = pair as unknown[];
      if (!Number.isInteger(first) || !Number.isInteger(last))
        throw new TypeError('printPageRange pages must be integers');
      const f = first as number, l = last as number;
      if (f < 1 || l < 1 || f > l || l > pages)
        throw new RangeError(`printPageRange pair ${f}-${l} out of range 1..${pages}`);
    }
  }
}

/** Merge `update` into the catalog /ViewerPreferences.
 *
 *  Narrow on purpose: only the keys `update` states are touched, so an entry
 *  this module declines to read — a newer spec revision's, a producer's junk —
 *  is still in the file afterwards. Read leniently, write narrowly, or a
 *  read-modify-write strips everything we do not model.
 *
 *  The dict is created only when there is something to write and DELETED when
 *  the last entry goes: an empty << >> says nothing, and leaving one behind
 *  gives a document that "has viewer preferences" and does not. It is pruned
 *  only when nothing we did not write remains. */
export function setViewerPreferences(doc: Document, update: ViewerPreferencesUpdate): void {
  checkUpdate(doc, update);
  const u = update as Record<string, unknown>;

  const writes: Array<readonly [string, PdfObject | null]> = [];
  for (const [field, key] of BOOLEANS) {
    const v = u[field];
    if (v !== undefined) writes.push([key, v === null ? null : (v as boolean)]);
  }
  for (const [field, key] of NAMES) {
    const v = u[field];
    if (v !== undefined) writes.push([key, v === null ? null : name(v as string)]);
  }
  if (u.numCopies !== undefined)
    writes.push(['NumCopies', u.numCopies === null ? null : (u.numCopies as number)]);
  if (u.printPageRange !== undefined) {
    const r = u.printPageRange;
    writes.push(['PrintPageRange', r === null ? null : (r as PrintPageRange[]).flatMap((p) => [p[0], p[1]])]);
  }
  if (writes.length === 0) return;

  let vp = viewerPrefsDict(doc);
  // A pure delete against a document with no dict has nothing to do — creating
  // one so as to delete from it materializes exactly the empty << >> the prune
  // below exists to remove.
  if (!vp && writes.every(([, v]) => v === null)) return;
  if (!vp) {
    vp = new Map<string, PdfObject>();
    doc.catalog().set('ViewerPreferences', vp);
  }
  for (const [key, v] of writes) {
    if (v === null) vp.delete(key); else vp.set(key, v);
  }
  if (vp.size === 0) doc.catalog().delete('ViewerPreferences');
  doc.markModified();
}

/** @internal Whether the dict states /DisplayDocTitle true. The one reader
 *  behind `Document.DisplayDocTitle`, which predates this module. */
export function readDisplayDocTitle(doc: Document): boolean {
  return readViewerPreferences(doc).displayDocTitle === true;
}
