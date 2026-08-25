import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Document, PageFormat } from '../../src/index.js';
import type { Page } from '../../src/index.js';
import { DOC_AUTHOR, DOC_TITLE, DOC_VERSION, PRODUCT_NAME, addUnifiedFooter } from './theme.js';
import { addCoverPage } from './cover.js';
import { addPageText } from './text.js';
import { addPageImage } from './image.js';
import { addFormFields } from './forms.js';
import { addAnnotations } from './annotations.js';
import { addRedactionDemo } from './redaction.js';
import { addRestaurantBill } from './bill.js';
import { addSalesReport } from './sales.js';
import { addLandscapeChart } from './landscape.js';
import { addVectorShowcase } from './vector.js';
import { addFlattenDemo } from './flatten.js';
import { addFlowShowcase } from './flowshowcase.js';
import { addBookmarks, addTOC } from './contents.js';
import { addCenteredWatermark, stampLogoOnEveryPage } from './furniture.js';
import { addRenderShowcase, imposedSheetThumb, renderPageThumb } from './render.js';
import { addBarcodeShowcase } from './barcodes.js';
import { addLayerShowcase } from './layers.js';
import { addTaggedShowcase, handTagPage, runAutoTag } from './tagged.js';
import { addComplianceShowcase } from './compliance.js';
import { addHtmlShowcase } from './htmlexport.js';
import { addSigningShowcase, signSavedDocument, SIGNED_PATH } from './signing.js';
import { verifySavedDocument, verifySignedDocument } from './verify.js';
import { dejaVuSansPath } from './assets.js';

const OUTPUT_PATH = 'docs/feature-showcase.pdf';

export const DEST_TEXT = 'section.text';
export const DEST_IMAGE = 'section.image';
export const DEST_FORM = 'section.form';
export const DEST_ANNOT = 'section.annotations';
export const DEST_REDACT = 'section.redaction';
export const DEST_BILL = 'section.bill';
export const DEST_SALES = 'section.sales';
export const DEST_LANDSCAPE = 'section.landscape';
export const DEST_VECTOR = 'section.vector';
export const DEST_FLATTEN = 'section.flatten';
export const DEST_FLOW = 'section.flow';
export const DEST_RENDER = 'section.render';
export const DEST_BARCODE = 'section.barcode';
export const DEST_LAYERS = 'section.layers';
export const DEST_TAGGED = 'section.tagged';
export const DEST_COMPLIANCE = 'section.compliance';
export const DEST_HTML = 'section.html';
export const DEST_SIGN = 'section.signing';

/** One TOC/outline entry. */
export interface Section {
  dest: string;
  title: string;
  subtype: string;
  page: Page;
}

mkdirSync(dirname(OUTPUT_PATH), { recursive: true });

// --- Document scaffolding -------------------------------------------------
const doc = Document.New(PageFormat.A4);
for (let i = 0; i < 7; i++) doc.AddPage(PageFormat.A4);

const coverPage = doc.Pages[0];
const tocPage = doc.Pages[1];
const textPage = doc.Pages[2];
const imagePage = doc.Pages[3];
const formPage = doc.Pages[4];
const annotPage = doc.Pages[5];
const redactPage = doc.Pages[6];
const billPage = doc.Pages[7];

// --- Body content ---------------------------------------------------------
// One AddFontFile for the whole document: the text page and the flow's formula
// cards share the handle, so Save embeds one subset rather than two.
const dejaVu = doc.AddFontFile(dejaVuSansPath());

addCoverPage(coverPage);
addPageText(textPage, dejaVu);
addPageImage(imagePage);
addFormFields(doc, formPage);
addAnnotations(annotPage);
addRedactionDemo(redactPage);
addRestaurantBill(billPage);

// Sales report — a fresh page the table then grows from. It runs before the
// later pages are allocated so its continuation pages land directly after it.
const salesPage = doc.AddPage(PageFormat.A4).page;
const salesContinuations = addSalesReport(salesPage);
console.log(`sales report: ${salesContinuations} continuation page(s) appended`);

// Landscape wide chart — a physically wider page.
const landscapePage = doc.AddPage(PageFormat.A4.landscape()).page;
addLandscapeChart(landscapePage);

const vectorPage = doc.AddPage(PageFormat.A4).page;
addVectorShowcase(vectorPage);

const flattenPage = doc.AddPage(PageFormat.A4).page;
addFlattenDemo(doc, flattenPage);

// The flow appends its own page(s); capture the first for the TOC anchor.
const flowPages = addFlowShowcase(doc, dejaVu);
const flowPage = flowPages[0];

// A meta page whose thumbnails are renders of this very document.
const renderPage = doc.AddPage(PageFormat.A4).page;

