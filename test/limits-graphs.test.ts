import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { LoadLimits, type LimitField } from '../src/loadlimits.js';
import { ResourceLimitError } from '../src/errors.js';
import {
  deepStructPdf, deepNumberTreePdf, deepVePdf, deepFormChainPdf,
} from './helpers/build-hostile-pdf.js';

// ibzo.6: the recursive walks ibzo.2 did not reach. Every object in these files
// is FLAT, so the COS grammar sees no depth; before this issue each walk below
// ended in a raw RangeError — or, worse, in a catch that swallowed it and
// returned a document with the content missing. Measured on a 200,000-deep
// structure tree, ToMarkdown returned "" where the shallow file gives "Hello".

function refusal(f: () => unknown): ResourceLimitError {
  try { f(); } catch (e) { if (e instanceof ResourceLimitError) return e; throw e; }
  throw new Error('completed without reaching a limit');
}
const expectLimit = (e: ResourceLimitError, field: LimitField = 'maxNestingDepth') => expect(e.limit).toBe(field);
const depth = (n: number) => ({ limits: LoadLimits.defaults.with({ maxNestingDepth: n }) });

describe('the structure tree', () => {
  it('bounds every consumer at the one place they all descend', () => {
    // Children, Nodes, GetText and GetBBox all build child elements through one
    // helper, so validation, table extraction and the three exports are bounded
    // by it rather than each keeping a counter.
    const buf = deepStructPdf(11);
    for (const [name, f] of [
      ['ValidatePdfUa', (d: Document) => d.ValidatePdfUa()],
      ['ValidatePdfUa(2)', (d: Document) => d.ValidatePdfUa(2)],
      ['GetTables', (d: Document) => d.GetTables()],
      ['ToMarkdown', (d: Document) => d.ToMarkdown()],
      ['ToHtml', (d: Document) => d.ToHtml()],
      ['ToDocx', (d: Document) => d.ToDocx()],
      ['StructTreeRoot.GetText', (d: Document) => d.GetStructTree()!.GetText()],
    ] as const) {
      const e = refusal(() => f(Document.Open(buf, depth(10))));
      expectLimit(e);
      expect(e.message, name).toContain('structure tree');
    }
  });

  it('admits a tree exactly at the bound, and its text survives the export', () => {
    // The silent failure this replaces returned "" — so the at-bound case must
    // prove the content is actually there, not merely that nothing threw.
    const doc = Document.Open(deepStructPdf(10), depth(10));
    expect(doc.ToMarkdown()).toContain('Hello');
    expect(doc.ValidatePdfUa()).toBeDefined();
  });

  it('refuses under the DEFAULTS, where the export used to come back empty', () => {
    expectLimit(refusal(() => Document.Open(deepStructPdf(20_000)).ToMarkdown()));
  });

  it('treats a cycle as damage: the back edge is dropped, the text kept, nothing thrown', () => {
    // A /K pointing at an ancestor is a broken file, not a deep one; it recursed
    // until the stack gave out. Reported as a depth limit it would misdescribe the file.
    const doc = Document.Open(deepStructPdf(3, true));
    expect(doc.GetStructTree()!.GetText()).toContain('Hello');
    expect(() => doc.ToMarkdown()).not.toThrow();
    expect(() => doc.ValidatePdfUa()).not.toThrow();
  });

  it('bounds the clone behind Split, ExtractPages and Merge', () => {
    // structpreserve walks the raw dicts rather than StructElement, so it needs
    // its own counter.
    const buf = deepStructPdf(11);
    expectLimit(refusal(() => Document.Open(buf, depth(10)).Split()));
    expectLimit(refusal(() => Document.Open(buf, depth(10)).ExtractPages([1])));
    expectLimit(refusal(() => Document.Merge(Document.Open(buf, depth(10)))));
    expect(Document.Open(deepStructPdf(10), depth(10)).Split()).toHaveLength(1);
  });
});

describe('number trees', () => {
  it('bounds the leaf collection behind StructElement.Remove', () => {
    const e = refusal(() => Document.Open(deepNumberTreePdf(11), depth(10)).GetStructTree()!.Children[0].Remove());
    expectLimit(e);
    expect(() => Document.Open(deepNumberTreePdf(10), depth(10)).GetStructTree()!.Children[0].Remove()).not.toThrow();
  });
});

describe('optional-content visibility expressions', () => {
  it('bounds /VE evaluation from extraction and rendering alike', () => {
    // Rendering used to catch the overflow and simply leave the section out.
    const buf = deepVePdf(11);
    expectLimit(refusal(() => Document.Open(buf, depth(10)).Pages[0].GetText()));
    expectLimit(refusal(() => Document.Open(buf, depth(10)).Pages[0].GetPaths()));
    expectLimit(refusal(() => Document.Open(buf, depth(10)).Pages[0].ToImage()));
    expectLimit(refusal(() => Document.Open(buf, depth(10)).FlattenLayers()));
    expect(() => Document.Open(deepVePdf(10), depth(10)).Pages[0].GetPaths()).not.toThrow();
  });

  it('bounds the rewrite behind RemoveLayer, which reaches /VE through the resources', () => {
    // Content that selects the section is refused earlier, by evaluation; this
    // fixture has none, so only RemoveLayer's own walks see the expression.
    const remove = (d: Document) => d.OptionalContent.RemoveLayer(d.OptionalContent.Layers[0]);
    expectLimit(refusal(() => remove(Document.Open(deepVePdf(11, false, true), depth(10)))));
    expect(() => remove(Document.Open(deepVePdf(10, false, true), depth(10)))).not.toThrow();
  });

  it('rewrites a cyclic /VE in RemoveLayer without unrolling it', () => {
    const doc = Document.Open(deepVePdf(5, true, true));
    expect(() => doc.OptionalContent.RemoveLayer(doc.OptionalContent.Layers[0])).not.toThrow();
  });

  it('treats a /VE cycle as a malformed expression, which reads as visible', () => {
    // 32000-1 gives a malformed /VE no meaning and this library already reads
    // one as true; a cycle is malformed, not deep. The true is read where the
    // cycle CLOSES, so the /Not levels around it still apply — four of them
    // around a true /And keep the section visible, which is what this asserts.
    const doc = Document.Open(deepVePdf(5, true));
    expect(doc.Pages[0].GetPaths()).toHaveLength(1);
    expect(() => doc.FlattenLayers()).not.toThrow();
  });
});

describe('Form XObject resource graphs', () => {
  it('bounds the font enumeration behind PDF/A and PDF/X validation', () => {
    expectLimit(refusal(() => Document.Open(deepFormChainPdf(30), depth(10)).ValidatePdfA('1b')));
    expect(() => Document.Open(deepFormChainPdf(5), depth(10)).ValidatePdfA('1b')).not.toThrow();
  });

  it('bounds the cross-document graph copy behind StampWith and NUp', () => {
    const target = () => { const t = Document.New(); t.AddPage(); return t; };
    expectLimit(refusal(() => target().Pages[0].StampWith(Document.Open(deepFormChainPdf(30), depth(10)).Pages[0])));
    expectLimit(refusal(() => Document.Open(deepFormChainPdf(30), depth(10)).NUp(2, 1)));
    expect(() => target().Pages[0].StampWith(Document.Open(deepFormChainPdf(5), depth(10)).Pages[0])).not.toThrow();
  });
});
