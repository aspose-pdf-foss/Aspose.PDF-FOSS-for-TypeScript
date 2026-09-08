import type { Document } from './document.js';
import { PdfDict, PdfObject, PdfStream, isArray, isDict, isStream } from './types.js';
import { inflateStream } from './flate.js';
import { ImageInfo, collectImages } from './image.js';
import { InlineImageInfo, collectInlineImages } from './inlineimage.js';
import { extractText, extractFragments, extractStructured, TextFragment, TextBlock } from './text.js';
import { searchText, replaceText, TextMatch, type SearchOptions } from './textedit.js';
import { searchAnnotations, searchAnnotationText, type AnnotationMatch, type AnnotationTextMatch } from './annotsearch.js';
import { measureText, stampText, stampTextBlock, StampOptions, TextBlockOptions, AuthoringFont } from './stamp.js';
import { isTextRunList, type TextRun } from './textdecor.js';
import { PageGraphics } from './graphics.js';
import { PageFormat } from './pageformat.js';
import {
  readTransition, readDuration, setTransition, setDuration, type PageTransition,
} from './pagetransition.js';
import { renderPageToSvg, SvgOptions } from './svgrender.js';
import { renderPageToHtml, HtmlOptions } from './html.js';
import { renderPageToDocx, type DocxOptions } from './docxexport.js';
import {
  renderPageToMarkdown, renderPageToMarkdownAssets,
  type MarkdownExportOptions, type MarkdownExportResult,
} from './mdexport.js';
import { renderPageToPng, ImageOptions } from './raster.js';
import { addImage, AddImageOptions } from './imageembed.js';
import { addBarcode, BarcodeSpec, AddBarcodeOptions } from './barcodeplace.js';
import { addSvgObject, AddSVGOptions, AddSVGResult } from './svgembed.js';
import { drawTable, AddTableOptions, AddTableResult } from './tablerender.js';
import { TableBuilder } from './tableauthor.js';
import { drawTOC, AddTOCResult } from './tocrender.js';
import type { TOCEntry, TOCOptions } from './toc.js';
import { redactPage, redactText, RedactOptions } from './redact.js';
import { applyRedactions, ApplyRedactionsOptions, markRedactText, MarkRedactTextOptions } from './redactapply.js';
import { flattenAnnotations } from './flatten.js';
import { stampWith, StampWithOptions, resizePage, scalePage, ResizeOptions } from './compose.js';
import type { Rect } from './text.js';
import { extractTables, type Table, type TableExtractOptions } from './table.js';
import { extractPaths, type PagePath } from './paths.js';
import { extractArtifacts, type PageArtifact } from './artifact.js';
import {
  Annotation, wrapAnnotation, addTextNote, TextAnnotation, TextNoteOptions,
  addStamp, StampAnnotation, StampAnnotationOptions,
  addHighlight, addUnderline, addStrikeOut, addSquiggly, MarkupAnnotation, MarkupOptions,
  addLink, LinkAnnotation, LinkOptions,
  addFileAttachment, FileAttachmentAnnotation, FileAttachmentOptions,
  addSquare, addCircle, SquareCircleAnnotation, SquareCircleOptions,
  addLine, LineAnnotation, LineOptions,
  addPolygon, addPolyline, PolyAnnotation, PolygonOptions, PolylineOptions,
  addInk, InkAnnotation, InkOptions,
  addFreeText, FreeTextAnnotation, FreeTextOptions,
  addPopup, PopupAnnotation, PopupOptions,
  addRedact, RedactAnnotation, RedactAnnotationOptions,
  addCaret, CaretAnnotation, CaretOptions,
} from './annotation.js';
import {
  addTextField, addCheckbox, addComboBox, addListBox, addPushButton,
  type TextFieldInit, type CheckboxInit, type ComboBoxInit, type ListBoxInit,
  type PushButtonInit,
} from './formcreate.js';
import type { TextField, CheckboxField, ChoiceField, ButtonField } from './formfield.js';
import { untagObjects } from './structwrite.js';
import { markdownElements, type AddMarkdownResult, type MarkdownFlowOptions } from './mdflow.js';
import { htmlElements, type AddHtmlResult, type HtmlFlowOptions } from './htmlflow.js';
import type { NotRendered } from './htmlreport.js';
import type { HtmlDocument } from './htmldom.js';
import { placeElements } from './flowplace.js';
import type { MdDocument } from './mdast.js';
import type { StructElement } from './struct.js';

/** Validate a rectangle and return a defensive copy. */
function checkBox(key: string, box: number[]): number[] {
  if (
    !Array.isArray(box) ||
    box.length !== 4 ||
    !box.every((x) => typeof x === 'number' && Number.isFinite(x))
  ) {
    throw new TypeError(`${key} must be [llx, lly, urx, ury] (4 finite numbers)`);
  }
  return [...box];
}

