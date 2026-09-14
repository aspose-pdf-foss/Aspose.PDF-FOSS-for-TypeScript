/** What an optional-content group's `/Usage` dictionary says, and what a
 *  configuration's `/AS` usage application dictionaries make of it
 *  (PDF 32000-1 8.11.4.4).
 *
 *  A pure LEAF over `types.js` and `langmatch.js` — no `Document`, no PDF
 *  object allocation, no `node:` import — so every rule here is drivable from
 *  hand-built dicts with no file built, the split `floatstack.ts`,
 *  `tablespan.ts`, `linebox.ts` and `meshtri.ts` each already make. It never
 *  throws.
 *
 *  **Invariant: `/Usage` ALONE IS INERT.** It is a statement about a group,
 *  and only an `/AS` entry naming that group turns a statement into a state.
 *  So `readUsage` answers what the group SAYS and `applyUsageEntry` answers
 *  what one `/AS` entry MAKES of it; nothing here reads a configuration's
 *  `/ON`/`/OFF`, which is `ocg.ts`'s to combine the answer with.
 *
 *  **Invariant: a category that cannot speak returns `undefined`, never a
 *  state.** `/Zoom` and `/Language` describe a VIEWER, so with no
 *  magnification and no language tag supplied they decline rather than being
 *  decided against an invented one; `/User` declines ALWAYS, since this
 *  library has no viewer identity to match a person or organisation against;
 *  and `/PageElement` declines because it carries no state at all — it says
 *  what the content IS (a header, a logo), not whether to show it. A
 *  defaulted state is the failure that renders plausibly: a watermark
 *  silently dropped, or a whole CAD drawing switched off, with nothing
 *  anywhere saying why.
 *
 *  **Invariant: several categories combine so that any one saying OFF wins**
 *  (`combineUsageStates`, the one owner of that rule, asked once per `/AS`
 *  entry here and once across entries by `ocg.ts`). With no category speaking
 *  the answer is `undefined` and the group's CONFIGURED state stands — which
 *  is what makes "a group with `/Usage` and no `/AS` entry resolves
 *  unchanged" true by construction rather than by a check. */

import {
  PdfObject, PdfDict, isDict, isArray, isName, isString, name,
} from './types.js';
import { decodePdfText, encodePdfText } from './metadata.js';
import { langMatches } from './langmatch.js';

type Resolve = (o: PdfObject | undefined) => PdfObject;

/** The event an `/AS` usage application dictionary fires on. */
export type UsageEvent = 'View' | 'Print' | 'Export';

/** A group's `/Usage` dictionary, as a typed view.
 *
 *  A field is ABSENT when the dictionary states nothing, never defaulted —
 *  the present-versus-absent rule `parseSimpleWidths` records for
 *  `/MissingWidth`, and here it is the difference between a group that
 *  declines to be printed and one that says nothing about printing. */
export interface LayerUsage {
  /** `/View /ViewState` — show the content on screen. */
  view?: boolean;
  /** `/Print /PrintState` — include the content when printing. */
  print?: boolean;
  /** `/Print /Subtype` — what kind of print content this is
   *  (`Trapping`, `PrintersMarks`, `Watermark`). Carries no state. */
  printSubtype?: string;
  /** `/Export /ExportState` — include the content when exporting. */
  export?: boolean;
  /** `/Zoom` — the magnification range the content is meant for, as the
   *  half-open interval `min <= zoom < max`. An absent `max` is unbounded. */
  zoom?: { min: number; max?: number };
  /** `/Language` — the language the content is in, and whether it is the
   *  fallback when nothing matches the viewer's language exactly. */
  language?: { lang: string; preferred?: boolean };
  /** `/PageElement /Subtype` — `HF` (header/footer), `FG`, `BG` or `L`
   *  (logo). Purely descriptive: it carries no state. */
  pageElement?: string;
  /** `/CreatorInfo` — the application that made the content. Descriptive. */
  creatorInfo?: { creator: string; subtype: string };
  /** `/User` — the person, title or organisation the content is for.
   *  Read and written, NEVER evaluated: there is no viewer identity here. */
  user?: { type: string; name: string[] };
}

/** What a caller knows about the viewer, for the two categories that describe
 *  one. Each field left out makes its category decline rather than guess. */
export interface UsageContext {
  /** The current magnification, 1 being 100%. Absent: `/Zoom` declines. */
  zoom?: number;
  /** The viewer's BCP 47 language tag. Absent: `/Language` declines. */
  language?: string;
}

/** The `/Usage` categories that can yield a state, and the `/AS` `/Event`
 *  each one hangs off. `/User` and `/PageElement` are deliberately absent —
 *  see the module invariant. */
const CATEGORY_EVENT: ReadonlyMap<string, UsageEvent> = new Map([
  ['View', 'View'],
  ['Zoom', 'View'],
  ['Language', 'View'],
  ['Print', 'Print'],
  ['Export', 'Export'],
] as [string, UsageEvent][]);

