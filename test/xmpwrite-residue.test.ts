import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { encodePdfText, decodePdfText } from '../src/metadata.js';
import { isString } from '../src/types.js';
import { buildSigner } from './helpers/build-signer.js';

// o6uu.12: residue from the o6uu.8 review of doc.SetXmpValue.

const ACME = 'http://acme.example/ns/1.0/';
const PDF = 'http://ns.adobe.com/pdf/1.3/';
const doc1 = () => { const d = Document.New(); d.AddPage(PageFormat.A4); return d; };
const infoText = (d: Document, key: string) => {
  const v = d.ensureInfo().get(key);
  return isString(v) ? decodePdfText(v.bytes) : undefined;
};

describe('language tags', () => {
  it('refuses two tags that collide ignoring case', () => {
    expect(() => doc1().SetXmpValue(ACME, 'T', { lang: { 'x-default': 'a', 'X-Default': 'b' } })).toThrow(RangeError);
    expect(() => doc1().SetXmpValue(ACME, 'T', { lang: { 'en-US': 'a', 'EN-us': 'b' } })).toThrow(RangeError);
  });

  it('refuses a tag that is not letters, digits and hyphens', () => {
    for (const tag of ['x y', 'en_US', 'en-', '-en', 'en--US', 'é'])
      expect(() => doc1().SetXmpValue(ACME, 'T', { lang: { [tag]: 'a' } }), tag).toThrow(RangeError);
  });

  it('accepts ordinary tags, and a refused call leaves the document untouched', () => {
    const d = doc1();
    d.SetXmpValue(ACME, 'T', { lang: { 'x-default': 'a', 'en-US': 'b', 'zh-Hant-TW': 'c', 'de': 'd' } });
    expect(d.GetXmpValue(ACME, 'T')!.asText('zh-Hant-TW')).toBe('c');
    const before = d.Save();
    expect(() => d.SetXmpValue(ACME, 'T', { lang: { 'x-default': 'a', 'X-DEFAULT': 'b' } })).toThrow();
    expect(d.Save()).toEqual(before);
  });
});

describe('characters XML cannot carry', () => {
  it('refuses them in a namespace rather than writing a different URI', () => {
    expect(() => doc1().SetXmpValue('http://acme.example/\u0001', 'P', 'x')).toThrow(TypeError);
    expect(() => doc1().SetXmpValue(ACME, 'S', { struct: [{ namespace: 'http://f/￾', name: 'a', value: 'x' }] }))
      .toThrow(TypeError);
  });
});

describe('deleting a mirrored property XMP does not hold', () => {
  it('deletes the /Info key it mirrors', () => {
    const d = doc1();
    d.ensureInfo().set('Producer', { kind: 'string', bytes: encodePdfText('Acme 1.0') });
    expect(d.GetXmpValue(PDF, 'Producer')).toBeUndefined();
    d.SetXmpValue(PDF, 'Producer', null);
    expect(infoText(d, 'Producer')).toBeUndefined();
  });

  it('leaves the other /Info keys alone, and creates no /Info', () => {
    const d = doc1();
    d.ensureInfo().set('Producer', { kind: 'string', bytes: encodePdfText('Acme 1.0') });
    d.ensureInfo().set('Title', { kind: 'string', bytes: encodePdfText('T') });
    d.SetXmpValue(PDF, 'Producer', null);
    expect(infoText(d, 'Title')).toBe('T');
    const bare = doc1();
    bare.SetXmpValue(PDF, 'Producer', null);
    expect(bare.catalog().has('Metadata')).toBe(false);
  });
});

describe('a write that changes nothing', () => {
  it('rewrites nothing and marks nothing, so a later Sign() still appends', async () => {
    const d0 = doc1();
    d0.SetXmpValue(ACME, 'Batch', 'B1', { prefix: 'acme' });
    d0.SetXmpValue(PDF, 'Producer', 'Acme 1.0');
    const base = d0.Save();
    const d = Document.Open(base);
    d.SetXmpValue(ACME, 'Batch', 'B1', { prefix: 'acme' });
    d.SetXmpValue(PDF, 'Producer', 'Acme 1.0');
    d.SetXmpValue(ACME, 'Absent', null);
    const s = buildSigner();
    await d.Sign({ certificate: s.certificate, privateKey: s.privateKey }, {});
    expect(d.Save().subarray(0, base.length)).toEqual(base);
  });

  it('still mirrors to /Info when only /Info disagrees', () => {
    const d = doc1();
    d.SetXmpValue(PDF, 'Producer', 'Acme 1.0');
    d.ensureInfo().set('Producer', { kind: 'string', bytes: encodePdfText('Stale') });
    d.SetXmpValue(PDF, 'Producer', 'Acme 1.0');
    expect(infoText(d, 'Producer')).toBe('Acme 1.0');
  });
});
