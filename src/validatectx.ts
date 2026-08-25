import type { Document } from './document.js';
import {
  PdfObject, PdfDict, PdfRef, isDict, isName, isArray, isStream, isRef,
} from './types.js';
import { inflateStream } from './flate.js';
import { parseContentStream } from './content.js';
import type { Page } from './page.js';

/** Per-run context shared (read-only) across the rules of any validator.
 *  PDF/A and PDF/X each extend this with their conformance target. */
export interface Ctx {
  doc: Document;
  catalog: PdfDict;
  /** Bound `doc.resolve`. */
  R(o: PdfObject | undefined): PdfObject;
  /** Memo store for shared scans (fonts, content scan, …). */
  cache: Map<string, unknown>;
}

/** Memoize an expensive per-run computation under `key`. */
export function memo<T>(ctx: Ctx, key: string, fn: () => T): T {
  if (!ctx.cache.has(key)) ctx.cache.set(key, fn());
  return ctx.cache.get(key) as T;
}

/** The name value of `dict.get(key)`, resolved, or undefined. */
export function nameOf(ctx: Ctx, dict: PdfDict, key: string): string | undefined {
  const v = ctx.R(dict.get(key));
  return isName(v) ? v.name : undefined;
}

/** All `/Filter` names on a stream (or other) dict, normalized to bare names. */
export function filterNames(dict: PdfDict, R: Ctx['R']): string[] {
  const f = R(dict.get('Filter'));
  if (isName(f)) return [f.name];
  if (isArray(f)) return f.map(R).filter(isName).map((n) => (n as { name: string }).name);
  return [];
}

/** Every indirect object with its ref, memoized for the run. */
export function allObjects(ctx: Ctx): [PdfRef, PdfObject][] {
  return memo(ctx, 'allObjects', () => [...ctx.doc.objectEntries()]);
}

/** Decoded XMP packet text from /Root /Metadata, or undefined when absent. */
export function xmpText(ctx: Ctx): string | undefined {
  return memo(ctx, 'xmpText', () => {
    const md = ctx.R(ctx.catalog.get('Metadata'));
    if (!isStream(md)) return undefined;
    return new TextDecoder('latin1').decode(inflateStream(md));
  });
}

// ---- fonts -----------------------------------------------------------------

/** Every distinct font dict referenced by any page (recursing Form XObject
 *  resources), deduped by indirect ref. */
export function enumerateFonts(ctx: Ctx): { ref?: PdfRef; dict: PdfDict }[] {
  return memo(ctx, 'fonts', () => {
    const out: { ref?: PdfRef; dict: PdfDict }[] = [];
    const seen = new Set<PdfDict>();
    const seenRes = new Set<PdfDict>();
    const visitRes = (resObj: PdfObject | undefined): void => {
      const res = ctx.R(resObj);
      if (!isDict(res) || seenRes.has(res)) return;
      seenRes.add(res);
      const fonts = ctx.R(res.get('Font'));
      if (isDict(fonts)) {
        for (const v of fonts.values()) {
          const d = ctx.R(v);
          if (isDict(d) && !seen.has(d)) { seen.add(d); out.push({ ref: isRef(v) ? v : undefined, dict: d }); }
        }
      }
      const xobjs = ctx.R(res.get('XObject'));
      if (isDict(xobjs)) {
        for (const v of xobjs.values()) {
          const x = ctx.R(v);
          if (isStream(x)) visitRes(x.dict.get('Resources'));
        }
      }
    };
    for (const page of ctx.doc.Pages) visitRes(page.Resources);
    return out;
  });
}

/** The descendant CIDFont dict of a Type0 font, or undefined. */
export function descendantFont(ctx: Ctx, font: PdfDict): PdfDict | undefined {
  const arr = ctx.R(font.get('DescendantFonts'));
  if (!isArray(arr) || arr.length === 0) return undefined;
  const d = ctx.R(arr[0]);
  return isDict(d) ? d : undefined;
}

/** True when a font descriptor embeds a font program. */
export function hasFontProgram(ctx: Ctx, descriptor: PdfObject | undefined): boolean {
  const fd = ctx.R(descriptor);
  if (!isDict(fd)) return false;
  return ['FontFile', 'FontFile2', 'FontFile3'].some((k) => isStream(ctx.R(fd.get(k))));
}

