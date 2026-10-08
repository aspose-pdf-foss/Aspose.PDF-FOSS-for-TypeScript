/** Footnotes and endnotes for Flow (v9j3.3).
 *
 *  Everything note-specific lives here: lowering a run that carries a note
 *  into its body and a MARK RUN, finding which references a placement kept,
 *  numbering, the `NoteElement` decorator a note's body lowers to, the
 *  per-column `NoteColumn`, and the pure loop that settles an element's
 *  budget so the content and its notes share a column.
 *
 *  **Invariant:** the mark run carries its `NoteRef` under a module-private
 *  SYMBOL key. `stamp.ts`'s `sliceContent` builds a remainder's runs as
 *  `{ ...source, text }`, and object spread copies own symbol properties, so
 *  a continuation carries its references with no change to `stamp.ts` — and
 *  a symbol key cannot trip `resolveRuns`' guard against a `footnote` key.
 *
 *  **Invariant:** lowering does NOT number. The builders (`paragraph`,
 *  `heading`, `list`) are free functions with no flow to number against;
 *  `Flow.Render` numbers every reference in one pass before anything is
 *  measured, so a mark's width never changes after a line was measured.
 *
 *  **Invariant (`v9j3.3.2`):** under `footnotes.restart: 'page'` a footnote's
 *  number depends on the page its line lands on, so it is (re)numbered each
 *  time its element is OFFERED to a column, before any probe, from that
 *  page's count of footnotes already placed. A mark therefore never changes
 *  after its line is PLACED — every measurement happens in the column the
 *  line is then placed in. Committed references are final.
 *
 *  **Invariant:** a `FlowNote` cited several times is numbered and placed by
 *  its FIRST citation in queue order; every later citation is a REPEAT — the
 *  same mark, an empty body, `repeatOf` set — so it reserves no foot room,
 *  commits nothing and is never tagged (GitHub's footnote model, `v9j3.3.1`).
 *  Numbering is per Render: building the same runs again for another document
 *  is ordinary, and every lowering makes a fresh `NoteRef` anyway.
 *
 *  It must NOT value-import `flow.ts`, which value-imports it. @internal */
import {
  insetScale,
  type Compromise, type FlowElement, type MeasureContext, type PlaceContext, type PlaceResult,
} from './flowelement.js';
import { stampText, measureText } from './stamp.js';
import { placeElements, measureElements } from './flowplace.js';
import { fillRect, paintDecoration, rule } from './flowblock.js';
import type { Document } from './document.js';
import type { Page } from './page.js';
import type { PdfDict, PdfObject, PdfRef } from './types.js';
import { collectNameTree } from './nametree.js';
import { vmetricsFor, type TextRun } from './textdecor.js';
import type { StructElement } from './struct.js';
import { addLink } from './annotation.js';
import type { DeferredLink, LinkedRun } from './runlink.js';

/** The key a mark run carries its reference under. @internal */
export const NOTE: unique symbol = Symbol('flowNote');

export type NoteKind = 'footnote' | 'endnote';
/** Flowed text, structurally `FlowText` (which lives in flow.ts). */
export type NoteText = string | TextRun[];

/** A footnote or endnote attached to a {@link FlowTextRun}. */
export interface FlowNote {
  /** The note body: text or runs (one paragraph), or any FlowElements built
   *  with the flow builders (`paragraph`, `list`, `image`, …). */
  content: NoteText | FlowElement[];
  /** Explicit mark text, e.g. `'*'` or `'†'`. A stated mark consumes no
   *  number. Default: the next number in the note's sequence. */
  mark?: string;
}

/** A run of flowed text that may cite a note. The mark is drawn right after
 *  the run's text, raised, at a fraction of its size. At most one of
 *  `footnote` and `endnote`. Accepted only by Flow builders: any other text
 *  API refuses such a run rather than drawing it without its note. */
export interface FlowTextRun extends TextRun {
  footnote?: FlowNote;
  endnote?: FlowNote;
}

/** A mark run: the run lowering inserts after a noted run. A `LinkedRun`, so
 *  its link may be the `DeferredLink` numbering writes (mba3). @internal */
export type MarkRun = LinkedRun & { [NOTE]: NoteRef };

/** One reference, from lowering to tagging. @internal */
export interface NoteRef {
  readonly kind: NoteKind;
  readonly note: FlowNote;
  /** The run object in the lowered list; numbering writes its text/size/rise. */
  readonly markRun: MarkRun;
  /** The referencing run's font size (its own, else the block's). */
  readonly baseSize: number;
  /** '' until numbered. */
  mark: string;
  /** [] until numbered. */
  body: FlowElement[];
  /** The /Note's /ID, set at tagging commit. */
  id?: string;
  /** The structure element holding the reference, set when it is placed. */
  owner?: StructElement;
  /** The /Note, set at tagging commit. */
  noteTag?: StructElement;
  /** The first citation of the same note, for a repeated citation. */
  repeatOf?: NoteRef;
  /** Tag this note when its body first places, for a placement with no
   *  commit step (`notesAsTrailing`): by then the citing element has placed,
   *  so `owner` is set and the /Note lands beside the citation. */
  tagAtPlace?: () => void;
}