// Self-contained sections, filled here with the rest of the body so that the
// later tagging pass covers them like any other page.
const barcodePage = doc.AddPage(PageFormat.A4).page;
addBarcodeShowcase(barcodePage);

const layersPage = doc.AddPage(PageFormat.A4).page;
addLayerShowcase(doc, layersPage);

// Filled in the late phase below: these pages report on the finished document,
// so they cannot be written until the document is finished.
const taggedPage = doc.AddPage(PageFormat.A4).page;
const compliancePage = doc.AddPage(PageFormat.A4).page;
const htmlPage = doc.AddPage(PageFormat.A4).page;
const signingPage = doc.AddPage(PageFormat.A4).page;

const sections: Section[] = [
  { dest: DEST_TEXT, title: 'Text Capabilities Showcase', subtype: 'text', page: textPage },
  { dest: DEST_IMAGE, title: 'Image Embedding', subtype: 'image', page: imagePage },
  { dest: DEST_FORM, title: 'AcroForm Fields', subtype: 'form', page: formPage },
  { dest: DEST_ANNOT, title: 'Annotation Gallery', subtype: 'annotations', page: annotPage },
  { dest: DEST_REDACT, title: 'Redactions', subtype: 'redaction', page: redactPage },
  { dest: DEST_BILL, title: 'Restaurant Bill', subtype: 'bill', page: billPage },
  { dest: DEST_SALES, title: 'Multi-Page Sales Report', subtype: 'sales', page: salesPage },
  { dest: DEST_LANDSCAPE, title: 'Annual Sales — 12 Month Trend', subtype: 'landscape', page: landscapePage },
  { dest: DEST_VECTOR, title: 'Vector Graphics', subtype: 'vector', page: vectorPage },
  { dest: DEST_FLATTEN, title: 'Form & Annotation Flattening', subtype: 'flatten', page: flattenPage },
  { dest: DEST_FLOW, title: 'Flow Layout — Giants of Physics', subtype: 'flow', page: flowPage },
  { dest: DEST_RENDER, title: 'Rendering & Imposition', subtype: 'image', page: renderPage },
  { dest: DEST_BARCODE, title: 'Barcodes & QR Codes', subtype: 'barcode', page: barcodePage },
  { dest: DEST_LAYERS, title: 'Optional-Content Layers', subtype: 'layers', page: layersPage },
  { dest: DEST_TAGGED, title: 'Tagged PDF & Logical Structure', subtype: 'tagged', page: taggedPage },
  { dest: DEST_COMPLIANCE, title: 'Standards Validation — PDF/A · PDF/X · PDF/UA', subtype: 'compliance', page: compliancePage },
  { dest: DEST_HTML, title: 'HTML Export', subtype: 'html', page: htmlPage },
  { dest: DEST_SIGN, title: 'Digital Signatures', subtype: 'signing', page: signingPage },
];

// --- Named destinations ---------------------------------------------------
for (const s of sections) doc.SetNamedDestination(s.dest, { page: s.page.Number });

// --- Page labels ----------------------------------------------------------
// Cover + TOC are lowercase roman; the body restarts at decimal 1. This MUST
// run before the TOC is drawn: AddTOC defaults each row's label to the target
// page's /PageLabels label.
doc.SetPageLabels([
  { startIndex: 0, style: 'roman' },
  { startIndex: 2, style: 'decimal', start: 1 },
]);

// --- Table of contents, then the outline tree -----------------------------
// Both run after SetPageLabels: AddTOC defaults each row's label to the target
// page's logical /PageLabels label.
addTOC(tocPage, sections);
addBookmarks(doc, sections);

// --- Per-page furniture ---------------------------------------------------
// Runs before the render page is filled, so its thumbnails show finished pages.
stampLogoOnEveryPage(doc, [coverPage, tocPage]);
// The watermark lives only on the Text Capabilities page, where it doubles as
// the example of `behind: true`. Other body pages read more cleanly without it.
addCenteredWatermark(doc, textPage, 'WATERMARK');
doc.Pages.forEach((p, i) => addUnifiedFooter(p, i + 1, doc.Pages.length));

// --- Rendering & imposition ----------------------------------------------
// Impose a finished, self-contained subset — the first eight pages, all
// complete with furniture by now — rather than the whole document, so both the
// N-up sheet and the booklet spread are full rather than showing this
// still-empty page.
const subset = doc.ExtractPages([1, 2, 3, 4, 5, 6, 7, 8]);
const nup = subset.NUp(2, 2, { margin: 14, gutter: 8, drawBorder: true });
const booklet = subset.Booklet({});
addRenderShowcase(renderPage, [
  renderPageThumb(textPage, 'Rendered page — Text'),
  renderPageThumb(vectorPage, 'Rendered page — Vector'),
  imposedSheetThumb(nup, '4-up imposition — NUp(2×2)'),
  imposedSheetThumb(booklet, 'Booklet spread — Booklet()'),
]);

