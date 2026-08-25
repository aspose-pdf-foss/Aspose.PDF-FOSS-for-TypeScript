import { existsSync, readFileSync } from 'node:fs';
import { Document, visitContent } from '../../src/index.js';
import { isNamedDest } from '../../src/outline.js';
import { isArray, isRef } from '../../src/types.js';
import type { OutlineItem, Page } from '../../src/index.js';
import type { Section } from './main.js';
import { MARKED_VALUES, REDACTED_VALUES } from './redaction.js';
import { SIGNATURE_RECT } from './signing.js';

/** The sections filled after the AutoTag pass, and therefore tagged by hand.
 *  Grows as each late section lands. */
const HAND_TAGGED_DESTS = ['section.tagged', 'section.compliance', 'section.html', 'section.signing'];

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`showcase verification failed: ${what}`);
  console.log(`  ok — ${what}`);
}

/** The page a named destination points at.
 *
 *  Sections are located by destination, never by a text substring. Every
 *  section title also appears in the table of contents and the outline, so
 *  `Pages.find(p => p.GetText().includes(title))` matches the TOC page first —
 *  and the TOC page carries a link annotation per row, which is how a page
 *  asserted to have no /Annots came back with twelve. That only surfaced once
 *  Standard-14 text extraction was fixed to measure from AFM metrics: before
 *  that the TOC row's glyphs were spaced too widely to extract as a contiguous
 *  substring, so the wrong-page match silently did not happen. */
function destPage(doc: Document, name: string): Page {
  const entry = doc.GetNamedDestinations().find((d) => d.name === name);
  if (!entry) throw new Error(`showcase verification failed: no named destination ${name}`);
  return doc.Pages[entry.dest.page - 1];
}

/** Re-open the written file and assert the three things this document claims
 *  about itself. Fails loudly, so a regression in any of them stops the build
 *  rather than producing a quietly wrong artifact. */
