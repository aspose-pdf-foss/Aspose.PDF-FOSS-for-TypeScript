import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { EditableContent } from '../src/editcontent.js';
import { removeGlyphsUnder, removeImagesUnder, sanitizeResources } from '../src/redact.js';
import { sanitizeResources as sanitizeFromOwner } from '../src/resprune.js';
import { isDict, PdfDict } from '../src/types.js';
import { buildImageOnlyPdf } from './helpers/build-text-pdf.js';
import { buildMultiStreamPage, buildTwoFontPage } from './helpers/build-edit-pdf.js';

/** Keys of a page's /Resources sub-dict (e.g. 'Font', 'XObject'), or []. */
function resourceKeys(doc: Document, key: string, pageIndex = 0): string[] {
  const res = doc.resolve(doc.Pages[pageIndex].Dict.get('Resources'));
  const sub = isDict(res) ? doc.resolve((res as PdfDict).get(key)) : undefined;
  return isDict(sub) ? [...(sub as PdfDict).keys()] : [];
}
const savedText = (doc: Document) => new TextDecoder('latin1').decode(doc.Save());

describe('sanitizeResources — orphaned XObject pruning', () => {
  it('drops an image XObject resource after its draw is removed, so Save sweeps it', () => {
    const doc = Document.Open(buildImageOnlyPdf()); // /Im0 image at [50,50,150,150]
    const page = doc.Pages[0];
    const ec = new EditableContent(doc, page);
    removeImagesUnder(doc, page, [[40, 40, 160, 160]], ec);
    sanitizeResources(doc, page, ec);
    ec.commit();

    const reopened = Document.Open(doc.Save());
    expect(resourceKeys(reopened, 'XObject')).not.toContain('Im0'); // resource pruned
    expect(savedText(doc)).not.toContain('/Image');                  // object swept
  });

  it('keeps an image XObject that is still drawn', () => {
    const doc = Document.Open(buildImageOnlyPdf());
    const page = doc.Pages[0];
    const ec = new EditableContent(doc, page);
    sanitizeResources(doc, page, ec); // nothing removed: /Im0 is still referenced
    ec.commit();
    expect(resourceKeys(doc, 'XObject')).toContain('Im0');
  });
});

describe('sanitizeResources — orphaned font pruning', () => {
  it('prunes a font no op references while keeping the one still used', () => {
    // Content references /F1 only; /F2 is declared but never selected with Tf.
    const doc = Document.Open(buildTwoFontPage('BT /F1 10 Tf 50 100 Td (hi) Tj ET'));
    const page = doc.Pages[0];
    const ec = new EditableContent(doc, page);
    sanitizeResources(doc, page, ec);
    ec.commit();

    expect(resourceKeys(doc, 'Font').sort()).toEqual(['F1']); // F2 dropped, F1 kept
  });

  it('does not prune a font whose Tf survives text removal', () => {
    // R1 removes the shown glyphs but leaves the Tf op, so the font is still used.
    const doc = Document.Open(buildMultiStreamPage(['BT /F1 10 Tf 50 100 Td (SECRET) Tj ET']));
    const page = doc.Pages[0];
    const ec = new EditableContent(doc, page);
    removeGlyphsUnder(doc, page, [[40, 95, 200, 115]], ec);
    sanitizeResources(doc, page, ec);
    ec.commit();

    expect(resourceKeys(doc, 'Font')).toContain('F1');
  });
});

describe('resprune.ts — the module that owns the prune', () => {
  it('is the same function redact.ts re-exports', () => {
    expect(sanitizeFromOwner).toBe(sanitizeResources);
  });

  it('prunes through its own import path', () => {
    const doc = Document.Open(buildTwoFontPage('BT /F1 10 Tf 50 100 Td (hi) Tj ET'));
    const page = doc.Pages[0];
    const ec = new EditableContent(doc, page);
    sanitizeFromOwner(doc, page, ec);
    ec.commit();
    expect(resourceKeys(doc, 'Font').sort()).toEqual(['F1']);
  });
});