/** The `/AS` `/Event` a category is applied on, or undefined for one this
 *  library never turns into a state. */
export function usageCategoryEvent(category: string): UsageEvent | undefined {
  return CATEGORY_EVENT.get(category);
}

/** Read an ON/OFF name as a boolean; anything else states nothing. */
function stateOf(resolve: Resolve, o: PdfObject | undefined): boolean | undefined {
  const n = resolve(o);
  if (!isName(n)) return undefined;
  if (n.name === 'ON') return true;
  if (n.name === 'OFF') return false;
  return undefined;
}

function nameOf(resolve: Resolve, o: PdfObject | undefined): string | undefined {
  const n = resolve(o);
  return isName(n) ? n.name : undefined;
}

function numberOf(resolve: Resolve, o: PdfObject | undefined): number | undefined {
  const v = resolve(o);
  // A /Zoom bound must be a real number: a NaN or an Infinity would make the
  // half-open interval below answer false for every magnification.
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function textOf(resolve: Resolve, o: PdfObject | undefined): string | undefined {
  const s = resolve(o);
  return isString(s) ? decodePdfText(s.bytes) : undefined;
}

/** Every text string in `o`, which may be one string or an array of them. */
function textsOf(resolve: Resolve, o: PdfObject | undefined): string[] {
  const v = resolve(o);
  if (isArray(v)) return v.map((e) => textOf(resolve, e)).filter((s): s is string => s !== undefined);
  const one = textOf(resolve, o);
  return one === undefined ? [] : [one];
}

function sub(resolve: Resolve, d: PdfDict, key: string): PdfDict | undefined {
  const v = resolve(d.get(key));
  return isDict(v) ? v : undefined;
}

function pdfText(v: string): PdfObject {
  return { kind: 'string', bytes: encodePdfText(v) };
}

/** The typed view of a `/Usage` dictionary. */
export function readUsage(resolve: Resolve, usage: PdfDict): LayerUsage {
  const out: LayerUsage = {};

  const view = sub(resolve, usage, 'View');
  if (view) {
    const s = stateOf(resolve, view.get('ViewState'));
    if (s !== undefined) out.view = s;
  }

  const print = sub(resolve, usage, 'Print');
  if (print) {
    const s = stateOf(resolve, print.get('PrintState'));
    if (s !== undefined) out.print = s;
    const st = nameOf(resolve, print.get('Subtype'));
    if (st !== undefined) out.printSubtype = st;
  }

  const exp = sub(resolve, usage, 'Export');
  if (exp) {
    const s = stateOf(resolve, exp.get('ExportState'));
    if (s !== undefined) out.export = s;
  }

  const zoom = sub(resolve, usage, 'Zoom');
  if (zoom) {
    // 8.11.4.4: /min defaults to 0 and /max to infinity, so a /Zoom dict
    // stating only one end still describes a real interval.
    out.zoom = { min: numberOf(resolve, zoom.get('min')) ?? 0, max: numberOf(resolve, zoom.get('max')) };
  }

  const lang = sub(resolve, usage, 'Language');
  if (lang) {
    const tag = textOf(resolve, lang.get('Lang'));
    if (tag !== undefined) {
      const preferred = stateOf(resolve, lang.get('Preferred'));
      out.language = preferred === undefined ? { lang: tag } : { lang: tag, preferred };
    }
  }

  const pe = sub(resolve, usage, 'PageElement');
  if (pe) {
    const st = nameOf(resolve, pe.get('Subtype'));
    if (st !== undefined) out.pageElement = st;
  }

  const ci = sub(resolve, usage, 'CreatorInfo');
  if (ci) {
    const creator = textOf(resolve, ci.get('Creator'));
    const subtype = nameOf(resolve, ci.get('Subtype'));
    if (creator !== undefined && subtype !== undefined) out.creatorInfo = { creator, subtype };
  }

  const user = sub(resolve, usage, 'User');
  if (user) {
    const type = nameOf(resolve, user.get('Type'));
    const names = textsOf(resolve, user.get('Name'));
    if (type !== undefined && names.length > 0) out.user = { type, name: names };
  }

  return out;
}

/** A `/Usage` dictionary holding exactly the categories `usage` states. */
export function writeUsage(usage: LayerUsage): PdfDict {
  const out: PdfDict = new Map<string, PdfObject>();

  if (usage.view !== undefined) {
    out.set('View', new Map<string, PdfObject>([['ViewState', name(usage.view ? 'ON' : 'OFF')]]));
  }
  if (usage.print !== undefined || usage.printSubtype !== undefined) {
    const d = new Map<string, PdfObject>();
    if (usage.print !== undefined) d.set('PrintState', name(usage.print ? 'ON' : 'OFF'));
    if (usage.printSubtype !== undefined) d.set('Subtype', name(usage.printSubtype));
    out.set('Print', d);
  }
  if (usage.export !== undefined) {
    out.set('Export', new Map<string, PdfObject>([['ExportState', name(usage.export ? 'ON' : 'OFF')]]));
  }
  if (usage.zoom) {
    const d = new Map<string, PdfObject>([['min', usage.zoom.min]]);
    if (usage.zoom.max !== undefined) d.set('max', usage.zoom.max);
    out.set('Zoom', d);
  }
  if (usage.language) {
    const d = new Map<string, PdfObject>([['Lang', pdfText(usage.language.lang)]]);
    if (usage.language.preferred !== undefined) {
      d.set('Preferred', name(usage.language.preferred ? 'ON' : 'OFF'));
    }
    out.set('Language', d);
  }
  if (usage.pageElement !== undefined) {
    out.set('PageElement', new Map<string, PdfObject>([['Subtype', name(usage.pageElement)]]));
  }
  if (usage.creatorInfo) {
    out.set('CreatorInfo', new Map<string, PdfObject>([
      ['Creator', pdfText(usage.creatorInfo.creator)],
      ['Subtype', name(usage.creatorInfo.subtype)],
    ]));
  }
  if (usage.user) {
    out.set('User', new Map<string, PdfObject>([
      ['Type', name(usage.user.type)],
      ['Name', usage.user.name.length === 1
        ? pdfText(usage.user.name[0])
        : usage.user.name.map(pdfText)],
    ]));
  }

  return out;
}

/** Combine the states several categories yield for ONE group: any category
 *  saying OFF wins, otherwise ON when at least one says so, and `undefined`
 *  when none of them speaks — in which case the group's CONFIGURED state
 *  stands. The ONE owner of that rule: `applyUsageEntry` asks it per `/AS`
 *  entry and `ocg.ts` asks it again across entries, so two entries cannot
 *  combine by a different rule from two categories. */
export function combineUsageStates(states: (boolean | undefined)[]): boolean | undefined {
  let spoke = false;
  for (const s of states) {
    if (s === undefined) continue;
    if (s === false) return false;
    spoke = true;
  }
  return spoke ? true : undefined;
}

/** Is `usage`'s `/Language` the one the viewer asked for?
 *
 *  A whole-subtag match (RFC 4647, so `de` covers `de-AT` and not `den`) is
 *  ON. Anything else is OFF — UNLESS the group is `/Preferred` and nothing in
 *  the same `/AS` entry stated this language EXACTLY, which is the fallback
 *  that entry is for. Note `exactInEntry` is decided over the whole entry
 *  rather than per group: read per group, a preferred German group stays on
 *  beside the English one that matched, and the page comes out in two
 *  languages at once. */
function languageState(
  usage: LayerUsage,
  tag: string,
  exactInEntry: boolean,
): boolean | undefined {
  const l = usage.language;
  if (!l) return undefined;
  if (langMatches(tag, l.lang)) return true;
  return l.preferred === true && !exactInEntry;
}

/** The state ONE category makes of ONE group's `/Usage`, or `undefined` when
 *  it does not speak (see the module invariant). */
function categoryState(
  usage: LayerUsage,
  category: string,
  ctx: UsageContext,
  exactLanguageInEntry: boolean,
): boolean | undefined {
  switch (category) {
    case 'View':   return usage.view;
    case 'Print':  return usage.print;
    case 'Export': return usage.export;
    case 'Zoom': {
      if (ctx.zoom === undefined || !usage.zoom) return undefined;
      // 8.11.4.4: the interval is HALF-OPEN, so a group whose /max is the
      // next one's /min does not overlap it. Closed at both ends, two
      // adjacent zoom bands both draw at the boundary magnification.
      const { min, max } = usage.zoom;
      return ctx.zoom >= min && (max === undefined || ctx.zoom < max);
    }
    case 'Language':
      return ctx.language === undefined
        ? undefined
        : languageState(usage, ctx.language, exactLanguageInEntry);
    // /User and /PageElement reach here and decline, as does any category
    // 8.11.4.4 does not define.
    default: return undefined;
  }
}

/** What ONE `/AS` usage application dictionary makes of the groups it names:
 *  one state per group, in the order given, `undefined` where nothing the
 *  entry's `/Category` list names has anything to say about that group.
 *
 *  `usages` is one entry per group in the `/AS` entry's `/OCGs` — `undefined`
 *  for a group carrying no `/Usage` — because `/Preferred` is scoped to the
 *  entry and so cannot be decided one group at a time. */
export function applyUsageEntry(
  usages: (LayerUsage | undefined)[],
  categories: string[],
  ctx: UsageContext,
): (boolean | undefined)[] {
  const exactLanguage = ctx.language !== undefined
    && usages.some((u) => u?.language !== undefined
      && u.language.lang.toLowerCase() === ctx.language!.toLowerCase());

  return usages.map((u) => (u === undefined
    ? undefined
    : combineUsageStates(categories.map((c) => categoryState(u, c, ctx, exactLanguage)))));
}