// --- Document info + XMP --------------------------------------------------
const now = new Date();
doc.SetMetadata({
  title: DOC_TITLE,
  author: DOC_AUTHOR,
  subject: `End-to-end showcase of ${PRODUCT_NAME} capabilities`,
  keywords: 'aspose,pdf,typescript,acroform,annotations,svg,redaction,tables,flow',
  creator: `${PRODUCT_NAME} ${DOC_VERSION}`,
  producer: `${PRODUCT_NAME} ${DOC_VERSION}`,
  creationDate: now,
  modDate: now,
  custom: { AsposeProduct: PRODUCT_NAME },
});
// SetMetadata already mirrors the shared fields into XMP, so no explicit sync
// step is needed; this adds an XMP-only namespaced property on top.
doc.SetXmp({
  custom: [{
    namespace: 'http://ns.aspose.com/pdf/foss/1.0/',
    prefix: 'aspose',
    name: 'Showcase',
    value: 'feature-showcase',
  }],
});

// --- Optimize -------------------------------------------------------------
// The Go original calls SubsetFonts() here. It has no counterpart: a font added
// with AddFontFile is subset and embedded at Save automatically, covering only
// the glyphs actually drawn, so DejaVu Sans lands at ~12 KB rather than 739 KB
// with no explicit step. Optimize's font pass targets fonts read from an opened
// document and therefore reports nothing for this one — the dedup and
// recompress passes still earn their keep.
//
// Deliberately ahead of the tagging pass below, as a precaution rather than a
// demonstrated fix: Optimize's dedup pass merges byte-identical streams, so run
// after MCIDs are embedded it could fuse two pages' content streams and leave
// the /ParentTree mapping one page's MCIDs onto another's content. Swapping the
// two was measured on this document and changed nothing — no two pages here
// have identical content streams — so the ordering costs nothing and removes
// the hazard for documents that do.
const report = doc.Optimize({ fonts: true, dedup: true, compress: true, dr: false });
console.log(`optimize: ${report.fonts.length} font program(s) shrunk, `
  + `${report.dedup.merged} duplicate stream(s) merged, `
  + `${report.compress.streams} recompressed, `
  + `${(report.bytesSaved / 1024).toFixed(1)} KB saved`);

// --- Tag the whole document -----------------------------------------------
// Exactly one pass, over finished content. AutoTag appends into whatever tree
// exists and re-walks every text block, so a second call — or any hand-tagging
// before this point — would double-tag the same content.
const tagReport = runAutoTag(doc);
console.log(`autotag: ${tagReport.headings} heading(s), ${tagReport.paragraphs} paragraph(s), `
  + `${tagReport.tables} table(s), ${tagReport.figures} figure(s), `
  + `${tagReport.artifacts} artifact(s)`);

// --- Late phase: the pages that report on the finished document ------------
// Filled after tagging because they describe its result, then hand-tagged so
// they are not left as untagged content. Each needs its own footer: the
// document-wide footer pass above ran before these pages had any content.
addTaggedShowcase(doc, taggedPage, tagReport);
addUnifiedFooter(taggedPage, taggedPage.Number, doc.Pages.length);
handTagPage(doc, taggedPage, 'Tagged PDF');

addComplianceShowcase(doc, compliancePage);
addUnifiedFooter(compliancePage, compliancePage.Number, doc.Pages.length);
handTagPage(doc, compliancePage, 'Standards Validation');

// Exports the document as it stands, so it runs after the pages above are
// filled. The siblings will not contain the signing page — signing happens
// after the PDF is written.
addHtmlShowcase(doc, htmlPage);
addUnifiedFooter(htmlPage, htmlPage.Number, doc.Pages.length);
handTagPage(doc, htmlPage, 'HTML Export');

addSigningShowcase(signingPage);
addUnifiedFooter(signingPage, signingPage.Number, doc.Pages.length);
handTagPage(doc, signingPage, 'Digital Signatures');

doc.WriteTo(OUTPUT_PATH);
console.log(`wrote ${OUTPUT_PATH} (${doc.Pages.length} pages)`);

verifySavedDocument(OUTPUT_PATH, sections);

// --- Signing --------------------------------------------------------------
// Last of all, and on the saved file rather than the live document: signing
// appends incrementally, so the signed bytes must not be mutated afterwards.
// The main artifact stays unsigned on purpose — signing it would freeze it
// against the regeneration this example exists to perform.
// Page.Number is 1-based; SignatureAppearance.page is 0-based.
await signSavedDocument(OUTPUT_PATH, signingPage.Number - 1);
await verifySignedDocument(SIGNED_PATH);
