import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import {
  PDF17_NS, PDF20_NS, MATHML_NS,
  namespaceUriOf, namespacesOf, ensureNamespace,
} from '../src/structns.js';
import { isStandardTypeIn, PDF20_STRUCTURE_TYPES, STANDARD_STRUCTURE_TYPES } from '../src/structtype.js';
import { PdfDict, PdfObject, isArray, name } from '../src/types.js';
import { buildStampTarget } from './helpers/build-stamp-target.js';

/** A document plus a bare /StructTreeRoot dict, with no tree built. */
function bare() {
  const doc = Document.Open(buildStampTarget());
  const root: PdfDict = new Map<string, PdfObject>([['Type', name('StructTreeRoot')]]);
  return { doc, root };
}

describe('structns: the two meanings of /NS', () => {
  // On an element /NS is a REF to a namespace dict; INSIDE that dict it is the
  // URI string. Reading one as the other yields a plausible wrong answer.
  it('resolves an element /NS through the namespace dict to its URI', () => {
    const { doc, root } = bare();
    const nsRef = ensureNamespace(doc, root, PDF20_NS);
    const el: PdfDict = new Map<string, PdfObject>([['S', name('P')], ['NS', nsRef]]);
    expect(namespaceUriOf(doc, el)).toBe(PDF20_NS);
  });

  it('reports undefined for an element with no /NS', () => {
    const { doc } = bare();
    const el: PdfDict = new Map<string, PdfObject>([['S', name('P')]]);
    expect(namespaceUriOf(doc, el)).toBeUndefined();
  });

  it('reports undefined when /NS does not resolve to a namespace dict', () => {
    const { doc } = bare();
    const el: PdfDict = new Map<string, PdfObject>([['S', name('P')], ['NS', name('P')]]);
    expect(namespaceUriOf(doc, el)).toBeUndefined();
  });
});

describe('structns: declaring namespaces', () => {
  it('declares a namespace and lists it', () => {
    const { doc, root } = bare();
    ensureNamespace(doc, root, PDF20_NS);
    expect(namespacesOf(doc, root)).toEqual([PDF20_NS]);
  });

  // Idempotent, and it must reuse the SAME object: a second dict for one URI
  // makes two elements in "the same" namespace compare unequal by ref.
  it('is idempotent and reuses the existing dict', () => {
    const { doc, root } = bare();
    const a = ensureNamespace(doc, root, PDF20_NS);
    const b = ensureNamespace(doc, root, PDF20_NS);
    expect(b).toEqual(a);
    expect(namespacesOf(doc, root)).toEqual([PDF20_NS]);
    const arr = doc.resolve(root.get('Namespaces'));
    expect(isArray(arr) && arr.length).toBe(1);
  });

  it('declares a second namespace beside the first', () => {
    const { doc, root } = bare();
    ensureNamespace(doc, root, PDF17_NS);
    ensureNamespace(doc, root, PDF20_NS);
    expect(namespacesOf(doc, root)).toEqual([PDF17_NS, PDF20_NS]);
  });

  it('writes /Type /Namespace and the URI as a string', () => {
    const { doc, root } = bare();
    const ref = ensureNamespace(doc, root, PDF20_NS);
    const d = doc.resolve(ref) as PdfDict;
    expect(doc.resolve(d.get('Type'))).toEqual(name('Namespace'));
    // The URI is a STRING here, not a name and not a ref.
    const uri = doc.resolve(d.get('NS'));
    expect(typeof uri === 'object' && uri !== null && 'kind' in uri
      && (uri as { kind: string }).kind).toBe('string');
  });
});

// Transcribed verbatim from veraPDF-parser@integration
// src/main/java/org/verapdf/tools/TaggedPDFHelper.java isStandardType.
describe('structtype: the standard-type selection algorithm', () => {
  it('uses the PDF 1.7 set when the element states no namespace', () => {
    expect(isStandardTypeIn('BlockQuote', undefined)).toBe(true);
    expect(isStandardTypeIn('Aside', undefined)).toBe(false);
  });

  it('uses the PDF 1.7 set for the PDF 1.7 namespace', () => {
    expect(isStandardTypeIn('BlockQuote', PDF17_NS)).toBe(true);
    expect(isStandardTypeIn('Aside', PDF17_NS)).toBe(false);
  });

  it('uses the PDF 2.0 set for the PDF 2.0 namespace', () => {
    expect(isStandardTypeIn('Aside', PDF20_NS)).toBe(true);
    // Dropped from the 2.0 vocabulary.
    expect(isStandardTypeIn('BlockQuote', PDF20_NS)).toBe(false);
  });

  // The 2.0 vocabulary is a SET PLUS A PATTERN: H1..H6 are absent from the set
  // and standard anyway, and PDF 2.0 puts no ceiling on the level. A set-only
  // reading rejects every heading in every PDF 2.0 document.
  it('admits Hn in the PDF 2.0 namespace, for any level', () => {
    expect(PDF20_STRUCTURE_TYPES.has('H1')).toBe(false);
    expect(isStandardTypeIn('H1', PDF20_NS)).toBe(true);
    expect(isStandardTypeIn('H6', PDF20_NS)).toBe(true);
    expect(isStandardTypeIn('H42', PDF20_NS)).toBe(true);
    expect(isStandardTypeIn('H0', PDF20_NS)).toBe(false);
    expect(isStandardTypeIn('H', PDF20_NS)).toBe(true);   // in the set itself
  });

  // No MathML type list exists: the namespace makes ANY type standard.
  it('admits anything in the MathML namespace', () => {
    expect(isStandardTypeIn('mrow', MATHML_NS)).toBe(true);
    expect(isStandardTypeIn('utterly-invented', MATHML_NS)).toBe(true);
  });

  // The default arm. An invented namespace must not launder an arbitrary type.
  it('admits nothing in an unrecognised namespace', () => {
    expect(isStandardTypeIn('P', 'http://example.invalid/ns')).toBe(false);
  });
});

