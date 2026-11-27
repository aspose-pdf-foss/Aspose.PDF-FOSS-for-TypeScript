// Selected-page and PDF/A-1 flattening. The entire affected page is the compositing region:
// retaining the complete backdrop is essential for non-Normal blend modes.
import type { Document } from './document.js';
import type { OperationContext, OperationSteps } from './operation.js';
import type { OperationControlOptions } from './checkpoint.js';
import type { ConvertAction } from './conversion.js';
import type { Page } from './page.js';
import { hasSignatureField } from './signature.js';
import { resolvePages } from './pagerange.js';
import { PdfDict, PdfObject, isArray, isDict, isName, isRef, isStream, name } from './types.js';
import { usesTransparency } from './pdfatransparency.js';
import { visitContent, mul, invert, type GlyphEvent, type Matrix } from './text.js';
import { renderPageRgb } from './raster.js';
import { GlyphlessCodes, createGlyphlessFont, GLYPHLESS_ADVANCE } from './glyphless.js';
import { num } from './pagecontent.js';
import { encodeStream } from './filters.js';
import { srgbIcc } from './srgb.js';
import { serializeValue } from './serialize.js';

export interface FlattenTransparencyOptions extends OperationControlOptions {
  /** One-based selection, defaulting to all pages. */
  pages?: number[] | string;
  /** Raster resolution in (0, 1200]. Default 150. */
  dpi?: number;
  /** Write an invisible searchable text layer. Default true. */
  retainText?: boolean;
}

type SkipReason = 'signature-field' | 'no-transparency' | 'tagged-page' | 'annotation-resources';

export interface FlattenTransparencyReport {
  affected: number[];
  skipped: { page: number; reason: SkipReason }[];
}

/** Validate before any conversion pass mutates the document. */
export function resolveFlattenTransparency(value: unknown): number | undefined {
  if (value === undefined || value === false) return undefined;
  if (value !== true && (value === null || typeof value !== 'object' || Array.isArray(value)))
    throw new TypeError('flattenTransparency must be a boolean or { dpi }');
  return flattenDpi(value === true ? 150 : (value as { dpi?: unknown }).dpi ?? 150);
}