/** Mark rise as a fraction of the referencing run's size. @internal */
export const MARK_RISE = 0.33;
/** Points between a note's mark and its body. @internal */
export const GUTTER_GAP = 3;

/** Whether `c` is a non-empty list of flow elements. @internal */
export function isElementList(c: unknown): c is FlowElement[] {
  return Array.isArray(c) && c.length > 0
    && c.every((e) => typeof e === 'object' && e !== null && typeof (e as FlowElement).place === 'function');
}

function hasNote(r: TextRun): boolean {
  return (r as FlowTextRun).footnote !== undefined || (r as FlowTextRun).endnote !== undefined;
}

function isRunList(c: unknown): c is TextRun[] {
  return Array.isArray(c)
    && c.every((r) => typeof r === 'object' && r !== null && typeof (r as TextRun).text === 'string');
}

function checkNote(n: unknown, i: number): asserts n is FlowNote {
  if (typeof n !== 'object' || n === null) throw new TypeError(`run ${i}: a note must be an object`);
  const note = n as FlowNote;
  if (note.mark !== undefined && (typeof note.mark !== 'string' || note.mark === ''))
    throw new TypeError(`run ${i}: note mark must be a non-empty string`);
  const c = note.content;
  if (typeof c === 'string') {
    // text body
  } else if (isElementList(c)) {
    if (c.some((e) => (e.noteRefs?.().length ?? 0) > 0))
      throw new TypeError(`run ${i}: notes do not nest — a note body may not reference a note`);
  } else if (isRunList(c)) {
    if (c.some(hasNote))
      throw new TypeError(`run ${i}: notes do not nest — a note body may not reference a note`);
  } else {
    throw new TypeError(`run ${i}: note content must be text, a run list, or FlowElements`);
  }
}

/** Split every noted run into its body and a mark run carrying a NoteRef.
 *  Returns `text` itself when it carries no note, which is what keeps every
 *  note-free caller byte-identical. Validates every run before lowering any,
 *  so a rejected call consumes no FlowNote. @internal */
export function lowerNotes(text: string | FlowTextRun[], blockSize: number): NoteText {
  if (typeof text === 'string' || !text.some(hasNote)) return text;
  text.forEach((r, i) => {
    const fr = r as FlowTextRun;
    if (fr.footnote !== undefined && fr.endnote !== undefined)
      throw new TypeError(`run ${i}: a run may carry a footnote or an endnote, not both`);
    const n = fr.footnote ?? fr.endnote;
    if (n !== undefined) checkNote(n, i);
  });
  const out: TextRun[] = [];
  for (const r of text) {
    const { footnote, endnote, ...body } = r as FlowTextRun;
    out.push(body);
    const note = footnote ?? endnote;
    if (note === undefined) continue;
    const markRun = { text: '' } as MarkRun;
    if (body.font !== undefined) markRun.font = body.font;
    if (body.color !== undefined) markRun.color = body.color;
    if (body.link !== undefined) markRun.link = body.link;
    const ref: NoteRef = {
      kind: footnote !== undefined ? 'footnote' : 'endnote',
      note, markRun, baseSize: body.fontSize ?? blockSize, mark: '', body: [],
    };
    markRun[NOTE] = ref;
    // The ONE place a LinkedRun enters a TextRun list: its link is still the
    // cited run's string here, and every reader of a run's link reads it as a
    // LinkedRun (runlink.ts), so the DeferredLink numbering writes later is
    // seen for what it is.
    out.push(markRun as TextRun);
  }
  return out;
}

/** Whether any run of `text` cites a note. @internal */
export function citesNote(text: string | TextRun[]): boolean {
  return typeof text !== 'string' && text.some(hasNote);
}

/** Atomics whose `beforeRun` indexes `text` rebased onto `lowerNotes(text)`'s
 *  output (v9j3.3.3): lowering inserts a mark run after every cited run, so an
 *  atomic before run i moves past the marks of the cited runs before i — and
 *  so draws after the mark of run i - 1, where it belongs. Returns `atomics`
 *  itself when nothing is cited; an out-of-range index passes through for
 *  `resolveAtomics` to refuse. @internal */
export function rebaseForMarks<T extends { beforeRun: number }>(
  text: string | TextRun[], atomics: T[] | undefined,
): T[] | undefined {
  if (atomics === undefined || !citesNote(text)) return atomics;
  const runs = text as TextRun[];
  const shift: number[] = [0];
  for (let i = 0; i < runs.length; i++) shift.push(shift[i] + (hasNote(runs[i]) ? 1 : 0));
  return atomics.map((a) => Number.isInteger(a.beforeRun) && a.beforeRun >= 0 && a.beforeRun <= runs.length
    ? { ...a, beforeRun: a.beforeRun + shift[a.beforeRun] } : a);
}

/** The references in `text`, in order. @internal */
export function refsIn(text: NoteText | null): NoteRef[] {
  if (text === null || typeof text === 'string') return [];
  const out: NoteRef[] = [];
  for (const r of text) {
    const ref = (r as Partial<MarkRun>)[NOTE];
    if (ref !== undefined) out.push(ref);
  }
  return out;
}