/** A single PDF page: a live, mutable handle over its real page dict. */
export class Page {
  constructor(
    private readonly doc: Document,
    /** The live page dict from the objects map (not a copy). */
    readonly Dict: PdfDict,
    /** 1-based position in document order. */
    readonly Number: number,
  ) {}

  /** @internal The owning document (used for cross-document page copy). */
  get Document(): Document {
    return this.doc;
  }

  /** Resolve an inheritable key: own dict, then up the /Parent chain (cycle-guarded). */
  private inherited(key: string): PdfObject {
    let node: PdfObject = this.Dict;
    const seen = new Set<PdfDict>();
    while (isDict(node)) {
      if (seen.has(node)) break;
      seen.add(node);
      if (node.has(key)) return this.doc.resolve(node.get(key));
      node = this.doc.resolve(node.get('Parent'));
    }
    return null;
  }

  private box(key: string, dflt: number[]): number[] {
    const b = this.inherited(key);
    if (isArray(b) && b.length === 4) {
      const nums = b.map((x) => this.doc.resolve(x)).filter((x): x is number => typeof x === 'number');
      if (nums.length === 4) return nums;
    }
    return dflt;
  }

  /** Page boundary [llx, lly, urx, ury]; inherited; defaults to US Letter. */
  get MediaBox(): number[] {
    return this.box('MediaBox', PageFormat.Letter.mediaBox());
  }

  /** Write /MediaBox into the page's own live dict (overrides any inherited value). */
  set MediaBox(box: number[]) {
    this.Dict.set('MediaBox', checkBox('MediaBox', box));
    this.doc.markModified();
  }

  /** Visible region; inherited; falls back to MediaBox. */
  get CropBox(): number[] {
    return this.box('CropBox', this.MediaBox);
  }

  /** Write /CropBox into the page's own live dict (overrides any inherited value). */
  set CropBox(box: number[]) {
    this.Dict.set('CropBox', checkBox('CropBox', box));
    this.doc.markModified();
  }

  /** Own-dict (non-inheritable) box read; falls back to CropBox. */
  private ownBox(key: string): number[] {
    const b = this.doc.resolve(this.Dict.get(key));
    if (isArray(b) && b.length === 4) {
      const nums = b.map((x) => this.doc.resolve(x)).filter((x): x is number => typeof x === 'number');
      if (nums.length === 4) return nums;
    }
    return this.CropBox;
  }

  /** Bleed boundary for print production; own key only (not inheritable); falls back to CropBox. */
  get BleedBox(): number[] {
    return this.ownBox('BleedBox');
  }

  /** Write /BleedBox into the page's own live dict. */
  set BleedBox(box: number[]) {
    this.Dict.set('BleedBox', checkBox('BleedBox', box));
    this.doc.markModified();
  }

  /** Intended finished-page boundary; own key only (not inheritable); falls back to CropBox. */
  get TrimBox(): number[] {
    return this.ownBox('TrimBox');
  }

  /** Write /TrimBox into the page's own live dict. */
  set TrimBox(box: number[]) {
    this.Dict.set('TrimBox', checkBox('TrimBox', box));
    this.doc.markModified();
  }

  /** Meaningful-content boundary; own key only (not inheritable); falls back to CropBox. */
  get ArtBox(): number[] {
    return this.ownBox('ArtBox');
  }

  /** Write /ArtBox into the page's own live dict. */
  set ArtBox(box: number[]) {
    this.Dict.set('ArtBox', checkBox('ArtBox', box));
    this.doc.markModified();
  }

  /** Effective visible rectangle (= CropBox). */
  get Rect(): number[] {
    return this.CropBox;
  }

  /** Clockwise rotation in degrees, normalized to 0/90/180/270; inherited. */
  get Rotate(): number {
    const r = this.inherited('Rotate');
    if (typeof r !== 'number') return 0;
    return ((Math.trunc(r) % 360) + 360) % 360;
  }

  /** Write /Rotate into the page's own live dict (overrides any inherited value). */
  set Rotate(deg: number) {
    this.Dict.set('Rotate', ((Math.trunc(deg) % 360) + 360) % 360);
    this.doc.markModified();
  }

  /** The page's /Trans transition dictionary, or undefined when it states none
   *  (32000-1 Table 165) — what a viewer plays on arriving at this page in a
   *  presentation. A present but empty dict reads as `{}`.
   *
   *  Not inherited: /Trans is not an inheritable page attribute, unlike the
   *  {@link Rotate} and {@link Resources} beside it. */
  get Transition(): PageTransition | undefined {
    return readTransition(this.doc, this.Dict);
  }

  /** Replace the page's /Trans WHOLLY; `null` or `undefined` deletes it.
   *
   *  Whole-value rather than `SetViewerPreferences`' merge, because the
   *  dictionary is a UNIT — a style plus that style's parameters — and merging
   *  would leave a stale /SS, or a Glitter-only 315, beside a newly-set style.
   *
   *  Throws TypeError for the wrong kind of value and RangeError for one
   *  outside its allowed set, validating the whole object before writing
   *  anything, so a rejected assignment leaves the page byte-identical. */
  set Transition(t: PageTransition | null | undefined) {
    setTransition(this.doc, this.Dict, t);
  }

