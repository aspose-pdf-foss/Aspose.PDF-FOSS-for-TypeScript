// A reusable Form XObject a caller authors: doc.NewTemplate(w, h) hands back a
// Template wrapping an OFF-TREE page, so every existing authoring API draws
// into it unchanged, and the first PlaceOn converts that page into a form.
//
// Direction note: compose.ts's importPageAsXObject also turns a page into a
// form, but for a page in ANOTHER document — it deep-copies the resource graph
// through importGraphInto. Used same-document that would duplicate every font
// and image a template touches, which is why the conversion here is its own.
import type { Document } from './document.js';
import { Page } from './page.js';
import { enc, escapeName } from './serialize.js';
import { name, type PdfDict, type PdfObject, type PdfRef } from './types.js';
import {
  appendContent, num, registerExtGState, registerXObjectRef,
} from './pagecontent.js';
import { IDENTITY, containMatrix, mul, placementMatrix, type Matrix } from './text.js';
import { markDrawing, validateMarkOptions, type MarkOptions } from './structwrite.js';

function positive(label: string, n: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0)
    throw new TypeError(`${label} must be a positive finite number`);
  return n;
}

/** Options for {@link Template.PlaceOn}. The marking fields are
 *  structwrite.ts's, so a placed template tags exactly as `AddBarcode` and
 *  `AddSVGObject` do. */
export interface PlaceOptions extends MarkOptions {
  /** `'stretch'` (default) fills `rect` exactly; `'contain'` scales uniformly
   *  and centres, preserving the template's aspect ratio. */
  fit?: 'stretch' | 'contain';
  /** Constant opacity 0..1 via an /ExtGState, as `AddImage` takes. Default 1. */
  opacity?: number;
  /** Rotation in DEGREES counter-clockwise about the rect's ORIGIN — the point
   *  `(rect[0], rect[1])` — matching what `stamp.ts` documents for `AddText`.
   *  Default 0. */
  rotation?: number;
}

/** A rotation of `degrees` counter-clockwise about the point (`x`, `y`).
 *
 *  Composed as translate(-x,-y) then rotate then translate(x,y); `mul(m, n)`
 *  applies `m` first. Getting the order wrong still produces something that
 *  looks rotated while moving the content off its rect entirely, which is why
 *  the test asserts that the pivot itself does not move. */
