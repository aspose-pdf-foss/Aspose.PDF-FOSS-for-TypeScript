import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildStampTarget } from './helpers/build-stamp-target.js';
import { readOwnerName, effectiveListNumbering } from '../src/structattr.js';
import type { StructElement, StructTreeRoot } from '../src/struct.js';
import { PDF20_NS, MATHML_NS } from '../src/structns.js';
import { name, type PdfDict, type PdfObject } from '../src/types.js';
import {
  buildStructTablePdf, type Cell, type TableSpec,
} from './helpers/build-irregular-table-pdf.js';

/** A tagged document with a title, a language and DisplayDocTitle, so that only
 *  the rule under test can report. Returns the live tree root. */
export function taggedDoc(): { doc: Document; root: StructTreeRoot } {
  const doc = Document.Open(buildStampTarget());
  doc.Lang = 'en-US';
  doc.SetMetadata({ title: 'T' });
  doc.DisplayDocTitle = true;
  return { doc, root: doc.CreateStructTree() };
}

/** An attribute dict for `owner` carrying one name-valued key. */
function attrDict(owner: string, key: string, value: string): PdfDict {
  return new Map<string, PdfObject>([['O', name(owner)], [key, name(value)]]);
}

/** A FENote under `parent`.
 *
 *  **FENote is a PDF 2.0 type and is ABSENT from the PDF 1.7 vocabulary**, so a
 *  bare `Append('FENote')` throws `RangeError` — `checkStructType` defaults to
 *  the 1.7 arm. `TOC`, `TOCI`, `Note` and `Reference` are the mirror case, 1.7
 *  only, so those must NOT be given this namespace. */
function appendFENote(parent: StructElement): StructElement {
  return parent.Append('FENote', { ns: PDF20_NS });
}

/** Rule ids reported for `doc` at `part`. */
const ids = (doc: Document, part: 1 | 2): string[] =>
  doc.ValidatePdfUa(part).Issues.map((i) => i.rule);

const cell = (o: Cell = {}): Cell => o;
const hdr = (o: Cell = {}): Cell => ({ header: true, ...o });

/** Rule ids for a table built exactly as `spec` declares it. */
const tableIds = (spec: TableSpec, part: 1 | 2): string[] =>
  ids(Document.Open(buildStructTablePdf(spec)), part);

/** Build a tree, save, reopen, and report the rule ids at BOTH parts.
 *
 *  The cross-part PAIR is the whole point: a single-part assertion provably
 *  cannot tell a rule that correctly went quiet from one never wired up. */
function bothParts(build: (root: StructTreeRoot, doc: Document) => void):
    { at2: string[]; at1: string[] } {
  const { doc, root } = taggedDoc();
  build(root, doc);
  const re = Document.Open(doc.Save());
  return { at2: ids(re, 2), at1: ids(re, 1) };
}

describe('StructElement.References — the /Ref KEY', () => {
  it('is empty when the element states no /Ref', () => {
    const { root } = taggedDoc();
    expect(root.Append('Document').References).toEqual([]);
  });

  it('reads the refs the element names, and is NOT the element own Ref', () => {
    const { doc, root } = taggedDoc();
    const docEl = root.Append('Document');
    const target = docEl.Append('P');
    const toci = docEl.Append('TOCI');
    toci.Dict.set('Ref', [target.Ref!]);
    doc.markModified();
    expect(toci.References).toEqual([target.Ref]);
    // The collision this accessor is named to avoid: `Ref` is the element's OWN
    // object reference and has nothing to do with /Ref.
    expect(toci.Ref).not.toEqual(target.Ref);
  });

  it('ignores a /Ref that is not an array, and non-ref members', () => {
    const { doc, root } = taggedDoc();
    const el = root.Append('Document');
    el.Dict.set('Ref', name('nonsense'));
    doc.markModified();
    expect(el.References).toEqual([]);
  });
});