/** The references a placement KEPT: those in `text` but not in what it left
 *  over, by identity. @internal */
export function keptRefs(text: NoteText, remainder: NoteText | null): NoteRef[] {
  const later = new Set(refsIn(remainder));
  return refsIn(text).filter((r) => !later.has(r));
}

/** How a note's number is spelled. */
export type MarkFormat = 'arabic' | 'roman' | 'Roman' | 'alpha' | 'Alpha' | 'symbols';
const FORMATS: readonly MarkFormat[] = ['arabic', 'roman', 'Roman', 'alpha', 'Alpha', 'symbols'];
const ROMAN: ReadonlyArray<[number, string]> = [
  [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
  [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
];
// Every one encodes in WinAnsi, so a Standard-14 face draws it: Word's `‖`
// (U+2016) does not, and drew nothing as note 5.
const SYMBOLS = ['*', '†', '‡', '§', '¶', '#'];

/** Spell note number `n` (>= 1). Alpha and symbols repeat past the end of
 *  their set (`aa`, `**`) — Word's convention, not spreadsheet columns. @internal */
export function formatMark(n: number, format: MarkFormat): string {
  switch (format) {
    case 'arabic': return String(n);
    case 'roman': case 'Roman': {
      let s = '';
      let v = n;
      for (const [k, sym] of ROMAN) while (v >= k) { s += sym; v -= k; }
      return format === 'roman' ? s.toLowerCase() : s;
    }
    case 'alpha': case 'Alpha': {
      const ch = String.fromCharCode((format === 'alpha' ? 97 : 65) + ((n - 1) % 26));
      return ch.repeat(Math.floor((n - 1) / 26) + 1);
    }
    case 'symbols':
      return SYMBOLS[(n - 1) % SYMBOLS.length].repeat(Math.floor((n - 1) / SYMBOLS.length) + 1);
  }
}

/** Options for {@link FlowOptions.footnotes} (and the base of the endnote
 *  options). All lengths are in points. */
export interface FlowNoteOptions {
  /** How marks are numbered. Default `'arabic'` for footnotes, `'roman'`
   *  for endnotes. */
  format?: MarkFormat;
  /** First number. Positive integer. Default 1. */
  start?: number;
  /** Mark size as a fraction of the referencing run's size, in (0, 1].
   *  Default 0.6. */
  markScale?: number;
  /** Note body font size. Default 8 for footnotes, 10 for endnotes. */
  fontSize?: number;
  /** The rule above the notes, or `false` for none. Default: a rule a third
   *  of the column wide, 0.5pt, black. */
  separator?: { width?: number; thickness?: number; color?: [number, number, number] } | false;
  /** Gap above the separator and between notes. >= 0. Default 4. */
  spacing?: number;
  /** When footnote numbers restart (v9j3.3.2): `'continuous'` (default) or
   *  `'page'`, from `start` on every page — Word's "restart each page".
   *  Footnotes only; endnotes refuse `'page'`. */
  restart?: 'continuous' | 'page';
  /** Link each citation mark to its note and the note's mark back to the
   *  first citation, as GoTo annotations (v9j3.3.4). Default true. */
  links?: boolean;
}

/** Options for {@link FlowOptions.endnotes}. */
export interface FlowEndnoteOptions extends FlowNoteOptions {
  /** Start the endnotes on a fresh page rather than after the content.
   *  Default false. */
  newPage?: boolean;
}

/** Note options with every default applied. @internal */
export interface ResolvedNoteOptions {
  format: MarkFormat;
  start: number;
  markScale: number;
  fontSize: number;
  separator: { width?: number; thickness: number; color: [number, number, number] } | undefined;
  spacing: number;
  newPage: boolean;
  restart: 'continuous' | 'page';
  links: boolean;
}

function checkColor(label: string, c: unknown): [number, number, number] {
  if (!Array.isArray(c) || c.length !== 3
      || !c.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1))
    throw new TypeError(`${label} must be [r, g, b] with each component in 0..1`);
  return c as [number, number, number];
}

function positiveNum(v: unknown, dflt: number, label: string): number {
  const n = v ?? dflt;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0)
    throw new TypeError(`${label} must be a positive finite number`);
  return n;
}