export function verifySavedDocument(path: string, sections: Section[]): void {
  const doc = Document.OpenFile(path);
  console.log('verifying saved document:');

  // 1. The flatten page is inert, while the AcroForm page's fields survive.
  const flatten = destPage(doc, 'section.flatten');
  check(flatten.GetText().includes('Annotation Flattening'),
    'the flattening page is present');
  check(flatten.Annotations.length === 0, 'the flattening page carries no /Annots');
  const names = doc.Form.Fields.map((f) => f.FullName);
  check(!names.includes('FlattenName') && !names.includes('FlattenCheck'),
    'the flattened fields are unwired from /AcroForm');
  check(names.includes('FullName') && names.includes('Plan'),
    "the AcroForm page's fields are still interactive");
  check(flatten.GetText().includes('Alice Sample'),
    'the flattened value is baked into page content');

  // 2. Applied redactions destroyed their values; unapplied marks did not.
  const redact = destPage(doc, 'section.redaction');
  check(redact.GetText().includes('Internal memo'), 'the redaction page is present');
  const redactText = redact.GetText();
  for (const v of REDACTED_VALUES) {
    check(!redactText.includes(v), `applied redaction destroyed ${JSON.stringify(v)}`);
  }
  for (const v of MARKED_VALUES) {
    check(redactText.includes(v), `unapplied mark preserved ${JSON.stringify(v)}`);
  }
  check(redact.Annotations.filter((a) => a.Subtype === 'Redact').length === 2,
    'two /Redact marks survive unapplied');

  // 3. Every navigation target resolves.
  const pageCount = doc.Pages.length;
  const destNames = new Set(doc.GetNamedDestinations().map((d) => d.name));
  for (const s of sections) {
    check(destNames.has(s.dest), `named destination ${s.dest} exists`);
  }
  for (const { name, dest } of doc.GetNamedDestinations()) {
    check(dest.page >= 1 && dest.page <= pageCount,
      `named destination ${name} targets a page in range`);
  }
  const walk = (items: OutlineItem[]): void => {
    for (const it of items) {
      if (it.Dest && isNamedDest(it.Dest)) {
        check(destNames.has(it.Dest.name),
          `outline "${it.Title}" names an existing destination`);
      }
      if (it.Children) walk(it.Children);
    }
  };
  walk(doc.GetOutlines());

  // 4. The barcode page drew every symbology.
  const barcode = destPage(doc, 'section.barcode');
  check(barcode.GetText().includes('Barcodes'), 'the barcode page is present');

  // Count subpaths, not paths: a vector barcode fills every module in ONE paint
  // op, so GetPaths() returns a handful of entries carrying hundreds of
  // subpaths each. Asserting on the path count would pass on a page that drew
  // nothing but its eight card frames.
  const barcodeSubpaths = barcode.GetPaths()
    .reduce((n, p) => n + p.subpaths.length, 0);
  check(barcodeSubpaths > 800,
    `the barcode page drew module geometry (${barcodeSubpaths} subpaths)`);

  const barcodeText = barcode.GetText();
  for (const payload of ['5901234123457', '036000291452', '96385074']) {
    check(barcodeText.includes(payload), `the human-readable payload ${payload} was drawn`);
  }

  // The raster QR is the page's only image: every other symbology is vector.
  let barcodeImages = 0;
  visitContent(doc, barcode, { image: () => { barcodeImages++; } });
  check(barcodeImages === 1,
    `render: 'raster' produced exactly one image XObject (${barcodeImages})`);

  // 5. Optional content: the layers, the nesting, and the default-off one.
  const oc = doc.OptionalContent;
  const layerNames = oc.Layers.map((l) => l.Name);
  for (const want of ['Walls', 'Furniture', 'Seating', 'Grid', 'Branding', 'Asset Tag']) {
    check(layerNames.includes(want), `layer "${want}" survives the save`);
  }
  const grid = oc.GetLayer('Grid');
  check(grid !== undefined && !oc.Default.IsVisible(grid),
    'the Grid layer is default-off in the /D config');
  const walls = oc.GetLayer('Walls');
  check(walls !== undefined && oc.Default.IsVisible(walls),
    'the Walls layer is default-on');

  // The panel tree: /D /Order represents nesting as an OCG followed by an array
  // of its children, so Seating must live in an array immediately after
  // Furniture. Layer *existence* alone would pass on a flat, unnested list.
  const order = doc.resolve(oc.Default.Dict.get('Order'));
  const seatingRef = oc.GetLayer('Seating')?.Ref;
  const furnitureRef = oc.GetLayer('Furniture')?.Ref;
  let nested = false;
  if (isArray(order) && seatingRef && furnitureRef) {
    for (let i = 0; i < order.length - 1; i++) {
      const here = order[i];
      const next = doc.resolve(order[i + 1]);
      if (isRef(here) && here.num === furnitureRef.num && isArray(next))
        nested = next.some((e) => isRef(e) && e.num === seatingRef.num);
    }
  }
  check(nested, 'Seating is nested under Furniture in /D /Order');

  // 6. The document is tagged, and the late-filled pages were hand-tagged.
  const tree = doc.GetStructTree();
  check(tree !== null, 'the saved document carries a /StructTreeRoot');
  check(doc.IsTagged, 'the catalog declares /MarkInfo /Marked true');
  check(doc.Lang === 'en-US', "the document /Lang is 'en-US'");
  check(tree!.Children.length > 20,
    `the structure tree has top-level elements (${tree!.Children.length})`);
  const types = new Set(tree!.Children.map((c) => c.Type));
  check(types.has('P'), 'the tree contains paragraphs');
  check([...types].some((t) => /^H[1-6]$/.test(t)), 'the tree contains headings');

  // The late-filled pages are hand-tagged, not covered by the AutoTag pass —
  // they were still empty when it ran. Asserting only on the tree as a whole
  // would pass while leaving every one of them untagged content.
  const elementsOn = (p: Page): number =>
    tree!.Children.filter((c) => c.Page?.Number === p.Number).length;
  for (const dest of HAND_TAGGED_DESTS) {
    const p = destPage(doc, dest);
    check(elementsOn(p) > 0,
      `${dest} was hand-tagged (${elementsOn(p)} element(s) on the page)`);
  }

  // 7. The compliance page reports real validator findings.
  const compliance = destPage(doc, 'section.compliance');
  check(compliance.GetText().includes('Standards Validation'),
    'the compliance page is present');
  check(compliance.GetText().includes('FontEmbedded'),
    'the PDF/A findings name the unembedded Standard-14 faces');
  check(existsSync('docs/feature-showcase-pdfa.pdf'),
    'the PDF/A conversion sibling was written');

  // 8. Both HTML siblings exist, and the semantic one took the tagged path.
  for (const p of ['docs/feature-showcase.html', 'docs/feature-showcase-fixed.html']) {
    check(existsSync(p), `${p} was written`);
  }
  const semantic = readFileSync('docs/feature-showcase.html', 'utf8');
  check(semantic.length > 4096, 'the semantic export has substantial content');
  check(/<h[1-6][ >]/.test(semantic), 'the semantic export emitted heading markup');

  // Proving the *tagged* path ran needs a marker the fallback cannot produce,
  // and headings are not it — untaggedBody derives them from font-size ranks
  // and emits them too (44 of them on this document, measured). The /Alt text
  // the alt callback wrote is the discriminator: it exists only on /Figure
  // elements in the structure tree, so the geometry-driven fallback has no way
  // to invent it.
  check(semantic.includes('Showcase illustration,'),
    'the semantic export carries /Figure /Alt text (proving the tagged path)');

  console.log('all checks passed');
}

