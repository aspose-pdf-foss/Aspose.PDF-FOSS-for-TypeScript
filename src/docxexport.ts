import type { Document } from './document.js';
import type { Page } from './page.js';
import { buildDocModel } from './docmodel.js';
import { encodeImage, imageExtension, imageKey } from './imagehref.js';
import { ImageInfo } from './image.js';
import type { PdfStream } from './types.js';
import { docxBody, type DocxImage } from './docxflow.js';
import { docxNumberingXml, docxStylesXml, TWIPS_PER_PT, type DocxNumbering } from './docxstyles.js';
import { writeDocx } from './docxpackage.js';
import type { OoxmlPart, OoxmlRelationship } from './ooxml.js';
import { visitContent, type GlyphEvent } from './text.js';
import { renderPageGraphicsToPng } from './raster.js';
import { groupGlyphs } from './docxgroup.js';
import { docxTextboxBody, type ImagePlacement, type TextboxPage } from './docxtextbox.js';

/** Options for {@link Document.ToDocx} and {@link Page.ToDocx}.
 *
 *  Mirrors `HtmlOptions` deliberately: a caller who knows
 *  `ToHtml({ mode: 'fixed' })` should not have to learn a second idiom. */
export interface DocxOptions {
  /** Reflowable, or positioned page reproduction. Default 'flow'. */
  mode?: 'flow' | 'textbox';
  /** A raster of the page's GRAPHICS behind the frames, in `textbox` mode,
   *  with every glyph suppressed. Default `'none'`.
   *
   *  `backdrop`, not `background`: `ImageOptions.background` already means
   *  `'white' | 'transparent'`, so a second meaning on a bag callers use in the
   *  same file has no compile-time guard. `'raster'` is `HtmlOptions.backdrop`'s
   *  word for exactly this render, and means the same thing here.
   *
   *  **Invariant:** the backdrop is glyph-less and the frames stay visible —
   *  never both. Each is a complete drawing of the text, so a full-page raster
   *  under visible frames draws every glyph twice: once baked in, once
   *  re-rendered by Word with a substituted face, which does not land on the
   *  same pixels (`tvc4`). HTML resolves the same tension with a second value,
   *  `'page'`, that rasterizes everything and makes the text transparent;
   *  WordprocessingML has no transparent run colour to do that with — `w:color`
   *  carries no alpha, and the `w14:textFill` extension would drag in a
   *  namespace this writer deliberately avoids — so `'raster'` is the only
   *  backdrop DOCX can honestly offer, and it is the one that suits an editable
   *  format anyway. */
  backdrop?: 'none' | 'raster';
  /** Which page box sizes the page. Default 'crop'. 'textbox' mode only. */
  box?: 'crop' | 'media';
}

const REL_BASE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const STYLES_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml';
const NUMBERING_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** `w:sectPr` from the first page's box, in twips.
 *
 *  **Invariant:** the page size is stated. Word's default is US Letter, so an
 *  A4 document would otherwise reflow the moment it is opened — a change to the
 *  document made by saying nothing. */
function sectPr(page: Page | undefined): string {
  const box = page?.CropBox ?? [0, 0, 595.28, 841.89];
  const w = Math.round((box[2] - box[0]) * TWIPS_PER_PT);
  const h = Math.round((box[3] - box[1]) * TWIPS_PER_PT);
  return `<w:sectPr><w:pgSz w:w="${w}" w:h="${h}"/>`
    + '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>';
}

/** The package's image registry: encodes, dedupes, allocates the media part and
 *  its relationship.
 *
 *  **Invariant:** identity is the hash of the ENCODED BYTES, not the PdfStream
 *  object. A merged document holds distinct stream objects with identical
 *  content, and keying on identity would write the same picture into the
 *  package several times. mdexport.ts's rule, reused rather than re-derived.
 *
 *  Shared by both modes, so they cannot disagree about what an image is or how
 *  many copies a package carries. */
function imageRegistry(
  doc: Document, parts: OoxmlPart[], rels: OoxmlRelationship[], relId: () => string,
) {
  const seen = new Map<string, DocxImage>();

  const addBytes = (bytes: Uint8Array, mediaType: string): DocxImage => {
    const key = imageKey(bytes);
    const hit = seen.get(key);
    if (hit) return hit;

    const path = `word/media/image${seen.size + 1}.${imageExtension(mediaType)}`;
    // Stored, never deflated: these are JPEG or PNG, both already compressed,
    // so deflating costs time and usually grows them. This is the case zip.ts's
    // per-entry method exists for.
    parts.push({ path, bytes, contentType: mediaType, store: true });
    const id = relId();
    rels.push({
      source: 'word/document.xml', id, type: `${REL_BASE}/image`,
      target: path.slice('word/'.length),      // relative to the SOURCE part
    });
    const img: DocxImage = { rid: id, pxWidth: 0, pxHeight: 0 };
    seen.set(key, img);
    return img;
  };

  return {
    addBytes,
    /** Register an image XObject. Undefined when it cannot be encoded, which is
     *  the mapper's cue to fall back to the alt text. */
    add(stream: PdfStream): DocxImage | undefined {
      const enc = encodeImage(doc, stream, [0, 0, 0]);
      if (!enc) return undefined;
      const img = addBytes(enc.bytes, enc.mediaType);
      if (!img.pxWidth) {
        const info = new ImageInfo(doc, '', stream);
        img.pxWidth = info.Width || 0;
        img.pxHeight = info.Height || 0;
      }
      return img;
    },
  };
}

