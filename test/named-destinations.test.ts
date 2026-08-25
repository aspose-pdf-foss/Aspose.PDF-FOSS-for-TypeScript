import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildOutlinePdf } from './helpers/build-outline-pdf.js';
import { isDict } from '../src/types.js';

const open = () => Document.Open(buildOutlinePdf());
const reopen = (d: Document) => Document.Open(d.Save());

describe('GetNamedDestinations (read)', () => {
  it('merges the /Names /Dests name tree and legacy /Dests dict, sorted by name', () => {
    expect(open().GetNamedDestinations()).toEqual([
      { name: 'chap2', dest: { page: 3, view: { type: 'Fit' } } }, // name tree
      { name: 'chap3', dest: { page: 2, view: { type: 'Fit' } } }, // legacy dict
    ]);
  });

  it('returns [] when there are no destinations', () => {
    const doc = open();
    doc.catalog().delete('Names');
    doc.catalog().delete('Dests');
    expect(doc.GetNamedDestinations()).toEqual([]);
  });
});

describe('SetNamedDestination (upsert)', () => {
  it('adds a new entry into the name tree and round-trips', () => {
    const doc = open();
    doc.SetNamedDestination('intro', { page: 1, view: { type: 'XYZ', left: null, top: 700, zoom: null } });
    const got = reopen(doc).GetNamedDestinations();
    expect(got).toEqual([
      { name: 'chap2', dest: { page: 3, view: { type: 'Fit' } } },
      { name: 'chap3', dest: { page: 2, view: { type: 'Fit' } } },
      { name: 'intro', dest: { page: 1, view: { type: 'XYZ', left: null, top: 700, zoom: null } } },
    ]);
  });

  it('overwrites an existing name-tree entry', () => {
    const doc = open();
    doc.SetNamedDestination('chap2', { page: 1 });
    expect(reopen(doc).GetNamedDestinations().find((d) => d.name === 'chap2')!.dest)
      .toEqual({ page: 1, view: { type: 'Fit' } });
  });

  it('creates the /Names container when absent', () => {
    const doc = open();
    doc.catalog().delete('Names');
    doc.catalog().delete('Dests');
    doc.SetNamedDestination('only', { page: 2 });
    const rt = reopen(doc);
    expect(rt.GetNamedDestinations()).toEqual([{ name: 'only', dest: { page: 2, view: { type: 'Fit' } } }]);
    expect(isDict(rt.resolve(rt.catalog().get('Names')))).toBe(true);
  });

  it('throws RangeError for an out-of-range destination page', () => {
    const doc = open();
    expect(() => doc.SetNamedDestination('x', { page: 99 })).toThrow(RangeError);
  });

  it('throws TypeError for an empty name', () => {
    const doc = open();
    expect(() => doc.SetNamedDestination('', { page: 1 })).toThrow(TypeError);
  });
});

describe('RemoveNamedDestination', () => {
  it('removes a name-tree entry and round-trips', () => {
    const doc = open();
    doc.RemoveNamedDestination('chap2');
    expect(reopen(doc).GetNamedDestinations().map((d) => d.name)).toEqual(['chap3']);
  });

  it('removes a legacy /Dests entry', () => {
    const doc = open();
    doc.RemoveNamedDestination('chap3');
    expect(reopen(doc).GetNamedDestinations().map((d) => d.name)).toEqual(['chap2']);
  });

  it('prunes the empty /Names /Dests container after the last entry is removed', () => {
    const doc = open();
    doc.RemoveNamedDestination('chap2'); // the only name-tree entry
    const names = doc.resolve(doc.catalog().get('Names'));
    // /Names had only /Dests; pruning /Dests should drop /Names too
    expect(doc.catalog().has('Names')).toBe(false);
    expect(names && isDict(names) ? names.has('Dests') : false).toBe(false);
  });

  it('is a no-op for an unknown name', () => {
    const doc = open();
    doc.RemoveNamedDestination('nope');
    expect(doc.GetNamedDestinations().map((d) => d.name)).toEqual(['chap2', 'chap3']);
  });
});
