import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildTaggedPdf } from './helpers/build-tagged-pdf.js';
import { buildMultiRootPdf } from './helpers/build-multi-root-pdf.js';
import { PDF20_NS } from '../src/structns.js';
import type { StructElement } from '../src/struct.js';

describe('ConvertToPdfUa({ part: 2 })', () => {
  // Every PART-2 rule this issue's conversion targets is resolved. Not
  // `toEqual([])`: buildTaggedPdf carries TWO pre-existing defects that
  // conversion refuses to fix, because both are authoring decisions.
  //
  //  - HeadingNesting — an H2 with no H1 before it, visible in
  //    test/pdfua-part1-identity's snapshot; choosing a heading level is
  //    authoring.
  //  - LinkEnclosure — the fixture's /Link annotation (object 6) is tagged
  //    under a /Figure (object 11), and ISO 14289-2 8.2.5.20-1 requires a Link
  //    or a Reference. Added by `q7hc.4.1`, and a TRUE POSITIVE on this
  //    fixture rather than a regression: re-parenting a link annotation is
  //    authoring for the same reason a heading level is.
  //  - FontNotEmbedded — the fixture draws /Helvetica with no descriptor and
  //    no font program, and ISO 14289-2 8.4.5.5.1-1 requires every RENDERED
  //    font embedded. PDF 2.0 grants the Standard 14 no exemption, so this is
  //    a TRUE POSITIVE too. Added by `q7hc.4.3`, and unconvertible for the
  //    same reason as the other two: embedding a face means choosing one and
  //    writing it into the file, which is authoring rather than remediation —
  //    CLAUDE.md records that nothing in uafont.ts is converted.
  //
  // A blanket assertion here would be asserting the fixture rather than the
  // feature, which is why the list is exhaustive and each entry is explained.
  it('resolves every part-2 rule on a UA-1 tree', () => {
    const doc = Document.Open(buildTaggedPdf());
    const report = doc.ConvertToPdfUa({ part: 2, title: 'T', lang: 'en-US' });
    const left = report.unresolved.map((i) => i.rule);
    for (const r of ['PdfuaIdentification', 'StructParent', 'StructureNamespace',
      'RoleMapChain', 'DocumentElement', 'Metadata']) expect(left).not.toContain(r);
    expect(left).toEqual(['HeadingNesting', 'LinkEnclosure', 'FontNotEmbedded']);
  });

  // "No pre-existing STRUCTURE defects" — this fixture's tree is clean, and
  // since `q7hc.4.3` its FONT is not: it draws /Helvetica unembedded, exactly
  // as the UA-1 fixture does. The conversion still resolves everything it
  // targets, which is what this case is about, so the assertion names the one
  // defect it cannot fix rather than pretending the document is conformant.
  it('converts a tree with no pre-existing structure defects', () => {
    const doc = Document.Open(buildMultiRootPdf());
    const report = doc.ConvertToPdfUa({ part: 2, title: 'T', lang: 'en-US' });
    expect(report.unresolved.map((i) => i.rule)).toEqual(['FontNotEmbedded']);
  });

  it('writes pdfuaid:part 2 and pdfuaid:rev 2024', () => {
    const doc = Document.Open(buildTaggedPdf());
    doc.ConvertToPdfUa({ part: 2, title: 'T', lang: 'en-US' });
    const xmp = doc.GetXmp();
    expect(xmp.pdfuaPart).toBe(2);
    expect(xmp.pdfuaRev).toBe(2024);
  });

  it('puts the Document element in the PDF 2.0 namespace', () => {
    const doc = Document.Open(buildTaggedPdf());
    doc.ConvertToPdfUa({ part: 2, title: 'T', lang: 'en-US' });
    const root = doc.GetStructTree()!;
    expect(root.Children).toHaveLength(1);
    expect(root.Children[0].StandardType).toBe('Document');
    expect(root.Children[0].Namespace).toBe(PDF20_NS);
  });

  it('sets catalog /Version 2.0', () => {
    const doc = Document.Open(buildTaggedPdf());
    doc.ConvertToPdfUa({ part: 2, title: 'T', lang: 'en-US' });
    const bytes = doc.Save();
    expect(new TextDecoder('latin1').decode(bytes).slice(0, 8)).toBe('%PDF-2.0');
  });

  // The wrapping branch. buildTaggedPdf cannot reach it — it already has a
  // single Document child.
  it('wraps several top-level children in a new Document element', () => {
    const doc = Document.Open(buildMultiRootPdf());
    doc.ConvertToPdfUa({ part: 2, title: 'T', lang: 'en-US' });
    const root = doc.GetStructTree()!;
    expect(root.Children).toHaveLength(1);
    expect(root.Children[0].StandardType).toBe('Document');
    expect(root.Children[0].Namespace).toBe(PDF20_NS);
    expect(root.Children[0].Children).toHaveLength(3);
  });

  // Order is the whole content of a reading order, so wrapping must preserve
  // it. Asserted on TEXT, not on child count, which cannot see a permutation.
  it('preserves reading order when it wraps', () => {
    const doc = Document.Open(buildMultiRootPdf());
    const before = doc.GetStructTree()!.GetText();
    doc.ConvertToPdfUa({ part: 2, title: 'T', lang: 'en-US' });
    expect(doc.GetStructTree()!.GetText()).toBe(before);
  });

  it('writes /P onto every element', () => {
    const doc = Document.Open(buildMultiRootPdf());
    doc.ConvertToPdfUa({ part: 2, title: 'T', lang: 'en-US' });
    const walk = (els: StructElement[]): void => {
      for (const e of els) { expect(e.Dict.has('P')).toBe(true); walk(e.Children); }
    };
    walk(doc.GetStructTree()!.Children);
  });
});

