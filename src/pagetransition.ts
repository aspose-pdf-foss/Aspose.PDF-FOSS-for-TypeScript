// A page's /Trans transition dictionary — 32000-1 Table 165 in full — and the
// /Dur beside it. What a producer says should happen when a viewer ARRIVES at
// this page in a presentation: pure dictionary work, with no rendering
// consequence anywhere in this library.
//
// A leaf like viewerprefs.ts and docaction.ts: it imports Document as a TYPE
// only, so every rule here is drivable from a hand-built page dict. It never
// throws on read.
import type { Document } from './document.js';
import { PdfDict, PdfObject, isDict, isName, name } from './types.js';

/** /S — the transition style. Default 'R', an ordinary replace (no effect). */
export type TransitionStyle =
  | 'Split' | 'Blinds' | 'Box' | 'Wipe' | 'Dissolve' | 'Glitter' | 'R'
  | 'Fly' | 'Push' | 'Cover' | 'Uncover' | 'Fade';
/** /Dm — the axis a Split or Blinds runs along. Default 'H'. */
export type TransitionDimension = 'H' | 'V';
/** /M — inward toward the centre or outward from it, for Split, Box and Fly.
 *  Default 'I'. */
export type TransitionMotion = 'I' | 'O';
/** /Di — the direction in degrees, for Wipe, Glitter, Fly, Cover, Uncover and
 *  Push. Default 0. 315 is Glitter's alone; the name 'None' is Fly's alone and
 *  means the effect has no direction at all. */
export type TransitionDirection = 0 | 90 | 180 | 270 | 315 | 'None';

/** What a page STATES about the transition to play on arriving at it
 *  (32000-1 Table 165).
 *
 *  **A field the page does not state is `undefined`, never the spec default.**
 *  Absent means the producer said nothing, which is a different fact from a
 *  stated `'H'` — the present-versus-absent rule `parseSimpleWidths` records
 *  for `/MissingWidth`. Each field's default is documented on its type above;
 *  nothing here fills one in.
 *
 *  Read leniently: an entry of the wrong type, a name outside its enumeration
 *  or a /Di outside its value set reads as `undefined` rather than throwing. */
export interface PageTransition {
  /** The transition style. Default 'R'. */
  style?: TransitionStyle;
  /** /D — how long the EFFECT runs, in seconds. Default 1.
   *
   *  Not to be confused with `Page.Duration` (/Dur), which is how long the PAGE
   *  is displayed before advancing. */
  duration?: number;
  /** The axis a Split or Blinds runs along. Default 'H'. */
  dimension?: TransitionDimension;
  /** Inward or outward, for Split, Box and Fly. Default 'I'. */
  motion?: TransitionMotion;
  /** The direction in degrees, for Wipe, Glitter, Fly, Cover, Uncover and Push.
   *  Default 0. */
  direction?: TransitionDirection;
  /** /SS — Fly's starting scale when `motion` is 'I', its ending scale when
   *  'O'. Default 1. */
  scale?: number;
  /** /B — whether Fly's incoming area is rectangular and opaque. Default false. */
  opaque?: boolean;
}

const STYLES: readonly string[] = [
  'Split', 'Blinds', 'Box', 'Wipe', 'Dissolve', 'Glitter', 'R',
  'Fly', 'Push', 'Cover', 'Uncover', 'Fade',
];
const DIMENSIONS: readonly string[] = ['H', 'V'];
const MOTIONS: readonly string[] = ['I', 'O'];
const DEGREES: readonly number[] = [0, 90, 180, 270, 315];

/** [field, /Key, permitted names] for the three name-valued entries. */
const NAMES: ReadonlyArray<readonly [keyof PageTransition, string, readonly string[]]> = [
  ['style', 'S', STYLES],
  ['dimension', 'Dm', DIMENSIONS],
  ['motion', 'M', MOTIONS],
];

/** [field, /Key] for the two number-valued entries. /Di is neither, being a
 *  number OR a name. */
const NUMBERS: ReadonlyArray<readonly [keyof PageTransition, string]> = [
  ['duration', 'D'],
  ['scale', 'SS'],
];

const isFinite_ = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Read /Di, which is a number OR the name /None, or undefined when it is
 *  neither. The duality is the entry's own: only Fly may say 'None'. */
function readDirection(doc: Document, raw: PdfObject | undefined): TransitionDirection | undefined {
  const v = doc.resolve(raw);
  if (isName(v)) return v.name === 'None' ? 'None' : undefined;
  if (typeof v === 'number' && DEGREES.includes(v)) return v as TransitionDirection;
  return undefined;
}

/** Read a page's /Trans, or undefined when it states none.
 *
 *  A present but EMPTY dict reads as `{}` rather than as undefined: its
 *  presence is itself the statement that this page has a transition, and the
 *  spec's defaults then describe it. Read from the page's OWN dict — /Trans is
 *  not an inheritable page attribute, unlike the /Rotate and /Resources beside
 *  it in Table 30. */
export function readTransition(doc: Document, page: PdfDict): PageTransition | undefined {
  const t = doc.resolve(page.get('Trans'));
  if (!isDict(t)) return undefined;
  const out: PageTransition = {};
  const field = out as unknown as Record<string, unknown>;

  for (const [prop, key, allowed] of NAMES) {
    const v = doc.resolve(t.get(key));
    if (isName(v) && allowed.includes(v.name)) field[prop] = v.name;
  }
  for (const [prop, key] of NUMBERS) {
    const v = doc.resolve(t.get(key));
    if (isFinite_(v)) field[prop] = v;
  }
  const di = readDirection(doc, t.get('Di'));
  if (di !== undefined) out.direction = di;
  const b = doc.resolve(t.get('B'));
  if (typeof b === 'boolean') out.opaque = b;
  return out;
}