describe('structattr raw and inherited reads', () => {
  it('readOwnerName returns a value OUTSIDE the enumeration', () => {
    // 8.2.5.14-4 must REPORT a bad NoteType, and the typed reader drops it.
    const { doc, root } = taggedDoc();
    const el = appendFENote(root.Append('Document'));
    el.Dict.set('A', [attrDict('FENote', 'NoteType', 'Nonsense')]);
    doc.markModified();
    expect(readOwnerName(doc, root, el.Dict, 'FENote', 'NoteType')).toBe('Nonsense');
  });

  it('readOwnerName is undefined when the owner states nothing', () => {
    const { doc, root } = taggedDoc();
    const el = appendFENote(root.Append('Document'));
    expect(readOwnerName(doc, root, el.Dict, 'FENote', 'NoteType')).toBeUndefined();
  });

  it('effectiveListNumbering defaults to None when nothing states one', () => {
    const { doc, root } = taggedDoc();
    const l = root.Append('Document').Append('L');
    expect(effectiveListNumbering(doc, root, l.Dict)).toBe('None');
  });

  it('effectiveListNumbering INHERITS through /P', () => {
    // AttributeHelper.getListNumbering passes isInheritable = true and walks /P.
    // A nested list therefore inherits its ancestor's numbering; NoteType and
    // Scope pass false and do not.
    const { doc, root } = taggedDoc();
    const outer = root.Append('Document').Append('L');
    outer.SetListAttributes({ listNumbering: 'Decimal' });
    const inner = outer.Append('LI').Append('L');
    expect(effectiveListNumbering(doc, root, inner.Dict)).toBe('Decimal');
  });

  it('a nearer declaration wins over the inherited one', () => {
    const { doc, root } = taggedDoc();
    const outer = root.Append('Document').Append('L');
    outer.SetListAttributes({ listNumbering: 'Decimal' });
    const inner = outer.Append('LI').Append('L');
    inner.SetListAttributes({ listNumbering: 'Disc' });
    expect(effectiveListNumbering(doc, root, inner.Dict)).toBe('Disc');
  });
});