describe('structtype: the transcribed vocabularies', () => {
  // Asserted sizes, so a half-pasted table is a red build (htmlforeign.ts's
  // rule). 49 and 40 are the veraPDF sets as fetched 2026-09-15.
  it('carries 49 PDF 1.7 types and 40 PDF 2.0 types', () => {
    expect(STANDARD_STRUCTURE_TYPES.size).toBe(49);
    expect(PDF20_STRUCTURE_TYPES.size).toBe(40);
  });

  it('adds exactly the eight PDF 2.0 types and drops exactly twelve', () => {
    const added = [...PDF20_STRUCTURE_TYPES].filter((t) => !STANDARD_STRUCTURE_TYPES.has(t));
    expect(added.sort()).toEqual(
      ['Artifact', 'Aside', 'DocumentFragment', 'Em', 'FENote', 'Strong', 'Sub', 'Title']);
    const dropped = [...STANDARD_STRUCTURE_TYPES].filter((t) => !PDF20_STRUCTURE_TYPES.has(t));
    expect(dropped.sort()).toEqual(
      ['Art', 'BibEntry', 'BlockQuote', 'Code', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
       'Index', 'Note', 'Private', 'Quote', 'Reference', 'TOC', 'TOCI'].sort());
  });
});

describe('StructElement.Namespace and StructTreeRoot namespaces', () => {
  function tree() {
    const doc = Document.Open(buildStampTarget());
    doc.Lang = 'en-US';
    const root = doc.CreateStructTree();
    return { doc, root };
  }

  it('reads undefined for an element that states no namespace', () => {
    const { root } = tree();
    expect(root.Append('P').Namespace).toBeUndefined();
  });

  it('declares on write and reads back', () => {
    const { root } = tree();
    const p = root.Append('P');
    p.Namespace = PDF20_NS;
    expect(p.Namespace).toBe(PDF20_NS);
    expect(root.Namespaces).toEqual([PDF20_NS]);
  });

  it('shares one namespace dict between two elements', () => {
    const { doc, root } = tree();
    const a = root.Append('P');
    const b = root.Append('P');
    a.Namespace = PDF20_NS;
    b.Namespace = PDF20_NS;
    expect(root.Namespaces).toEqual([PDF20_NS]);
    // Same object, which is what 8.2.5.2-2's comparison rests on.
    expect(doc.resolve(a.Dict.get('NS'))).toBe(doc.resolve(b.Dict.get('NS')));
  });

  it('clears /NS when set to undefined', () => {
    const { root } = tree();
    const p = root.Append('P');
    p.Namespace = PDF20_NS;
    p.Namespace = undefined;
    expect(p.Namespace).toBeUndefined();
    expect(p.Dict.has('NS')).toBe(false);
  });

  it('DeclareNamespace is idempotent', () => {
    const { root } = tree();
    root.DeclareNamespace(PDF20_NS);
    root.DeclareNamespace(PDF20_NS);
    expect(root.Namespaces).toEqual([PDF20_NS]);
  });

  // Without the ns option a PDF 2.0 tree cannot be authored at all: Aside is
  // not a PDF 1.7 type, so checkStructType rejects it.
  it('Append accepts a PDF 2.0 type when the namespace is stated', () => {
    const { root } = tree();
    const el = root.Append('Aside', { ns: PDF20_NS });
    expect(el.Type).toBe('Aside');
    expect(el.Namespace).toBe(PDF20_NS);
  });

  it('Append still rejects a PDF 2.0 type with no namespace stated', () => {
    const { root } = tree();
    expect(() => root.Append('Aside')).toThrow(RangeError);
  });

  // A rejected Append must allocate nothing — formcreate.ts's rule.
  it('writes nothing when Append rejects', () => {
    const { doc, root } = tree();
    const before = doc.Save();
    expect(() => root.Append('Aside')).toThrow(RangeError);
    expect(Buffer.from(doc.Save())).toEqual(Buffer.from(before));
  });

  it('IsStandardType keeps its PDF 1.7 meaning', () => {
    const { root } = tree();
    const el = root.Append('Aside', { ns: PDF20_NS });
    // Deliberate: the accessor is documented as the PDF 1.7 question, and the
    // part-2 validator asks the namespace-aware one directly.
    expect(el.IsStandardType).toBe(false);
  });
});
