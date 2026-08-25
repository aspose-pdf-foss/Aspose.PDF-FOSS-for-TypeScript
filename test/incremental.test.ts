import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { buildSigner } from './helpers/build-signer.js';
import { appendIncrementalUpdate, appendSignatureUpdate, fillSignature } from '../src/incremental.js';
import { buildSignedData, verifySignedData } from '../src/cms.js';
import { readXref } from '../src/xref.js';
import { Lexer } from '../src/lexer.js';
import { ObjectParser } from '../src/object-parser.js';
import { Document } from '../src/document.js';
import {
  name, ref, isRef, isDict, isArray, isString, PdfDict, PdfObject,
} from '../src/types.js';

/** Parse a single indirect object located at byte `offset`. */
function readObjAt(buf: Uint8Array, offset: number): { num: number; value: PdfObject } {
  const { num, value } = new ObjectParser(new Lexer(buf, offset)).parseIndirectObject();
  return { num, value };
}

/** The byte offset recorded for `num` in the (merged, newest-wins) xref. */
function offsetOf(buf: Uint8Array, num: number): number {
  const e = readXref(buf).entries.get(num);
  if (!e || e.type !== 'offset') throw new Error(`no offset entry for ${num}`);
  return e.offset;
}

describe('appendIncrementalUpdate', () => {
  it('preserves the original bytes verbatim as a prefix', () => {
    const base = buildClassicPdf(1);
    const newObj: PdfDict = new Map<string, PdfObject>([['Type', name('Custom')], ['Val', 42]]);
    const out = appendIncrementalUpdate(base, { objects: new Map([[10, newObj]]) });
    expect(out.length).toBeGreaterThan(base.length);
    expect(out.subarray(0, base.length)).toEqual(base);
  });

  it('makes a brand-new object resolvable through the appended xref', () => {
    const base = buildClassicPdf(1);
    const newObj: PdfDict = new Map<string, PdfObject>([['Type', name('Custom')], ['Val', 42]]);
    const out = appendIncrementalUpdate(base, { objects: new Map([[10, newObj]]) });

    const entry = readXref(out).entries.get(10);
    expect(entry?.type).toBe('offset');
    const parsed = readObjAt(out, offsetOf(out, 10));
    expect(parsed.num).toBe(10);
    expect(isDict(parsed.value) && parsed.value.get('Val')).toBe(42);
    // The new object lives in the appended region, after the original bytes.
    expect(offsetOf(out, 10)).toBeGreaterThanOrEqual(base.length);
  });

  it('overrides an existing object with a later-section offset', () => {
    const base = buildClassicPdf(1);
    const newCatalog: PdfDict = new Map<string, PdfObject>([
      ['Type', name('Catalog')], ['Pages', ref(2)], ['Custom', ref(10)],
    ]);
    const newObj: PdfDict = new Map<string, PdfObject>([['Tag', name('Hi')]]);
    const out = appendIncrementalUpdate(base, {
      objects: new Map<number, PdfObject>([[1, newCatalog], [10, newObj]]),
    });

    // Object 1 now resolves to the appended copy carrying /Custom.
    expect(offsetOf(out, 1)).toBeGreaterThanOrEqual(base.length);
    const cat = readObjAt(out, offsetOf(out, 1)).value;
    expect(isDict(cat) && isRef(cat.get('Custom')!) && (cat.get('Custom') as any).num).toBe(10);
  });

  it('writes a trailer chaining /Prev to the original startxref, preserving /Root and growing /Size', () => {
    const base = buildClassicPdf(2);
    const out = appendIncrementalUpdate(base, {
      objects: new Map<number, PdfObject>([[20, new Map([['A', 1]])]]),
    });
    const tr = readXref(out).trailer;
    expect(isRef(tr.get('Root')!) && (tr.get('Root') as any).num).toBe(1);
    expect(tr.get('Size')).toBe(21);
    expect(tr.get('Prev')).toBe(readPrevStartxref(base));
  });

  it('keeps the document openable after the update', () => {
    const base = buildClassicPdf(3);
    const out = appendIncrementalUpdate(base, {
      objects: new Map<number, PdfObject>([[30, new Map([['A', name('B')]])]]),
    });
    const doc = Document.Open(out);
    expect(doc.Pages.length).toBe(3);
  });

  it('inserts a separator when the original does not end in a newline', () => {
    const base = buildClassicPdf(1);
    // Strip trailing newline(s) so the original does not end clean.
    let end = base.length;
    while (end > 0 && (base[end - 1] === 0x0a || base[end - 1] === 0x0d)) end--;
    const trimmed = base.subarray(0, end);
    const out = appendIncrementalUpdate(trimmed, {
      objects: new Map<number, PdfObject>([[10, new Map([['A', 1]])]]),
    });
    expect(out.subarray(0, trimmed.length)).toEqual(trimmed);
    // The byte immediately after the original must be an EOL separator.
    expect(out[trimmed.length]).toBe(0x0a);
    expect(Document.Open(out).Pages.length).toBe(1);
  });
});

