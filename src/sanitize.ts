// Hidden-data sanitization (`74mf.1`): one call that removes what a document
// carries beyond what it shows, and says what it removed.
//
// It COMPOSES the existing removals rather than re-deriving them — layers go
// through `ocflatten.ts`, forms through `flatten.ts`, attachments through
// `embeddedfile.ts`, annotations through `Page.RemoveAnnotation` (which untags
// them) and metadata through `Document.ClearMetadata`. What is new here is the
// order, the action sweep, and the report.
import type { Document } from './document.js';
import type { Page } from './page.js';
import { PdfDict, PdfObject, isArray, isDict, isName, isStream, name } from './types.js';
import { UnsupportedFeatureError } from './errors.js';
import { hasSignatureField } from './signature.js';
import { flattenForm } from './flatten.js';
import { flattenLayers, type FlattenLayersReport } from './ocflatten.js';
import { collectNameTree } from './nametree.js';
import { removeEmbeddedFile } from './embeddedfile.js';
import { renderPageRgb } from './raster.js';
import { encodeJpeg } from './jpegencode.js';
import { deflateSync } from 'node:zlib';
import { invert, mul, type Matrix } from './text.js';
import { num } from './pagecontent.js';

/** What `Document.Sanitize` removes. Every toggle defaults to `true` — pass
 *  `false` to keep that category — except `pagesToImages`, which is lossy and
 *  defaults to `false`. */
export interface SanitizeOptions {
  /** The `/Info` dictionary and every XMP packet: the catalog's and any
   *  object-level `/Metadata` (a page's, an image's, a font's). */
  metadata?: boolean;
  /** Every action: document-level JavaScript, `/OpenAction`, the catalog's,
   *  pages', annotations' and fields' `/AA`, and the `/A` of every annotation
   *  and outline item. A GoTo action on a link or bookmark becomes a plain
   *  `/Dest`, so navigation survives and the action does not. */
  actions?: boolean;
  /** Embedded files: the `/EmbeddedFiles` name tree, the catalog `/AF`, every
   *  `/FileAttachment` annotation, and a portfolio's `/Collection`. */
  attachments?: boolean;
  /** Every annotation except form widgets (which `forms` governs) and file
   *  attachments (which `attachments` governs) — comments, markup, stamps and
   *  links alike. Removed, not flattened: their ink leaves the page. */
  annotations?: boolean;
  /** Flatten the interactive form: field values are baked into page content
   *  and `/AcroForm` is removed. */
  forms?: boolean;
  /** Flatten optional content: hidden layers are DELETED and the visible ones
   *  become ordinary content. See `Document.FlattenLayers`. */
  layers?: boolean;
  /** Data a viewer never shows: `/PieceInfo` page-piece dictionaries
   *  (catalog, page and form XObject — where producers keep private
   *  application data, and where Acrobat embeds a search index) with the `/LastModified` stamp beside each, page
   *  `/Thumb` thumbnails, web-capture data (catalog `/SpiderInfo`, page
   *  `/ID`), and the catalog `/Perms` permissions dictionary, which is how
   *  Reader usage rights (`/UR3`) are granted. */
  privateData?: boolean;
  /** Replace every page's content with a rendering of it — the one category
   *  that removes what a page HIDES IN ITS OWN CONTENT: white-on-white text,
   *  text under an image, glyphs clipped away, anything outside the crop box.
   *  OFF by default, because it is lossy: the page stops having text, vectors
   *  and fonts. `true` uses the defaults; an object chooses `dpi` (default
   *  150, at most 1200), `format` (`'flate'`, lossless, the default, or
   *  `'jpeg'`) and `quality` (1..100, JPEG only, default 75).
   *
   *  No text layer is kept. A layer derived from the page's own text would
   *  carry exactly the hidden text this option exists to remove, so follow
   *  with `doc.MakeSearchable(engine)`, which OCRs the rendering — every
   *  converted page is image-only, so it reads them all. */
  pagesToImages?: boolean | PagesToImagesOptions;
}

