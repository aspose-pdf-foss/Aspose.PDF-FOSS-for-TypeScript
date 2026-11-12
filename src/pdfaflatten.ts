// Opt-in PDF/A-1 flattening. The entire affected page is the compositing region:
// retaining the complete backdrop is essential for non-Normal blend modes.
import type { Document } from './document.js';
import type { OperationContext, OperationSteps } from './operation.js';
import type { ConvertAction } from './conversion.js';
import { PdfDict, PdfObject, isArray, isDict, isName, isRef, isStream, name } from './types.js';
import { usesTransparency } from './pdfatransparency.js';
import { visitContent, mul, invert, type GlyphEvent, type Matrix } from './text.js';
import { renderPageRgb } from './raster.js';
import { GlyphlessCodes, createGlyphlessFont, GLYPHLESS_ADVANCE } from './glyphless.js';
import { num } from './pagecontent.js';
import { encodeStream } from './filters.js';
import { srgbIcc } from './srgb.js';

/** Validate before any conversion pass mutates the document. */
export function resolveFlattenTransparency(value: unknown): number | undefined {
  if (value === undefined || value === false) return undefined;
  if (value !== true && (value === null || typeof value !== 'object' || Array.isArray(value)))
    throw new TypeError('flattenTransparency must be a boolean or { dpi }');
  const dpi = value === true ? 150 : (value as { dpi?: unknown }).dpi ?? 150;
  if (typeof dpi !== 'number') throw new TypeError('flattenTransparency.dpi must be a number');
  if (!(dpi > 0 && dpi <= 1200)) throw new RangeError('flattenTransparency.dpi must be in (0, 1200]');
  return dpi;
}

/** The same Root/Info reachability as Save, without copying/renumbering objects.
 *  Direct containers are visited once too, so shared and cyclic maps are safe. */
function reachable(doc: Document): Set<number> {
  const refs = new Set<number>(), containers = new Set<object>();
  const stack = [doc.trailer.get('Root'), doc.trailer.get('Info')];
  while (stack.length) {
    const o = stack.pop();
    if (isRef(o)) {
      if (refs.has(o.num)) continue;
      refs.add(o.num); stack.push(doc.resolve(o)); continue;
    }
    const c = isStream(o) ? o.dict : o;
    if (!isArray(c) && !isDict(c)) continue;
    if (containers.has(c)) continue;
    containers.add(c);
    for (const v of isArray(c) ? c : c.values()) stack.push(v);
  }
  return refs;
}

/** Does a descendant leaf still inherit this node's Resources? A nearer
 *  Resources entry shadows it for that entire branch. */
function inheritedByLeaf(doc: Document, kids: PdfObject[]): boolean {
  const stack = [...kids], seen = new Set<PdfDict>();
  while (stack.length) {
    const d = doc.resolve(stack.pop());
    if (!isDict(d) || seen.has(d)) continue;
    seen.add(d);
    if (d.has('Resources')) continue;
    const children = doc.resolve(d.get('Kids'));
    if (!isArray(children)) return true;
    stack.push(...children);
  }
  return false;
}

function detachUnusedInheritedResources(doc: Document): void {
  const stack = [doc.catalog().get('Pages')], seen = new Set<PdfDict>();
  while (stack.length) {
    const d = doc.resolve(stack.pop());
    if (!isDict(d) || seen.has(d)) continue;
    seen.add(d);
    const kids = doc.resolve(d.get('Kids'));
    if (!isArray(kids)) continue;
    if (d.has('Resources') && !inheritedByLeaf(doc, kids)) d.delete('Resources');
    stack.push(...kids);
  }
}

/** Replacing Resources must not bypass a caller's PostScript preservation.
 *  Walk indirect/nested resources conservatively, including unused entries. */
function hasPostScript(doc: Document, resources: PdfDict | undefined): boolean {
  const stack: (PdfObject | undefined)[] = [resources], seen = new Set<object>();
  while (stack.length) {
    const o = doc.resolve(stack.pop());
    if (isStream(o)) {
      const sub = doc.resolve(o.dict.get('Subtype'));
      if (isName(sub) && sub.name === 'PS') return true;
    }
    const c = isStream(o) ? o.dict : o;
    if ((!isArray(c) && !isDict(c)) || seen.has(c)) continue;
    seen.add(c);
    for (const v of isArray(c) ? c : c.values()) stack.push(v);
  }
  return false;
}

/** An appearance without its own Resources falls back to the page's. Replacing
 *  that context would change live ink, including rollover/down states. Decline
 *  instead of modifying appearances that may be shared by other pages. */
function inheritsAppearanceResources(doc: Document, annots: PdfObject | undefined): boolean {
  const annotations = doc.resolve(annots);
  if (!isArray(annotations)) return false;
  const stack: PdfObject[] = [], seen = new Set<object>();
  for (const entry of annotations) {
    const annot = doc.resolve(entry);
    const ap = isDict(annot) ? doc.resolve(annot.get('AP')) : undefined;
    if (isDict(ap)) stack.push(...ap.values());
  }
  while (stack.length) {
    const value = doc.resolve(stack.pop());
    if (isStream(value)) {
      if (!isDict(doc.resolve(value.dict.get('Resources')))) return true;
    } else if (isDict(value) && !seen.has(value)) {
      seen.add(value);
      stack.push(...value.values());
    }
  }
  return false;
}