function renderFlow(doc: Document, pages: Page[]): Uint8Array {
  const parts: OoxmlPart[] = [];
  const rels: OoxmlRelationship[] = [];
  let nextRel = 2;                     // rId1 is the package root -> document
  const relId = (): string => `rId${nextRel++}`;

  const images = imageRegistry(doc, parts, rels, relId);

  const links = {
    add(href: string): string {
      const id = relId();
      rels.push({
        source: 'word/document.xml', id, type: `${REL_BASE}/hyperlink`,
        target: href, external: true,
      });
      return id;
    },
  };

  let xml = '';
  let nums: DocxNumbering[] = [];
  try {
    ({ xml, nums } = docxBody(buildDocModel(doc, pages), images, links));
  } catch {
    // Degrade: emit whatever was produced. Matches mdexport.ts's render and
    // renderPageToSvg, neither of which throws on a document we could not
    // fully reconstruct.
  }

  // Unconditional: a w:pStyle naming a style the package does not define is not
  // an error a reader reports, it just renders as body text.
  parts.push({ path: 'word/styles.xml', bytes: utf8(docxStylesXml()), contentType: STYLES_TYPE });
  rels.push({
    source: 'word/document.xml', id: relId(), type: `${REL_BASE}/styles`, target: 'styles.xml',
  });

  // Only when a list exists: a numbering part defining lists nobody uses is the
  // same nothing as a relationships part with no relationships.
  if (nums.length) {
    parts.push({
      path: 'word/numbering.xml', bytes: utf8(docxNumberingXml(nums)),
      contentType: NUMBERING_TYPE,
    });
    rels.push({
      source: 'word/document.xml', id: relId(), type: `${REL_BASE}/numbering`,
      target: 'numbering.xml',
    });
  }

  return writeDocx(xml + sectPr(pages[0]), { parts, rels });
}

/** Collect one page's positioned content.
 *
 *  ONE `visitContent` pass, not two: `ContentVisitor` carries both a `glyph`
 *  and an `image` hook, so text and image placements arrive together and in
 *  content order from a single walk. */
function collectPage(
  doc: Document, page: Page, opts: DocxOptions,
  images: ReturnType<typeof imageRegistry>,
): TextboxPage {
  const box = (opts.box === 'media' ? page.MediaBox : page.CropBox) as
    [number, number, number, number];
  const glyphs: GlyphEvent[] = [];
  const placed: ImagePlacement[] = [];
  try {
    visitContent(doc, page, {
      glyph: (e) => glyphs.push(e),
      image: (e) => {
        // An inline image's samples live in the content op and in no object, so
        // there is nothing to register — it reaches the output only through
        // backdrop: 'raster'.
        if (!e.stream) return;
        const img = images.add(e.stream);
        if (img) placed.push({ rid: img.rid, quad: e.quad });
      },
    });
  } catch {
    // Degrade: whatever was collected before the failure still positions.
  }

  let backdrop: { rid: string } | undefined;
  if (opts.backdrop === 'raster') {
    try {
      // GRAPHICS only, sharing htmlfixed.ts's glyph-less render: the frames
      // below are visible, so a page.ToImage() here would bake in a second copy
      // of every glyph (`tvc4`). Inline images still reach the output through
      // this, since they are graphics rather than text.
      const png = renderPageGraphicsToPng(doc, page, { box: opts.box ?? 'crop' });
      backdrop = { rid: images.addBytes(png, 'image/png').rid };
    } catch {
      // A page we cannot rasterize keeps its text frames and loses its backdrop.
      // Safe here in a way it is not for HTML's 'page': the frames are visible
      // either way, so degrading costs the graphics, never the text.
    }
  }

  return {
    box, groups: groupGlyphs(glyphs), images: placed,
    ...(backdrop ? { backdrop } : {}),
  };
}

/** Textbox mode: each page's own geometry as page-anchored frames.
 *
 *  No `styles.xml` and no `numbering.xml` — this mode names no style id and
 *  allocates no list, and a part defining styles nobody uses is the same
 *  nothing as a relationships part with no relationships. */
function renderTextbox(doc: Document, pages: Page[], opts: DocxOptions): Uint8Array {
  const parts: OoxmlPart[] = [];
  const rels: OoxmlRelationship[] = [];
  let nextRel = 2;                     // rId1 is the package root -> document
  const relId = (): string => `rId${nextRel++}`;
  const images = imageRegistry(doc, parts, rels, relId);

  let xml = '';
  try {
    xml = docxTextboxBody(pages.map((p) => collectPage(doc, p, opts, images)));
  } catch {
    // Degrade: emit whatever was produced. Matches renderFlow and
    // renderPageToSvg, neither of which throws on a page we could not walk.
  }
  return writeDocx(xml, { parts, rels });
}

/** **Invariant:** the mode is branched on ONCE, here. `docxflow.ts` never
 *  learns that a second mode exists — it gained optional vocabulary that emits
 *  nothing when unset, which is what keeps flow mode's bytes frozen. */
function render(doc: Document, pages: Page[], opts: DocxOptions): Uint8Array {
  return (opts.mode ?? 'flow') === 'textbox'
    ? renderTextbox(doc, pages, opts)
    : renderFlow(doc, pages);
}

/** Render every page to one `.docx`. Never throws. */
export function renderDocumentToDocx(doc: Document, opts: DocxOptions = {}): Uint8Array {
  return render(doc, doc.Pages, opts);
}

/** Render one page to a `.docx`. Never throws. */
export function renderPageToDocx(doc: Document, page: Page, opts: DocxOptions = {}): Uint8Array {
  return render(doc, [page], opts);
}
