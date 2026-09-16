import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildTaggedPdf } from './helpers/build-tagged-pdf.js';
import { buildStampTarget } from './helpers/build-stamp-target.js';
import { isDict, type PdfDict } from '../src/types.js';

/** The /A dict of the last annotation on page 0. */
function actionOf(doc: Document): PdfDict {
  const annots = doc.Pages[0].Annotations;
  const a = doc.resolve(annots[annots.length - 1].Dict.get('A'));
  if (!isDict(a)) throw new Error('no action');
  return a;
}

describe('a GoTo action carries /SD in a tagged document', () => {
  it('adds /SD beside /D, leaving /D a page destination', () => {
    const doc = Document.Open(buildTaggedPdf());
    doc.Pages[0].AddLink({ rect: [10, 10, 60, 30], action: { type: 'goto', page: 1 } });
    const a = actionOf(doc);
    // /D stays a page destination, so a PDF 1.7 viewer navigates as before --
    // that is the whole reason /SD sits BESIDE it rather than replacing it.
    const d = doc.resolve(a.get('D'));
    expect(Array.isArray(d)).toBe(true);
    // /SD is the structure destination the rule asks for.
    const sd = doc.resolve(a.get('SD'));
    expect(Array.isArray(sd)).toBe(true);
    // ...and its first element is a STRUCTURE ELEMENT, which is what makes it
    // one: a structure element dict carries /S, a page never does.
    const first = doc.resolve((sd as unknown[])[0] as never);
    expect(isDict(first) && first.has('S')).toBe(true);
  });

  it('satisfies 8.8-2', () => {
    const doc = Document.Open(buildTaggedPdf());
    doc.Pages[0].AddLink({ rect: [10, 10, 60, 30], action: { type: 'goto', page: 1 } });
    const round = Document.Open(doc.Save());
    expect(round.ValidatePdfUa(2).Issues.map((i) => i.rule))
      .not.toContain('GoToNotStructure');
  });

  it('a link with NO /SD still reports, so the test above measures something', () => {
    // Belt and braces: without this the case above could pass because the rule
    // never fires on this fixture at all.
    const doc = Document.Open(buildTaggedPdf());
    doc.Pages[0].AddLink({ rect: [10, 10, 60, 30], action: { type: 'goto', page: 1 } });
    actionOf(doc).delete('SD');
    const round = Document.Open(doc.Save());
    expect(round.ValidatePdfUa(2).Issues.map((i) => i.rule))
      .toContain('GoToNotStructure');
  });

  it('writes NO /SD in an UNTAGGED document, which stays byte-identical', () => {
    // There is no structure element to point at, so the output must not move.
    const a = Document.Open(buildStampTarget());
    a.Pages[0].AddLink({ rect: [10, 10, 60, 30], action: { type: 'goto', page: 1 } });
    const b = Document.Open(buildStampTarget());
    b.Pages[0].AddLink({ rect: [10, 10, 60, 30], action: { type: 'goto', page: 1 } });
    expect(Buffer.from(a.Save()).equals(Buffer.from(b.Save()))).toBe(true);
    expect(actionOf(a).has('SD')).toBe(false);
  });
});
