import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { upsertNameTreeEntry } from '../src/nametree.js';
import { enc } from '../src/serialize.js';
import { isDict, name, type PdfDict, type PdfObject } from '../src/types.js';

const docWith = (n: number) => {
  const doc = Document.New();
  for (let i = 0; i < n; i++) doc.AddPage(PageFormat.A4);
  return doc;
};
const reopen = (d: Document) => Document.Open(d.Save());

describe('GetJavaScripts / SetJavaScript', () => {
  it('is empty for a document with no tree', () => {
    expect(docWith(1).GetJavaScripts()).toEqual([]);
  });

  it('round-trips a script through Save/Open', () => {
    const doc = docWith(1);
    doc.SetJavaScript('greet', 'app.alert("hi");');
    expect(reopen(doc).GetJavaScripts())
      .toEqual([{ name: 'greet', script: 'app.alert("hi");' }]);
  });

  it('returns several entries sorted by name', () => {
    const doc = docWith(1);
    doc.SetJavaScript('zebra', 'z');
    doc.SetJavaScript('alpha', 'a');
    expect(doc.GetJavaScripts().map((j) => j.name)).toEqual(['alpha', 'zebra']);
  });

  it('sorts a tree that does not present its entries in order', () => {
    // The case above CANNOT pin the sort: flatNameNode orders the /Names array
    // on write, so any tree we wrote comes back sorted whatever the reader
    // does. Scrambling the node afterwards is the only fixture that fails when
    // the sort is removed — and an unordered node is a real shape, since a
    // third-party producer or a /Kids tree owes us nothing.
    const doc = docWith(1);
    doc.SetJavaScript('alpha', 'a');
    doc.SetJavaScript('zebra', 'z');
    const names = doc.resolve(doc.catalog().get('Names')) as PdfDict;
    const node = doc.resolve(names.get('JavaScript')) as PdfDict;
    const arr = doc.resolve(node.get('Names')) as PdfObject[];
    node.set('Names', [arr[2], arr[3], arr[0], arr[1]]);   // zebra pair first
    expect(doc.GetJavaScripts().map((j) => j.name)).toEqual(['alpha', 'zebra']);
  });

  it('replaces the script for an existing name', () => {
    const doc = docWith(1);
    doc.SetJavaScript('n', 'first');
    doc.SetJavaScript('n', 'second');
    expect(doc.GetJavaScripts()).toEqual([{ name: 'n', script: 'second' }]);
  });

  it('reads an entry whose /JS is a STREAM', () => {
    // The shape a producer picks for a large document-level script. Task 2's
    // fix is what makes this readable; before it, the entry vanished whole.
    const doc = docWith(1);
    const js = doc.allocObject({
      kind: 'stream', dict: new Map(), raw: enc('var big = 1;'),
    });
    upsertNameTreeEntry(doc, 'JavaScript', 'big',
      new Map<string, PdfObject>([['S', name('JavaScript')], ['JS', js]]));
    expect(doc.GetJavaScripts()).toEqual([{ name: 'big', script: 'var big = 1;' }]);
  });

  it('skips a non-JavaScript entry and still returns its siblings', () => {
    // 32000-1 7.7.4 requires a JavaScript action here. A ResetForm action parses
    // fine and has no script to report, so it is skipped — but the skip must not
    // truncate the list, which is the failure a single-entry fixture cannot see.
    const doc = docWith(1);
    doc.SetJavaScript('good', 'x = 1;');
    upsertNameTreeEntry(doc, 'JavaScript', 'bad',
      new Map<string, PdfObject>([['S', name('ResetForm')]]));
    expect(doc.GetJavaScripts()).toEqual([{ name: 'good', script: 'x = 1;' }]);
  });

  it('rejects an empty name or an empty script, allocating nothing', () => {
    const doc = docWith(1);
    const before = doc.Save().length;
    expect(() => doc.SetJavaScript('', 'x')).toThrow(TypeError);
    expect(() => doc.SetJavaScript('n', '')).toThrow(TypeError);
    expect(doc.Save().length).toBe(before);
  });
});

describe('RemoveJavaScript', () => {
  it('returns true then false, and prunes /Names when the last entry goes', () => {
    // The end-to-end reading of nametree.ts's two-level prune.
    const doc = docWith(1);
    doc.SetJavaScript('n', 'x = 1;');
    expect(doc.RemoveJavaScript('n')).toBe(true);
    expect(doc.RemoveJavaScript('n')).toBe(false);
    expect(doc.GetJavaScripts()).toEqual([]);
    expect(doc.catalog().has('Names')).toBe(false);
  });

  it('leaves a sibling branch alone', () => {
    const doc = docWith(2);
    doc.SetNamedDestination('chap1', { page: 1 });
    doc.SetJavaScript('n', 'x = 1;');
    doc.RemoveJavaScript('n');
    const names = doc.resolve(doc.catalog().get('Names'));
    expect(isDict(names) && (names as PdfDict).has('Dests')).toBe(true);
    expect(doc.GetNamedDestinations()).toHaveLength(1);
  });
});