/** Read the integer following the last `startxref` keyword in `buf`. */
function readPrevStartxref(buf: Uint8Array): number {
  const tail = new TextDecoder('latin1').decode(buf.subarray(Math.max(0, buf.length - 2048)));
  const idx = tail.lastIndexOf('startxref');
  return parseInt(/startxref\s+(\d+)/.exec(tail.slice(idx))![1], 10);
}

describe('appendSignatureUpdate', () => {
  const sigDict = (): PdfDict => new Map<string, PdfObject>([
    ['Type', name('Sig')],
    ['Filter', name('Adobe.PPKLite')],
    ['SubFilter', name('adbe.pkcs7.detached')],
  ]);

  it('computes a /ByteRange that excludes exactly the /Contents hex digits', () => {
    const base = buildClassicPdf(1);
    const res = appendSignatureUpdate(base, { sigObjNum: 10, sigDict: sigDict(), placeholderBytes: 2048 });
    const [first, a, b, c] = res.byteRange; // [0, a, b, c]
    expect(first).toBe(0);
    expect(res.contentsLength).toBe(2 * 2048);
    expect(a).toBe(res.contentsOffset);              // range 1 ends at the first hex digit
    expect(b).toBe(res.contentsOffset + res.contentsLength); // range 2 begins at '>'
    expect(b + c).toBe(res.bytes.length);            // range 2 runs to EOF
  });

  it('brackets the placeholder and zero-fills it', () => {
    const base = buildClassicPdf(1);
    const res = appendSignatureUpdate(base, { sigObjNum: 10, sigDict: sigDict(), placeholderBytes: 1024 });
    const { bytes, byteRange, contentsOffset, contentsLength } = res;
    const [, a, b, c] = byteRange;
    // a = first hex digit, the '<' sits just before it; b = '>' position.
    expect(bytes[a - 1]).toBe('<'.charCodeAt(0));
    expect(bytes[b]).toBe('>'.charCodeAt(0));
    expect(a).toBe(contentsOffset);
    expect(b - a).toBe(contentsLength);
    expect(b + c).toBe(bytes.length);
    // Placeholder is all ASCII '0'.
    for (let i = a; i < b; i++) expect(bytes[i]).toBe('0'.charCodeAt(0));
  });

  it('emits a parseable /Sig object carrying the filled /ByteRange and zero /Contents', () => {
    const base = buildClassicPdf(1);
    const res = appendSignatureUpdate(base, { sigObjNum: 10, sigDict: sigDict(), placeholderBytes: 512 });
    const obj = readObjAt(res.bytes, offsetOf(res.bytes, 10));
    expect(obj.num).toBe(10);
    const d = obj.value as PdfDict;
    expect(isDict(d)).toBe(true);
    expect((d.get('Type') as any).name).toBe('Sig');
    const br = d.get('ByteRange');
    expect(isArray(br!)).toBe(true);
    expect(br).toEqual(res.byteRange);
    const contents = d.get('Contents');
    expect(isString(contents!)).toBe(true);
    const cb = (contents as any).bytes as Uint8Array;
    expect(cb.length).toBe(512);
    expect(cb.every((x) => x === 0)).toBe(true);
  });

  it('appends accompanying objects alongside the signature object', () => {
    const base = buildClassicPdf(1);
    const widget: PdfDict = new Map<string, PdfObject>([
      ['Type', name('Annot')], ['Subtype', name('Widget')], ['FT', name('Sig')], ['V', ref(10)],
    ]);
    const res = appendSignatureUpdate(base, {
      sigObjNum: 10, sigDict: sigDict(),
      objects: new Map<number, PdfObject>([[11, widget]]),
    });
    const w = readObjAt(res.bytes, offsetOf(res.bytes, 11)).value as PdfDict;
    expect((w.get('Subtype') as any).name).toBe('Widget');
    expect(Document.Open(res.bytes).Pages.length).toBe(1);
  });

  it('fillSignature writes the DER hex and leaves the rest zero, keeping /ByteRange intact', () => {
    const base = buildClassicPdf(1);
    const res = appendSignatureUpdate(base, { sigObjNum: 10, sigDict: sigDict(), placeholderBytes: 256 });
    const der = Uint8Array.from([0x30, 0x82, 0x01, 0x02, 0xde, 0xad, 0xbe, 0xef]);
    fillSignature(res.bytes, res, der);

    // Original prefix still intact, file length unchanged.
    expect(res.bytes.subarray(0, base.length)).toEqual(base);

    const obj = readObjAt(res.bytes, offsetOf(res.bytes, 10)).value as PdfDict;
    expect(obj.get('ByteRange')).toEqual(res.byteRange);
    const cb = (obj.get('Contents') as any).bytes as Uint8Array;
    expect(cb.length).toBe(256);
    expect(cb.subarray(0, der.length)).toEqual(der);
    expect(cb.subarray(der.length).every((x) => x === 0)).toBe(true);
    expect(Document.Open(res.bytes).Pages.length).toBe(1);
  });

  it('fillSignature rejects a DER blob larger than the reserved capacity', () => {
    const base = buildClassicPdf(1);
    const res = appendSignatureUpdate(base, { sigObjNum: 10, sigDict: sigDict(), placeholderBytes: 4 });
    expect(() => fillSignature(res.bytes, res, new Uint8Array(5))).toThrow();
  });

  it('produces a digest contract that round-trips through real CMS sign + verify', async () => {
    const base = buildClassicPdf(1);
    const res = appendSignatureUpdate(base, { sigObjNum: 10, sigDict: sigDict(), placeholderBytes: 4096 });

    // Digest the two /ByteRange segments — exactly what a verifier recomputes.
    const [, a, b, c] = res.byteRange;
    const covered = new Uint8Array(a + c);
    covered.set(res.bytes.subarray(0, a), 0);
    covered.set(res.bytes.subarray(b, b + c), a);
    const digest = new Uint8Array(createHash('sha256').update(covered).digest());

    const signer = buildSigner({ type: 'rsa' });
    const cms = await buildSignedData(digest, { certificate: signer.certificate, privateKey: signer.privateKey });
    fillSignature(res.bytes, res, cms);

    // Pull the CMS back out of /Contents and verify it against the same digest.
    const obj = readObjAt(res.bytes, offsetOf(res.bytes, 10)).value as PdfDict;
    const stored = (obj.get('Contents') as any).bytes as Uint8Array;
    const result = verifySignedData(stored.subarray(0, cms.length), digest);
    expect(result.digestMatches).toBe(true);
    expect(result.signatureValid).toBe(true);
  });
});