describe('PDF/UA-2 8.2.5: the simple shape rules', () => {
  it('8.2.5.8-1 reports a TOCI with no /Ref anywhere beneath it', () => {
    const { at2, at1 } = bothParts((root) => {
      root.Append('Document').Append('TOC').Append('TOCI').Append('P');
    });
    expect(at2).toContain('TociRef');
    expect(at1).not.toContain('TociRef');
  });

  it('8.2.5.8-1 is satisfied by a /Ref on a DESCENDANT, not just the TOCI', () => {
    const { doc, root } = taggedDoc();
    const d = root.Append('Document');
    const target = d.Append('P');
    const toci = d.Append('TOC').Append('TOCI');
    toci.Append('P').Dict.set('Ref', [target.Ref!]);
    doc.markModified();
    expect(ids(Document.Open(doc.Save()), 2)).not.toContain('TociRef');
  });

  it('8.2.5.12-1 reports the H structure type', () => {
    const { at2, at1 } = bothParts((root) => { root.Append('Document').Append('H'); });
    expect(at2).toContain('HeadingH');
    expect(at1).not.toContain('HeadingH');
  });

  it('8.2.5.14-1 reports the Note structure type', () => {
    const { at2, at1 } = bothParts((root) => { root.Append('Document').Append('Note'); });
    expect(at2).toContain('NoteProhibited');
    expect(at1).not.toContain('NoteProhibited');
  });

  it('8.2.5.23-1 accepts RB,RT and RB,RP,RT,RP and reports anything else', () => {
    const good = bothParts((root) => {
      const r = root.Append('Document').Append('Ruby');
      r.Append('RB'); r.Append('RT');
    });
    expect(good.at2).not.toContain('RubySequence');

    const long = bothParts((root) => {
      const r = root.Append('Document').Append('Ruby');
      r.Append('RB'); r.Append('RP'); r.Append('RT'); r.Append('RP');
    });
    expect(long.at2).not.toContain('RubySequence');

    const bad = bothParts((root) => {
      const r = root.Append('Document').Append('Ruby');
      r.Append('RT'); r.Append('RB');
    });
    expect(bad.at2).toContain('RubySequence');
    expect(bad.at1).not.toContain('RubySequence');
  });

  it('8.2.5.24-1 accepts WP,WT,WP and reports anything else', () => {
    const good = bothParts((root) => {
      const w = root.Append('Document').Append('Warichu');
      w.Append('WP'); w.Append('WT'); w.Append('WP');
    });
    expect(good.at2).not.toContain('WarichuSequence');

    const bad = bothParts((root) => {
      const w = root.Append('Document').Append('Warichu');
      w.Append('WT'); w.Append('WP');
    });
    expect(bad.at2).toContain('WarichuSequence');
    expect(bad.at1).not.toContain('WarichuSequence');
  });

  it('a Div between Ruby and its RB is TRANSPARENT', () => {
    // NonStruct, Div and Part are pass-through: their children stand in their
    // place, recursively. Left opaque, this Ruby reads as 'Div,RT'.
    const { at2 } = bothParts((root) => {
      const r = root.Append('Document').Append('Ruby');
      r.Append('Div').Append('RB');
      r.Append('RT');
    });
    expect(at2).not.toContain('RubySequence');
  });

  it('a Part is transparent too, which a first reading gets wrong', () => {
    // Part is a GROUPING element rather than a wrapper, so it reads as opaque.
    const { at2 } = bothParts((root) => {
      const w = root.Append('Document').Append('Warichu');
      w.Append('WP');
      w.Append('Part').Append('WT');
      w.Append('WP');
    });
    expect(at2).not.toContain('WarichuSequence');
  });

  it('8.2.5.27-1 reports a Caption that is neither first nor last', () => {
    const mid = bothParts((root) => {
      const s = root.Append('Document').Append('Sect');
      s.Append('P'); s.Append('Caption'); s.Append('P');
    });
    expect(mid.at2).toContain('CaptionPosition');
    expect(mid.at1).not.toContain('CaptionPosition');

    const first = bothParts((root) => {
      const s = root.Append('Document').Append('Sect');
      s.Append('Caption'); s.Append('P'); s.Append('P');
    });
    expect(first.at2).not.toContain('CaptionPosition');

    const last = bothParts((root) => {
      const s = root.Append('Document').Append('Sect');
      s.Append('P'); s.Append('P'); s.Append('Caption');
    });
    expect(last.at2).not.toContain('CaptionPosition');
  });

  it('8.2.5.29-1 reports a MathML element outside a Formula', () => {
    const bad = bothParts((root) => {
      root.Append('Document').Append('P').Append('math', { ns: MATHML_NS });
    });
    expect(bad.at2).toContain('MathMLParent');
    expect(bad.at1).not.toContain('MathMLParent');

    const good = bothParts((root) => {
      root.Append('Document').Append('Formula').Append('math', { ns: MATHML_NS });
    });
    expect(good.at2).not.toContain('MathMLParent');
  });

  it('8.2.5.29-1 allows MathML nested inside MathML', () => {
    const { at2 } = bothParts((root) => {
      const m = root.Append('Document').Append('Formula').Append('math', { ns: MATHML_NS });
      m.Append('mrow', { ns: MATHML_NS });
    });
    expect(at2).not.toContain('MathMLParent');
  });

  it('8.2.5.25-2 reports an LI that owns marked content directly', () => {
    const { doc, root } = taggedDoc();
    const li = root.Append('Document').Append('L').Append('LI');
    li.MarkContent(doc.Pages[0], [0, 0, 100, 100]);
    const re = Document.Open(doc.Save());
    expect(ids(re, 2)).toContain('ListItemContent');
    expect(ids(re, 1)).not.toContain('ListItemContent');
  });

  it('8.2.5.25-2 is silent when the content sits in an LBody', () => {
    const { doc, root } = taggedDoc();
    const li = root.Append('Document').Append('L').Append('LI');
    li.Append('LBody').MarkContent(doc.Pages[0], [0, 0, 100, 100]);
    expect(ids(Document.Open(doc.Save()), 2)).not.toContain('ListItemContent');
  });
});