// ---- content scan ----------------------------------------------------------

export interface PageScan {
  page: Page;
  /** Every color space named by the page's content, e.g. 'DeviceRGB', 'ICCBased'.
   *  PDF/X's rules are per-space, so this records the space rather than a
   *  device-or-not flag. */
  colorSpaces: Set<string>;
  inlineImageFilters: string[];
  renderingIntents: string[];
}

/** Operators that set color in a device space, mapped to that space. */
const DEVICE_COLOR_OPS: Record<string, string> = {
  g: 'DeviceGray', G: 'DeviceGray',
  rg: 'DeviceRGB', RG: 'DeviceRGB',
  k: 'DeviceCMYK', K: 'DeviceCMYK',
};

/** Abbreviated (inline-image) and full names of the device spaces. */
const DEVICE_CS: Record<string, string> = {
  DeviceGray: 'DeviceGray', G: 'DeviceGray',
  DeviceRGB: 'DeviceRGB', RGB: 'DeviceRGB',
  DeviceCMYK: 'DeviceCMYK', CMYK: 'DeviceCMYK',
};

const INLINE_FILTER_ABBREV: Record<string, string> = {
  AHx: 'ASCIIHexDecode', A85: 'ASCII85Decode', LZW: 'LZWDecode', Fl: 'FlateDecode',
  RL: 'RunLengthDecode', CCF: 'CCITTFaxDecode', DCT: 'DCTDecode',
};

/** True when the scan saw any device-dependent color space. */
export function usesDeviceColor(scan: PageScan): boolean {
  return scan.colorSpaces.has('DeviceGray')
    || scan.colorSpaces.has('DeviceRGB')
    || scan.colorSpaces.has('DeviceCMYK');
}

/** Filter names of an inline image dict (abbreviated /F or full /Filter). */
function inlineFilterNames(ctx: Ctx, idict: PdfDict): string[] {
  const raw = ctx.R(idict.get('F')) ?? ctx.R(idict.get('Filter'));
  if (isName(raw)) return [raw.name];
  if (isArray(raw)) return raw.map(ctx.R).filter(isName).map((n) => (n as { name: string }).name);
  return [];
}

/** The family of a named color space from /Resources /ColorSpace, e.g. an
 *  /ICCBased or /Separation array's first element. Falls back to the name. */
function resolveSpaceFamily(ctx: Ctx, resDict: PdfDict | undefined, csName: string): string {
  if (!resDict) return csName;
  const csDict = ctx.R(resDict.get('ColorSpace'));
  if (!isDict(csDict)) return csName;
  const entry = ctx.R(csDict.get(csName));
  if (isName(entry)) return DEVICE_CS[entry.name] ?? entry.name;
  if (isArray(entry) && entry.length > 0) {
    const family = ctx.R(entry[0]);
    if (isName(family)) return family.name;
  }
  return csName;
}

/** Walk a page's content (recursing Form XObjects) once, recording the usage
 *  the conformance validators care about. */
