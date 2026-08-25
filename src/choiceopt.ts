import type { Document } from './document.js';
import { PdfDict, PdfObject, isArray, isString } from './types.js';
import { decodePdfText, encodePdfText } from './metadata.js';

/** One option of a choice field. A bare string is an option whose export value
 *  and displayed text are the same. */
export type ChoiceOption = string | { export: string; display?: string };

/** A validated option. `display` is absent when it matches the export. */
export interface NormalizedOption { export: string; display?: string }

/** The text shown for an option — the display half when it has one. `/V` holds
 *  the *export*, so every renderer has to make this distinction explicitly. */
export function displayOf(o: NormalizedOption): string {
  return o.display ?? o.export;
}

/** Validate one option. `where` names it in the error, so the same check reads
 *  correctly whether it came from a list at creation or a single AddOption. */
export function normalizeOption(o: ChoiceOption, where: string): NormalizedOption {
  let ex: string;
  let disp: string | undefined;
  if (typeof o === 'string') {
    ex = o;
  } else if (o !== null && typeof o === 'object' && typeof o.export === 'string') {
    ex = o.export;
    if (o.display !== undefined && typeof o.display !== 'string')
      throw new TypeError(`${where}: display must be a string`);
    disp = o.display;
  } else {
    throw new TypeError(`${where}: must be a string or { export, display? }`);
  }
  if (ex === '') throw new TypeError(`${where}: export must be a non-empty string`);
  return { export: ex, display: disp };
}

/** Validate and normalise a whole option list. Rejects everything before any
 *  object is allocated. */
export function normalizeOptions(options: ChoiceOption[]): NormalizedOption[] {
  if (!Array.isArray(options)) throw new TypeError('options must be an array');
  const seen = new Set<string>();
  const out: NormalizedOption[] = [];
  for (let i = 0; i < options.length; i++) {
    const o = normalizeOption(options[i], `option ${i}`);
    if (seen.has(o.export)) throw new RangeError(`option ${i}: duplicate export '${o.export}'`);
    seen.add(o.export);
    out.push(o);
  }
  return out;
}

/** A PdfString carrying a PDF text string. */
function pdfText(s: string): PdfObject {
  return { kind: 'string', bytes: encodePdfText(s) };
}

/** The /Opt array: a plain string when the display matches the export, else an
 *  [export, display] pair. */
export function optArray(options: NormalizedOption[]): PdfObject[] {
  return options.map((o) => (
    o.display === undefined || o.display === o.export
      ? pdfText(o.export)
      : [pdfText(o.export), pdfText(o.display)] as PdfObject
  ));
}

/** Parse a field's /Opt back into the normalised model — the inverse of
 *  optArray, and the one place the two-shape entry grammar is read.
 *
 *  An entry is either a string (both roles) or an [export, display] pair.
 *  Keeping both halves is what lets a renderer match on the export — which is
 *  what /V holds — while drawing the display. */
export function parseOptions(doc: Document, fieldDict: PdfDict): NormalizedOption[] {
  const opt = doc.resolve(fieldDict.get('Opt'));
  if (!isArray(opt)) return [];
  const out: NormalizedOption[] = [];
  for (const e of opt) {
    const r = doc.resolve(e);
    if (isArray(r)) {
      const ex = doc.resolve(r[0]);
      if (!isString(ex)) continue;
      const disp = doc.resolve(r[1]);
      out.push({
        export: decodePdfText(ex.bytes),
        display: isString(disp) ? decodePdfText(disp.bytes) : undefined,
      });
    } else if (isString(r)) {
      out.push({ export: decodePdfText(r.bytes) });
    }
  }
  return out;
}
