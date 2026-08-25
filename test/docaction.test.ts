import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { encodeDest } from '../src/outline.js';
import { isArray, isDict, name, type PdfObject } from '../src/types.js';

/** A document with `n` A4 pages. */
const docWith = (n: number) => {
  const doc = Document.New();
  for (let i = 0; i < n; i++) doc.AddPage(PageFormat.A4);
  return doc;
};
const reopen = (d: Document) => Document.Open(d.Save());

describe('GetOpenAction (read)', () => {
  it('is undefined when the catalog has none', () => {
    expect(docWith(1).GetOpenAction()).toBeUndefined();
  });

  it('reads a bare destination array as kind dest', () => {
    const doc = docWith(3);
    doc.catalog().set('OpenAction', encodeDest(doc.pageRef(3), { type: 'Fit' }));
    expect(doc.GetOpenAction())
      .toEqual({ kind: 'dest', dest: { page: 3, view: { type: 'Fit' } } });
  });

  // THE pair. Both dicts carry /D and both resolve to page 3, so a page-number
  // assertion passes with the discriminator inverted; only `kind` separates
  // them. decodeDest already accepts the << /D [...] >> destination-dict form,
  // which is exactly why a dict alone cannot decide it.
  it('reads a << /D [...] >> dict with NO /S as kind dest', () => {
    const doc = docWith(3);
    const d = encodeDest(doc.pageRef(3), { type: 'Fit' });
    doc.catalog().set('OpenAction', new Map<string, PdfObject>([['D', d]]));
    const got = doc.GetOpenAction();
    expect(got?.kind).toBe('dest');
    expect(got).toEqual({ kind: 'dest', dest: { page: 3, view: { type: 'Fit' } } });
  });

  it('reads a << /S /GoTo /D [...] >> dict as kind action', () => {
    const doc = docWith(3);
    const d = encodeDest(doc.pageRef(3), { type: 'Fit' });
    doc.catalog().set('OpenAction',
      new Map<string, PdfObject>([['S', name('GoTo')], ['D', d]]));
    const got = doc.GetOpenAction();
    expect(got?.kind).toBe('action');
    expect(got).toEqual({
      kind: 'action', action: { type: 'goto', page: 3, view: { type: 'Fit' } },
    });
  });

  it('is undefined for an action type the library does not model', () => {
    const doc = docWith(1);
    doc.catalog().set('OpenAction', new Map<string, PdfObject>([['S', name('Launch')]]));
    expect(doc.GetOpenAction()).toBeUndefined();
  });
});

describe('SetOpenDestination / SetOpenAction (write)', () => {
  it('SetOpenDestination writes an ARRAY and round-trips', () => {
    const doc = docWith(3);
    doc.SetOpenDestination({ page: 2, view: { type: 'Fit' } });
    expect(isArray(doc.resolve(doc.catalog().get('OpenAction')))).toBe(true);
    expect(reopen(doc).GetOpenAction())
      .toEqual({ kind: 'dest', dest: { page: 2, view: { type: 'Fit' } } });
  });

  it('SetOpenAction writes a DICT and round-trips', () => {
    // The two writers must not converge on one shape: a caller who asked for an
    // action and got an array back has had their statement rewritten.
    const doc = docWith(3);
    doc.SetOpenAction({ type: 'javascript', script: 'app.alert("hi");' });
    expect(isDict(doc.resolve(doc.catalog().get('OpenAction')))).toBe(true);
    expect(reopen(doc).GetOpenAction())
      .toEqual({ kind: 'action', action: { type: 'javascript', script: 'app.alert("hi");' } });
  });

  it('defaults the view to Fit, as encodeDest does', () => {
    const doc = docWith(3);
    doc.SetOpenDestination({ page: 2 });
    expect(doc.GetOpenAction())
      .toEqual({ kind: 'dest', dest: { page: 2, view: { type: 'Fit' } } });
  });

  it('rejects an out-of-range page and leaves the document byte-identical', () => {
    const doc = docWith(2);
    const before = doc.Save().length;
    expect(() => doc.SetOpenDestination({ page: 3 })).toThrow(RangeError);
    expect(() => doc.SetOpenDestination({ page: 0 })).toThrow(RangeError);
    // encodeAction owns the same check for a goto action — not restated.
    expect(() => doc.SetOpenAction({ type: 'goto', page: 3 })).toThrow(RangeError);
    expect(doc.Save().length).toBe(before);
  });

  it('rejects an unknown action type', () => {
    const doc = docWith(1);
    expect(() => doc.SetOpenAction({ type: 'nope' } as never)).toThrow(TypeError);
  });
});

describe('RemoveOpenAction', () => {
  it('removes an existing one and is a no-op otherwise', () => {
    const doc = docWith(2);
    doc.SetOpenDestination({ page: 1 });
    doc.RemoveOpenAction();
    expect(doc.GetOpenAction()).toBeUndefined();
    expect(() => doc.RemoveOpenAction()).not.toThrow();
  });
});
