import type { Document } from './document.js';
import { rethrowLimit } from './errors.js';
import type { Page } from './page.js';
import { baseMatrix } from './pagerender.js';
import type { RgbImage } from './pixeldiff.js';
import { renderPageRgb } from './raster.js';
import type { PdfRevision } from './xref.js';

/** A change to signed page appearance that merits review. */
export interface ShadowFinding {
  /** 1-based position in the signed document. */
  page: number;
  kind: 'hide' | 'replace' | 'hide-and-replace';
  /** Some changed signed marks reappear when a layer is omitted. */
  overlay: boolean;
}

/** Results of comparing a signed revision with the current document. */
export interface ShadowAnalysis {
  findings: ShadowFinding[];
  /** Signed pages whose geometry or rendering prevented comparison. */
  skippedPages: number[];
}

const WHITE = 0xffffff;
const MAX_PAGE_SIDE = 1440;

function eofEnd(bytes: Uint8Array, end: number): number | undefined {
  // A producer may sign before the terminal EOL or include extra PDF
  // whitespace after it. Normalize both extents to the end of the marker.
  while (end > 0) {
    const byte = bytes[end - 1];
    if (byte !== 0 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13 && byte !== 32) break;
    end--;
  }
  const marker = [0x25, 0x25, 0x45, 0x4f, 0x46]; // %%EOF
  return marker.every((byte, i) => bytes[end - marker.length + i] === byte) ? end : undefined;
}

/** @internal Bind a signed prefix to a complete revision in the xref chain. */
export function findSignedRevision(
  revisions: readonly PdfRevision[], bytes: Uint8Array, signedEnd: number,
): PdfRevision | undefined {
  const end = eofEnd(bytes, signedEnd);
  if (end === undefined) return undefined;
  // The xref walk already consumed each section and measured its EOF position.
  for (let i = revisions.length - 1; i >= 0; i--) {
    const revision = revisions[i];
    if (revision.xrefOffset < end && eofEnd(bytes, revision.length) === end) return revision;
  }
  return undefined;
}

function pixel(image: RgbImage, x: number, y: number): number {
  if (x >= image.width || y >= image.height) return WHITE;
  const i = (y * image.width + x) * 3;
  return (image.rgb[i] << 16) | (image.rgb[i + 1] << 8) | image.rgb[i + 2];
}

/** @internal Compare two rendered appearances and any independently rendered
 *  underlying layers. Additional paint matters once previously visible marks
 *  have changed. */
export function classifyShadowAppearance(
  signed: RgbImage, current: RgbImage, underlays: readonly RgbImage[] = [],
): Omit<ShadowFinding, 'page'> | undefined {
  let signedChanged = false;
  let newMarks = false;
  const layers = underlays.map((image) => ({ image, coversMark: false, addsMark: false }));
  const height = Math.max(signed.height, current.height);
  for (let y = 0; y < height; y++) {
    // Compare the union of each row. The enclosing rectangle could be much
    // larger than both images combined when their orientations differ.
    const width = Math.max(y < signed.height ? signed.width : 0, y < current.height ? current.width : 0);
    for (let x = 0; x < width; x++) {
      const before = pixel(signed, x, y), after = pixel(current, x, y);
      if (before === after) continue;
      if (after !== WHITE) newMarks = true;
      if (before !== WHITE) signedChanged = true;
      for (const layer of layers) {
        if (pixel(layer.image, x, y) !== before) continue;
        if (before !== WHITE) layer.coversMark = true;
        if (after !== WHITE) layer.addsMark = true;
      }
    }
  }
  if (!signedChanged) return undefined;
  const overlay = layers.some((layer) => layer.coversMark);
  const combined = layers.some((layer) => layer.coversMark && layer.addsMark);
  return { kind: combined ? 'hide-and-replace' : newMarks ? 'replace' : 'hide', overlay };
}

function leadingStateSaves(content: Uint8Array): number {
  let offset = 0;
  while (content[offset] === 0x71 && content[offset + 1] === 0x0a) offset += 2;
  return offset;
}

function retainedContentPrefix(signed: Uint8Array, current: Uint8Array): Uint8Array | undefined {
  if (!signed.length || current.length <= signed.length) return undefined;
  // The authoring path may wrap the earlier drawing in a graphics state
  // save/restore. Preserve the leading saves when rerendering that drawing.
  const start = Math.max(0, leadingStateSaves(current) - leadingStateSaves(signed));
  const end = start + signed.length;
  return current[end] === 0x0a && signed.every((byte, i) => byte === current[start + i])
    ? current.subarray(0, end)
    : undefined;
}

function comparePage(signed: Page, current: Page, scale: number): Omit<ShadowFinding, 'page'> | undefined {
  const beforeContents = signed.Contents;
  const afterContents = current.Contents;
  const before = renderPageRgb(signed.Document, signed, scale, true, { contents: beforeContents, strict: true });
  const renderCurrent = (annotations: boolean, contents: Uint8Array) =>
    renderPageRgb(current.Document, current, scale, annotations, { contents, strict: true });
  const after = renderCurrent(true, afterContents);
  const change = classifyShadowAppearance(before, after);
  if (!change) return undefined;

  const prefix = retainedContentPrefix(beforeContents, afterContents);
  const candidates = [
    { annotations: false, contents: current.Annotations.length ? afterContents : undefined },
    { annotations: true, contents: prefix },
  ];
  const underlays: RgbImage[] = [];
  for (const { annotations, contents } of candidates) {
    if (contents === undefined) continue;
    try { underlays.push(renderCurrent(annotations, contents)); }
    catch (caught) {
      rethrowLimit(caught);
      // The full comparison still supplies a finding.
    }
  }
  return underlays.length ? classifyShadowAppearance(before, after, underlays) : change;
}

/** @internal Compare the signed pages in reading order, using a common sample
 *  scale for each pair and treating removed pages as hidden. */
export function compareShadowPages(signed: Document, current: Document): ShadowAnalysis {
  const result: ShadowAnalysis = { findings: [], skippedPages: [] };
  for (const page of signed.Pages) {
    const revised = current.Pages[page.Number - 1];
    if (!revised) {
      result.findings.push({ page: page.Number, kind: 'hide', overlay: false });
      continue;
    }
    const a = baseMatrix(page, 'crop'), b = baseMatrix(revised, 'crop');
    const sides = [a.width, a.height, b.width, b.height];
    if (sides.some((side) => !Number.isFinite(side) || side <= 0)) {
      result.skippedPages.push(page.Number);
      continue;
    }
    const scale = Math.min(1, MAX_PAGE_SIDE / Math.max(...sides));
    try {
      const change = comparePage(page, revised, scale);
      if (change) result.findings.push({ page: page.Number, ...change });
    } catch (caught) {
      rethrowLimit(caught);
      result.skippedPages.push(page.Number);
    }
  }
  return result;
}
