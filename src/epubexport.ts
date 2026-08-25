import { createHash } from 'node:crypto';
import type { Document } from './document.js';
import type { Page } from './page.js';
import { isArray, isString, type PdfStream } from './types.js';
import { buildDocModel, type DocNode } from './docmodel.js';
import { semanticBody, type HtmlImageSink } from './htmlsemantic.js';
import { encodeImage, imageExtension } from './imagehref.js';
import { writeEpub, type EpubPart, type EpubMetadata } from './epub.js';
import { splitChapters } from './epubsplit.js';

/** Options for {@link Document.ToEpub}. */
export interface EpubOptions {
  /** `dc:identifier`. Defaults to the trailer `/ID`, then a hash of the
   *  content — every branch deterministic, so the archive stays reproducible. */
  identifier?: string;
  /** `dc:title`. Defaults to the `/Info` title, then `''`. */
  title?: string;
  /** `dc:language`. Defaults to `Document.Lang`, then `'und'`. */
  language?: string;
  /** `dc:creator`. Defaults to the `/Info` author, then omitted. */
  author?: string;
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

const hex = (b: Uint8Array): string =>
  [...b].map((n) => n.toString(16).padStart(2, '0')).join('');

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;');
}

/** An XHTML document shell. EPUB content documents must be well-formed XML,
 *  which is what htmlsemantic.ts's self-closed void elements are for. */
function xhtml(title: string, lang: string, body: string): string {
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<html xmlns="http://www.w3.org/1999/xhtml" '
    + `xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${esc(lang)}">\n`
    + `<head><title>${esc(title)}</title></head>\n`
    + `<body>\n${body}\n</body>\n</html>\n`;
}

/** The trailer `/ID` as a urn, or undefined.
 *
 *  The PDF's own claim to identity, which `Save()` preserves across a round
 *  trip — which is what makes it the honest first choice for `dc:identifier`. */
function idFromTrailer(doc: Document): string | undefined {
  const id = doc.resolve(doc.trailer.get('ID'));
  if (!isArray(id) || id.length < 1) return undefined;
  const first = doc.resolve(id[0]);
  if (!isString(first) || first.bytes.length === 0) return undefined;
  return `urn:uuid:${hex(first.bytes)}`;
}

/** Render `pages` to one EPUB 3 archive. */
export function renderEpub(
  doc: Document, pages: Page[], opts: EpubOptions,
): Uint8Array {
  const parts: EpubPart[] = [];

  // **Invariant:** image identity is the hash of the ENCODED BYTES, not the
  // PdfStream object — mdexport.ts's rule, reused rather than re-derived. A
  // merged document holds distinct stream objects with identical content, and
  // keying on identity writes the same picture into the package several times.
  const seen = new Map<string, string>();
  const images: HtmlImageSink = {
    href(stream: PdfStream): string | undefined {
      const enc = encodeImage(doc, stream, [0, 0, 0]);
      if (!enc) return undefined;
      const key = createHash('sha256').update(enc.bytes).digest('hex');
      const hit = seen.get(key);
      if (hit) return hit;
      const n = seen.size + 1;
      const path = `images/image${n}.${imageExtension(enc.mediaType)}`;
      parts.push({
        path, bytes: enc.bytes, mediaType: enc.mediaType, id: `img${n}`,
      });
      seen.set(key, path);
      return path;
    },
  };

  const meta = doc.GetMetadata();
  const title = opts.title ?? meta.title ?? '';
  // 'und', not 'en': a missing dc:language makes the file invalid so something
  // must be written, but claiming English states a fact the PDF never did.
  const language = opts.language ?? doc.Lang ?? 'und';
  const author = opts.author ?? meta.author;

  let chapters = [{ title: title || 'Start', nodes: [] as DocNode[] }];
  try {
    chapters = splitChapters(buildDocModel(doc, pages), title || 'Start');
  } catch {
    // Degrade: one empty chapter, as ToDocx and ToHtml degrade to what they
    // produced. A half-written EPUB that opens beats an exception, and the
    // shape that makes a reader reject the file outright — a manifest naming a
    // part that does not exist — cannot arise here, since a part is only ever
    // registered by the sink that also produced its href.
  }

  // ONE sink across every chapter, so an image drawn in two of them is one
  // package part. A per-chapter sink would silently duplicate every shared
  // picture, which is invisible in the markup and obvious in the file size.
  const docs = chapters.map((c) => {
    let body = '';
    try {
      body = semanticBody(doc, c.nodes, images);
    } catch {
      // One unrenderable chapter costs its own content, not the whole book.
    }
    return xhtml(c.title, language, body);
  });

  const nav = xhtml(title, language,
    '<nav epub:type="toc" id="toc">\n<ol>\n'
    + chapters.map((c, i) =>
      `<li><a href="chapter${i + 1}.xhtml">${esc(c.title)}</a></li>`).join('\n')
    + '\n</ol>\n</nav>');

  parts.push({
    path: 'nav.xhtml', bytes: utf8(nav),
    mediaType: 'application/xhtml+xml', id: 'nav', properties: 'nav',
  });
  // Spine order is array order, so the chapters follow the nav they are listed
  // in — both built from the one `chapters` list, which is what stops the nav
  // and the spine disagreeing about how many chapters exist or what they hold.
  docs.forEach((content, i) => {
    parts.push({
      path: `chapter${i + 1}.xhtml`, bytes: utf8(content),
      mediaType: 'application/xhtml+xml', id: `ch${i + 1}`, spine: true,
    });
  });

  const identifier = opts.identifier ?? idFromTrailer(doc)
    ?? `urn:sha256:${createHash('sha256').update(docs.join('')).digest('hex')}`;

  const epubMeta: EpubMetadata = { identifier, title, language };
  if (author) epubMeta.author = author;
  return writeEpub(parts, epubMeta);
}
