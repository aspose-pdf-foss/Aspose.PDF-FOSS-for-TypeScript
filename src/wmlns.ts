/** WordprocessingML namespaces and the attribute readers every `wml*` module
 *  shares (`m2fp.3`). Note the direction: `docx*` modules WRITE and share no
 *  code with this.
 *
 *  **Invariant:** transitional and Strict are ONE vocabulary. `canonNs` folds
 *  each Strict URI onto its transitional twin at parse, so no reader compares
 *  against two constants.
 *
 *  **Invariant:** Word's extension namespaces (w14, wps, …) are NOT in
 *  `UNDERSTOOD`: we understand none of their content, so a Choice requiring
 *  them is passed over for the Fallback, which we can read. */
import { parseNsXml, nsAttr, nsChild, nsChildren, MC_NS, type NsElement } from './xmlns.js';
import { LoadLimits } from './loadlimits.js';

export const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
export const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
export const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
export const WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
export const PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
export const M = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
export const V = 'urn:schemas-microsoft-com:vml';

const STRICT: ReadonlyMap<string, string> = new Map([
  ['http://purl.oclc.org/ooxml/wordprocessingml/main', W],
  ['http://purl.oclc.org/ooxml/officeDocument/relationships', R],
  ['http://purl.oclc.org/ooxml/drawingml/main', A],
  ['http://purl.oclc.org/ooxml/drawingml/wordprocessingDrawing', WP],
  ['http://purl.oclc.org/ooxml/drawingml/picture', PIC],
]);
export const canonNs = (uri: string): string => STRICT.get(uri) ?? uri;

export const UNDERSTOOD: ReadonlySet<string> = new Set([W, R, A, WP, PIC, MC_NS]);

export function parseWml(bytes: Uint8Array, limits: LoadLimits = LoadLimits.defaults): NsElement {
  return parseNsXml(bytes, limits, { canon: canonNs, understood: UNDERSTOOD });
}

export const wAttr = (el: NsElement | undefined, local: string): string | undefined => nsAttr(el, W, local);
export const wChild = (el: NsElement | undefined, local: string): NsElement | undefined => nsChild(el, W, local);
export const wChildren = (el: NsElement | undefined, local: string): NsElement[] => nsChildren(el, W, local);

const PREFIX: ReadonlyMap<string, string> = new Map([
  [W, 'w'], [R, 'r'], [A, 'a'], [WP, 'wp'], [PIC, 'pic'], [M, 'm'], [MC_NS, 'mc'], [V, 'v'],
]);
/** A qualified name for the unsupported report: the conventional prefix for a
 *  known namespace, else `{uri}local` — never the document's own prefix, which
 *  is arbitrary. */
export function displayName(el: NsElement): string {
  const p = PREFIX.get(el.ns);
  return p !== undefined ? `${p}:${el.local}` : el.ns === '' ? el.local : `{${el.ns}}${el.local}`;
}

/** ST_OnOff: present with no `w:val` is true; `0`, `false`, `off` are false. */
export function onOff(el: NsElement | undefined): boolean | undefined {
  if (!el) return undefined;
  const v = wAttr(el, 'val');
  return v === undefined ? true : !(v === '0' || v === 'false' || v === 'off');
}

/** A decimal attribute value, or undefined. `Number('')` is 0, so the grammar
 *  is tested first. */
export function numAttr(v: string | undefined): number | undefined {
  return v !== undefined && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : undefined;
}
export const wNum = (el: NsElement | undefined, local = 'val'): number | undefined => numAttr(wAttr(el, local));

export type Rgb = [number, number, number];

/** `auto` → null (stated: automatic); six hex digits → 0..1 components;
 *  anything else → undefined (unreadable: the next layer decides). */
export function hexColor(v: string | undefined): Rgb | null | undefined {
  if (v === undefined) return undefined;
  if (v === 'auto') return null;
  if (!/^[0-9A-Fa-f]{6}$/.test(v)) return undefined;
  const n = parseInt(v, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