/** Validate and default note options for `kind`. @internal */
export function normalizeNoteOptions(o: FlowEndnoteOptions | undefined, kind: NoteKind): ResolvedNoteOptions {
  const p = kind === 'footnote' ? 'footnotes' : 'endnotes';
  if (o !== undefined && (typeof o !== 'object' || o === null)) throw new TypeError(`${p} must be an object`);
  const v = o ?? {};
  const format = v.format ?? (kind === 'footnote' ? 'arabic' : 'roman');
  if (!FORMATS.includes(format)) throw new TypeError(`${p}.format must be one of ${FORMATS.join(', ')}`);
  const start = v.start ?? 1;
  if (!Number.isInteger(start) || start < 1) throw new TypeError(`${p}.start must be a positive integer`);
  const markScale = positiveNum(v.markScale, 0.6, `${p}.markScale`);
  if (markScale > 1) throw new TypeError(`${p}.markScale must be in (0, 1]`);
  const fontSize = positiveNum(v.fontSize, kind === 'footnote' ? 8 : 10, `${p}.fontSize`);
  const spacing = v.spacing ?? 4;
  if (typeof spacing !== 'number' || !Number.isFinite(spacing) || spacing < 0)
    throw new TypeError(`${p}.spacing must be a non-negative finite number`);
  let separator: ResolvedNoteOptions['separator'];
  if (v.separator !== false) {
    const s = v.separator ?? {};
    if (typeof s !== 'object' || s === null) throw new TypeError(`${p}.separator must be an object or false`);
    separator = {
      width: s.width === undefined ? undefined : positiveNum(s.width, 0, `${p}.separator.width`),
      thickness: positiveNum(s.thickness, 0.5, `${p}.separator.thickness`),
      color: s.color === undefined ? [0, 0, 0] : checkColor(`${p}.separator.color`, s.color),
    };
  }
  const restart = v.restart ?? 'continuous';
  if (restart !== 'continuous' && restart !== 'page')
    throw new TypeError(`${p}.restart must be 'continuous' or 'page'`);
  if (restart === 'page' && kind === 'endnote')
    throw new TypeError("endnotes.restart cannot be 'page': endnotes do not sit on the page that cites them");
  const newPage = v.newPage ?? false;
  if (typeof newPage !== 'boolean') throw new TypeError(`${p}.newPage must be a boolean`);
  const links = v.links ?? true;
  if (typeof links !== 'boolean') throw new TypeError(`${p}.links must be a boolean`);
  return { format, start, markScale, fontSize, separator, spacing, newPage, restart, links };
}

/** Builds a text note body at a font size. Injected by `flow.ts`, which owns
 *  `paragraph()` — importing it here would close a cycle. @internal */
export type BodyMaker = (text: NoteText, fontSize: number) => FlowElement[];

/** Shared by every NoteElement one note lowers to — the list-item marker
 *  pattern: whichever decorator draws FIRST paints the mark, so a note whose
 *  body opens with an image still gets exactly one mark. @internal */
interface NoteHolder {
  ref: NoteRef;
  gutter: number;
  markSize: number;
  fontSize: number;
  drawn: boolean;
  /** Where the gutter mark reports itself, when the kind links (v9j3.3.4). */
  links?: NoteLinks;
}

type NoteRect = [number, number, number, number];
interface LinkFrom { page: Page; rect: NoteRect; elem?: StructElement }

/** A tagged /Link that will get no annotation becomes a /Span, keeping its
 *  content where it is. Several boxes may share one element; retyping twice is
 *  harmless. */
function unlink(elem: StructElement | undefined): void {
  if (elem !== undefined && elem.Type === 'Link') elem.SetType('Span');
}

/** The GoTo links between citation marks and notes (v9j3.3.4), one per
 *  placement (`Flow.Render`, or one rect). A mark run carries `linkFor(ref)`;
 *  its laid-out boxes arrive through the deferred link, the note's gutter mark
 *  through `noteDrawn`, and `finish()` writes every annotation once all is
 *  placed — so no annotation ever names a target that does not exist yet.
 *  A citation whose note never placed gets no link. @internal */
export class NoteLinks {
  private readonly cites = new Map<NoteRef, LinkFrom[]>();
  private readonly notes = new Map<NoteRef, LinkFrom & { x: number; top: number }>();

  private finished = false;

  constructor(private readonly doc: Document) {}

  /** The deferred link a mark run carries: its boxes are recorded against `ref`. */
  linkFor(ref: NoteRef): DeferredLink {
    return {
      deferred: true,
      onBox: (page, rect, elem) => {
        // Placed after finish() — a one-rect remainder continued later: no link
        // can be written for it, so its /Link must not stay hollow.
        if (this.finished) { unlink(elem); return; }
        const list = this.cites.get(ref) ?? [];
        list.push({ page, rect, ...(elem !== undefined ? { elem } : {}) });
        this.cites.set(ref, list);
      },
    };
  }

  /** A note's gutter mark was drawn: its own box, and the note's anchor. */
  noteDrawn(ref: NoteRef, box: LinkFrom & { x: number; top: number }): void {
    if (this.finished) { unlink(box.elem); return; }
    if (!this.notes.has(ref)) this.notes.set(ref, box);
  }

  /** Write every annotation. Citation → the note's first line; the note's
   *  mark → its FIRST citation (a repeat resolves to its first). A box whose
   *  other end never placed gets no annotation, and its tagged /Link becomes a
   *  /Span: a /Link with no annotation is announced as a link that goes
   *  nowhere (final review). */
  finish(): void {
    this.finished = true;
    for (const [ref, boxes] of this.cites) {
      const n = this.notes.get(ref.repeatOf ?? ref);
      // A tagged /SD names the /Note itself (mba3), not the target page's
      // first structure element.
      const note = (ref.repeatOf ?? ref).noteTag;
      for (const b of boxes) {
        if (n === undefined) unlink(b.elem);
        else this.link(b, n.page, n.x, n.top, note);
      }
    }
    for (const [ref, n] of this.notes) {
      const first = this.cites.get(ref)?.[0];
      if (first === undefined) unlink(n.elem);
      // …and the back link names the element holding the first citation.
      else this.link(n, first.page, first.rect[0], first.rect[3], ref.owner);
    }
  }

