import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { serializeLinearized, verifyLinearization } from '../src/linearize.js';
import { serializeDocument } from '../src/serializer.js';
import { type PdfDict, isName, name } from '../src/types.js';
import {
  singlePageDoc, multiPageDoc, sharedResourceDoc, inheritedAttributesDoc,
} from './helpers/build-linear-fixtures.js';

const save = (live: { objects: any; trailer: any }) =>
  serializeLinearized(live.objects, live.trailer);

describe('serializeLinearized — round-trips through Document.Open', () => {
  it('preserves a single page', () => {
    const re = Document.Open(save(singlePageDoc()));
    expect(re.Pages.length).toBe(1);
    expect(re.Pages[0].MediaBox).toEqual([0, 0, 200, 200]);
  });

  it('preserves a multi-page document in order', () => {
    const re = Document.Open(save(multiPageDoc(3)));
    expect(re.Pages.length).toBe(3);
    expect(re.Pages[0].GetText().trim()).toContain('Page 1');
    expect(re.Pages[2].GetText().trim()).toContain('Page 3');
  });

  it('preserves a document with a shared resource', () => {
    const re = Document.Open(save(sharedResourceDoc(3)));
    expect(re.Pages.length).toBe(3);
  });

  it('marks the output as linearized', () => {
    expect(Document.Open(save(singlePageDoc())).IsLinearized).toBe(true);
  });
});

describe('verifyLinearization — structural', () => {
  it('accepts valid single-page output with no errors', () => {
    const out = save(singlePageDoc());
    const check = verifyLinearization(out);
    expect(check.errors).toEqual([]);
    expect(check.linearized).toBe(true);
  });

  it('accepts valid multi-page output with no errors', () => {
    const check = verifyLinearization(save(multiPageDoc(4)));
    expect(check.errors).toEqual([]);
    expect(check.linearized).toBe(true);
  });

  it('reports /L equal to the byte length', () => {
    const out = save(singlePageDoc());
    const m = /\/L\s+(\d+)/.exec(new TextDecoder('latin1').decode(out.subarray(0, 200)));
    expect(Number(m![1])).toBe(out.length);
  });

  it('flags a corrupted cross-reference offset', () => {
    const out = save(multiPageDoc(3));
    // Corrupt a digit inside the first-page xref entries (well past the dict,
    // before the body objects). Find the "xref" keyword and mangle an entry.
    const text = new TextDecoder('latin1').decode(out);
    const xrefAt = text.indexOf('xref\n');
    // First entry digit of the first subsection's first row.
    const entryPos = text.indexOf(' n \n', xrefAt); // a used entry row end
    const digit = out[entryPos - 18]; // somewhere in the 10-digit offset
    out[entryPos - 18] = digit === 0x39 ? 0x38 : digit + 1;
    expect(verifyLinearization(out).errors.length).toBeGreaterThan(0);
  });

  it('reports not-linearized for ordinary output', () => {
    const normal = singlePageDoc();
    const bytes = Document.Open(serializeLinearized(normal.objects, normal.trailer)).Save();
    expect(verifyLinearization(bytes).linearized).toBe(false);
  });
});

describe('verifyLinearization — primary hint stream', () => {
  for (const [name, build] of [
    ['single', singlePageDoc], ['multi', () => multiPageDoc(4)], ['shared', () => sharedResourceDoc(3)],
  ] as const) {
    it(`re-reads the page-offset + shared-object tables clean (${name})`, () => {
      const check = verifyLinearization(save(build()));
      expect(check.linearized).toBe(true);
      expect(check.errors).toEqual([]);          // includes the hint-table checks
    });
  }

  it('catches a corrupted hint table (verifier is not vacuous)', () => {
    const out = save(multiPageDoc(3));
    const text = new TextDecoder('latin1').decode(out);
    // Flip a byte inside the hint stream data (the first_page_offset field).
    const dataAt = text.indexOf('stream\n', text.indexOf('/S ')) + 'stream\n'.length;
    out[dataAt + 5] ^= 0xff;
    expect(verifyLinearization(out).errors.length).toBeGreaterThan(0);
  });

  it('FlateDecode-compresses the hint stream and still verifies clean', () => {
    const out = save(multiPageDoc(8));
    const text = new TextDecoder('latin1').decode(out.subarray(0, 1024));
    // The hint stream object (lin object right after the first-page xref) carries
    // a /Filter /FlateDecode; the verifier inflates it before re-reading.
    const hintOff = Number(/\/H\s*\[\s*(\d+)/.exec(text)![1]);
    const dict = new TextDecoder('latin1').decode(out).slice(
      hintOff, new TextDecoder('latin1').decode(out).indexOf('stream\n', hintOff));
    expect(dict).toMatch(/\/Filter\s*\/FlateDecode/);
    const check = verifyLinearization(out);
    expect(check.errors).toEqual([]);
  });
});

describe('Save({ linearized: true }) — full path', () => {
  it('routes through the document Save API and verifies', async () => {
    const { verifyLinearization: vl } = await import('../src/index.js');
    const doc = Document.Open(serializeLinearized(multiPageDoc(2).objects, multiPageDoc(2).trailer));
    const out = doc.Save({ linearized: true });
    expect(vl(out).errors).toEqual([]);
    expect(Document.Open(out).Pages.length).toBe(2);
  });

  it.each(['1.7', '2.0'])('materializes inherited page attributes in PDF %s', async (version) => {
    const { objects, trailer } = inheritedAttributesDoc();
    if (version === '2.0') (objects.get(1) as PdfDict).set('Version', name('2.0'));
    const doc = Document.Open(serializeDocument(objects, trailer));
    const before = structuredClone([...doc.objectEntries()]);
    const out = doc.Save({ linearized: true });
    expect(await doc.SaveAsync({ linearized: true })).toEqual(out);
    expect([...doc.objectEntries()]).toEqual(before);
    expect(verifyLinearization(out)).toEqual({ linearized: true, errors: [] });
    expect(new TextDecoder().decode(out.subarray(0, 8))).toBe(`%PDF-${version}`);

    const reopened = Document.Open(out);
    const attributes = ['MediaBox', 'CropBox', 'Rotate', 'Resources'];
    expect(reopened.Pages.map((page) => attributes.filter((key) => !page.Dict.has(key))))
      .toEqual([[], [], [], []]);
    expect(reopened.Pages.map((page) => [page.MediaBox, page.CropBox, page.Rotate])).toEqual([
      [[0, 0, 220, 240], [10, 20, 180, 190], 180],
      [[0, 0, 220, 240], [4, 5, 196, 195], 180],
      [[0, 0, 220, 240], [4, 5, 196, 195], 90],
      [[0, 0, 200, 200], [5, 10, 190, 180], 0],
    ]);
    expect(reopened.Pages.map((page) => {
      const fonts = reopened.resolve(page.Resources?.get('Font')) as PdfDict;
      const font = reopened.resolve(fonts.get('F1')) as PdfDict;
      return font.get('BaseFont');
    })).toEqual([name('Courier'), name('Courier'), name('Helvetica'), name('Times-Roman')]);
    for (const [, obj] of reopened.objectEntries()) {
      if (!(obj instanceof Map)) continue;
      const type = obj.get('Type');
      if (isName(type) && type.name === 'Pages') {
        expect(attributes.filter((key) => obj.has(key))).toEqual([]);
      }
    }
  });
});
