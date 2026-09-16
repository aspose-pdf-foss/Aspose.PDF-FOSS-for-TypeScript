import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildTaggedPdf } from './helpers/build-tagged-pdf.js';
import { buildMultiRootPdf } from './helpers/build-multi-root-pdf.js';
import { buildStampTarget } from './helpers/build-stamp-target.js';
import { PDF20_NS, PDF17_NS } from '../src/structns.js';
import { name } from '../src/types.js';

const ids = (doc: Document, part: 1 | 2): string[] =>
  doc.ValidatePdfUa(part).Issues.map((i) => i.rule);

/** A tagged document with a /Document root element and a title, so that only
 *  the rule under test can report. */
function buildStampTargetTagged(): Uint8Array {
  const doc = Document.Open(buildStampTarget());
  doc.Lang = 'en-US';
  doc.SetMetadata({ title: 'T' });
  doc.DisplayDocTitle = true;
  const root = doc.CreateStructTree();
  root.Append('Document');
  return doc.Save();
}

describe('PDF/UA-2: identification (5-1..5-5)', () => {
  it('reports a missing pdfuaid at BOTH parts', () => {
    // Part 1 was silent here until `q7hc.4.5`, which widened the rule: PDF_UA/1
    // carries clause 5 exactly as PDF_UA/2 does, so the old gating was a gap
    // rather than a difference between the parts. The two clauses are still not
    // the same rule -- part 1 wants `part == 1` and states no rev requirement --
    // which `test/pdfua1-identification.test.ts` pins.
    const doc = Document.Open(buildTaggedPdf());
    expect(ids(doc, 2)).toContain('PdfuaIdentification');
    expect(ids(doc, 1)).toContain('PdfuaIdentification');
  });

  it('reports pdfuaid:part 1 when validating against part 2', () => {
    const doc = Document.Open(buildTaggedPdf());
    doc.SetXmp({ pdfuaPart: 1, pdfuaRev: 2024 });
    const msgs = doc.ValidatePdfUa(2).Issues
      .filter((i) => i.rule === 'PdfuaIdentification').map((i) => i.message);
    expect(msgs.join(' ')).toContain('part');
  });

  it('reports a missing or wrong pdfuaid:rev', () => {
    const doc = Document.Open(buildTaggedPdf());
    doc.SetXmp({ pdfuaPart: 2 });                    // no rev
    expect(ids(doc, 2)).toContain('PdfuaIdentification');
    doc.SetXmp({ pdfuaPart: 2, pdfuaRev: 2014 });    // wrong rev
    expect(ids(doc, 2)).toContain('PdfuaIdentification');
  });

  it('accepts part 2 with rev 2024', () => {
    const doc = Document.Open(buildTaggedPdf());
    doc.SetXmp({ pdfuaPart: 2, pdfuaRev: 2024 });
    expect(ids(doc, 2)).not.toContain('PdfuaIdentification');
  });
});

describe('PDF/UA-2: the namespace rules (8.2.4)', () => {
  // THE CORRECTION THIS ISSUE TURNS ON. An element with no /NS is in the PDF
  // 1.7 namespace by default (ISO 32000-2 14.8.6), which 8.2.4-1 permits. A
  // UA-1 tree carried over whole must NOT report here.
  it('does not report elements that state no namespace', () => {
    const doc = Document.Open(buildTaggedPdf());
    expect(ids(doc, 2)).not.toContain('StructureNamespace');
  });

  it('does not report a PDF 2.0 type in the PDF 2.0 namespace', () => {
    const doc = Document.Open(buildStampTargetTagged());
    const root = doc.GetStructTree()!;
    root.Children[0].Append('Aside', { ns: PDF20_NS });
    expect(ids(doc, 2)).not.toContain('StructureNamespace');
  });

  it('reports a type that is not standard in the namespace it names', () => {
    const doc = Document.Open(buildStampTargetTagged());
    const root = doc.GetStructTree()!;
    // BlockQuote is PDF 1.7 only; naming the 2.0 namespace makes it non-standard.
    const el = root.Children[0].Append('BlockQuote');
    el.Namespace = PDF20_NS;
    expect(ids(doc, 2)).toContain('StructureNamespace');
    expect(ids(doc, 1)).not.toContain('StructureNamespace');
  });

  it('reports an element in an unrecognised namespace', () => {
    const doc = Document.Open(buildStampTargetTagged());
    const root = doc.GetStructTree()!;
    const el = root.Children[0].Append('P');
    el.Namespace = 'http://example.invalid/ns';
    expect(ids(doc, 2)).toContain('StructureNamespace');
    expect(ids(doc, 1)).not.toContain('StructureNamespace');
  });

  it('reports a circular /RoleMap chain at part 2', () => {
    // buildTaggedPdf's /RoleMap carries Loop1 -> Loop2 -> Loop1.
    //
    // The type is written to the dict DIRECTLY rather than through Append,
    // which rejects it — `checkStructType` refuses a type no /RoleMap chain
    // resolves (q7hc.1), so this shape can only arrive in a document we did
    // not author, which is exactly the population the rule exists for.
    const doc = Document.Open(buildTaggedPdf());
    const root = doc.GetStructTree()!;
    const el = root.Children[0].Append('P');
    el.Dict.set('S', name('Loop1'));
    expect(ids(doc, 2)).toContain('RoleMapChain');
    expect(ids(doc, 1)).not.toContain('RoleMapChain');
  });
});

describe('PDF/UA-2: the Document element (8.2.5.2)', () => {
  it('reports a root with three top-level children', () => {
    const doc = Document.Open(buildMultiRootPdf());
    expect(ids(doc, 2)).toContain('DocumentElement');
    expect(ids(doc, 1)).not.toContain('DocumentElement');
  });

  // The other half: a single Document child is not enough — it must be in the
  // PDF 2.0 namespace. buildTaggedPdf has the child and not the namespace,
  // which is the everyday carried-over-from-UA-1 shape.
  it('reports a single Document child that is not in the PDF 2.0 namespace', () => {
    const doc = Document.Open(buildTaggedPdf());
    expect(ids(doc, 2)).toContain('DocumentElement');
  });

  it('accepts a single Document child in the PDF 2.0 namespace', () => {
    const doc = Document.Open(buildTaggedPdf());
    doc.GetStructTree()!.Children[0].Namespace = PDF20_NS;
    expect(ids(doc, 2)).not.toContain('DocumentElement');
  });

  // The PDF 1.7 namespace is explicitly NOT enough, which is the whole of
  // 8.2.5.2-2 and is easy to get wrong as "any declared namespace".
  it('reports a Document child in the PDF 1.7 namespace', () => {
    const doc = Document.Open(buildTaggedPdf());
    doc.GetStructTree()!.Children[0].Namespace = PDF17_NS;
    expect(ids(doc, 2)).toContain('DocumentElement');
  });
});

describe('PDF/UA-2: /P and catalog /Metadata', () => {
  it('reports an element with no /P at part 2 only', () => {
    const doc = Document.Open(buildTaggedPdf());
    const el = doc.GetStructTree()!.Children[0];
    el.Children[0].Dict.delete('P');
    expect(ids(doc, 2)).toContain('StructParent');
    expect(ids(doc, 1)).not.toContain('StructParent');
  });

  it('reports a missing catalog /Metadata at part 2 only', () => {
    const doc = Document.Open(buildTaggedPdf());
    expect(ids(doc, 2)).toContain('Metadata');
    expect(ids(doc, 1)).not.toContain('Metadata');
  });
});