  private link(from: LinkFrom, to: Page, left: number, top: number, target: StructElement | undefined): void {
    const annot = addLink(this.doc, from.page, {
      rect: from.rect,
      action: { type: 'goto', page: to.Number, view: { type: 'XYZ', left, top, zoom: null } },
      border: 0,
    }, target);
    // Glyphs first, then the annotation: the order runlink.ts keeps.
    from.elem?.AddAnnotation(annot);
  }
}

/** Numbers references, in the order they are handed in, from one counter per
 *  kind. `Flow.Render` hands them in queue order — which is Add order — before
 *  anything is measured. @internal */
export class NoteNumberer {
  private readonly next: Record<NoteKind, number>;
  private assigned = false;
  private readonly firsts = new Map<FlowNote, NoteRef>();
  private readonly holders = new Map<NoteRef, NoteHolder>();

  constructor(
    private readonly foot: ResolvedNoteOptions,
    private readonly end: ResolvedNoteOptions,
    private readonly makeBody: BodyMaker,
    /** The placement's link collector (v9j3.3.4); none, no links. */
    private readonly links?: NoteLinks,
  ) { this.next = { footnote: foot.start, endnote: end.start }; }

  /** Whether any reference has been numbered. */
  get any(): boolean { return this.assigned; }

  /** Reset the named kinds' counters to their `start` (a restart marker). */
  restart(kinds: readonly NoteKind[]): void {
    for (const k of kinds) this.next[k] = (k === 'footnote' ? this.foot : this.end).start;
  }

  /** Re-number a reference not yet placed (`restart: 'page'`): its mark and
   *  its gutter, which is measured from the mark. An explicit mark takes no
   *  number and is left alone; a repeat copies its first citation's mark. */
  renumber(ref: NoteRef, n: number): void {
    if (ref.repeatOf !== undefined) { ref.mark = ref.repeatOf.mark; ref.markRun.text = ref.mark; return; }
    if (ref.note.mark !== undefined) return;
    const o = ref.kind === 'footnote' ? this.foot : this.end;
    ref.mark = formatMark(n, o.format);
    ref.markRun.text = ref.mark;
    const h = this.holders.get(ref);
    if (h !== undefined) h.gutter = measureText(ref.mark, h.markSize, 'Helvetica') + GUTTER_GAP;
  }

  /** Number one reference. Idempotent: a reference keeps its first number. */
  assign(ref: NoteRef): void {
    if (ref.mark !== '') return;
    const prior = this.firsts.get(ref.note);
    if (prior !== undefined) {
      // A repeat: the first citation's mark, no body of its own.
      const p = ref.kind === 'footnote' ? this.foot : this.end;
      ref.mark = prior.mark;
      ref.markRun.text = prior.mark;
      ref.markRun.fontSize = ref.baseSize * p.markScale;
      ref.markRun.rise = ref.baseSize * MARK_RISE;
      ref.repeatOf = prior;
      if (this.links !== undefined && p.links) ref.markRun.link = this.links.linkFor(ref);
      return;
    }
    this.firsts.set(ref.note, ref);
    const o = ref.kind === 'footnote' ? this.foot : this.end;
    ref.mark = ref.note.mark ?? formatMark(this.next[ref.kind]++, o.format);
    ref.markRun.text = ref.mark;
    ref.markRun.fontSize = ref.baseSize * o.markScale;
    ref.markRun.rise = ref.baseSize * MARK_RISE;
    // Overwrites a URI lowerNotes copied from the cited run: the words keep
    // the URI, the mark goes to the note (v9j3.3.4). Set here, not in
    // lowerNotes, because lowering has no flow and so no `links` option.
    const linking = this.links !== undefined && o.links;
    if (linking) ref.markRun.link = this.links!.linkFor(ref);
    const c = ref.note.content;
    const els = isElementList(c) ? c : this.makeBody(c as NoteText, o.fontSize);
    const markSize = o.fontSize * o.markScale;
    const holder: NoteHolder = {
      ref, markSize, fontSize: o.fontSize, drawn: false,
      gutter: measureText(ref.mark, markSize, 'Helvetica') + GUTTER_GAP,
      ...(linking ? { links: this.links } : {}),
    };
    this.holders.set(ref, holder);
    ref.body = els.map((e, i) => new NoteElement(e, holder,
      (i === 0 ? o.spacing : 0) + (e.spaceBefore ?? 0), e.spaceAfter ?? 0));
    this.assigned = true;
  }
}

/** One element of a note's body: the mark's gutter plus the child, which it
 *  delegates to and never paginates (flow.ts's container rule). A note split
 *  across columns therefore needs no special case. @internal */
export class NoteElement implements FlowElement {
  constructor(
    private readonly inner: FlowElement,
    private readonly h: NoteHolder,
    readonly spaceBefore: number,
    readonly spaceAfter: number,
  ) {}

  get onCompromise(): ((how: Compromise) => void) | undefined { return this.inner.onCompromise; }
  set onCompromise(fn: ((how: Compromise) => void) | undefined) { this.inner.onCompromise = fn; }

