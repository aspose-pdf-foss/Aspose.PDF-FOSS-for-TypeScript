// test/xfafont.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Document } from '../src/document.js';
import { faceLookup, XFA_SUBSTITUTES } from '../src/xfafont.js';
import { getStd14Sfnt } from '../src/std14fonts.js';
import { buildSigner } from './helpers/build-signer.js';

const opm = () => new Uint8Array(readFileSync(new URL('./fixtures/xfa-dynamic/opm1644.pdf', import.meta.url)));
const style = (family: string[], bold = false, italic = false) => ({ family, size: 10, bold, italic });
const metrics = (r: ReturnType<ReturnType<typeof faceLookup>>) => {
  if ('reason' in r) throw new Error(r.reason);
  return r;
};

describe('faceLookup: tier 1, faces embedded in the document', () => {
  it('finds OPM 1644 Arial by its own name table, with hhea line metrics', () => {
    const faces = faceLookup(Document.Open(opm()));
    const m = metrics(faces(style(['Arial']), 'Type of provider'));
    expect(m.unitsPerEm).toBe(2048);
    expect([m.ascent, m.descent]).toEqual([1854, 434]);
    expect(m.advance(0x41)).toBe(1366);
  });

  it('matches style exactly: Arial italic is a different embedded face from Arial', () => {
    const faces = faceLookup(Document.Open(opm()));
    const i = metrics(faces(style(['Arial'], false, true), 'x'));
    const b = metrics(faces(style(['Arial'], true, false), 'x'));
    expect(b.advance(0x41)).toBe(1479);
    expect(i).not.toBe(metrics(faces(style(['Arial']), 'x')));
  });
});

describe('faceLookup: tier 2, registered folders', () => {
  it('finds a registered face by family when nothing is embedded', () => {
    const doc = Document.New();
    doc.RegisterFontFolder(fileURLToPath(new URL('../fonts/', import.meta.url)));
    const m = metrics(faceLookup(doc)(style(['Liberation Serif'], true), 'abc'));
    expect(m.unitsPerEm).toBe(2048);
  });
});

describe('faceLookup: tier 3, the closed substitute table', () => {
  it('maps exactly three families onto the bundled Liberation faces', () => {
    expect(Object.keys(XFA_SUBSTITUTES).sort()).toEqual(['arial', 'courier new', 'times new roman']);
    const doc = Document.New();
    const m = metrics(faceLookup(doc)(style(['Times New Roman'], false, true), 'abc'));
    const lib = getStd14Sfnt('Times-Italic')!;
    expect(m.advance(0x61)).toBe(lib.advanceWidth(lib.cmapLookup(0x61)!));
  });

  // Helvetica's vendors' vertical metrics differ from Liberation's: not a substitute.
  it('does not substitute Helvetica, Times or Courier', () => {
    const faces = faceLookup(Document.New());
    for (const f of ['Helvetica', 'Times', 'Courier'])
      expect(faces(style([f]), 'a')).toMatchObject({ reason: expect.stringMatching(new RegExp(f)) });
  });

  // Review Focus 3: a generic keyword never resolves.
  it('never resolves a generic family keyword', () => {
    expect(faceLookup(Document.New())(style(['sans-serif']), 'a'))
      .toMatchObject({ reason: expect.any(String) });
    expect(metrics(faceLookup(Document.New())(style(['sans-serif', 'Arial']), 'a')).unitsPerEm).toBe(2048);
  });
});

describe('faceLookup: coverage and purity', () => {
  it('refuses a character no face covers, naming it', () => {
    expect(faceLookup(Document.New())(style(['Arial']), 'a\u{1F600}'))
      .toMatchObject({ reason: expect.stringMatching(/U\+1F600/) });
  });

  // A lookup must not mark the document modified: the sign path is the only
  // place that can see it (a full rewrite reproduces an untouched model).
  it('writes nothing to the document', async () => {
    const base = opm();
    const doc = Document.Open(base);
    const faces = faceLookup(doc);
    faces(style(['Arial']), 'abc');
    faces(style(['Times New Roman'], true), 'abc');
    const s = buildSigner();
    await doc.Sign({ certificate: s.certificate, privateKey: s.privateKey }, {});
    expect(doc.Save().subarray(0, base.length)).toEqual(base);
  });
});