/** How `pagesToImages` renders. */
export interface PagesToImagesOptions {
  /** Render resolution. Default 150; at most 1200. */
  dpi?: number;
  /** `'flate'` (lossless, default) or `'jpeg'`. */
  format?: 'flate' | 'jpeg';
  /** JPEG quality 1..100; only with `format: 'jpeg'`. Default 75. */
  quality?: number;
}

/** What each toggle removed; a section is `undefined` when its toggle was off,
 *  so "not asked" reads differently from "nothing found". */
export interface SanitizeReport {
  metadata: {
    /** An `/Info` dictionary was removed. */
    info: boolean;
    /** XMP packets removed: the catalog's plus every object-level one. */
    xmp: number;
  } | undefined;
  actions: {
    /** A catalog `/OpenAction` was removed. */
    openAction: boolean;
    /** Entries of the `/Names /JavaScript` tree removed. */
    documentJavaScripts: number;
    /** `/AA` dictionaries removed — catalog, pages, annotations, fields. */
    additionalActions: number;
    /** `/A` actions removed outright from annotations and outline items. */
    actions: number;
    /** GoTo actions replaced by the `/Dest` they named. */
    convertedToDestinations: number;
  } | undefined;
  attachments: {
    /** Files removed from the `/EmbeddedFiles` tree and the catalog `/AF`. */
    embeddedFiles: number;
    /** `/FileAttachment` annotations removed. */
    fileAttachmentAnnotations: number;
    /** A portfolio `/Collection` was removed. */
    collection: boolean;
  } | undefined;
  annotations: {
    /** Annotations removed. */
    removed: number;
  } | undefined;
  forms: {
    /** Widgets baked into page content. */
    widgets: number;
  } | undefined;
  layers: FlattenLayersReport | undefined;
  privateData: {
    /** `/PieceInfo` dictionaries removed, on any object. */
    pieceInfo: number;
    /** Page `/Thumb` thumbnails removed. */
    thumbnails: number;
    /** Web-capture entries removed: the catalog `/SpiderInfo` and page `/ID`s. */
    webCapture: number;
    /** A catalog `/Perms` was removed. */
    permissions: boolean;
    /** Acrobat's embedded search index was among the removed `/PieceInfo`:
     *  the catalog's `/PieceInfo /SearchIndex`, which carries the word index
     *  of the document's text. */
    searchIndex: boolean;
  } | undefined;
  pagesToImages: {
    /** Pages replaced by their rendering. */
    pages: number;
    /** The resolution they were rendered at. */
    dpi: number;
    /** The structure tree was removed: its marked content no longer exists. */
    structureRemoved: boolean;
  } | undefined;
}

const TOGGLES = [
  'metadata', 'actions', 'attachments', 'annotations', 'forms', 'layers', 'privateData',
] as const;

/** Validate the whole option bag before anything changes. An unknown key is a
 *  TypeError rather than ignored: `{ metaData: false }` silently sanitizing
 *  the metadata the caller asked to keep is the worst way for a typo to fail. */
interface Resolved extends Required<Omit<SanitizeOptions, 'pagesToImages'>> {
  pagesToImages: Required<PagesToImagesOptions> | undefined;
}