  /** ONE definition read by measure and place, through the e1bp floor. */
  private indentFor(width: number): number { return this.h.gutter * insetScale(width, this.h.gutter); }

  measure(ctx: MeasureContext): { usedHeight: number; fits: boolean } {
    const indent = this.indentFor(ctx.width);
    return this.inner.measure?.({ width: ctx.width - indent, availHeight: ctx.availHeight })
      ?? { usedHeight: 0, fits: false };
  }

  place(ctx: PlaceContext): PlaceResult {
    if (ctx.availHeight <= 0) return { usedHeight: 0, remainder: this, drew: false };
    if (this.h.ref.noteTag === undefined) this.h.ref.tagAtPlace?.();
    const note = this.h.ref.noteTag;
    const indent = this.indentFor(ctx.width);
    const res = this.inner.place({
      ...ctx, x: ctx.x + indent, width: ctx.width - indent,
      structParent: note ?? ctx.structParent,
    });
    if (res.drew && !this.h.drawn) {
      // The mark is the /Note's OWN content, not a /Lbl: this library's
      // PDF/UA rule (and PDF 1.7's Table 336) keeps /Lbl to list items, so a
      // /Lbl here failed ValidatePdfUa on every tagged flow with notes. With
      // links (v9j3.3.4) it sits in a /Link child of the /Note.
      const links = this.h.links;
      const linkEl = links !== undefined && note !== undefined ? note.Append('Link') : undefined;
      const tag = linkEl ?? note;
      const y = ctx.top - this.h.fontSize + this.h.fontSize * MARK_RISE;
      stampText(ctx.doc, ctx.page, this.h.ref.mark, ctx.x, y,
        { font: 'Helvetica', fontSize: this.h.markSize, ...(tag ? { tag } : {}) });
      if (links !== undefined) {
        const w = measureText(this.h.ref.mark, this.h.markSize, 'Helvetica');
        const vm = vmetricsFor('Helvetica');
        links.noteDrawn(this.h.ref, {
          page: ctx.page, x: ctx.x, top: ctx.top,
          rect: [ctx.x, y + vm.descent * this.h.markSize, ctx.x + w, y + vm.ascent * this.h.markSize],
          ...(linkEl !== undefined ? { elem: linkEl } : {}),
        });
      }
      this.h.drawn = true;
    }
    if (res.drew && indent < this.h.gutter) this.onCompromise?.('squeezed');
    return {
      usedHeight: res.usedHeight,
      drew: res.drew,
      remainder: res.remainder === null ? null : new NoteElement(res.remainder, this.h, 0, this.spaceAfter),
    };
  }

  /** None: notes do not nest, which lowering enforces. */
  noteRefs(): NoteRef[] { return []; }
}

/** What `settleBudget` needs from one measure. @internal */
export interface Probe { usedHeight: number; notes?: readonly NoteRef[] }
/** A budget to place at and the references it keeps, or 'advance' to the
 *  next column. @internal */
export type Settled = { budget: number; refs: NoteRef[] } | 'advance';

const BISECT_STEPS = 30;
const BISECT_TOL = 0.01;
const OVERFLOW_PROBE = 1e6;

/** The largest budget at which the content kept, plus the WHOLE notes of the
 *  footnotes it keeps, fit in `room` (the column from the pen to its bottom).
 *
 *  **Invariant:** feasibility is MONOTONE in the budget — a larger budget
 *  keeps at least as much content and a superset of references, so content
 *  plus feet never shrinks — which is what makes a bisection exact (to
 *  `BISECT_TOL`) rather than a guess. It replaced a shrink loop that stepped
 *  the budget down by the note's height: that stopped as soon as the
 *  reference fell out of the kept prefix and left the lines above it unused,
 *  about 180pt of blank page in a measured case (review #5).
 *
 *  **Invariant:** `footHeightWith` may answer `Infinity` to declare a set of
 *  feet impossible here — `Render` does when they would rise above a float's
 *  bottom — and the bisection then keeps only content citing no footnote.
 *
 *  **Invariant:** whole notes come first; a split is the fallback. When not
 *  even one line fits with its whole notes, mid-column answers 'advance' (the
 *  next column may hold both); only at an EMPTY column start — where
 *  advancing could never help — does it take the smallest budget that keeps a
 *  line, letting that line's notes split. Endnote references reserve nothing
 *  but are returned, so the caller can collect them. @internal */
