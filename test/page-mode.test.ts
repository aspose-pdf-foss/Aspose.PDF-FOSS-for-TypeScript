import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { isName, name, type PdfObject } from '../src/types.js';
import { PAGE_MODES, NON_FULL_SCREEN_MODES } from '../src/pagemode.js';
import { buildSigner } from './helpers/build-signer.js';

const doc1 = () => {
  const doc = Document.New();
  doc.AddPage(PageFormat.A4);
  return doc;
};
const reopen = (d: Document) => Document.Open(d.Save());

/** Seed a raw catalog entry, bypassing the writer. */
const seed = (d: Document, key: string, v: PdfObject): Document => {
  d.catalog().set(key, v);
  return d;
};

const catName = (d: Document, key: string): string | undefined => {
  const v = d.resolve(d.catalog().get(key));
  return isName(v) ? v.name : undefined;
};

describe('doc.PageMode / doc.PageLayout — read', () => {
  it('is undefined when the catalog states nothing', () => {
    const doc = doc1();
    expect(doc.PageMode).toBeUndefined();
    expect(doc.PageLayout).toBeUndefined();
  });

  it('reports every /PageMode the standard defines', () => {
    for (const m of PAGE_MODES) {
      expect(seed(doc1(), 'PageMode', name(m)).PageMode).toBe(m);
    }
  });

  it('reports every /PageLayout the standard defines', () => {
    const layouts = ['SinglePage', 'OneColumn', 'TwoColumnLeft', 'TwoColumnRight',
      'TwoPageLeft', 'TwoPageRight'] as const;
    for (const l of layouts) {
      expect(seed(doc1(), 'PageLayout', name(l)).PageLayout).toBe(l);
    }
  });

  it('reads a name outside the enumeration as undefined', () => {
    expect(seed(doc1(), 'PageMode', name('UseSomething')).PageMode).toBeUndefined();
    // A /PageLayout name is not a /PageMode name, and vice versa.
    expect(seed(doc1(), 'PageMode', name('OneColumn')).PageMode).toBeUndefined();
    expect(seed(doc1(), 'PageLayout', name('FullScreen')).PageLayout).toBeUndefined();
  });

  it('reads a value that is not a name as undefined', () => {
    expect(seed(doc1(), 'PageMode', 3).PageMode).toBeUndefined();
    expect(seed(doc1(), 'PageLayout', { kind: 'string', bytes: new Uint8Array([65]) }).PageLayout)
      .toBeUndefined();
  });

  it('leaves an unreadable entry in the file rather than stripping it', () => {
    // Lenient read, narrow write: setting the sibling key must not touch the
    // one we declined to understand.
    const doc = seed(doc1(), 'PageMode', name('UseSomething'));
    doc.PageLayout = 'OneColumn';
    expect(catName(doc, 'PageMode')).toBe('UseSomething');
  });
});

describe('doc.PageMode / doc.PageLayout — write', () => {
  it('writes the name into the catalog', () => {
    const doc = doc1();
    doc.PageMode = 'FullScreen';
    doc.PageLayout = 'TwoPageRight';
    expect(catName(doc, 'PageMode')).toBe('FullScreen');
    expect(catName(doc, 'PageLayout')).toBe('TwoPageRight');
  });

  it('survives a save and reopen', () => {
    const doc = doc1();
    doc.PageMode = 'UseAttachments';
    doc.PageLayout = 'TwoColumnLeft';
    const back = reopen(doc);
    expect(back.PageMode).toBe('UseAttachments');
    expect(back.PageLayout).toBe('TwoColumnLeft');
  });

  it('removes the entry when assigned null', () => {
    const doc = doc1();
    doc.PageMode = 'UseThumbs';
    doc.PageMode = null;
    expect(doc.catalog().has('PageMode')).toBe(false);
    expect(doc.PageMode).toBeUndefined();
  });

  it('leaves the document byte-identical when deleting an entry it has not got', () => {
    const before = doc1().Save();
    const doc = Document.Open(before);
    doc.PageMode = null;
    doc.PageLayout = null;
    expect(doc.Save()).toEqual(before);
  });

  it('does not mark the document modified when the delete had nothing to do', async () => {
    // The observable consequence, and the reason the has() guard is not
    // decoration: `choosePath()` takes the incremental append only for an
    // UNMODIFIED base, so a no-op delete that marks the document modified
    // silently turns a sign-on-save into a full rewrite. Saving alone cannot
    // see this — a full rewrite of an untouched model reproduces the same
    // bytes — so the fixture signs, and asserts the base survives as a
    // byte-identical prefix.
    const base = doc1().Save();
    const doc = Document.Open(base);
    doc.PageMode = null;
    doc.PageLayout = null;
    const s = buildSigner();
    await doc.Sign({ certificate: s.certificate, privateKey: s.privateKey }, {});
    const saved = doc.Save();
    expect(saved.subarray(0, base.length)).toEqual(base);
  });

  it('throws RangeError for a name outside the enumeration, writing nothing', () => {
    const doc = doc1();
    expect(() => { (doc as { PageMode: unknown }).PageMode = 'Presentation'; })
      .toThrow(RangeError);
    expect(doc.catalog().has('PageMode')).toBe(false);
  });

  it('throws TypeError for a value that is not a string, writing nothing', () => {
    const doc = doc1();
    expect(() => { (doc as { PageLayout: unknown }).PageLayout = 2; }).toThrow(TypeError);
    expect(doc.catalog().has('PageLayout')).toBe(false);
  });

  it('does not disturb an entry already there when a write is rejected', () => {
    const doc = doc1();
    doc.PageMode = 'UseOutlines';
    expect(() => { (doc as { PageMode: unknown }).PageMode = 'Nope'; }).toThrow(RangeError);
    expect(doc.PageMode).toBe('UseOutlines');
  });
});

describe('the page-mode vocabulary has one owner', () => {
  it('derives /NonFullScreenPageMode as the page modes that are not full screen', () => {
    // Table 150's four names, and they must stay a subset of Table 28's six —
    // the compiler checks the TYPE, this checks the list the writer validates
    // against.
    expect(NON_FULL_SCREEN_MODES).toEqual(['UseNone', 'UseOutlines', 'UseThumbs', 'UseOC']);
    for (const m of NON_FULL_SCREEN_MODES) expect(PAGE_MODES).toContain(m);
  });

  it('still refuses FullScreen as a /NonFullScreenPageMode', () => {
    const doc = doc1();
    expect(() => doc.SetViewerPreferences({
      nonFullScreenPageMode: 'FullScreen' as never,
    })).toThrow(RangeError);
  });
});