describe('PDF/UA-2 8.2.5.14: the FENote /Ref graph', () => {
  it('reports an orphan — a citation the FENote does not cite back', () => {
    const { doc, root } = taggedDoc();
    const d = root.Append('Document');
    const note = appendFENote(d);
    const cite = d.Append('P');
    cite.Dict.set('Ref', [note.Ref!]);   // one-sided: the note names nobody
    doc.markModified();
    const re = Document.Open(doc.Save());
    expect(ids(re, 2)).toContain('FENoteRefOrphan');
    expect(ids(re, 2)).not.toContain('FENoteRefGhost');
    expect(ids(re, 1)).not.toContain('FENoteRefOrphan');
  });

  it('reports a ghost — a reference the cited element does not return', () => {
    const { doc, root } = taggedDoc();
    const d = root.Append('Document');
    const note = appendFENote(d);
    const cite = d.Append('P');
    note.Dict.set('Ref', [cite.Ref!]);   // one-sided the other way
    doc.markModified();
    const re = Document.Open(doc.Save());
    expect(ids(re, 2)).toContain('FENoteRefGhost');
    expect(ids(re, 2)).not.toContain('FENoteRefOrphan');
    expect(ids(re, 1)).not.toContain('FENoteRefGhost');
  });

  it('is silent when the graph closes in both directions', () => {
    const { doc, root } = taggedDoc();
    const d = root.Append('Document');
    const note = appendFENote(d);
    const cite = d.Append('P');
    note.Dict.set('Ref', [cite.Ref!]);
    cite.Dict.set('Ref', [note.Ref!]);
    doc.markModified();
    const at2 = ids(Document.Open(doc.Save()), 2);
    expect(at2).not.toContain('FENoteRefOrphan');
    expect(at2).not.toContain('FENoteRefGhost');
  });

  it('8.2.5.14-4 accepts the three NoteType values and an ABSENT one', () => {
    for (const nt of ['Footnote', 'Endnote', 'None']) {
      const { doc, root } = taggedDoc();
      const note = appendFENote(root.Append('Document'));
      note.Dict.set('A', [attrDict('FENote', 'NoteType', nt)]);
      doc.markModified();
      expect(ids(Document.Open(doc.Save()), 2)).not.toContain('FENoteType');
    }
    // Absent reads as the default None (AttributeHelper.getNoteType), so it
    // PASSES rather than failing — the obvious reading has this backwards.
    const { doc, root } = taggedDoc();
    appendFENote(root.Append('Document'));
    expect(ids(Document.Open(doc.Save()), 2)).not.toContain('FENoteType');
  });

  it('8.2.5.14-4 reports a NoteType outside the three', () => {
    const { doc, root } = taggedDoc();
    const note = appendFENote(root.Append('Document'));
    note.Dict.set('A', [attrDict('FENote', 'NoteType', 'Sidenote')]);
    doc.markModified();
    const re = Document.Open(doc.Save());
    expect(ids(re, 2)).toContain('FENoteType');
    expect(ids(re, 1)).not.toContain('FENoteType');
  });
});

describe('PDF/UA-2 8.2.5.25-1: ListNumbering', () => {
  it('reports a list whose items carry an Lbl with no numbering stated', () => {
    const { at2, at1 } = bothParts((root) => {
      const li = root.Append('Document').Append('L').Append('LI');
      li.Append('Lbl'); li.Append('LBody');
    });
    expect(at2).toContain('ListNumbering');
    expect(at1).not.toContain('ListNumbering');
  });

  it('is silent when the L states a numbering other than None', () => {
    const { doc, root } = taggedDoc();
    const l = root.Append('Document').Append('L');
    l.SetListAttributes({ listNumbering: 'Decimal' });
    const li = l.Append('LI');
    li.Append('Lbl'); li.Append('LBody');
    expect(ids(Document.Open(doc.Save()), 2)).not.toContain('ListNumbering');
  });

  it('reports an explicit ListNumbering of None', () => {
    const { doc, root } = taggedDoc();
    const l = root.Append('Document').Append('L');
    l.SetListAttributes({ listNumbering: 'None' });
    const li = l.Append('LI');
    li.Append('Lbl'); li.Append('LBody');
    expect(ids(Document.Open(doc.Save()), 2)).toContain('ListNumbering');
  });

  it('is silent for a list with no Lbl at all', () => {
    const { at2 } = bothParts((root) => {
      root.Append('Document').Append('L').Append('LI').Append('LBody');
    });
    expect(at2).not.toContain('ListNumbering');
  });

  it('INHERITS the numbering from an outer list', () => {
    const { doc, root } = taggedDoc();
    const outer = root.Append('Document').Append('L');
    outer.SetListAttributes({ listNumbering: 'Decimal' });
    const inner = outer.Append('LI').Append('L');
    const li = inner.Append('LI');
    li.Append('Lbl'); li.Append('LBody');
    expect(ids(Document.Open(doc.Save()), 2)).not.toContain('ListNumbering');
  });
});