/** `pagesToImages`, validated: `undefined` when off. */
function resolveRaster(v: unknown): Required<PagesToImagesOptions> | undefined {
  if (v === undefined || v === false) return undefined;
  if (v === true) v = {};
  if (v === null || typeof v !== 'object' || Array.isArray(v))
    throw new TypeError('Sanitize: pagesToImages must be a boolean or an object');
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o))
    if (!['dpi', 'format', 'quality'].includes(k))
      throw new TypeError(`Sanitize: unknown pagesToImages option '${k}'`);
  const dpi = o.dpi ?? 150;
  if (typeof dpi !== 'number') throw new TypeError('Sanitize: pagesToImages.dpi must be a number');
  if (!(dpi > 0 && dpi <= 1200)) throw new RangeError(`Sanitize: pagesToImages.dpi must be in (0, 1200]: ${dpi}`);
  const format = o.format ?? 'flate';
  if (format !== 'flate' && format !== 'jpeg')
    throw new RangeError(`Sanitize: pagesToImages.format must be 'flate' or 'jpeg': ${String(format)}`);
  // A quality with a lossless format would be accepted and mean nothing.
  if (o.quality !== undefined && format !== 'jpeg')
    throw new TypeError("Sanitize: pagesToImages.quality applies only to format 'jpeg'");
  const quality = o.quality ?? 75;
  if (typeof quality !== 'number') throw new TypeError('Sanitize: pagesToImages.quality must be a number');
  if (!(Number.isInteger(quality) && quality >= 1 && quality <= 100))
    throw new RangeError(`Sanitize: pagesToImages.quality must be an integer 1..100: ${quality}`);
  return { dpi, format, quality };
}

function resolveOptions(opts: SanitizeOptions): Resolved {
  if (opts === null || typeof opts !== 'object' || Array.isArray(opts))
    throw new TypeError('Sanitize: options must be an object');
  for (const k of Object.keys(opts)) {
    if (k === 'pagesToImages') continue;
    if (!(TOGGLES as readonly string[]).includes(k))
      throw new TypeError(`Sanitize: unknown option '${k}'`);
    const v = (opts as Record<string, unknown>)[k];
    if (v !== undefined && typeof v !== 'boolean')
      throw new TypeError(`Sanitize: option '${k}' must be a boolean`);
  }
  const out = { pagesToImages: resolveRaster(opts.pagesToImages) } as Resolved;
  for (const k of TOGGLES) out[k] = opts[k] ?? true;
  return out;
}

const subtypeOf = (doc: Document, annot: PdfDict): string | undefined => {
  const s = doc.resolve(annot.get('Subtype'));
  return isName(s) ? s.name : undefined;
};

/** The annotation dicts on `page`, resolved. */
function annotDicts(doc: Document, page: Page): PdfDict[] {
  const arr = doc.resolve(page.Dict.get('Annots'));
  if (!isArray(arr)) return [];
  return arr.map((e) => doc.resolve(e)).filter(isDict);
}

/** Remove every annotation on `page` that `pick` selects, with each one's
 *  `/Popup`: a popup left behind is a note window with nothing to annotate. */
function removeAnnots(doc: Document, page: Page, pick: (a: PdfDict) => boolean): number {
  const victims = annotDicts(doc, page).filter(pick);
  const popups = new Set<PdfDict>();
  for (const v of victims) {
    const p = doc.resolve(v.get('Popup'));
    if (isDict(p)) popups.add(p);
  }
  for (const v of victims) page.RemoveAnnotation(v);
  for (const p of popups) if (!victims.includes(p)) page.RemoveAnnotation(p);
  return victims.length;
}

/**
 * Remove hidden data from `doc` in place. See {@link SanitizeOptions} for what
 * each toggle covers and `Document.Sanitize` for the contract.
 */