function flattenDpi(dpi: unknown): number {
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
function textLayer(glyphs: GlyphEvent[], codes: GlyphlessCodes, verticalCodes: GlyphlessCodes): string {
  let body = 'BT\n3 Tr\n';
  for (const g of glyphs) {
    if (!g.text) continue;
    const m = mul(g.tm, g.ctm);
    if (g.vertical) {
      const code = verticalCodes.encodeGlyph(g.text, g.advance);
      // The vertical quad is centred on the starting pen and spans its two
      // Y positions. Recover that pen including rise, regardless of advance
      // sign. Preserve Tf and the matrix bases so cell width and size survive.
      const tm: Matrix = [m[0], m[1], m[2], m[3],
        (g.quad[0] + g.quad[2]) / 2, g.quad[1] + g.quad[3] - g.penEnd[1]];
      // emitGlyphs folds spacing into advance except at size zero, where only
      // spacing can move the pen. Word spacing applies to a one-byte 0x20.
      const spacing = g.tfSize === 0
        ? g.charSpacing + (g.byteLen === 1 && g.code === 0x20 ? g.wordSpacing : 0) : 0;
      if (!tm.every(Number.isFinite) || !Number.isFinite(g.tfSize) || !Number.isFinite(spacing))
        throw new RangeError('flattenTransparency: invalid text geometry');
      // Tf and matrix factors can compensate each other. Six-decimal display
      // rounding could turn a normal-sized selection cell into a zero matrix.
      body += `/TextV ${serializeValue(g.tfSize)} Tf 100 Tz ${serializeValue(spacing)} Tc 0 Tw ` +
        `${tm.map(serializeValue).join(' ')} Tm <${code.toString(16).padStart(4, '0')}> Tj\n`;
      continue;
    }
    const cs = codes.encode(g.text);
    const natural = GLYPHLESS_ADVANCE / 1000 * cs.length;
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
    body += `/Text 1 Tf 0 Tc 0 Tw ${num(hscale)} Tz ${tm.map(num).join(' ')} Tm <${hex}> Tj\n`;
  }
  return body + 'ET\n';
}

/** Return the number of glyphs retained or the reason the page was skipped. */
function flattenPage(
  doc: Document, page: Page, dpi: number, retainText: boolean, prepareFonts?: () => void,
): number | Exclude<SkipReason, 'signature-field'> {
  if (!usesTransparency(page.Resources, (o) => doc.resolve(o))) return 'no-transparency';
  if (page.Dict.has('StructParents')) return 'tagged-page';
  if (inheritsAppearanceResources(doc, page.Dict.get('Annots'))) return 'annotation-resources';
  const glyphs: GlyphEvent[] = [];
  const collect = (g: GlyphEvent) => { glyphs.push(g); };
  // Structure links can target a Form in an OFF layer. Scan all drawn Forms
  // for MCIDs, but keep only visible glyphs in the searchable layer.
  const separateGlyphPass = retainText && (prepareFonts !== undefined || doc.catalog().has('OCProperties'));
  let tagged = false;
  visitContent(doc, page, {
    glyph: retainText && !separateGlyphPass ? collect : undefined,
    marked: () => { tagged = true; },
  });
  if (tagged) return 'tagged-page';
  prepareFonts?.();
  if (separateGlyphPass) visitContent(doc, page, { glyph: collect }, { skipHidden: true });
  const codes = new GlyphlessCodes(), verticalCodes = new GlyphlessCodes();
  const layer = glyphs.length ? textLayer(glyphs, codes, verticalCodes) : '';
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
  const fonts: PdfDict = new Map();
  for (const [key, assigned, vertical] of [['Text', codes, false], ['TextV', verticalCodes, true]] as const) {
    if (!assigned.maxCode) continue;
    const font = createGlyphlessFont((o) => doc.allocObject(o), (r, o) => doc.replaceObject(r.num, o), vertical);
    font.finish(assigned);
    fonts.set(key, font.font);
  }
  if (fonts.size) resources.set('Font', fonts);
  const body = `q ${m.map(num).join(' ')} cm /Raster Do Q\n${fonts.size ? layer : ''}`;
  const content = doc.allocObject(encodeStream(new TextEncoder().encode(body), 'FlateDecode'));
  page.Dict.set('Contents', content);
  page.Dict.set('Resources', resources);
  page.Dict.delete('Group');
  return glyphs.length;
}

function inheritedResourceOwner(doc: Document, page: Page): PdfDict | undefined {
  let node = page.Dict;
  const seen = new Set<PdfDict>();
  while (!node.has('Resources')) {
    const parent = doc.resolve(node.get('Parent'));
    if (!isDict(parent) || seen.has(parent)) return undefined;
    seen.add(parent);
    node = parent;
  }
  return node === page.Dict ? undefined : node;
}

export function* flattenSelectedTransparency(
  doc: Document, options: FlattenTransparencyOptions, context: OperationContext, prepareFonts?: () => void,
): OperationSteps<FlattenTransparencyReport> {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('options must be an object');
  const { pages, dpi = 150, retainText = true } = options;
  flattenDpi(dpi);
  if (typeof retainText !== 'boolean') throw new TypeError('retainText must be a boolean');
  const selected = resolvePages(pages, doc.Pages.length);
  const report: FlattenTransparencyReport = { affected: [], skipped: [] };
  if (!selected.length) return report;
  if (hasSignatureField(doc)) {
    report.skipped = selected.map(page => ({ page, reason: 'signature-field' }));
    return report;
  }

  const owners = new Set<PdfDict>();
  let completed = 0;
  try {
    for (const n of selected) {
      const page = doc.Pages[n - 1], owner = inheritedResourceOwner(doc, page);
      const outcome = flattenPage(doc, page, dpi, retainText, prepareFonts);
      if (typeof outcome === 'number') {
        prepareFonts = undefined;
        report.affected.push(n);
        if (owner) owners.add(owner);
      } else {
        report.skipped.push({ page: n, reason: outcome });
      }
      yield context.progress('transparency-pages', ++completed, selected.length, n);
    }
  } finally {
    // Keep detached objects available to live authoring handles. Save sweeps
    // any that the caller did not reuse.
    for (const owner of owners) {
      const kids = doc.resolve(owner.get('Kids'));
      if (isArray(kids) && !inheritedByLeaf(doc, kids)) owner.delete('Resources');
    }
  }
  return report;
}

/** PDF/A validates all objects, so it also prunes newly orphaned assets. */
export function* flattenTransparencySteps(
  doc: Document, dpi: number, context: OperationContext, preserve: ReadonlySet<string>,
): OperationSteps<ConvertAction[]> {
  const before = reachable(doc), actions: ConvertAction[] = [];
  const pages = doc.Pages;
  let completed = 0;
  try {
    for (const page of pages) {
      if (!(preserve.has('optionalContent') && doc.catalog().has('OCProperties'))
          && !(preserve.has('postScript') && hasPostScript(doc, page.Resources))) {
        const glyphs = flattenPage(doc, page, dpi, true);
        if (typeof glyphs === 'number') actions.push({ rule: 'Transparency', page,
          action: `Rasterized the complete page at ${dpi} DPI; retained ${glyphs} invisible text glyphs.` });
      }
      yield context.progress('transparency-pages', ++completed, pages.length, page.Number);
    }
  } finally {
    if (actions.length) {
      detachUnusedInheritedResources(doc);
      const after = reachable(doc);
      for (const n of before) if (!after.has(n)) doc.deleteObject(n);
    }
  }
  return actions;
}