export function settleBudget(
  measure: (budget: number) => Probe, budget: number, room: number,
  footHeightWith: (refs: NoteRef[]) => number, atColumnStart: boolean,
): Settled {
  const feet = (p: Probe): NoteRef[] => (p.notes ?? []).filter((r) => r.kind === 'footnote');
  const fits = (p: Probe): boolean => {
    const fr = feet(p);
    return fr.length === 0 || p.usedHeight + footHeightWith(fr) <= room + 1e-9;
  };
  const full = measure(budget);
  if (full.usedHeight <= 0) return { budget, refs: [] };   // the engine's ordinary no-fit path
  if (fits(full)) return { budget, refs: [...(full.notes ?? [])] };
  let lo = 0;                                              // feasible (keeps nothing)
  let hi = budget;                                         // infeasible
  for (let i = 0; i < BISECT_STEPS && hi - lo > BISECT_TOL; i++) {
    const mid = (lo + hi) / 2;
    if (fits(measure(mid))) lo = mid; else hi = mid;
  }
  const kept = lo > 0 ? measure(lo) : { usedHeight: 0 };
  if (kept.usedHeight > 0) return { budget: lo, refs: [...(kept.notes ?? [])] };
  // Not one line fits with its whole notes.
  if (!atColumnStart) return 'advance';
  lo = 0;
  hi = budget;                                             // measure(hi).usedHeight > 0
  for (let i = 0; i < BISECT_STEPS && hi - lo > BISECT_TOL; i++) {
    const mid = (lo + hi) / 2;
    if (measure(mid).usedHeight > 0) hi = mid; else lo = mid;
  }
  return { budget: hi, refs: [...(measure(hi).notes ?? [])] };
}

/** One column's footnote area: the notes whose references landed in this
 *  column, plus the CARRY — what the previous column could not fit, painted
 *  first. @internal
 *
 *  **Invariant:** painting happens at column CLOSE, never incrementally. The
 *  area grows upward as references arrive, and note 1 must sit above note 2.
 *
 *  **Invariant:** reserve and paint agree by construction: `footHeight`
 *  measures through `measureElements`, which shares `placeElements`' gap
 *  rule, and `paint` places through `placeElements`.
 *
 *  **Invariant:** carry always makes progress. A column painting carry either
 *  places some of it or, when nothing else is in the column, draws its first
 *  piece at its natural height past the bottom (the main loop's zch2.16
 *  rule) — so the carry shrinks every column and Render's drain terminates. */
export class NoteColumn {
  private carry: FlowElement[] = [];
  private committed: FlowElement[] = [];

  constructor(private readonly opts: ResolvedNoteOptions, private readonly width: number) {}

  /** No carry and nothing committed. */
  get empty(): boolean { return this.carry.length === 0 && this.committed.length === 0; }

  /** Whether the previous column left notes for this one. A column holding
   *  carry is not EMPTY for `settleBudget`'s split fallback: advancing there
   *  helps, because the carry drains and the next column is clean. */
  get hasCarry(): boolean { return this.carry.length > 0; }

  private get sepH(): number { return this.opts.separator?.thickness ?? 0; }

  /** The height the area needs with everything held plus `extra`'s notes. */
  footHeight(extra: readonly NoteRef[] = []): number {
    const els = [...this.carry, ...this.committed, ...extra.flatMap((r) => r.body)];
    if (els.length === 0) return 0;
    return this.opts.spacing + this.sepH + measureElements(els, this.width);
  }

  /** Hold the notes of these references; endnote references are ignored. */
  commit(refs: readonly NoteRef[]): void {
    for (const r of refs) if (r.kind === 'footnote') this.committed.push(...r.body);
  }

  /** Paint the area between the pen (`penY`) and the column bottom, and keep
   *  what did not fit as the next column's carry. */
  paint(a: {
    doc: Document; page: Page; x: number; penY: number; contentBottom: number;
    structParent?: StructElement; columnEmpty: boolean;
  }): void {
    if (this.empty) return;
    const els = [...this.carry, ...this.committed];
    this.carry = [];
    this.committed = [];
    const areaH = Math.min(this.opts.spacing + this.sepH + measureElements(els, this.width),
      a.penY - a.contentBottom);
    const ruleTop = a.contentBottom + areaH - this.opts.spacing;
    const sep = this.opts.separator;
    if (sep !== undefined) {
      paintDecoration(
        { doc: a.doc, page: a.page, x: a.x, top: ruleTop, width: this.width, availHeight: areaH,
          structParent: a.structParent },
        fillRect(a.x, ruleTop - sep.thickness, Math.min(sep.width ?? this.width / 3, this.width),
          sep.thickness, sep.color));
    }
    const top = ruleTop - this.sepH;
    const h = top - a.contentBottom;
    let rest = els;
    if (h > 0) {
      const r = placeElements(a.doc, a.page, els, [a.x, a.contentBottom, this.width, h],
        { structParent: a.structParent });
      rest = r.remainder;
      if (r.usedHeight === 0 && rest.length > 0 && a.columnEmpty) rest = this.overflow(rest, a, top);
    } else if (a.columnEmpty) {
      rest = this.overflow(rest, a, top);
    }
    this.carry = rest;
  }

  /** An unsplittable piece taller than an empty column: drawn at its natural
   *  height past the bottom, so the carry terminates. */
  private overflow(
    els: FlowElement[], a: { doc: Document; page: Page; x: number; structParent?: StructElement },
    top: number,
  ): FlowElement[] {
    const [first, ...more] = els;
    first.onCompromise?.('overflow');
    const natural = first.measure?.({ width: this.width, availHeight: OVERFLOW_PROBE })?.usedHeight
      ?? OVERFLOW_PROBE;
    const res = first.place({
      doc: a.doc, page: a.page, x: a.x, top, width: this.width,
      availHeight: natural > 0 ? natural : OVERFLOW_PROBE, structParent: a.structParent,
    });
    return res.remainder === null ? more : [res.remainder, ...more];
  }
}

