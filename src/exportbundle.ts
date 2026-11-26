import type { Document } from './document.js';
import type { Page } from './page.js';
import { runOperation } from './operation.js';
import { imageHref, imageKey, type AssetWriter } from './imagehref.js';
import { renderPageToSvgSteps, type SvgOptions } from './svgrender.js';
import { escapeHtml, shell, type HtmlOptions } from './html.js';
import { semanticBodySteps } from './htmlsemantic.js';
import { fixedBodySteps } from './htmlfixed.js';
import { taggedModelSteps, untaggedModelSteps, type LinkResolver } from './docmodel.js';
import { headingRanksSteps } from './textrank.js';
import { parseAction, parseStandaloneAction } from './actions.js';
import { readOutlineTree, resolvePageDest, type OutlineItem } from './outline.js';

import { isDict, type PdfStream } from './types.js';
import { isAnnotVisible } from './annotappearance.js';

/** Relative paths and file contents, with entry points in requested page order. */
export interface ExportBundle {
  files: Map<string, Uint8Array>;
  entryPoints: string[];
}

interface BundleOptions {
  pages?: readonly number[];
  patchDpi?: number;
}

export interface SvgBundleOptions extends SvgOptions, BundleOptions {}
export interface HtmlBundleOptions extends Omit<HtmlOptions, 'fragment'>, BundleOptions {
  split?: boolean;
  outlineNav?: boolean;
}

function selectedPages(doc: Document, numbers?: readonly number[]): Page[] {
  const pages = doc.Pages;
  if (!numbers?.length) return pages;
  return [...new Set(numbers)].map(n => {
    if (!Number.isInteger(n) || n < 1 || n > pages.length)
      throw new RangeError(`page ${n} out of range (1..${pages.length})`);
    return pages[n - 1];
  });
}

class Bundle implements ExportBundle {
  files = new Map<string, Uint8Array>();
  entryPoints: string[] = [];
  constructor(readonly patchDpi = 144) {
    if (!Number.isFinite(patchDpi) || patchDpi <= 0) throw new RangeError('patchDpi must be positive and finite');
  }
  write: AssetWriter = (bytes, extension) => {
    const path = `assets/${imageKey(bytes)}.${extension}`;
    if (!this.files.has(path)) this.files.set(path, bytes.slice());
    return path;
  };
  entry(path: string, markup: string): void {
    this.entryPoints.push(path);
    this.files.set(path, new TextEncoder().encode(markup));
  }
  result(): ExportBundle { return { files: this.files, entryPoints: this.entryPoints }; }
}

export function svgBundle(doc: Document, opts: SvgBundleOptions): ExportBundle {
  return runOperation('ToSvgBundle', opts, function* (context) {
    const bundle = new Bundle(opts.patchDpi);
    for (const page of selectedPages(doc, opts.pages)) {
      const svg = yield* renderPageToSvgSteps(doc, page, opts, context, bundle);
      bundle.entry(`page-${page.Number}.svg`, svg);
    }
    return bundle.result();
  });
}

/** Browsers remove ASCII tabs/newlines and leading control characters before
 *  interpreting a scheme. Use the same normalization for the protocol check. */
function navigationUri(uri: string): string | undefined {
  const normalized = uri.replace(/[\t\n\r]/g, '').replace(/^[\x00-\x20]+/, '');
  return /^(?:javascript|vbscript|data|blob):/i.test(normalized) ? undefined : uri;
}

function outlineNav(doc: Document, pageHref: (n: number) => string | undefined): string {
  const root = doc.resolve(doc.catalog().get('Outlines'));
  if (!isDict(root)) return '';
  const items = readOutlineTree(doc, root, raw => parseStandaloneAction(doc, raw), resolvePageDest);
  if (!items.length) return '';
  function list(nodes: readonly OutlineItem[]): string {
    return '<ul>' + nodes.map(item => {
      const dest = item.Dest;
      const page = item.Action?.type === 'goto' ? item.Action.page
        : dest && 'page' in dest ? dest.page : undefined;
      const href = page !== undefined ? pageHref(page)
        : item.Action?.type === 'uri' ? navigationUri(item.Action.uri) : undefined;
      const title = escapeHtml(item.Title);
      const label = href ? `<a href="${escapeHtml(href)}">${title}</a>` : title;
      const children = item.Children?.length ? list(item.Children) : '';
      return `<li>${label}${children}</li>`;
    }).join('') + '</ul>';
  }
  return `<nav aria-label="Bookmarks">${list(items)}</nav>`;
}

export function htmlBundle(doc: Document, opts: HtmlBundleOptions): ExportBundle {
  return runOperation('ToHtmlBundle', opts, function* (context) {
    const bundle = new Bundle(opts.patchDpi);
    const pages = selectedPages(doc, opts.pages);
    const fixed = opts.mode === 'fixed';
    if (opts.forms && !fixed) throw new TypeError("forms: true requires mode: 'fixed'");
    const selected = new Set(pages.map(p => p.Number));
    const pageHref = (n: number) => selected.has(n)
      ? (opts.split ? `page-${n}.html` : '') + `#page-${n}` : undefined;
    const resolveLink: LinkResolver = annotation => {
      if (!isAnnotVisible(doc, annotation)) return undefined;
      if (annotation.has('Dest')) {
        const dest = resolvePageDest(doc, annotation, o => doc.pageNumberOf(o));
        return dest && pageHref(dest.page);
      }
      const action = parseAction(doc, annotation);
      if (action?.type === 'goto') return pageHref(action.page);
      if (action?.type === 'uri') return navigationUri(action.uri);
      return undefined;
    };
    const nav = opts.outlineNav ? outlineNav(doc, pageHref) : '';
    const tree = fixed || !pages.length ? undefined : doc.GetStructTree();
    const ranks = !fixed && !tree && pages.length ? yield* headingRanksSteps(doc, context, pages) : new Map<number, number>();
    const images = { href: (stream: PdfStream) => imageHref(doc, stream, [0, 0, 0], bundle.write) };
    const groups = opts.split ? pages.map(p => [p]) : [pages];
    for (const group of groups) {
      let body = nav, css = '';
      if (fixed) {
        const out = yield* fixedBodySteps(doc, group, opts, context, bundle, resolveLink);
        body += out.body;
        css = out.css;
      } else {
        for (const page of group) {
          const model = tree ? yield* taggedModelSteps(doc, tree, page, context, resolveLink)
            : yield* untaggedModelSteps(doc, [page], ranks, context, resolveLink);
          const markup = yield* semanticBodySteps(doc, model, images, context);
          body += `<section id="page-${page.Number}">${markup}</section>`;
        }
      }
      const path = opts.split ? `page-${group[0].Number}.html` : 'index.html';
      bundle.entry(path, shell(doc, body, opts, css));
      yield context.progress('assemble', bundle.entryPoints.length, groups.length);
    }
    return bundle.result();
  });
}
