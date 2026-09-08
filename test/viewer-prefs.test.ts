import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { isArray, isDict, isName, name, type PdfDict, type PdfObject } from '../src/types.js';

/** A document with `n` A4 pages. */
const docWith = (n: number) => {
  const doc = Document.New();
  for (let i = 0; i < n; i++) doc.AddPage(PageFormat.A4);
  return doc;
};
const reopen = (d: Document) => Document.Open(d.Save());

/** The live /ViewerPreferences dict, or undefined. */
const vpOf = (d: Document): PdfDict | undefined => {
  const v = d.resolve(d.catalog().get('ViewerPreferences'));
  return isDict(v) ? v : undefined;
};

/** Seed a raw /ViewerPreferences dict, bypassing the writer. */
const seed = (d: Document, entries: Array<[string, PdfObject]>): Document => {
  d.catalog().set('ViewerPreferences', new Map<string, PdfObject>(entries));
  return d;
};

describe('GetViewerPreferences (read)', () => {
  it('is an empty object when the catalog has no /ViewerPreferences', () => {
    expect(docWith(1).GetViewerPreferences()).toEqual({});
  });

  it('reads the seven booleans', () => {
    const doc = seed(docWith(1), [
      ['HideToolbar', true], ['HideMenubar', true], ['HideWindowUI', true],
      ['FitWindow', true], ['CenterWindow', true], ['DisplayDocTitle', true],
      ['PickTrayByPDFSize', true],
    ]);
    expect(doc.GetViewerPreferences()).toEqual({
      hideToolbar: true, hideMenubar: true, hideWindowUI: true,
      fitWindow: true, centerWindow: true, displayDocTitle: true,
      pickTrayByPDFSize: true,
    });
  });

  it('reads the eight name-valued entries', () => {
    const doc = seed(docWith(1), [
      ['NonFullScreenPageMode', name('UseOutlines')], ['Direction', name('R2L')],
      ['ViewArea', name('MediaBox')], ['ViewClip', name('BleedBox')],
      ['PrintArea', name('TrimBox')], ['PrintClip', name('ArtBox')],
      ['PrintScaling', name('None')], ['Duplex', name('DuplexFlipShortEdge')],
    ]);
    expect(doc.GetViewerPreferences()).toEqual({
      nonFullScreenPageMode: 'UseOutlines', direction: 'R2L',
      viewArea: 'MediaBox', viewClip: 'BleedBox',
      printArea: 'TrimBox', printClip: 'ArtBox',
      printScaling: 'None', duplex: 'DuplexFlipShortEdge',
    });
  });

  it('reads /NumCopies and /PrintPageRange as pairs', () => {
    const doc = seed(docWith(12), [['NumCopies', 3], ['PrintPageRange', [1, 4, 9, 12]]]);
    expect(doc.GetViewerPreferences())
      .toEqual({ numCopies: 3, printPageRange: [[1, 4], [9, 12]] });
  });

  // ABSENT is not STATED-FALSE. A caller must be able to tell "the producer
  // said nothing" from "the producer said false" — the present-versus-absent
  // rule parseSimpleWidths already records for /MissingWidth. Defaulting the
  // getter collapses the two and makes a round trip write keys the document
  // never had.
  it('leaves an unstated entry undefined rather than defaulting it', () => {
    const doc = seed(docWith(1), [['HideToolbar', false]]);
    const vp = doc.GetViewerPreferences();
    expect(vp.hideToolbar).toBe(false);           // stated false
    expect('fitWindow' in vp).toBe(false);        // unstated, NOT false
    expect('direction' in vp).toBe(false);        // unstated, NOT 'L2R'
    expect('viewArea' in vp).toBe(false);         // unstated, NOT 'CropBox'
    expect('printScaling' in vp).toBe(false);     // unstated, NOT 'AppDefault'
    expect('nonFullScreenPageMode' in vp).toBe(false); // unstated, NOT 'UseNone'
  });

  it('resolves an indirect /ViewerPreferences and indirect values', () => {
    const doc = docWith(1);
    const vp: PdfDict = new Map<string, PdfObject>([
      ['NumCopies', doc.allocObject(2)], ['Direction', doc.allocObject(name('R2L'))],
    ]);
    doc.catalog().set('ViewerPreferences', doc.allocObject(vp));
    expect(doc.GetViewerPreferences()).toEqual({ numCopies: 2, direction: 'R2L' });
  });

  it('survives a save/open round trip', () => {
    const doc = docWith(12);
    doc.SetViewerPreferences({
      hideToolbar: true, fitWindow: false, direction: 'R2L',
      nonFullScreenPageMode: 'UseThumbs', viewArea: 'MediaBox', viewClip: 'BleedBox',
      printArea: 'TrimBox', printClip: 'ArtBox', printScaling: 'None',
      duplex: 'DuplexFlipLongEdge', pickTrayByPDFSize: true,
      numCopies: 4, printPageRange: [[2, 5]],
    });
    expect(reopen(doc).GetViewerPreferences()).toEqual({
      hideToolbar: true, fitWindow: false, direction: 'R2L',
      nonFullScreenPageMode: 'UseThumbs', viewArea: 'MediaBox', viewClip: 'BleedBox',
      printArea: 'TrimBox', printClip: 'ArtBox', printScaling: 'None',
      duplex: 'DuplexFlipLongEdge', pickTrayByPDFSize: true,
      numCopies: 4, printPageRange: [[2, 5]],
    });
  });
});

