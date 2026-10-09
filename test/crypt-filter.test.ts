import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Document } from '../src/document.js';
import { isStream, isName, isArray } from '../src/types.js';
import { streamCryptFilter } from '../src/crypto.js';

// lj8t: two encrypted OPM forms (Adobe LiveCycle Designer ES 8.2, AESV2,
// /EncryptMetadata false) carry their XMP as PLAINTEXT under its own
// `/Filter [/Crypt]` -- a crypt filter with no /Name, which is /Identity
// (32000-1 7.4.10). We decrypted it with /StmF anyway, the AES unpadding threw,
// and Open refused the whole file.
const load = (n: string) =>
  new Uint8Array(readFileSync(new URL(`./fixtures/opm/${n}`, import.meta.url)));

const latin1 = (b: Uint8Array) => Buffer.from(b).toString('latin1');

/** The catalog's /Metadata stream as the live model holds it. */
function catalogXmp(doc: Document) {
  const s = doc.resolve(doc.catalog().get('Metadata'));
  if (!isStream(s)) throw new Error('no /Metadata stream');
  return s;
}

describe('a stream under its own /Crypt filter (lj8t)', () => {
  it('opens OPM SF 1153, whose plaintext XMP is under an Identity /Crypt', () => {
    const doc = Document.Open(load('opm-sf1153.pdf'));
    expect(latin1(catalogXmp(doc).raw)).toContain('<x:xmpmeta');
    expect(doc.GetXmp().producer).toBe('Adobe LiveCycle Designer ES 8.2');
    expect(doc.recovery).toBeUndefined();
  });

  it('still decrypts every other stream with /StmF', () => {
    const doc = Document.Open(load('opm-sf1153.pdf'));
    // Page content is AESV2-encrypted; decrypted and inflated, it is operators.
    expect(latin1(doc.Pages[0].Contents)).toMatch(/\b(?:BT|re|cm|Do)\b/);
  });

  it('keeps the plaintext XMP plaintext when the encryption is preserved on Save', () => {
    const saved = Document.Open(load('opm-sf1153.pdf')).Save();
    expect(latin1(saved)).toContain('Adobe LiveCycle Designer ES 8.2');
    const back = Document.Open(saved);
    expect(back.GetXmp().producer).toBe('Adobe LiveCycle Designer ES 8.2');
  });
});

describe('Save({ encrypt: { encryptMetadata: false } }) leaves the XMP readable to anyone (lj8t)', () => {
  const withXmp = (): Document => {
    const doc = Document.New();
    doc.AddPage();
    doc.SetXmp({ title: 'PlainMeta' });
    return doc;
  };

  it('writes the metadata stream as plaintext, marked with an Identity /Crypt filter', () => {
    const bytes = withXmp().Save({ encrypt: { userPassword: 'u', encryptMetadata: false } });
    expect(latin1(bytes)).toContain('PlainMeta');
    const doc = Document.Open(bytes, { password: 'u' });
    const filter = doc.resolve(catalogXmp(doc).dict.get('Filter'));
    const names = isArray(filter) ? filter : [filter];
    expect(names.some((f) => isName(f) && f.name === 'Crypt')).toBe(true);
    expect(doc.GetXmp().title).toBe('PlainMeta');
  });

  it('still encrypts the metadata by default', () => {
    const bytes = withXmp().Save({ encrypt: { userPassword: 'u' } });
    expect(latin1(bytes)).not.toContain('PlainMeta');
    expect(Document.Open(bytes, { password: 'u' }).GetXmp().title).toBe('PlainMeta');
  });
});

// lj8t, the other half: OPM SF 50 (Acrobat PDFWriter 3.02) has a structurally
// sound file whose /Info dict holds `/Title (pages))`. Open used to refuse the
// whole document over it.
describe('a sound file with one object that parses only leniently (lj8t)', () => {
  it('opens OPM SF 50, salvaging its /Info and reporting the repair', () => {
    const doc = Document.Open(load('opm-sf50.pdf'));
    expect(doc.recovery?.reason).toBe('object-parse-failure');
    expect(doc.recovery?.repaired).toContain(1);
    expect(doc.recovery?.lost).toEqual([]);
    const md = doc.GetMetadata();
    expect(md.title).toBe('pages');
    // Balanced parentheses inside a literal string are legal and kept.
    expect(md.creator).toBe('Print SF50.TIF (6 pages)');
    expect(md.producer).toBe('Acrobat PDFWriter 3.02 for Windows');
    expect(doc.Pages.length).toBeGreaterThan(0);
  });
});

describe('streamCryptFilter: which crypt filter a stream names (lj8t)', () => {
  const dict = (entries: Record<string, unknown>) => new Map(Object.entries(entries)) as Map<string, never>;
  const n = (s: string) => ({ kind: 'name', name: s });
  const id = (o: unknown) => (o ?? null) as never;

  it('names none when /Crypt is absent', () => {
    expect(streamCryptFilter(dict({ Filter: n('FlateDecode') }), id)).toBeUndefined();
    expect(streamCryptFilter(dict({}), id)).toBeUndefined();
  });

  it('is /Identity when /Crypt carries no /Name', () => {
    expect(streamCryptFilter(dict({ Filter: [n('Crypt')] }), id)).toBe('Identity');
    expect(streamCryptFilter(dict({ Filter: n('Crypt') }), id)).toBe('Identity');
  });

  it('reads /Name from the /DecodeParms entry at the /Crypt filter\'s own index', () => {
    const parms = new Map([['Name', n('StdCF')]]);
    expect(streamCryptFilter(dict({ Filter: [n('Crypt'), n('FlateDecode')], DecodeParms: [parms, null] }), id))
      .toBe('StdCF');
    expect(streamCryptFilter(dict({ Filter: n('Crypt'), DecodeParms: parms }), id)).toBe('StdCF');
    // Parameters at ANOTHER index belong to another filter.
    expect(streamCryptFilter(dict({ Filter: [n('Crypt'), n('FlateDecode')], DecodeParms: [null, parms] }), id))
      .toBe('Identity');
  });
});

describe('a non-metadata stream under its own Identity /Crypt is written plaintext (lj8t)', () => {
  // The /EncryptMetadata exemption and the stream's OWN /Crypt both keep OPM
  // SF 1153's XMP plaintext on Save, so that round trip cannot see the second
  // rule alone. A marked stream that is not metadata, under a handler that
  // DOES encrypt metadata, is the case only the stream's own filter decides.
  it('keeps it plaintext under an encrypting handler and reads it back', () => {
    const doc = Document.New();
    doc.AddPage();
    const stream = { kind: 'stream' as const, raw: new TextEncoder().encode('MarkedPlain'),
      dict: new Map<string, never>([['Filter', [{ kind: 'name', name: 'Crypt' }] as never]]) };
    const ref = doc.allocObject(stream as never);
    doc.catalog().set('PieceInfo', ref as never);
    const bytes = doc.Save({ encrypt: { userPassword: 'u' } });
    expect(latin1(bytes)).toContain('MarkedPlain');
    const back = Document.Open(bytes, { password: 'u' });
    const s = back.resolve(back.catalog().get('PieceInfo'));
    expect(isStream(s) && latin1(s.raw)).toBe('MarkedPlain');
  });
});