export function rotateAbout(x: number, y: number, degrees: number): Matrix {
  if (degrees === 0) return [...IDENTITY];
  const r = (degrees * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return mul(mul([1, 0, 0, 1, -x, -y], [c, s, -s, c, 0, 0]), [1, 0, 0, 1, x, y]);
}

/** A reusable piece of drawn content, placed on any number of pages from a
 *  single Form XObject. Build one with {@link Document.NewTemplate}. */
export class Template {
  /** @internal The page dict. Deliberately NOT allocated: the content streams
   *  and image XObjects that drawing allocates are real objects, and become
   *  reachable only through the form's /Resources once the template is placed.
   *  So an unplaced template contributes nothing to Save() — not because a
   *  sweep removes it, but because there was never an object to sweep. */
  private readonly dict: PdfDict;
  private readonly drawPage: Page;
  /** The built form, once {@link PlaceOn} has run. Its presence IS the frozen
   *  flag. */
  private form?: PdfRef;
  /** Content length at build time, for the stale-edit check. */
  private builtLength = 0;

  /** @internal Use {@link Document.NewTemplate}. */
  constructor(
    private readonly doc: Document,
    readonly width: number,
    readonly height: number,
  ) {
    positive('template width', width);
    positive('template height', height);
    this.dict = new Map<string, PdfObject>([
      ['Type', name('Page')],
      ['MediaBox', [0, 0, width, height]],
      ['CropBox', [0, 0, width, height]],
      ['Resources', new Map<string, PdfObject>()],
    ]);
    // Number 0: it has no position in a document that does not contain it.
    this.drawPage = new Page(doc, this.dict, 0);
  }

  /** The page to draw the template's content into, in template space
   *  (`[0, 0, width, height]`). Every ordinary authoring API works on it.
   *
   *  Throws once the template has been placed: the form is built on the first
   *  {@link PlaceOn} and cannot change afterwards. Silently ignoring the edit
   *  is the failure mode worth spending a throw on — it reads as the drawing
   *  call being broken rather than as a lifecycle mistake.
   *
   *  Note that logical structure inside a template is NOT supported: a `tag:`
   *  or `MarkContent` here would write /Pg references to a page that is never
   *  written to the file. Tag the *placement* instead. */
  get page(): Page {
    if (this.form !== undefined)
      throw new TypeError(
        'this template has already been placed and can no longer be drawn into; '
        + 'build a second template');
    return this.drawPage;
  }

  /** Build the form on first use, and check for a stale edit afterwards. */
  private built(): PdfRef {
    const body = this.drawPage.Contents;
    if (this.form !== undefined) {
      // The `page` getter cannot intercept a Page the caller already stashed,
      // so this catches "edited through that reference, then placed again".
      if (body.length !== this.builtLength)
        throw new TypeError(
          'this template was modified after it was placed; a template is frozen '
          + 'by its first PlaceOn');
      return this.form;
    }
    // An empty template would allocate a form that paints nothing wherever it
    // is used.
    if (body.length === 0)
      throw new TypeError('a template must draw something before it is placed');

    const resources = this.dict.get('Resources') ?? new Map<string, PdfObject>();
    // No /Matrix: identity is the PDF default, and the template page's own
    // space already IS the template's space. compose.ts writes one only
    // because it must honour a source page's /Rotate.
    const dict: PdfDict = new Map<string, PdfObject>([
      ['Type', name('XObject')],
      ['Subtype', name('Form')],
      ['FormType', 1],
      ['BBox', [0, 0, this.width, this.height]],
      ['Resources', resources],
    ]);
    this.form = this.doc.allocObject({ kind: 'stream', dict, raw: body });
    this.builtLength = body.length;
    return this.form;
  }

  /** Draw this template onto `page` inside `rect` (`[x, y, w, h]`). Builds the
   *  form on the first call and freezes the template.
   *
   *  The same template may be placed any number of times, on any number of
   *  pages of this document, and costs one Form XObject in total. */
  PlaceOn(
    page: Page, rect: [number, number, number, number], opts: PlaceOptions = {},
  ): void {
    checkRect(rect);
    checkPlaceOptions(opts);
    validateMarkOptions(opts);
    const ref = this.built();
    // placementMatrix and containMatrix take CORNERS, not width/height — they
    // normalize with Math.min/Math.max, so a w/h pair silently places the form
    // in the wrong rect at the wrong size. Convert once, here.
    const corners = [rect[0], rect[1], rect[0] + rect[2], rect[1] + rect[3]];
    const bbox = [0, 0, this.width, this.height];
    const base = opts.fit === 'contain'
      ? containMatrix(bbox, IDENTITY, corners)
      : placementMatrix(bbox, IDENTITY, corners);
    if (base === undefined) return;   // unreachable: checkRect requires w,h > 0
    const place = opts.rotation
      ? mul(base, rotateAbout(rect[0], rect[1], opts.rotation))
      : base;

    const key = registerXObjectRef(this.doc, page, ref);
    const parts = ['q'];
    if (opts.opacity !== undefined && opts.opacity < 1)
      parts.push(`/${escapeName(registerExtGState(this.doc, page, opts.opacity))} gs`);
    parts.push(`${place.map(num).join(' ')} cm`);
    parts.push(`/${escapeName(key)} Do`);
    parts.push('Q');
    const body = enc(parts.join('\n'));
    appendContent(this.doc, page, markDrawing(this.doc, page, body, opts));
  }
}

function checkPlaceOptions(opts: PlaceOptions): void {
  if (opts.fit !== undefined && opts.fit !== 'stretch' && opts.fit !== 'contain')
    throw new TypeError("fit must be 'stretch' or 'contain'");
  if (opts.opacity !== undefined &&
      (typeof opts.opacity !== 'number' || !Number.isFinite(opts.opacity)
       || opts.opacity < 0 || opts.opacity > 1))
    throw new TypeError('opacity must be in 0..1');
  if (opts.rotation !== undefined &&
      (typeof opts.rotation !== 'number' || !Number.isFinite(opts.rotation)))
    throw new TypeError('rotation must be a finite number');
}

/** Module-private: nothing outside template.ts validates a placement rect. */
function checkRect(rect: [number, number, number, number]): void {
  if (!Array.isArray(rect) || rect.length !== 4 || !rect.every((n) => Number.isFinite(n)))
    throw new TypeError('rect must be [x, y, w, h] of finite numbers');
  if (!(rect[2] > 0) || !(rect[3] > 0))
    throw new TypeError('rect width and height must be positive');
}