export function sanitizeDocument(doc: Document, opts: SanitizeOptions = {}): SanitizeReport {
  const o = resolveOptions(opts);
  if (hasSignatureField(doc)) {
    throw new UnsupportedFeatureError(
      'Sanitize: the document is signed; removing anything would invalidate the signature',
    );
  }
  const report: SanitizeReport = {
    metadata: undefined, actions: undefined, attachments: undefined,
    annotations: undefined, forms: undefined, layers: undefined, privateData: undefined,
    pagesToImages: undefined,
  };

  // Layers go FIRST, so a widget or annotation a configuration hides is
  // deleted before the form flatten could bake it into page content. That one
  // ordering is reasoned rather than measured — no fixture hides a widget. The
  // rest is order-independent by construction: the annotation sweep never
  // touches a widget (`forms` owns those) or a file attachment (`attachments`
  // owns those), and the action and metadata sweeps only delete keys.
  if (o.layers) report.layers = flattenLayers(doc);

  if (o.forms) {
    report.forms = {
      widgets: doc.catalog().get('AcroForm') === undefined ? 0 : flattenForm(doc),
    };
  }

  if (o.annotations) {
    // Widgets belong to `forms` and file attachments to `attachments`, so
    // turning either of those off keeps them here too. A popup whose parent is
    // one of those kept annotations stays with its parent.
    const kept = (a: PdfDict): boolean => {
      const s = subtypeOf(doc, a);
      return s === 'Widget' || s === 'FileAttachment';
    };
    let removed = 0;
    for (const page of doc.Pages) {
      removed += removeAnnots(doc, page, (a) => {
        if (kept(a)) return false;
        if (subtypeOf(doc, a) === 'Popup') {
          const parent = doc.resolve(a.get('Parent'));
          if (isDict(parent) && kept(parent)) return false;
        }
        return true;
      });
    }
    report.annotations = { removed };
  }

  if (o.attachments) report.attachments = sanitizeAttachments(doc);
  // After the annotation sweeps, so what they removed is not rendered; the
  // render leaves annotations out entirely, since whatever survived them is
  // still drawn over the page and would otherwise be drawn twice.
  if (o.pagesToImages) report.pagesToImages = pagesToImages(doc, o.pagesToImages);
  if (o.actions) report.actions = sanitizeActions(doc);
  if (o.metadata) report.metadata = sanitizeMetadata(doc);
  if (o.privateData) report.privateData = sanitizePrivateData(doc);
  return report;
}

function sanitizeAttachments(doc: Document): NonNullable<SanitizeReport['attachments']> {
  const catalog = doc.catalog();
  let embeddedFiles = 0;
  const names = doc.resolve(catalog.get('Names'));
  if (isDict(names) && names.has('EmbeddedFiles')) {
    const entries: Array<[string, PdfObject]> = [];
    collectNameTree(doc, names.get('EmbeddedFiles'), entries);
    for (const [key] of entries) if (removeEmbeddedFile(doc, key)) embeddedFiles++;
    // A tree whose entries would not all remove by name (a duplicate key) still
    // goes: nothing here may survive under a name the walk could not address.
    if (names.has('EmbeddedFiles')) names.delete('EmbeddedFiles');
    if (names.size === 0) catalog.delete('Names');
  }
  // `/AF` may name files the tree does not — a PDF/A-3 associated file.
  const af = doc.resolve(catalog.get('AF'));
  if (isArray(af)) {
    embeddedFiles += af.filter((e) => { const d = doc.resolve(e); return isDict(d) && d.has('EF'); }).length;
    catalog.delete('AF');
  }
  let fileAttachmentAnnotations = 0;
  for (const page of doc.Pages)
    fileAttachmentAnnotations += removeAnnots(doc, page, (a) => subtypeOf(doc, a) === 'FileAttachment');
  const collection = catalog.has('Collection');
  if (collection) catalog.delete('Collection');
  if (embeddedFiles > 0 || collection) doc.markModified();
  return { embeddedFiles, fileAttachmentAnnotations, collection };
}