/** Reconstruct pen spans through an embedded glyphless font. Glyph outlines
 *  have already been rendered; render mode 3 keeps Unicode and geometry only.
 *  New per-glyph matrices preserve rise, rotation, advances and form placement. */
function textLayer(glyphs: GlyphEvent[], codes: GlyphlessCodes): string {
  let body = 'BT\n/Text 1 Tf\n3 Tr\n';
  for (const g of glyphs) {
    if (!g.text) continue;
    const cs = codes.encode(g.text);
    const natural = GLYPHLESS_ADVANCE / 1000 * cs.length;
    const m = mul(g.tm, g.ctm);
    const x = g.quad[0], y = g.quad[1];
    // Keep the baseline direction independent of pen advance. Combining glyphs
    // can advance zero (and spacing can make an advance negative); encoding
    // that in the matrix itself would lose or reverse the original angle.
    const axisScale = Math.abs(g.tfSize) || 1;
    const tm: Matrix = [
      m[0] * axisScale, m[1] * axisScale,
      m[2] * g.tfSize, m[3] * g.tfSize, x, y,
    ];
    const axisLength = tm[0] ** 2 + tm[1] ** 2;
    const hscale = axisLength === 0 ? 0
      : ((g.penEnd[0] - x) * tm[0] + (g.penEnd[1] - y) * tm[1]) / axisLength / natural * 100;
    if (!tm.every(Number.isFinite) || !Number.isFinite(hscale))
      throw new RangeError('flattenTransparency: invalid text geometry');
    const hex = cs.map((c) => c.toString(16).padStart(4, '0')).join('');
    body += `${num(hscale)} Tz ${tm.map(num).join(' ')} Tm <${hex}> Tj\n`;
  }
  return body + 'ET\n';
}

/** @internal Each page is completely installed, including ToUnicode, before
 *  yielding. Finally cleans up newly orphaned assets even after cancellation. */
export function* flattenTransparencySteps(
  doc: Document, dpi: number, context: OperationContext,
  preserve: ReadonlySet<string> = new Set(),
): OperationSteps<ConvertAction[]> {
  const before = reachable(doc), actions: ConvertAction[] = [];
  let changed = false, completed = 0;
  const pages = doc.Pages;
  try {
    for (const page of pages) {
      pageUnit: {
        if (!usesTransparency(page.Resources, (o) => doc.resolve(o))) break pageUnit;
        // A bitmap freezes the visible optional-content configuration and
        // removes its hidden content; retain the original if layers were kept.
        if (preserve.has('optionalContent') && doc.catalog().has('OCProperties')) break pageUnit;
        if (preserve.has('postScript') && hasPostScript(doc, page.Resources)) break pageUnit;
        if (inheritsAppearanceResources(doc, page.Dict.get('Annots'))) break pageUnit;
        if (page.Dict.has('StructParents')) break pageUnit;
        const glyphs: GlyphEvent[] = [];
        let tagged = false, vertical = false;
        visitContent(doc, page, {
          glyph: (g) => { glyphs.push(g); if (g.vertical) vertical = true; },
          marked: () => { tagged = true; },
        }, { skipHidden: true });
        // The existing glyphless font is Identity-H. Re-encoding Identity-V
        // through it would lose writing mode and can produce singular matrices.
        if (tagged || vertical) break pageUnit;
        const codes = new GlyphlessCodes(), layer = textLayer(glyphs, codes);
        // Keep annotations live; rendering them here would duplicate their ink.
        const { width, height, rgb, device } = renderPageRgb(doc, page, dpi / 72, false);
        const m = mul([width, 0, 0, -height, 0, height], invert(device));
        const image = encodeStream(rgb, 'FlateDecode', new Map<string, PdfObject>([
          ['Type', name('XObject')], ['Subtype', name('Image')], ['Width', width], ['Height', height],
          ['BitsPerComponent', 8],
        ]));
        // The renderer emits sRGB samples even for a custom non-RGB output
        // intent. Tag this image rather than calling those samples DeviceCMYK.
        const profile = doc.allocObject(encodeStream(srgbIcc(), 'FlateDecode', new Map<string, PdfObject>([['N', 3]])));
        image.dict.set('ColorSpace', [name('ICCBased'), profile]);
        const resources: PdfDict = new Map([['XObject', new Map([['Raster', doc.allocObject(image)]])]]);
        if (codes.maxCode) {
          const font = createGlyphlessFont((o) => doc.allocObject(o), (r, o) => doc.replaceObject(r.num, o));
          font.finish(codes);
          resources.set('Font', new Map([['Text', font.font]]));
        }
        const body = `q ${m.map(num).join(' ')} cm /Raster Do Q\n${codes.maxCode ? layer : ''}`;
        const content = doc.allocObject(encodeStream(new TextEncoder().encode(body), 'FlateDecode'));
        page.Dict.set('Contents', content);
        page.Dict.set('Resources', resources);
        page.Dict.delete('Group');
        changed = true;
        actions.push({ rule: 'Transparency', page,
          action: `Rasterized the complete page at ${dpi} DPI; retained ${glyphs.length} invisible text glyphs.` });
      }
      yield context.progress('transparency-pages', ++completed, pages.length, page.Number);
    }
  } finally {
    if (changed) {
      detachUnusedInheritedResources(doc);
      const after = reachable(doc);
      // Existing unrelated orphans are deliberately left alone. Other pages,
      // annotations, structure trees and Info can retain shared old assets.
      for (const n of before) if (!after.has(n)) doc.deleteObject(n);
    }
  }
  return actions;
}
