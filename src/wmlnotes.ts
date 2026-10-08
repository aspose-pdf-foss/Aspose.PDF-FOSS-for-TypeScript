/** Word's note NUMBERING properties (v9j3.3.2): `w:footnotePr` / `w:endnotePr`
 *  in settings.xml (the document defaults) and in each section's `sectPr`. A
 *  leaf over wmlns.ts; it never throws on content — an unreadable value is
 *  simply not kept — and resolves nothing: what a section's effective numbering
 *  is, is the mapper's (wmlflow.ts) decision. */
import type { LoadLimits } from './loadlimits.js';
import type { NsElement } from './xmlns.js';
import { PdfParseError } from './errors.js';
import { parseWml, W, wAttr, wChild } from './wmlns.js';

export interface WmlNotePr { numFmt?: string; numStart?: number; numRestart?: string; pos?: string }
export interface WmlSectionNotes { footnotePr?: WmlNotePr; endnotePr?: WmlNotePr }

/** A footnotePr/endnotePr element's four properties, only those stated and
 *  readable; undefined when none is. */
export function readNotePr(el: NsElement | undefined): WmlNotePr | undefined {
  if (el === undefined) return undefined;
  const out: WmlNotePr = {};
  const fmt = wAttr(wChild(el, 'numFmt'), 'val');
  if (fmt) out.numFmt = fmt;
  const start = wAttr(wChild(el, 'numStart'), 'val');
  if (start !== undefined && /^\d+$/.test(start) && Number(start) >= 1) out.numStart = Number(start);
  const restart = wAttr(wChild(el, 'numRestart'), 'val');
  if (restart) out.numRestart = restart;
  const pos = wAttr(wChild(el, 'pos'), 'val');
  if (pos) out.pos = pos;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** A sectPr's (or settings') note properties. */
export function readSectionNotes(el: NsElement | undefined): WmlSectionNotes {
  const out: WmlSectionNotes = {};
  const f = readNotePr(wChild(el, 'footnotePr'));
  if (f) out.footnotePr = f;
  const e = readNotePr(wChild(el, 'endnotePr'));
  if (e) out.endnotePr = e;
  return out;
}

export function parseSettingsNotes(bytes: Uint8Array, limits: LoadLimits): WmlSectionNotes {
  const root = parseWml(bytes, limits);
  if (root.ns !== W || root.local !== 'settings') throw new PdfParseError('settings.xml: the root is not w:settings');
  return readSectionNotes(root);
}