/** Read a page's /Dur — how long it is displayed before advancing — or
 *  undefined when it states none. Not inheritable, as /Trans is not. */
export function readDuration(doc: Document, page: PdfDict): number | undefined {
  const v = doc.resolve(page.get('Dur'));
  return isFinite_(v) ? v : undefined;
}

/** Validate the whole transition, throwing before anything is written.
 *
 *  TypeError for the wrong KIND of thing, RangeError for a value outside the
 *  allowed SET — `formcreate.ts`'s split. It runs over every field first so a
 *  rejected assignment leaves the page byte-identical.
 *
 *  The two style-dependent rules are decided from the object HANDED IN and
 *  never from the document, which is what whole-value replacement buys: 315 is
 *  Glitter's alone and the name 'None' is Fly's alone, so either on another
 *  style is a value no viewer honours — it renders as a plain transition rather
 *  than as an error. A merely INAPPLICABLE key (a /SS on a Wipe) is written as
 *  given: a viewer ignores it, and refusing it would force a caller to clear
 *  keys on every style change. */
function checkTransition(t: PageTransition): void {
  if (typeof t !== 'object' || t === null || Array.isArray(t))
    throw new TypeError('page transition must be an object');
  const u = t as Record<string, unknown>;

  for (const [field, , allowed] of NAMES) {
    const v = u[field];
    if (v === undefined) continue;
    if (typeof v !== 'string') throw new TypeError(`page transition ${field} must be a string`);
    if (!allowed.includes(v))
      throw new RangeError(`page transition ${field} must be one of ${allowed.join(', ')}, got ${v}`);
  }
  for (const [field] of NUMBERS) {
    const v = u[field];
    if (v === undefined) continue;
    if (!isFinite_(v)) throw new TypeError(`page transition ${field} must be a finite number`);
    if (v < 0) throw new RangeError(`page transition ${field} must be >= 0, got ${v}`);
  }
  if (u.opaque !== undefined && typeof u.opaque !== 'boolean')
    throw new TypeError('page transition opaque must be a boolean');

  const di = u.direction;
  if (di !== undefined) {
    if (typeof di === 'number') {
      if (!DEGREES.includes(di))
        throw new RangeError(`page transition direction must be one of ${DEGREES.join(', ')} or None, got ${di}`);
      if (di === 315 && u.style !== 'Glitter')
        throw new RangeError('page transition direction 315 is Glitter\'s alone');
    } else if (typeof di === 'string') {
      if (di !== 'None')
        throw new RangeError(`page transition direction must be one of ${DEGREES.join(', ')} or None, got ${di}`);
      if (u.style !== 'Fly')
        throw new RangeError('page transition direction None is Fly\'s alone');
    } else {
      throw new TypeError('page transition direction must be a number or the string None');
    }
  }
}

/** Replace a page's /Trans WHOLLY; `null` or `undefined` deletes it.
 *
 *  Whole-value rather than `setViewerPreferences`' merge, and the divergence is
 *  deliberate: /ViewerPreferences is a large shared dictionary where an entry
 *  we do not model must survive a read-modify-write, while /Trans is a UNIT — a
 *  style plus that style's parameters. Merging would leave a stale /SS, or a
 *  Glitter-only 315, beside a newly-set style.
 *
 *  Only the stated keys are written, so `{ style: 'Wipe' }` emits
 *  `<< /Type /Trans /S /Wipe >>` and lets the spec's defaults stand. An EMPTY
 *  object still writes the dictionary, because its presence is itself the
 *  statement that this page has a transition. */
export function setTransition(
  doc: Document, page: PdfDict, t: PageTransition | null | undefined,
): void {
  if (t === null || t === undefined) {
    if (page.delete('Trans')) doc.markModified();
    return;
  }
  checkTransition(t);
  const u = t as Record<string, unknown>;

  const d = new Map<string, PdfObject>([['Type', name('Trans')]]);
  for (const [field, key] of NAMES) {
    const v = u[field];
    if (v !== undefined) d.set(key, name(v as string));
  }
  for (const [field, key] of NUMBERS) {
    const v = u[field];
    if (v !== undefined) d.set(key, v as number);
  }
  if (t.direction !== undefined)
    d.set('Di', typeof t.direction === 'number' ? t.direction : name(t.direction));
  if (t.opaque !== undefined) d.set('B', t.opaque);

  page.set('Trans', d);
  doc.markModified();
}

/** Write a page's /Dur; `null` or `undefined` deletes it.
 *
 *  This is how long the PAGE is displayed before advancing — not
 *  {@link PageTransition.duration} (/D), which is how long the transition
 *  EFFECT runs. The two are easy to confuse and a viewer honours both. */
export function setDuration(
  doc: Document, page: PdfDict, seconds: number | null | undefined,
): void {
  if (seconds === null || seconds === undefined) {
    if (page.delete('Dur')) doc.markModified();
    return;
  }
  if (!isFinite_(seconds)) throw new TypeError('page duration must be a finite number');
  if (seconds < 0) throw new RangeError(`page duration must be >= 0, got ${seconds}`);
  page.set('Dur', seconds);
  doc.markModified();
}