describe('PDF/UA-2 8.2.5.20: link annotations', () => {
  const uriA = 'https://example.test/a';
  const uriB = 'https://example.test/b';

  /** A tagged page with one link annotation, tagged under `wrapper`. */
  function linkUnder(wrapper: string): Document {
    const { doc, root } = taggedDoc();
    const page = doc.Pages[0];
    const el = root.Append('Document').Append(wrapper);
    el.AddAnnotation(page.AddLink({
      rect: [0, 0, 50, 20], action: { type: 'uri', uri: uriA },
    }));
    return Document.Open(doc.Save());
  }

  /** Two links under one Link element, with the given URIs. */
  function twoLinks(a: string, b: string): Document {
    const { doc, root } = taggedDoc();
    const page = doc.Pages[0];
    const el = root.Append('Document').Append('Link');
    el.AddAnnotation(page.AddLink({ rect: [0, 0, 50, 20], action: { type: 'uri', uri: a } }));
    el.AddAnnotation(page.AddLink({ rect: [0, 30, 50, 50], action: { type: 'uri', uri: b } }));
    return Document.Open(doc.Save());
  }

  it('is silent for a link inside a Link element', () => {
    expect(ids(linkUnder('Link'), 2)).not.toContain('LinkEnclosure');
  });

  it('is silent for a link inside a Reference element', () => {
    expect(ids(linkUnder('Reference'), 2)).not.toContain('LinkEnclosure');
  });

  it('reports a link inside anything else', () => {
    const re = linkUnder('P');
    expect(ids(re, 2)).toContain('LinkEnclosure');
    expect(ids(re, 1)).not.toContain('LinkEnclosure');
  });

  it('is silent for a link that is in NO structure element at all', () => {
    // The profile test carries an explicit `|| structParentType == null`, so an
    // untagged link does NOT report here. It reads wrong; it is what the anchor
    // says, and UntaggedContent covers that case instead.
    const { doc } = taggedDoc();
    doc.Pages[0].AddLink({ rect: [0, 0, 50, 20], action: { type: 'uri', uri: uriA } });
    expect(ids(Document.Open(doc.Save()), 2)).not.toContain('LinkEnclosure');
  });

  it('reports two links with DIFFERENT targets under one Link element', () => {
    const re = twoLinks(uriA, uriB);
    expect(ids(re, 2)).toContain('LinkTargets');
    expect(ids(re, 1)).not.toContain('LinkTargets');
  });

  it('is silent for two links with the SAME target under one Link element', () => {
    expect(ids(twoLinks(uriA, uriA), 2)).not.toContain('LinkTargets');
  });

  it('is silent for two differing links under SEPARATE Link elements', () => {
    const { doc, root } = taggedDoc();
    const page = doc.Pages[0];
    const d = root.Append('Document');
    d.Append('Link').AddAnnotation(page.AddLink({
      rect: [0, 0, 50, 20], action: { type: 'uri', uri: uriA },
    }));
    d.Append('Link').AddAnnotation(page.AddLink({
      rect: [0, 30, 50, 50], action: { type: 'uri', uri: uriB },
    }));
    expect(ids(Document.Open(doc.Save()), 2)).not.toContain('LinkTargets');
  });
});