  /** The page's /Dur — how long it is displayed before advancing in a
   *  presentation, in seconds — or undefined when it states none.
   *
   *  Distinct from {@link PageTransition.duration} (/D), which is how long the
   *  transition EFFECT runs. Not inherited. */
  get Duration(): number | undefined {
    return readDuration(this.doc, this.Dict);
  }

  /** Write the page's /Dur; `null` or `undefined` deletes it. Throws TypeError
   *  for a value that is not a finite number and RangeError for a negative one. */
  set Duration(seconds: number | null | undefined) {
    setDuration(this.doc, this.Dict, seconds);
  }

  /** The page's resource dictionary, or undefined when absent; inherited. */
  get Resources(): PdfDict | undefined {
    const r = this.inherited('Resources');
    return isDict(r) ? r : undefined;
  }

  /** Decoded content-stream bytes; a /Contents array is joined with '\n'. */
  get Contents(): Uint8Array {
    const c = this.doc.resolve(this.Dict.get('Contents'));
    const streams: PdfStream[] = [];
    if (isStream(c)) {
      streams.push(c);
    } else if (isArray(c)) {
      for (const e of c) {
        const s = this.doc.resolve(e);
        if (isStream(s)) streams.push(s);
      }
    }
    if (streams.length === 0) return new Uint8Array(0);
    const parts = streams.map((s) => inflateStream(s));
    const total = parts.reduce((n, p) => n + p.length, 0) + (parts.length - 1);
    const out = new Uint8Array(total);
    let off = 0;
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) out[off++] = 0x0a;
      out.set(parts[i], off);
      off += parts[i].length;
    }
    return out;
  }

  /** This page's annotations as typed handles; [] when absent. Each handle's
   *  `.Dict` exposes the raw annotation dictionary. */
  get Annotations(): Annotation[] {
    const a = this.doc.resolve(this.Dict.get('Annots'));
    if (!isArray(a)) return [];
    const out: Annotation[] = [];
    for (const e of a) {
      const d = this.doc.resolve(e);
      if (isDict(d)) out.push(wrapAnnotation(this.doc, d));
    }
    return out;
  }

  /** Remove an annotation from this page's /Annots. Accepts an Annotation handle
   *  or a raw dict; a no-op when the annotation is not on this page. */
  RemoveAnnotation(a: Annotation | PdfDict): void {
    const target = a instanceof Annotation ? a.Dict : a;
    const arr = this.doc.resolve(this.Dict.get('Annots'));
    if (!isArray(arr)) return;
    for (let i = 0; i < arr.length; i++) {
      if (this.doc.resolve(arr[i]) === target) {
        arr.splice(i, 1);
        // A tagged annotation is also named by an OBJR in the structure tree,
        // which is reachable from /Root — leaving it there keeps the annotation
        // in the saved bytes with no /Annots entry anywhere.
        untagObjects(this.doc, new Set([target]));
        this.doc.markModified();
        return;
      }
    }
  }

  /** Add a /Text (sticky-note) annotation to this page. */
  AddTextNote(opts: TextNoteOptions): TextAnnotation {
    return addTextNote(this.doc, this, opts);
  }

  /** Add a /Stamp (rubber-stamp) annotation to this page. Provide exactly one of
   *  `name` (standard stamp), `text` (custom text), or `image` (JPEG/PNG bytes). */
  AddStamp(opts: StampAnnotationOptions): StampAnnotation {
    return addStamp(this.doc, this, opts);
  }

  /** Add a /Highlight markup annotation over the given /QuadPoints. */
  AddHighlight(opts: MarkupOptions): MarkupAnnotation {
    return addHighlight(this.doc, this, opts);
  }

  /** Add an /Underline markup annotation over the given /QuadPoints. */
  AddUnderline(opts: MarkupOptions): MarkupAnnotation {
    return addUnderline(this.doc, this, opts);
  }

  /** Add a /StrikeOut markup annotation over the given /QuadPoints. */
  AddStrikeOut(opts: MarkupOptions): MarkupAnnotation {
    return addStrikeOut(this.doc, this, opts);
  }

  /** Add a /Squiggly markup annotation over the given /QuadPoints. */
  AddSquiggly(opts: MarkupOptions): MarkupAnnotation {
    return addSquiggly(this.doc, this, opts);
  }

  /** Add a /Link annotation with an internal GoTo or external URI action. */
  AddLink(opts: LinkOptions): LinkAnnotation {
    return addLink(this.doc, this, opts);
  }

  /** Create a single-line AcroForm text field whose widget lands on this page.
   *  A thin forwarder to Form.AddTextField with `page` bound to this page. */
  AddTextField(init: Omit<TextFieldInit, 'page'>): TextField {
    return addTextField(this.doc, { ...init, page: this.Number });
  }

  /** Create an AcroForm checkbox whose widget lands on this page.
   *  A thin forwarder to Form.AddCheckbox with `page` bound to this page. */
  AddCheckbox(init: Omit<CheckboxInit, 'page'>): CheckboxField {
    return addCheckbox(this.doc, { ...init, page: this.Number });
  }

  /** Create an AcroForm combo box whose widget lands on this page.
   *  A thin forwarder to Form.AddComboBox with `page` bound to this page. */
  AddComboBox(init: Omit<ComboBoxInit, 'page'>): ChoiceField {
    return addComboBox(this.doc, { ...init, page: this.Number });
  }

  /** Create an AcroForm list box whose widget lands on this page.
   *  A thin forwarder to Form.AddListBox with `page` bound to this page. */
  AddListBox(init: Omit<ListBoxInit, 'page'>): ChoiceField {
    return addListBox(this.doc, { ...init, page: this.Number });
  }

  /** Create an AcroForm push button whose widget lands on this page.
   *  A thin forwarder to Form.AddPushButton with `page` bound to this page. */
  AddPushButton(init: Omit<PushButtonInit, 'page'>): ButtonField {
    return addPushButton(this.doc, { ...init, page: this.Number });
  }

  /** Embed a file and place a /FileAttachment icon annotation on this page. */
  AddFileAttachment(opts: FileAttachmentOptions): FileAttachmentAnnotation {
    return addFileAttachment(this.doc, this, opts);
  }

  /** Add a /Square rectangle annotation (border + optional interior fill). */
  AddSquare(opts: SquareCircleOptions): SquareCircleAnnotation {
    return addSquare(this.doc, this, opts);
  }

  /** Add a /Circle ellipse annotation (border + optional interior fill). */
  AddCircle(opts: SquareCircleOptions): SquareCircleAnnotation {
    return addCircle(this.doc, this, opts);
  }

  /** Mark a region for redaction with a /Redact annotation. This removes
   *  nothing — the marked content is still in the file and still extractable
   *  until `ApplyRedactions` is called. */
  AddRedact(opts: RedactAnnotationOptions): RedactAnnotation {
    return addRedact(this.doc, this, opts);
  }

  /** Mark every occurrence of `find` (a literal string or RegExp) for redaction
   *  with a /Redact annotation, via the same search as `Search`. Returns the
   *  number of occurrences marked. Nothing is removed until `ApplyRedactions` —
   *  the marked text is still extractable until then. */
  MarkRedactText(find: string | RegExp, opts?: MarkRedactTextOptions): number {
    return markRedactText(this.doc, this, find, opts ?? {});
  }

  /** Add a /Line annotation between two points, with optional end arrowheads. */
  AddLine(opts: LineOptions): LineAnnotation {
    return addLine(this.doc, this, opts);
  }

  /** Add a closed /Polygon annotation (border + optional interior fill). */
  AddPolygon(opts: PolygonOptions): PolyAnnotation {
    return addPolygon(this.doc, this, opts);
  }

  /** Add an open /PolyLine annotation, with optional end arrowheads. */
  AddPolyline(opts: PolylineOptions): PolyAnnotation {
    return addPolyline(this.doc, this, opts);
  }

  /** Add an /Ink annotation: one or more freehand strokes. */
  AddInk(opts: InkOptions): InkAnnotation {
    return addInk(this.doc, this, opts);
  }

  /** Add a /FreeText annotation: text drawn on the page, optionally with a callout. */
  AddFreeText(opts: FreeTextOptions): FreeTextAnnotation {
    return addFreeText(this.doc, this, opts);
  }

  /** Add a /Caret annotation: a text-insertion mark, optionally with a
   *  paragraph sign. */
  AddCaret(opts: CaretOptions): CaretAnnotation {
    return addCaret(this.doc, this, opts);
  }

  /** Add a /Popup window bound to an existing markup annotation on this page. */
  AddPopup(opts: PopupOptions): PopupAnnotation {
    return addPopup(this.doc, this, opts);
  }

  /** Embedded images reachable from this page's resources, descending into
   *  Form XObjects; [] when none. */
  get Images(): ImageInfo[] {
    return collectImages(this.doc, this.Resources, this);
  }

  /** Inline (`BI … EI`) images drawn by this page, in content order,
   *  descending into Form XObjects; [] when none.
   *
   *  Deliberately separate from {@link Images}, which enumerates image
   *  XObjects. An inline image lives in no object and has no resource name, so
   *  the two are addressed differently and neither collection contains the
   *  other's entries.
   *
   *  A handle is invalidated by any removal on the same page — see
   *  `InlineImageInfo.Remove`. */
  get InlineImages(): InlineImageInfo[] {
    return collectInlineImages(this.doc, this);
  }

  /** The `/Artifact` marked-content scopes the page declares — decoration
   *  (running heads, rules, backgrounds) that carries no meaning and that a
   *  screen reader skips.
   *
   *  Each entry reports what the artifact says about itself — `/Type`,
   *  `/Subtype`, `/Attached`, `/BBox` — and, where it declares no `/BBox`,
   *  the measured extent of the ink it encloses. Most artifacts declare
   *  nothing: a bare `/Artifact BMC` is what this library writes and what most
   *  producers write, so `bboxSource` says which of the two `bbox` is.
   *
   *  Nested scopes are reported one entry each, the inner naming the outer as
   *  its `parent`. Descends into Form XObjects. Read-only. */
  get Artifacts(): PageArtifact[] {
    return extractArtifacts(this.doc, this);
  }

  /** Extract visible text from the page with reasonable word/line ordering.
   *  Decodes through simple-font encodings, /ToUnicode CMaps, and Type0 fonts.
   *  Returns "" for pages with no text-showing operators. */
  GetText(): string {
    return extractText(this.doc, this);
  }

  /** Extract positioned text fragments: consecutive glyphs sharing a font, size,
   *  and baseline grouped into runs (in content order), each carrying its
   *  page-space `quad`, `fontSize`, and `fontName`. Returns [] for pages with no
   *  text-showing operators. */
  GetTextFragments(): TextFragment[] {
    return extractFragments(this.doc, this);
  }

  /** Extract structured text: positioned fragments grouped into lines (by
   *  baseline) and paragraph-like blocks (by vertical gap and left-edge
   *  alignment), ordered top-to-bottom. Each block/line carries its page-space
   *  `quad`. Returns [] for pages with no text-showing operators. */
  GetStructuredText(): TextBlock[] {
    return extractStructured(this.doc, this);
  }

  /** Reconstruct tables on the page. When the page is tagged and exposes
   *  `/Table` structure elements, the structure tree is used as the
   *  authoritative source for rows/cells/spans (with header/scope/section and
   *  summary semantics); otherwise tables are detected from ruling lines and
   *  text geometry. Returns a rows×cells model (spans, page-space quads, cell
   *  text), each serializable to HTML/Markdown. Pass `options.region` to
   *  restrict to a page-space rectangle, or `options.structure = 'off'` to force
   *  geometry-only detection. Returns [] when none found. */
  GetTables(options?: TableExtractOptions): Table[] {
    return extractTables(this.doc, this, options);
  }

  /** Extract painted vector paths (fills/strokes/clips) as positioned shapes:
   *  each carries its subpaths in user space, the CTM at paint time, a
   *  device-space bounding box, resolved fill/stroke color + colorspace family,
   *  fill rule, stroke line width, and clip usage. Descends into Form XObjects.
   *  Returns [] for pages with no painted paths. */
  GetPaths(): PagePath[] {
    return extractPaths(this.doc, this);
  }

  /** Find every occurrence of `find` (a literal string or RegExp) in the page's
   *  text, using the same word/line assembly as `GetText`. Each match carries the
   *  matched substring, one page-space quad per line it spans, and the glyph
   *  events behind it (op provenance). A RegExp is always applied globally. */
  Search(find: string | RegExp, options?: SearchOptions): TextMatch[] {
    return searchText(this.doc, this, find, options);
  }

  /** Find every occurrence of `find` (a literal string or RegExp) in the text
   *  the page's annotations DRAW — a /FreeText's visible words, a filled form
   *  field's value — which `Search` does not see, because it walks page content
   *  streams only. Each match carries the annotation, the matched substring and
   *  one page-space quad per line it spans. Only annotations a static render
   *  would draw are searched (not Hidden, not NoView, not a /Popup). A RegExp is
   *  always applied globally.
   *
   *  Unlike `Search`, a match carries no glyph provenance: an appearance stream
   *  is not addressable by the content-edit layer, so there is nothing a caller
   *  could act on. To redact what this finds, pass the quads to `Redact` —
   *  which removes any annotation whose /Rect they intersect, the whole
   *  annotation being the only granularity available. */
  SearchAnnotations(find: string | RegExp, options?: SearchOptions): AnnotationMatch[] {
    return searchAnnotations(this.doc, this, find, options);
  }

  /** Find every occurrence of `find` (a literal string or RegExp) in the text
   *  the page's annotations CARRY rather than draw: a note's body (/Contents),
   *  its author (/T) and its subject (/Subj). None of it appears on the page,
   *  so a match names the entry it came from and carries NO geometry — the only
   *  box available would be the annotation's whole /Rect, and redacting that
   *  covers whatever else sits under it.
   *
   *  Every annotation is searched, including Hidden, NoView and /Popup ones:
   *  unlike `SearchAnnotations`, which reports what a render draws, this
   *  reports what the file carries. A RegExp is always applied globally. */
  SearchAnnotationText(find: string | RegExp): AnnotationTextMatch[] {
    return searchAnnotationText(this.doc, this, find);
  }

  /** Replace every occurrence of `find` (a literal string or RegExp) with
   *  `replacement`, re-encoded in the matched text's own font and written in
   *  place. There is no layout reflow: positioning is preserved, so a wider
   *  replacement may overlap following text and a narrower one may leave a gap.
   *  Throws `UnsupportedFeatureError` for a Type0/composite font or a replacement
   *  character not representable in the font's encoding. Returns the number of
   *  occurrences replaced. */
  ReplaceText(find: string | RegExp, replacement: string, options?: SearchOptions): number {
    return replaceText(this.doc, this, find, replacement, options);
  }

  /** Rendered width of `text` in points at `fontSize` (default 12) for `font`:
   *  one of the 12 Latin Standard-14 faces (default Helvetica) or an embedded
   *  font handle from {@link Document.AddFont}. For a shaped embedded font, pass
   *  `opts` to reflect complex-text shaping (ligatures/kerning) in the width;
   *  Standard-14 fonts ignore `opts`. */
  MeasureText(
    text: string, fontSize = 12, font: AuthoringFont = 'Helvetica',
    opts: { shape?: boolean; dir?: 'auto' | 'ltr' | 'rtl'; script?: string; language?: string } = {},
  ): number {
    return measureText(text, fontSize, font, opts.shape, opts.dir, opts.script, opts.language);
  }

  /** Stamp `text` at (x, y) in PDF user space. Existing content is preserved.
   *  For an embedded font, {@link StampOptions.shape} (with `dir`/`script`/
   *  `language`) enables complex-text shaping (bidi/RTL, Arabic joining,
   *  GSUB/GPOS); it defaults to the font's `AddFont({ shape })` setting and is
   *  ignored for Standard-14 fonts. */
  AddText(text: string, x: number, y: number, options?: StampOptions): void {
    stampText(this.doc, this, text, x, y, options ?? {});
  }

  /** Flow `text` into the rectangle [x, y, w, h] (PDF user space), wrapping to
   *  the box width and clipping to its height. Returns the unconsumed remainder
   *  (to continue into another box), or `null` when everything fit or nothing
   *  was drawn. Existing content is preserved. Complex-text shaping applies per
   *  the same `shape`/`dir`/`script`/`language` options as {@link AddText}.
   *
   *  Pass a {@link TextRun} list instead of a string to mix fonts, sizes, colours
   *  and decorations within the block; the remainder comes back as runs. */
  AddTextBlock(
    text: string, rect: [number, number, number, number], options?: TextBlockOptions,
  ): string | null;
  AddTextBlock(
    runs: TextRun[], rect: [number, number, number, number], options?: TextBlockOptions,
  ): TextRun[] | null;
  AddTextBlock(
    content: string | TextRun[], rect: [number, number, number, number], options?: TextBlockOptions,
  ): string | TextRun[] | null {
    // Two identical arms: TypeScript resolves an overloaded call by picking one
    // signature, and a `string | TextRun[]` argument matches neither. Narrowing
    // first is what lets each arm pick its own.
    return isTextRunList(content)
      ? stampTextBlock(this.doc, this, content, rect, options ?? {})
      : stampTextBlock(this.doc, this, content, rect, options ?? {});
  }

  /** Lay a Markdown document into the rectangle [x, y, w, h] (PDF user space,
   *  `y` the bottom edge) on this page. Existing content is preserved.
   *
   *  Returns `usedHeight`, the `skipped` report, and a `remainder` of the
   *  elements that did not fit — pass it to `placeElements` to continue into
   *  another rect or another page. For a document that should paginate itself,
   *  use `Document.AddMarkdown` or a `Flow`. */
  AddMarkdown(
    src: string | MdDocument,
    rect: [number, number, number, number],
    options: MarkdownFlowOptions & {
      /** Gap between consecutive blocks, on top of the style's own spacing.
       *  Default 0. */
      paragraphSpacing?: number;
      /** Grouping element the content tags under. Omit for untagged output. */
      structParent?: StructElement;
    } = {},
  ): AddMarkdownResult {
    const { elements, skipped } = markdownElements(src, options);
    const { usedHeight, remainder } = placeElements(this.doc, this, elements, rect, {
      paragraphSpacing: options.paragraphSpacing,
      structParent: options.structParent,
    });
    return { usedHeight, remainder, skipped };
  }

  /** Lay an HTML document into the rectangle [x, y, w, h] (PDF user space,
   *  `y` the bottom edge) on this page. Existing content is preserved.
   *
   *  Returns `usedHeight`, the `skipped` and `unsupported` reports, and a
   *  `remainder` of the elements that did not fit — pass it to `placeElements`
   *  to continue into another rect or another page. For a document that should
   *  paginate itself, use `Document.AddHtml` or a `Flow`.
   *
   *  `rect[2]` is the containing width the CSS boxes resolve against. */
  AddHtml(
    src: string | HtmlDocument,
    rect: [number, number, number, number],
    options: HtmlFlowOptions & {
      /** Gap between consecutive blocks, on top of the CSS margins. Default 0,
       *  and leaving it there is what lets a collapsed margin reproduce
       *  exactly — flow.ts ADDS this between every pair. */
      paragraphSpacing?: number;
      /** Grouping element the content tags under. Omit for untagged output. */
      structParent?: StructElement;
    } = {},
  ): AddHtmlResult {
    // See Document.AddHtml: a fresh array on the way out, never a mutation of
    // the one htmlElements returned (zch2.16).
    const late: NotRendered[] = [];
    const sink = (r: NotRendered): void => {
      late.push(r);
      options.onNotRendered?.(r);
    };
    const { elements, skipped, unsupported } =
      htmlElements(this.doc, src, rect[2], { ...options, onNotRendered: sink });
    const { usedHeight, remainder } = placeElements(this.doc, this, elements, rect, {
      paragraphSpacing: options.paragraphSpacing,
      structParent: options.structParent,
    });
    return { usedHeight, remainder, skipped: [...skipped, ...late], unsupported };
  }

  /** Start a buffered vector-drawing session on this page. Operators are
   *  accumulated until you call apply(), which splices them into /Contents
   *  while preserving existing content. */
  Graphics(): PageGraphics {
    return new PageGraphics(this.doc, this);
  }

  /** Render this page to a standalone SVG document string. Interprets the
   *  content stream (paths, text, images, clipping, gradients) under the page's
   *  /Rotate and CropBox. Text is emitted as positioned <text>. Unsupported
   *  content degrades (gray fallback / placeholder) rather than throwing. */
  ToSvg(options?: SvgOptions): string {
    return renderPageToSvg(this.doc, this, options);
  }

  /** Render this page to a standalone HTML document. In the default 'semantic'
   *  mode the output is reflowable markup driven by the tagged structure tree
   *  when the document has one, and by font-size heuristics when it does not.
   *  Pass `fragment: true` for body markup only. */
  ToHtml(options?: HtmlOptions): string {
    return renderPageToHtml(this.doc, this, options);
  }

  /** Render this page to GFM Markdown. Reconstructs the document from the
   *  tagged structure tree when the document has one, and from font-size
   *  heuristics when it does not. Never throws. */
  ToMarkdown(options?: MarkdownExportOptions): string {
    return renderPageToMarkdown(this.doc, this, options);
  }

  /** Render this page to a `.docx`. See `Document.ToDocx`. */
  ToDocx(options?: DocxOptions): Uint8Array {
    return renderPageToDocx(this.doc, this, options);
  }

  /** Render this page to Markdown plus the image files it references.
   *  See `Document.ToMarkdownAssets`. */
  ToMarkdownAssets(options?: MarkdownExportOptions): MarkdownExportResult {
    return renderPageToMarkdownAssets(this.doc, this, options);
  }

  /** Render this page to PNG bytes with a pure-TypeScript software rasterizer.
   *  Anti-aliased vector fills (nonzero/even-odd) composite onto an RGBA canvas
   *  at device resolution (`scale`, or `width`/`height`), honoring `/Rotate` and
   *  the crop/media box. `background: 'transparent'` yields an RGBA PNG with the
   *  unpainted area transparent; the default is an opaque white RGB PNG.
   *  Unsupported content degrades rather than throwing. */
  ToImage(options?: ImageOptions): Uint8Array {
    return renderPageToPng(this.doc, this, options);
  }

  /** Embed `data` (JPEG or PNG) as an Image XObject and paint it into the
   *  rectangle [x, y, w, h] (PDF user space). Existing content is preserved. */
  AddImage(data: Uint8Array, rect: [number, number, number, number], opts?: AddImageOptions): void {
    addImage(this.doc, this, data, rect, opts ?? {});
  }

  /** Generate a barcode and place it in the rectangle [x, y, w, h] (PDF user
   *  space). `spec` selects the symbology (`code128`, `ean13`, `upca`, `ean8`,
   *  `qr`). Rendered as filled vector rectangles by default, or a 1-bit
   *  `/ImageMask` stencil with `{ render: 'raster' }`. Existing content is
   *  preserved. */
  AddBarcode(spec: BarcodeSpec, rect: [number, number, number, number], opts?: AddBarcodeOptions): void {
    addBarcode(this.doc, this, spec, rect, opts ?? {});
  }

  /** Parse `data` as SVG and draw its geometry and paint into `rect` =
   *  [x, y, w, h] as a Form XObject. The drawing is fitted per the file's own
   *  `preserveAspectRatio` (override with `opts.fit`) and always clipped to the
   *  rect. Covers shapes, paths, transforms, clipping, solid and gradient
   *  paint, and text (including `textPath`, `method="stretch"` included);
   *  anything it cannot render is
   *  skipped and named in `result.skipped`. A font-family outside
   *  the 12 Latin Standard-14 faces is silently substituted with the nearest of
   *  them unless `opts.font` supplies a {@link Document.AddFont} handle.
   *  Existing content is preserved. */
  AddSVGObject(
    data: Uint8Array, rect: [number, number, number, number], opts?: AddSVGOptions,
  ): AddSVGResult {
    return addSvgObject(this.doc, this, data, rect, opts ?? {});
  }

  /** Lay out a built table (see {@link createTable}) with its top-left corner at
   *  (x, top) in PDF user space and draw its backgrounds, cell text (aligned),
   *  and borders into this page's /Contents. `opts.width` is the total table
   *  width in points; `opts.cellPadding` supplies the table level of the padding
   *  cascade (default 2), which a row or cell `padding` overrides. By default a too-tall
   *  table is drawn only down to `opts.bottomMargin` above the page bottom and
   *  the undrawn rows are returned as `result.remainder` (re-draw with a fresh
   *  `AddTable`); pass `{ autoPaginate: true }` to append pages automatically.
   *  Existing content is preserved. */
  AddTable(table: TableBuilder, x: number, top: number, opts: AddTableOptions): AddTableResult {
    return drawTable(this.doc, this, table, x, top, opts);
  }

  /** Render `entries` as a table of contents into `rect` = [x, y, w, h]: wrapped
   *  titles indented by `level`, dot leaders, right-aligned page labels
   *  (defaulting to each target page's logical /PageLabels label), and a
   *  borderless GoTo link over each row. A too-long TOC is drawn down to the box
   *  bottom and the undrawn entries come back as `result.remainder` (re-draw with
   *  a fresh `AddTOC`); pass `{ autoPaginate: true }` to append pages
   *  automatically. Existing content is preserved — on top of the TOC with
   *  `{ behind: true }`, under it otherwise. */
  AddTOC(
    entries: TOCEntry[], rect: [number, number, number, number], opts?: TOCOptions,
  ): AddTOCResult {
    return drawTOC(this.doc, this, entries, rect, opts);
  }

  /** Stamp another page's content onto this one as a shared Form XObject. `src`
   *  may come from this or another Document (the source is left untouched). By
   *  default the source is fitted to this page's CropBox and drawn on top; use
   *  `mode: 'underlay'` to draw behind, `rect` to place it explicitly, `opacity`
   *  for a constant alpha, and `rotate` for an extra clockwise rotation. */
  StampWith(src: Page, opts?: StampWithOptions): void {
    stampWith(this.doc, this, src, opts ?? {});
  }

  /** Set this page's MediaBox and CropBox to `box` ([x0, y0, x1, y1]). With
   *  `{ scaleContent: true }` existing content is scaled to fill the new box
   *  (mapping the old CropBox onto `box`); by default the boxes change and
   *  content keeps its coordinates. Bleed/Trim/Art boxes are left untouched.
   *  Throws TypeError for a malformed box. */
  Resize(box: [number, number, number, number], opts?: ResizeOptions): void {
    resizePage(this.doc, this, box, opts ?? {});
  }

  /** Uniformly scale this page (content and every present boundary box) by
   *  `factor > 0`. Throws RangeError for a non-finite or non-positive factor. */
  Scale(factor: number): void {
    scalePage(this.doc, this, factor);
  }

  /** Redact every region in `rects` (each `[x0, y0, x1, y1]` in PDF user space):
   *  truly remove covered text and images, prune the resources they leave
   *  orphaned, then paint an opaque marker box over each region. Removed content
   *  is gone from the saved file, not merely hidden. A partially-covered image
   *  throws `UnsupportedFeatureError`; a malformed rectangle throws `TypeError`. */
  Redact(rects: Rect[], opts?: RedactOptions): void {
    redactPage(this.doc, this, rects, opts ?? {});
  }

  /** Redact by content: find every occurrence of `find` (a literal string or
   *  RegExp) via the same search as `Search`, then remove and mark each matched
   *  region through the `Redact` pipeline. Returns the number of occurrences
   *  redacted (0 leaves the page untouched). */
  RedactText(find: string | RegExp, opts?: RedactOptions): number {
    return redactText(this.doc, this, find, opts ?? {});
  }

  /** Apply every /Redact mark on this page: truly remove the marked content,
   *  paint each mark's overlay (/RO, else its /IC fill and /OverlayText), then
   *  remove the marks. Returns the number applied; a page with no marks is
   *  untouched and returns 0. */
  ApplyRedactions(opts?: ApplyRedactionsOptions): number {
    return applyRedactions(this.doc, this, opts ?? {});
  }

  /** Flatten this page's annotations: bake each visible annotation's /AP /N
   *  appearance into the page content at its /Rect, then remove it from /Annots.
   *  Hidden / NoView annotations and those without a usable appearance are left
   *  intact. Returns the number of annotations flattened. */
  FlattenAnnotations(): number {
    return flattenAnnotations(this.doc, this);
  }
}