/** The signed sibling: two signatures, both intact, with the certification's
 *  DocMDP verdict clean. Separate from verifySavedDocument because it opens a
 *  different file and VerifySignatures is async. */
export async function verifySignedDocument(path: string): Promise<void> {
  console.log('verifying signed sibling:');
  check(existsSync(path), `${path} was written`);
  const doc = Document.OpenFile(path);
  const reports = await doc.VerifySignatures();
  check(reports.length === 2, `the sibling carries two signatures (${reports.length})`);
  reports.forEach((r, i) => {
    check(r.integrity === 'valid',
      `signature ${i + 1} (${r.name}) has an intact /ByteRange digest`);
    check(r.signature === 'valid',
      `signature ${i + 1} (${r.name}) verifies cryptographically`);
  });
  // By name, not by index: the two differ in exactly the way that proves the
  // append happened, and an index-based check would not notice them swapping.
  const cert = reports.find((r) => r.name === 'ShowcaseCertification');
  const approval = reports.find((r) => r.name === 'ShowcaseApproval');
  check(cert !== undefined && approval !== undefined,
    'both signature fields are present by name');
  check(cert!.docMDP === 'ok', "the certification's DocMDP verdict is ok");
  check(approval!.coversWholeFile,
    'the approval signature covers the whole file');
  // The certification was signed before the approval was appended, so its
  // /ByteRange stops short of the end. That asymmetry IS the incremental
  // append: were the second signature a full rewrite, the first would be gone.
  check(!cert!.coversWholeFile,
    'the certification does not cover the appended revision (proving the append)');

  // The unsigned document outlines SIGNATURE_RECT and promises the signature
  // lands there, so the two must actually agree.
  const signingPage = destPage(doc, 'section.signing');
  const widget = signingPage.Annotations.find((a) => a.Subtype === 'Widget');
  check(widget !== undefined, 'the visible signature widget is on the signing page');
  const rect = widget?.Rect?.map(Math.round) ?? [];
  check(JSON.stringify(rect) === JSON.stringify(SIGNATURE_RECT),
    `the widget occupies the advertised rect ${JSON.stringify(SIGNATURE_RECT)}`);

  console.log('signed sibling verified');
}