// Reading LENIENTLY is what keeps a damaged or newer entry from throwing out of
// a plain accessor — GetXmp's rule. The write half is what makes it safe: the
// merge touches only the keys the update states, so what we declined to read is
// still in the file afterwards. Read leniently and write narrowly, or a
// read-modify-write silently strips every entry we do not model.
describe('GetViewerPreferences (lenient reads)', () => {
  it('ignores a value of the wrong type', () => {
    const doc = seed(docWith(1), [
      ['HideToolbar', name('true')],           // name where boolean belongs
      ['Direction', true],                     // boolean where name belongs
      ['NumCopies', name('Two')],              // name where integer belongs
      ['PrintPageRange', 4],                   // number where array belongs
    ]);
    expect(doc.GetViewerPreferences()).toEqual({});
  });

  it('ignores a name outside its enumeration', () => {
    const doc = seed(docWith(1), [
      ['Direction', name('T2B')], ['PrintScaling', name('Fit')],
      ['ViewArea', name('PageBox')], ['Duplex', name('Triplex')],
      ['NonFullScreenPageMode', name('UseAttachments')],
    ]);
    expect(doc.GetViewerPreferences()).toEqual({});
  });

  it('ignores a /NumCopies that is not a positive integer', () => {
    for (const v of [0, -1, 2.5, NaN]) {
      const doc = seed(docWith(1), [['NumCopies', v]]);
      expect(doc.GetViewerPreferences().numCopies).toBeUndefined();
    }
  });

  // MEASURED: the `arr.length === 0` half of this is load-bearing (an empty
  // array otherwise reads back as an empty range list), while the `% 2` half
  // provably is NOT and cannot be — an odd array always ends unpaired, and
  // doc.resolve(undefined) is null, which isPositiveInt rejects. The odd-length
  // test stays as the honest spelling of the question; do not cite it as
  // covered, and do not "simplify" it away either.
  it('ignores a malformed /PrintPageRange', () => {
    for (const v of [[1, 2, 3], [4, 2], [0, 3], [1.5, 3], [], [1, name('4')]]) {
      const doc = seed(docWith(12), [['PrintPageRange', v as PdfObject]]);
      expect(doc.GetViewerPreferences().printPageRange).toBeUndefined();
    }
  });

  // A deliberate asymmetry with the writer, which range-checks against the page
  // count. Reading reports what the PRODUCER said — a document split out of a
  // longer one legitimately carries a range past its own end — while writing
  // must not manufacture a range no dialog can honour.
  it('reads a range that runs past the last page', () => {
    const doc = seed(docWith(2), [['PrintPageRange', [1, 99]]]);
    expect(doc.GetViewerPreferences().printPageRange).toEqual([[1, 99]]);
    expect(() => doc.SetViewerPreferences({ printPageRange: [[1, 99]] })).toThrow(RangeError);
  });

  // The other half of leniency, and the half that matters: a merge must not
  // delete what it declined to read. Without this an entry from a newer spec
  // revision vanishes the first time anybody sets an unrelated preference.
  it('leaves an unreadable entry in the dict through a merge write', () => {
    const doc = seed(docWith(1), [['Direction', name('T2B')], ['Enforce', [name('PrintScaling')]]]);
    doc.SetViewerPreferences({ hideToolbar: true });
    const vp = vpOf(doc)!;
    expect(isName(vp.get('Direction')) && (vp.get('Direction') as { name: string }).name).toBe('T2B');
    expect(isArray(vp.get('Enforce'))).toBe(true);
    expect(vp.get('HideToolbar')).toBe(true);
  });
});