describe('ConvertToPdfUa({ part: 2 }) reports what it must not invent', () => {
  // Choosing a /RoleMap target is authoring, so a circular chain is REPORTED
  // and never repaired. roleMapPass already exists for the case where the
  // caller supplies a mapping.
  it('leaves a circular /RoleMap chain alone and reports it', () => {
    const doc = Document.Open(buildTaggedPdf());
    // buildTaggedPdf's /RoleMap carries Loop1 -> Loop2 -> Loop1.
    const el = doc.GetStructTree()!.Children[0].Append('P');
    el.Dict.set('S', { kind: 'name', name: 'Loop1' });
    const report = doc.ConvertToPdfUa({ part: 2, title: 'T', lang: 'en-US' });
    expect(report.unresolved.map((i) => i.rule)).toContain('RoleMapChain');
    expect(report.passed).toBe(false);
    // Untouched: the cycle is still exactly as the document declared it.
    expect(doc.GetStructTree()!.RoleMap.get('Loop1')).toBe('Loop2');
    expect(doc.GetStructTree()!.RoleMap.get('Loop2')).toBe('Loop1');
  });

  // The re-validation must run at the SAME part the conversion targeted, or a
  // part-2 conversion reports as passing while the part-2 rules were never
  // asked. Pinned through the CLAUSE of a part-2-only rule, which names the
  // part — the rule id alone shows validation ran at part 2, and the clause
  // additionally shows uaClause was wired to the right one.
  it('cites ISO 14289-2 on the part-2 rules it reports', () => {
    const doc = Document.Open(buildTaggedPdf());
    const el = doc.GetStructTree()!.Children[0].Append('P');
    el.Dict.set('S', { kind: 'name', name: 'Loop1' });
    const report = doc.ConvertToPdfUa({ part: 2, title: 'T', lang: 'en-US' });
    const chain = report.unresolved.find((i) => i.rule === 'RoleMapChain');
    expect(chain?.clause).toBe('ISO 14289-2 §8.2.4');
  });
});

describe('ConvertToPdfUa part 1 is unchanged', () => {
  it('still writes pdfuaid:part 1 and no rev', () => {
    const doc = Document.Open(buildTaggedPdf());
    doc.ConvertToPdfUa({ title: 'T', lang: 'en-US' });
    expect(doc.GetXmp().pdfuaPart).toBe(1);
    expect(doc.GetXmp().pdfuaRev).toBeUndefined();
  });

  it('does not touch the structure tree or the version', () => {
    const doc = Document.Open(buildTaggedPdf());
    doc.ConvertToPdfUa({ title: 'T', lang: 'en-US' });
    expect(doc.GetStructTree()!.Children[0].Namespace).toBeUndefined();
    expect(new TextDecoder('latin1').decode(doc.Save()).slice(0, 8)).toBe('%PDF-1.7');
  });

  // convertToPdfUa re-validates, and it must re-validate at the SAME part.
  it('re-validates at part 1, not part 2', () => {
    const doc = Document.Open(buildTaggedPdf());
    const report = doc.ConvertToPdfUa({ title: 'T', lang: 'en-US' });
    expect(report.unresolved.map((i) => i.rule)).not.toContain('DocumentElement');
  });
});