export function pageScans(ctx: Ctx): PageScan[] {
  return memo(ctx, 'scans', () => ctx.doc.Pages.map((page) => {
    const scan: PageScan = {
      page, colorSpaces: new Set<string>(), inlineImageFilters: [], renderingIntents: [],
    };
    const seen = new Set<PdfDict>();
    const walk = (resObj: PdfObject | undefined, contentBytes: Uint8Array, depth: number): void => {
      if (depth > 8) return;
      const res = ctx.R(resObj);
      const resDict = isDict(res) ? res : undefined;
      let ops;
      try { ops = parseContentStream(contentBytes); } catch { return; }
      for (const op of ops) {
        const deviceOp = DEVICE_COLOR_OPS[op.operator];
        if (deviceOp !== undefined) scan.colorSpaces.add(deviceOp);
        if (op.operator === 'cs' || op.operator === 'CS') {
          const a = op.operands[0];
          if (isName(a)) {
            const dev = DEVICE_CS[a.name];
            if (dev !== undefined) scan.colorSpaces.add(dev);
            else scan.colorSpaces.add(resolveSpaceFamily(ctx, resDict, a.name));
          }
        }
        if (op.operator === 'ri') {
          const a = op.operands[0];
          if (isName(a)) scan.renderingIntents.push(a.name);
        }
        if (op.operator === 'BI' && op.inlineImage) {
          // Inline images use abbreviated keys: /F (Filter), /CS (ColorSpace).
          const idict = op.inlineImage.dict;
          for (const f of inlineFilterNames(ctx, idict)) {
            scan.inlineImageFilters.push(INLINE_FILTER_ABBREV[f] ?? f);
          }
          const cs = ctx.R(idict.get('CS')) ?? ctx.R(idict.get('ColorSpace'));
          if (isName(cs)) {
            const dev = DEVICE_CS[cs.name];
            if (dev !== undefined) scan.colorSpaces.add(dev);
          }
        }
        if (op.operator === 'Do' && resDict) {
          const a = op.operands[0];
          if (isName(a)) {
            const xobjs = ctx.R(resDict.get('XObject'));
            const xo = isDict(xobjs) ? ctx.R(xobjs.get(a.name)) : undefined;
            if (isStream(xo) && nameOf(ctx, xo.dict, 'Subtype') === 'Form' && !seen.has(xo.dict)) {
              seen.add(xo.dict);
              try { walk(xo.dict.get('Resources'), inflateStream(xo), depth + 1); } catch { /* skip */ }
            }
          }
        }
      }
    };
    const contentObj = ctx.R(page.Dict.get('Contents'));
    const bytes = concatContents(ctx, contentObj);
    walk(page.Resources, bytes, 0);
    return scan;
  }));
}

/** Concatenate a page's content stream(s) into one decoded buffer. */
function concatContents(ctx: Ctx, contents: PdfObject): Uint8Array {
  const parts: Uint8Array[] = [];
  const push = (o: PdfObject): void => { if (isStream(o)) { try { parts.push(inflateStream(o)); } catch { /* skip */ } } };
  if (isStream(contents)) push(contents);
  else if (isArray(contents)) for (const e of contents) { const s = ctx.R(e); if (isStream(s)) { push(s); parts.push(new TextEncoder().encode('\n')); } }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// ---- graphics state and annotations ----------------------------------------

/** Every distinct ExtGState dict from page + Form XObject resources. */
export function extGStates(ctx: Ctx): { ref?: PdfRef; dict: PdfDict }[] {
  return memo(ctx, 'egs', () => {
    const out: { ref?: PdfRef; dict: PdfDict }[] = [];
    const seen = new Set<PdfDict>();
    const seenRes = new Set<PdfDict>();
    const visit = (resObj: PdfObject | undefined): void => {
      const res = ctx.R(resObj);
      if (!isDict(res) || seenRes.has(res)) return;
      seenRes.add(res);
      const egs = ctx.R(res.get('ExtGState'));
      if (isDict(egs)) for (const v of egs.values()) {
        const d = ctx.R(v);
        if (isDict(d) && !seen.has(d)) { seen.add(d); out.push({ ref: isRef(v) ? v : undefined, dict: d }); }
      }
      const xobjs = ctx.R(res.get('XObject'));
      if (isDict(xobjs)) for (const v of xobjs.values()) {
        const x = ctx.R(v);
        if (isStream(x)) visit(x.dict.get('Resources'));
      }
    };
    for (const page of ctx.doc.Pages) visit(page.Resources);
    return out;
  });
}

/** The blend-mode name of an ExtGState /BM (name or first array element). */
export function blendModeName(ctx: Ctx, dict: PdfDict): string | undefined {
  const bm = ctx.R(dict.get('BM'));
  if (isName(bm)) return bm.name;
  if (isArray(bm)) { const first = ctx.R(bm[0]); if (isName(first)) return first.name; }
  return undefined;
}

/** Every annotation dict across all pages. */
export function eachAnnotation(ctx: Ctx): { ref?: PdfRef; dict: PdfDict; page: Page }[] {
  return memo(ctx, 'annots', () => {
    const out: { ref?: PdfRef; dict: PdfDict; page: Page }[] = [];
    for (const page of ctx.doc.Pages) {
      const arr = ctx.R(page.Dict.get('Annots'));
      if (!isArray(arr)) continue;
      for (const a of arr) {
        const d = ctx.R(a);
        if (isDict(d)) out.push({ ref: isRef(a) ? a : undefined, dict: d, page });
      }
    }
    return out;
  });
}