describe('PDF/UA-2 8.2.5.26: table regularity', () => {
  it('is silent for a plain regular table', () => {
    const at2 = tableIds({
      rows: [[hdr({ scope: 'Column' }), hdr({ scope: 'Column' })], [cell(), cell()]],
    }, 2);
    expect(at2).not.toContain('TableCellIntersection');
    expect(at2).not.toContain('TableRowRegularity');
    expect(at2).not.toContain('TableColumnRegularity');
    expect(at2).not.toContain('TableColumnCount');
  });

  it('26-1 reports two cells occupying one slot, naming both', () => {
    // Placement SKIPS an occupied slot, so a collision needs a cell's
    // EXTENSION to meet one already placed: (0,1) spans down, and row 1's
    // single cell spans two columns into it.
    const spec = { rows: [[cell(), cell({ rowSpan: 2 })], [cell({ colSpan: 2 })]] };
    const hits = Document.Open(buildStructTablePdf(spec))
      .ValidatePdfUa(2).Issues.filter((i) => i.rule === 'TableCellIntersection');
    expect(hits).toHaveLength(2);
    expect(tableIds(spec, 1)).not.toContain('TableCellIntersection');
  });

  it('26-2 reports a row span that crosses a THead/TBody seam', () => {
    const spec = {
      groups: [
        { type: 'THead' as const, rows: [[cell({ rowSpan: 2 }), cell()]] },
        { type: 'TBody' as const, rows: [[cell()]] },
      ],
    };
    expect(tableIds(spec, 2)).toContain('TableRowRegularity');
    expect(tableIds(spec, 1)).not.toContain('TableRowRegularity');
  });

  it('26-2 is silent when that same span stays inside one grouping', () => {
    const spec = {
      groups: [{
        type: 'TBody' as const,
        rows: [[cell({ rowSpan: 2 }), cell()], [cell()]],
      }],
    };
    expect(tableIds(spec, 2)).not.toContain('TableRowRegularity');
  });

  it('26-3 reports a row WIDER than row 0, with no count', () => {
    const spec = { rows: [[cell(), cell()], [cell(), cell(), cell()]] };
    const at2 = tableIds(spec, 2);
    expect(at2).toContain('TableColumnRegularity');
    expect(at2).not.toContain('TableColumnCount');
    expect(tableIds(spec, 1)).not.toContain('TableColumnRegularity');
  });

  it('26-4 reports a SHORT row, with the count it reached', () => {
    const spec = { rows: [[cell(), cell()], [cell()]] };
    const at2 = tableIds(spec, 2);
    expect(at2).toContain('TableColumnCount');
    expect(at2).not.toContain('TableColumnRegularity');
    expect(tableIds(spec, 1)).not.toContain('TableColumnCount');
  });

  it('an irregular table is NOT also asked about headers', () => {
    // The fixture has to be able to FAIL the header walk, or gate 1 measures
    // nothing: an all-TD table leaves `everyHeaderScoped` true and gate 2
    // returns first. Measured — with an all-TD table, removing gate 1 stays
    // GREEN. So: an UNSCOPED TH (defeating gate 2), three columns, a short
    // second row (irregular), and a TD at (1,1) with no header above it and
    // none to its left.
    const at2 = tableIds({
      rows: [[hdr(), cell(), cell()], [cell(), cell()]],
    }, 2);
    expect(at2).toContain('TableColumnCount');
    expect(at2).not.toContain('TableHeaderConnectivity');
    expect(at2).not.toContain('TableHeaderUndefined');
  });
});