describe('SetViewerPreferences (write)', () => {
  it('creates the dict and writes booleans, names, integers and the range', () => {
    const doc = docWith(12);
    doc.SetViewerPreferences({
      centerWindow: true, duplex: 'Simplex', numCopies: 2, printPageRange: [[1, 3], [7, 9]],
    });
    const vp = vpOf(doc)!;
    expect(vp.get('CenterWindow')).toBe(true);
    expect(vp.get('Duplex')).toEqual(name('Simplex'));
    expect(vp.get('NumCopies')).toBe(2);
    expect(vp.get('PrintPageRange')).toEqual([1, 3, 7, 9]); // flattened on the wire
  });

  it('merges: undefined leaves, a value sets, null deletes', () => {
    const doc = docWith(1);
    doc.SetViewerPreferences({ hideToolbar: true, fitWindow: true, direction: 'R2L' });
    doc.SetViewerPreferences({ fitWindow: false, direction: null });
    expect(doc.GetViewerPreferences()).toEqual({ hideToolbar: true, fitWindow: false });
  });

  it('writes a stated false rather than treating it as a delete', () => {
    const doc = docWith(1);
    doc.SetViewerPreferences({ hideMenubar: false });
    expect(vpOf(doc)!.get('HideMenubar')).toBe(false);
    expect(doc.GetViewerPreferences().hideMenubar).toBe(false);
  });

  // MEASURED, and the redundant-defence trap in miniature: THREE guards keep an
  // empty << >> out of the catalog — the empty-update return, the pure-delete
  // return and the prune — and any TWO of them can be deleted with this file
  // still green. Only removing all three reddens (3 cases). They are kept
  // because they answer different questions: the first two also decline to call
  // markModified() for a call that changed nothing, which nothing here can see,
  // and only the prune reaches the delete-the-last-of-several case. Breaking
  // any one alone proves nothing — do not read a green suite as covering it.
  it('does nothing at all for an empty update', () => {
    const doc = docWith(1);
    doc.SetViewerPreferences({});
    expect(doc.catalog().has('ViewerPreferences')).toBe(false);
  });

  // An empty << >> says nothing, and leaving one behind gives a document that
  // "has viewer preferences" and does not — the shape removeNameTreeEntry
  // already prunes.
  it('prunes the dict when the last entry is deleted', () => {
    const doc = docWith(1);
    doc.SetViewerPreferences({ hideToolbar: true });
    expect(doc.catalog().has('ViewerPreferences')).toBe(true);
    doc.SetViewerPreferences({ hideToolbar: null });
    expect(doc.catalog().has('ViewerPreferences')).toBe(false);
  });

  it('does not prune a dict still holding an entry we do not model', () => {
    const doc = seed(docWith(1), [['Enforce', [name('PrintScaling')]]]);
    doc.SetViewerPreferences({ hideToolbar: true });
    doc.SetViewerPreferences({ hideToolbar: null });
    expect(doc.catalog().has('ViewerPreferences')).toBe(true);
  });

  it('deleting an absent entry is a no-op, not a materialized dict', () => {
    const doc = docWith(1);
    doc.SetViewerPreferences({ numCopies: null });
    expect(doc.catalog().has('ViewerPreferences')).toBe(false);
  });
});

