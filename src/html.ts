import type { Document } from './document.js';
import type { Page } from './page.js';
import { semanticBody } from './htmlsemantic.js';
import { buildDocModel } from './docmodel.js';
import { fixedBody } from './htmlfixed.js';

/** Options for {@link Page.ToHtml} and {@link Document.ToHtml}. */
export interface HtmlOptions {
  /** Reflowable semantic markup, or positioned page reproduction.
   *  Default 'semantic'. */
  mode?: 'semantic' | 'fixed';
  /** Which page box defines the page size. Default 'crop'. 'fixed' mode only. */
  box?: 'crop' | 'media';
  /** Composite annotation and form-field /AP appearances. Default true. */
  annotations?: boolean;
  /** Font handling in `fixed` mode. Default 'map'. 'embed' inlines each
   *  embeddable font program as a base64 WOFF `@font-face` (fsType-restricted
   *  fonts fall back to CSS stacks); 'embed-all' ignores fsType. */
  fonts?: 'map' | 'embed' | 'embed-all';
  /** What sits behind the text in `fixed` mode. Default `'vector'`.
   *
   *  `'vector'` draws page graphics as an inline SVG; `'raster'` draws them as
   *  a PNG with no glyphs in it; `'page'` rasterizes the WHOLE page, glyphs
   *  included, and turns the text layer transparent.
   *
   *  **Invariant:** the text treatment follows from this value and is never a
   *  separate option. A glyph-less backdrop needs visible text or the page has
   *  none; a full-page backdrop needs transparent text or every glyph is drawn
   *  twice — once baked in, once by the browser with a substituted face. The
   *  other two combinations are an invisible page and a double-drawn one, and
   *  a single three-valued option makes both unrepresentable. */
  backdrop?: 'vector' | 'raster' | 'page';
  /** Multiplier on the 72-DPI point size for a raster backdrop. Default 2, so
   *  the page is crisp on a HiDPI display at 100% zoom — the size at which a
   *  fixed-mode page is actually read. No width/height: they let a caller
   *  produce a raster whose aspect ratio does not match the page. */
  backdropScale?: number;
  /** Turn AcroForm fields into real fillable HTML controls. Default false.
   *
   *  `fixed` mode only — reflowable output has no widget geometry to place a
   *  control at, so `semantic` with this set THROWS rather than silently
   *  ignoring it. Works with every `backdrop`: the converted widgets are
   *  suppressed from whichever backdrop is rendered, so nothing is drawn
   *  twice. */
  forms?: boolean;
  /** Emit only body markup, without the doctype/head/CSS shell. Default false. */
  fragment?: boolean;
  /** <title> text. Defaults to the document's /Info /Title, else ''. */
  title?: string;
}

/** Escape a string for use in HTML text or a double-quoted attribute value. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;');
}

const CSS = [
  'body{font-family:serif;margin:2em auto;max-width:45em;line-height:1.5}',
  'table{border-collapse:collapse}',
  'td,th{border:1px solid #999;padding:.25em .5em}',
  'img{max-width:100%}',
].join('');

const FIXED_CSS = [
  '.pg{position:relative;background:#fff;margin:0 auto 8px;overflow:hidden}',
  '.pg>svg{position:absolute;left:0;top:0}',
  '.pg>img{position:absolute;left:0;top:0;width:100%;height:100%}',
  '.pg>span{position:absolute;white-space:pre;line-height:1;transform-origin:0 0}',
  // backdrop:'page' only. The glyphs are already in the raster, so the spans
  // exist purely to be selected and found — painting them would double-draw.
  '.sel>span{color:transparent}',
  // Controls sit above the backdrop and the text. box-sizing so the /Rect is
  // the OUTER box, which is what a PDF rect means; a border would otherwise
  // grow the control past its own field.
  '.pg>input,.pg>textarea,.pg>select,.pg>button'
    + '{position:absolute;box-sizing:border-box;margin:0;font-family:inherit}',
].join('');

function shell(doc: Document, body: string, opts: HtmlOptions, css: string): string {
  const title = opts.title ?? doc.GetMetadata().title ?? '';
  const lang = doc.Lang;
  const langAttr = lang ? ` lang="${escapeHtml(lang)}"` : '';
  return `<!doctype html>\n<html${langAttr}>\n<head>\n<meta charset="utf-8">\n`
    + `<title>${escapeHtml(title)}</title>\n<style>${css}</style>\n</head>\n`
    + `<body>\n${body}\n</body>\n</html>\n`;
}

/** The body markup for `pages`. */
function bodyFor(doc: Document, pages: Page[], opts: HtmlOptions): string {
  void opts;
  return semanticBody(doc, buildDocModel(doc, pages));
}

function render(doc: Document, pages: Page[], opts: HtmlOptions): string {
  const mode = opts.mode ?? 'semantic';
  // Refused rather than ignored: reflowable output has no widget geometry to
  // place a control at, and silently dropping one of two explicitly requested
  // options is the trap `textedit.ts` already guards against with `region`.
  if (opts.forms && mode !== 'fixed')
    throw new TypeError("forms: true requires mode: 'fixed'");
  if (mode === 'fixed') {
    let out = { body: '', css: '' };
    try {
      out = fixedBody(doc, pages, opts);
    } catch {
      // Degrade: emit a well-formed shell around whatever was produced.
    }
    return opts.fragment ? out.body : shell(doc, out.body, opts, FIXED_CSS + out.css);
  }
  let body = '';
  try {
    body = bodyFor(doc, pages, opts);
  } catch {
    // Degrade: emit a well-formed shell around whatever was produced. Matches
    // renderPageToSvg, which never throws.
  }
  return opts.fragment ? body : shell(doc, body, opts, CSS);
}

/** Render one page to HTML. Never throws. */
export function renderPageToHtml(doc: Document, page: Page, opts: HtmlOptions = {}): string {
  return render(doc, [page], opts);
}

/** Render every page to one HTML document. Never throws. */
export function renderDocumentToHtml(doc: Document, opts: HtmlOptions = {}): string {
  return render(doc, doc.Pages, opts);
}