describe('PDF/UA-2 8.2.5.26: header connectivity', () => {
  it('examines no cell when every TH states a Scope', () => {
    // The lone TD is unreachable from any header, but gate 2 fires first — so a
    // fixture built the obvious way measures NOTHING here.
    const spec = { rows: [[hdr({ scope: 'Column' }), cell()], [cell(), cell()]] };
    const at2 = tableIds(spec, 2);
    expect(at2).not.toContain('TableHeaderConnectivity');
    expect(at2).not.toContain('TableHeaderUndefined');
  });

  it('26-5 reports a TD with no /Headers and none derivable', () => {
    // The TH is UNSCOPED, so gate 2 does not fire and the walk runs.
    const spec = { rows: [[hdr(), cell()], [cell(), cell()]] };
    expect(tableIds(spec, 2)).toContain('TableHeaderConnectivity');
    expect(tableIds(spec, 1)).not.toContain('TableHeaderConnectivity');
  });

  it('26-5 is silent when the TD names a header that exists', () => {
    const spec = {
      rows: [[hdr({ id: 'h' }), cell()], [cell(), cell({ headers: ['h'] })]],
    };
    expect(tableIds(spec, 2)).not.toContain('TableHeaderConnectivity');
  });

  it('26-6 reports a TD whose /Headers names an id no TH declares', () => {
    const spec = {
      rows: [[hdr({ id: 'h' }), cell()], [cell(), cell({ headers: ['nope'] })]],
    };
    const at2 = tableIds(spec, 2);
    expect(at2).toContain('TableHeaderUndefined');
    expect(at2).not.toContain('TableHeaderConnectivity');
    expect(tableIds(spec, 1)).not.toContain('TableHeaderUndefined');
  });

  it('counts a TH stating a JUNK Scope as scoped, so gate 2 still fires', () => {
    // The ONLY input on which the raw scope read differs from the typed one.
    // veraPDF's gate counts a TH as scoped when it states ANY name, junk
    // included, so this table is connected and no TD is examined — where a
    // validated read would drop the junk, leave `everyHeaderScoped` false, run
    // the walk, and report (1,1). Measured: without this case, reading Scope
    // through the TYPED accessor instead reddens NOTHING.
    const spec = { rows: [[hdr({ rawScope: 'Nonsense' }), cell()], [cell(), cell()]] };
    const at2 = tableIds(spec, 2);
    expect(at2).not.toContain('TableHeaderConnectivity');
    expect(at2).not.toContain('TableHeaderUndefined');
  });

  it('reports at most ONE disconnected TD per table', () => {
    // veraPDF's hasHeaders returns on the first failure. Mirrored deliberately.
    const spec = { rows: [[hdr(), cell()], [cell(), cell()], [cell(), cell()]] };
    const hits = Document.Open(buildStructTablePdf(spec))
      .ValidatePdfUa(2).Issues.filter((i) => i.rule === 'TableHeaderConnectivity');
    expect(hits).toHaveLength(1);
  });
});

describe('PDF/UA-2 8.2.5.26: pass-through rows', () => {
  for (const wrap of ['NonStruct', 'Div', 'Part']) {
    it(`a ${wrap} between the Table and its rows is TRANSPARENT`, () => {
      // Left opaque, this table has ZERO rows, countRows returns 0, and the
      // grid reports it REGULAR by default — a silent false negative. Part is
      // the surprising member: a grouping element rather than a wrapper.
      const spec = { rows: [[cell(), cell()], [cell()]], wrapRowsIn: wrap };
      expect(tableIds(spec, 2)).toContain('TableColumnCount');
    });
  }
});

describe('PDF/UA-2 8.2.5.28.2-1: Figure alt text is PRE-EXISTING', () => {
  it('reports at BOTH parts, under IllustrationAlt, and is not duplicated', () => {
    // The twenty-first rule of the clause. `IllustrationAlt` already covers
    // Figure/Formula/Form at both parts, so this rule is SATISFIED rather than
    // implemented — the one rule of the 21 that is not silent at part 1. A
    // part-2-only twin would make one missing /Alt report twice, so there is
    // none. Asserted here so the exemption reads as a decision.
    const { at2, at1 } = bothParts((root) => { root.Append('Document').Append('Figure'); });
    expect(at2).toContain('IllustrationAlt');
    expect(at1).toContain('IllustrationAlt');
    expect(at2.filter((r) => r === 'IllustrationAlt')).toHaveLength(1);
    expect(at2).not.toContain('FigureAlt');
  });
});