/** The element IDs the document's /IDTree already holds. @internal */
export function takenIds(doc: Document, rootDict: PdfDict): Set<string> {
  const out: Array<[string, PdfObject]> = [];
  collectNameTree(doc, rootDict.get('IDTree'), out);
  return new Set(out.map(([k]) => k));
}

/** The next free note ID for `kind` — `fn-<k>` or `en-<k>`, the smallest
 *  `k` not in `taken` — recorded as taken. So a second flow in one
 *  document, or an ID some other producer wrote, never collides. @internal */
export function nextNoteId(kind: NoteKind, taken: Set<string>): string {
  const p = kind === 'footnote' ? 'fn' : 'en';
  let k = 1;
  while (taken.has(`${p}-${k}`)) k++;
  const id = `${p}-${k}`;
  taken.add(id);
  return id;
}

/** Create the reference's /Note, at COMMIT, as a child of the element holding
 *  the reference — so it reads right after the chunk that cites it, for
 *  endnotes too, whose ink is at the end. A screen reader then announces a
 *  note at its reference, not at the page foot. @internal */
export function tagNote(ref: NoteRef, fallback: StructElement, id: string): void {
  ref.id = id;
  ref.noteTag = (ref.owner ?? fallback).Append('Note', { id });
}

/** The marker `flow.RestartNotes` queues (v9j3.3.2): the numbering pass resets
 *  the named kinds' counters to their `start` on reaching it. It draws nothing
 *  and takes no room: Render and placeElements skip it outright rather than
 *  placing a zero-height element, which would still earn paragraphSpacing.
 *  @internal */
export class NoteRestartElement implements FlowElement {
  constructor(readonly noteRestart: readonly NoteKind[]) {}
  measure(): { usedHeight: number; fits: boolean } { return { usedHeight: 0, fits: true }; }
  place(): PlaceResult { return { usedHeight: 0, remainder: null, drew: false }; }
  noteRefs(): NoteRef[] { return []; }
}

/** A restart marker for `kind`, or for both kinds. @internal */
export function noteRestart(kind?: NoteKind): FlowElement {
  if (kind !== undefined && kind !== 'footnote' && kind !== 'endnote')
    throw new TypeError("kind must be 'footnote' or 'endnote'");
  return new NoteRestartElement(kind === undefined ? ['footnote', 'endnote'] : [kind]);
}

/** Whether `e` is a restart marker. @internal */
export function isNoteRestart(e: unknown): e is NoteRestartElement { return e instanceof NoteRestartElement; }

/** Notes for a SINGLE RECT (`page.AddMarkdown`), which has no column foot and
 *  no next column: number every reference in `elements`, DETACH each (delete
 *  the symbol key from its mark run, which the lowering owns) so
 *  `placeElements` stops refusing, and append the notes after the content —
 *  footnotes, then endnotes, each note once — under the footnote separator.
 *  Numbering is per call, and a restart marker (`noteRestart`) resets it
 *  in order; markers are stripped from the result. Returns `elements` itself
 *  when nothing cites a note and no restart marker is present.
 *
 *  With `tagging`, each note is tagged a `/Note` when its body first places —
 *  there is no commit step here — beside its citation, as `Flow.Render`
 *  does, and its ID is recorded in `tagging.entries` for the caller to
 *  register once placement is done. @internal */
export function notesAsTrailing(
  elements: FlowElement[], foot: ResolvedNoteOptions, end: ResolvedNoteOptions, makeBody: BodyMaker,
  tagging?: { parent: StructElement; taken: Set<string>; entries: Array<[string, PdfRef]> },
  links?: NoteLinks,
): FlowElement[] {
  const refs = elements.flatMap((e) => e.noteRefs?.() ?? []);
  if (refs.length === 0) return elements.some(isNoteRestart) ? elements.filter((e) => !isNoteRestart(e)) : elements;
  const nb = new NoteNumberer(foot, end, makeBody, links);
  for (const e of elements) {
    if (isNoteRestart(e)) { nb.restart(e.noteRestart); continue; }
    for (const r of e.noteRefs?.() ?? []) nb.assign(r);
  }
  for (const r of refs) delete (r.markRun as Partial<MarkRun>)[NOTE];
  const firsts = refs.filter((r) => r.repeatOf === undefined);
  if (tagging !== undefined) {
    for (const r of firsts) {
      r.tagAtPlace = () => {
        tagNote(r, tagging.parent, nextNoteId(r.kind, tagging.taken));
        tagging.entries.push([r.id!, r.noteTag!.Ref!]);
      };
    }
  }
  const out = elements.filter((e) => !isNoteRestart(e));
  const sep = foot.separator;
  if (sep !== undefined) {
    out.push(...rule({
      thickness: sep.thickness, color: sep.color, spaceBefore: foot.spacing,
      ...(sep.width === undefined ? {} : { width: sep.width }),
    }));
  }
  for (const r of firsts) if (r.kind === 'footnote') out.push(...r.body);
  for (const r of firsts) if (r.kind === 'endnote') out.push(...r.body);
  return out;
}