function sanitizeActions(doc: Document): NonNullable<SanitizeReport['actions']> {
  const r = {
    openAction: false, documentJavaScripts: 0, additionalActions: 0,
    actions: 0, convertedToDestinations: 0,
  };
  const catalog = doc.catalog();
  const seen = new Set<PdfDict>();
  const dropAA = (d: PdfDict): void => {
    if (seen.has(d)) return;
    seen.add(d);
    if (d.has('AA')) { d.delete('AA'); r.additionalActions++; }
  };
  // `/A` on a link or a bookmark. A GoTo names a destination inside the file,
  // which is not an action and can carry no script — keep THAT as `/Dest`, so
  // navigation survives, and drop the rest of the action (its `/Next` chain
  // included). Anything else goes outright.
  const dropA = (d: PdfDict): void => {
    if (!d.has('A')) return;
    const a = doc.resolve(d.get('A'));
    d.delete('A');
    const s = isDict(a) ? doc.resolve(a.get('S')) : undefined;
    const dest = isDict(a) ? a.get('D') : undefined;
    if (isName(s) && s.name === 'GoTo' && dest !== undefined && !d.has('Dest')) {
      d.set('Dest', dest);
      r.convertedToDestinations++;
    } else {
      r.actions++;
    }
  };

  if (catalog.has('OpenAction')) { catalog.delete('OpenAction'); r.openAction = true; }
  dropAA(catalog);
  const names = doc.resolve(catalog.get('Names'));
  if (isDict(names) && names.has('JavaScript')) {
    const entries: Array<[string, PdfObject]> = [];
    collectNameTree(doc, names.get('JavaScript'), entries);
    r.documentJavaScripts = entries.length;
    names.delete('JavaScript');
    if (names.size === 0) catalog.delete('Names');
  }

  for (const page of doc.Pages) {
    dropAA(page.Dict);
    for (const a of annotDicts(doc, page)) { dropA(a); dropAA(a); }
  }

  // Fields: a non-terminal node or a field whose widgets are separate dicts
  // carries its own `/AA` (keystroke, format, validate, calculate).
  const acro = doc.resolve(catalog.get('AcroForm'));
  const fields = isDict(acro) ? doc.resolve(acro.get('Fields')) : undefined;
  if (isArray(fields)) {
    const stack: PdfObject[] = [...fields];
    const visited = new Set<PdfDict>();
    while (stack.length) {
      const f = doc.resolve(stack.pop()!);
      if (!isDict(f) || visited.has(f)) continue;
      visited.add(f);
      dropAA(f);
      const kids = doc.resolve(f.get('Kids'));
      if (isArray(kids)) stack.push(...kids);
    }
  }

  const outlines = doc.resolve(catalog.get('Outlines'));
  if (isDict(outlines)) {
    const stack: PdfObject[] = [outlines.get('First') ?? null];
    const visited = new Set<PdfDict>();
    while (stack.length) {
      const item = doc.resolve(stack.pop()!);
      if (!isDict(item) || visited.has(item)) continue;
      visited.add(item);
      dropA(item);
      stack.push(item.get('Next') ?? null, item.get('First') ?? null);
    }
  }

  if (r.openAction || r.documentJavaScripts || r.additionalActions || r.actions
    || r.convertedToDestinations) doc.markModified();
  return r;
}

function sanitizeMetadata(doc: Document): NonNullable<SanitizeReport['metadata']> {
  const info = doc.trailer.has('Info');
  let xmp = doc.catalog().has('Metadata') ? 1 : 0;
  if (info || xmp > 0) doc.ClearMetadata();
  for (const [, obj] of doc.objectEntries()) {
    const d = isStream(obj) ? obj.dict : isDict(obj) ? obj : undefined;
    if (d?.has('Metadata')) { d.delete('Metadata'); xmp++; }
  }
  if (xmp > 0) doc.markModified();
  return { info, xmp };
}

// Every object is visited, not only what the catalog reaches: a form XObject's
// /PieceInfo is reached through /Resources, and enumerating every route there is
// is the walk the object map already is. Anything this deletes that only it
// referenced — a thumbnail image, a usage-rights signature — is then
// unreachable, and Save()'s mark-sweep drops it.
function sanitizePrivateData(doc: Document): NonNullable<SanitizeReport['privateData']> {
  const r = { pieceInfo: 0, thumbnails: 0, webCapture: 0, permissions: false, searchIndex: false };
  // Acrobat embeds a search index as the catalog's /PieceInfo /SearchIndex
  // (`74mf.5`, read off its Search.api plug-in), so the pass below already
  // removes it; this only names it in the report. A word index of the text is
  // the one piece of page-piece data whose presence a caller asks about.
  const piece = doc.resolve(doc.catalog().get('PieceInfo'));
  r.searchIndex = isDict(piece) && piece.has('SearchIndex');
  for (const [, obj] of doc.objectEntries()) {
    const d = isStream(obj) ? obj.dict : isDict(obj) ? obj : undefined;
    if (!d?.has('PieceInfo')) continue;
    d.delete('PieceInfo');
    // /LastModified exists to date the /PieceInfo beside it (32000-1 14.5); a
    // dict carrying one without the other is left alone.
    d.delete('LastModified');
    r.pieceInfo++;
  }
  for (const page of doc.Pages) {
    if (page.Dict.has('Thumb')) { page.Dict.delete('Thumb'); r.thumbnails++; }
    if (page.Dict.has('ID')) { page.Dict.delete('ID'); r.webCapture++; }
  }
  const catalog = doc.catalog();
  if (catalog.has('SpiderInfo')) { catalog.delete('SpiderInfo'); r.webCapture++; }
  if (catalog.has('Perms')) { catalog.delete('Perms'); r.permissions = true; }
  if (r.pieceInfo || r.thumbnails || r.webCapture || r.permissions) doc.markModified();
  return r;
}