// Every refusal must leave the document BYTE-IDENTICAL: validation runs over
// the whole update before a single key is written, formcreate.ts's rule. A
// writer that validates as it goes leaves half an update applied, which is a
// document nobody asked for and no error names.
describe('SetViewerPreferences (validation)', () => {
  const rejects = (update: object, ctor: ErrorConstructor) => {
    const doc = docWith(12);
    doc.SetViewerPreferences({ hideToolbar: true, numCopies: 2 });
    const before = doc.Save();
    expect(() => doc.SetViewerPreferences(update as never)).toThrow(ctor);
    expect(doc.Save()).toEqual(before);
  };

  it('TypeError for the wrong kind of thing', () => {
    rejects({ hideToolbar: 'yes' }, TypeError);
    rejects({ direction: 42 }, TypeError);
    rejects({ numCopies: '2' }, TypeError);
    rejects({ numCopies: 2.5 }, TypeError);
    // MEASURED and NOT covered: the pair-SHAPE check is redundant with the
    // integer check that follows it — a flat [1, 4] fails as `(1)[0]` is not an
    // integer, so both spellings throw TypeError and this case cannot tell them
    // apart. Retained as the honest statement of the rule.
    rejects({ printPageRange: [1, 4] }, TypeError);          // flat, not pairs
    rejects({ printPageRange: [[1, 4, 9]] }, TypeError);     // not a pair
    rejects({ printPageRange: 'all' }, TypeError);
  });

  it('RangeError for a value outside the allowed set', () => {
    rejects({ direction: 'T2B' }, RangeError);
    rejects({ printScaling: 'Fit' }, RangeError);
    rejects({ viewArea: 'PageBox' }, RangeError);
    rejects({ duplex: 'Triplex' }, RangeError);
    rejects({ nonFullScreenPageMode: 'UseAttachments' }, RangeError);
    rejects({ numCopies: 0 }, RangeError);
    rejects({ numCopies: -1 }, RangeError);
  });

  it('RangeError for a page range that is descending, zero-based or off the end', () => {
    rejects({ printPageRange: [[4, 2]] }, RangeError);
    rejects({ printPageRange: [[0, 3]] }, RangeError);
    rejects({ printPageRange: [[1, 13]] }, RangeError); // the doc has 12 pages
    rejects({ printPageRange: [[1, 2], [3, 99]] }, RangeError);
  });

  // The whole point of validating up front: the FIRST key of this update is
  // perfectly good, so a writer that validated as it went would have written it.
  it('writes nothing when a later key of the update is bad', () => {
    const doc = docWith(1);
    expect(() => doc.SetViewerPreferences({ centerWindow: true, direction: 'T2B' as never }))
      .toThrow(RangeError);
    expect(doc.catalog().has('ViewerPreferences')).toBe(false);
  });
});

// doc.DisplayDocTitle predates this module and PDF/UA depends on it. These
// assertions are the FENCE that folding it in moved nothing — they are written
// against the OLD API on purpose.
describe('DisplayDocTitle delegation', () => {
  it('still reads false for a document that states nothing', () => {
    expect(docWith(1).DisplayDocTitle).toBe(false);
  });

  it('still reads false for a stated false', () => {
    expect(seed(docWith(1), [['DisplayDocTitle', false]]).DisplayDocTitle).toBe(false);
  });

  it('still creates the dict and sets the flag', () => {
    const doc = docWith(1);
    doc.DisplayDocTitle = true;
    expect(vpOf(doc)!.get('DisplayDocTitle')).toBe(true);
    expect(reopen(doc).DisplayDocTitle).toBe(true);
  });

  it('agrees with the new accessor in both directions', () => {
    const doc = docWith(1);
    doc.SetViewerPreferences({ displayDocTitle: true });
    expect(doc.DisplayDocTitle).toBe(true);
    doc.DisplayDocTitle = false;
    expect(doc.GetViewerPreferences().displayDocTitle).toBe(false);
  });

  it('preserves the other preferences it shares the dict with', () => {
    const doc = docWith(1);
    doc.SetViewerPreferences({ hideToolbar: true });
    doc.DisplayDocTitle = true;
    expect(doc.GetViewerPreferences()).toEqual({ hideToolbar: true, displayDocTitle: true });
  });

  // autotag.ts carried a hand-rolled copy of the ensure-dict dance until this
  // issue folded it into the property. MEASURED: reverting that fold leaves this
  // case GREEN, and must — it is a de-duplication, not a behaviour change, and
  // the two spellings write the same key. What it does pin is that AutoTag's
  // title path still reaches the flag at all.
  it('AutoTag({ title }) sets the flag through the one writer', () => {
    const doc = docWith(1);
    doc.AutoTag({ title: 'A title' });
    expect(doc.DisplayDocTitle).toBe(true);
    expect(doc.GetViewerPreferences().displayDocTitle).toBe(true);
  });
});