/** Replace each page's content with its rendering. The page DICT is kept — its
 *  geometry, `/Rotate`, labels and every destination naming it stay valid —
 *  and only what it draws with is replaced. */
function pagesToImages(
  doc: Document, o: Required<PagesToImagesOptions>,
): NonNullable<SanitizeReport['pagesToImages']> {
  const scale = o.dpi / 72;
  let pages = 0;
  for (const page of doc.Pages) {
    const { width, height, rgb, device } = renderPageRgb(doc, page, scale, false);
    const jpeg = o.format === 'jpeg';
    const image = doc.allocObject({
      kind: 'stream',
      dict: new Map<string, PdfObject>([
        ['Type', name('XObject')], ['Subtype', name('Image')],
        ['Width', width], ['Height', height],
        ['ColorSpace', name('DeviceRGB')], ['BitsPerComponent', 8],
        ['Filter', name(jpeg ? 'DCTDecode' : 'FlateDecode')],
      ]),
      raw: jpeg
        ? encodeJpeg(width, height, rgb, 'rgb', { quality: o.quality })
        : new Uint8Array(deflateSync(rgb)),
    });
    // The image's unit square onto the pixel grid (y down), then pixels back to
    // page space through the inverse of the render's OWN page-to-pixel matrix.
    // One matrix for both directions is what lets a rotated page, or a crop box
    // off the origin, come back exactly where it was rendered from.
    const m: Matrix = mul([width, 0, 0, -height, 0, height], invert(device));
    const body = new TextEncoder().encode(`q ${m.map(num).join(' ')} cm /Im0 Do Q\n`);
    page.Dict.set('Contents', doc.allocObject({ kind: 'stream', dict: new Map(), raw: body }));
    page.Dict.set('Resources', new Map<string, PdfObject>([
      ['XObject', new Map<string, PdfObject>([['Im0', image]])],
    ]));
    // A transparency group described how the OLD content composited.
    page.Dict.delete('Group');
    page.Dict.delete('StructParents');
    pages++;
  }
  // Inherited /Resources on the tree's nodes now feed nothing — every page
  // states its own — and would keep the old fonts and forms in the file.
  const stack: PdfObject[] = [doc.catalog().get('Pages') ?? null];
  const seen = new Set<PdfDict>();
  while (stack.length) {
    const node = doc.resolve(stack.pop()!);
    if (!isDict(node) || seen.has(node)) continue;
    seen.add(node);
    const kids = doc.resolve(node.get('Kids'));
    if (!isArray(kids)) continue;
    node.delete('Resources');
    stack.push(...kids);
  }
  // Every MCID the tree points at was in content that no longer exists, and the
  // tree's own /Alt and /ActualText are hidden data in their own right.
  const catalog = doc.catalog();
  const structureRemoved = catalog.has('StructTreeRoot');
  if (structureRemoved) {
    catalog.delete('StructTreeRoot');
    catalog.delete('MarkInfo');
    for (const page of doc.Pages)
      for (const a of annotDicts(doc, page)) a.delete('StructParent');
  }
  if (pages > 0) doc.markModified();
  return { pages, dpi: o.dpi, structureRemoved };
}
