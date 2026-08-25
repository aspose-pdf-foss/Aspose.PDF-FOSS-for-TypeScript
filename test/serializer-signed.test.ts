import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { buildSigner } from './helpers/build-signer.js';
import { serializeSignedDocument } from '../src/serializer.js';
import { fillSignature } from '../src/sigplaceholder.js';
import { buildSignedData, verifySignedData } from '../src/cms.js';
import { readXref } from '../src/xref.js';
import { Lexer } from '../src/lexer.js';
import { ObjectParser } from '../src/object-parser.js';
import { Document } from '../src/document.js';
import { name, ref, isDict, isArray, isString, PdfDict, PdfObject } from '../src/types.js';

/** A live object map with a signature value dict (object 6) reachable from /Root
 *  via /AcroForm -> field/widget (object 4) -> /V. Returns the map + trailer. */
function signedFixture(): { objects: Map<number, PdfObject>; trailer: PdfDict } {
  const objects = new Map<number, PdfObject>();
  objects.set(1, new Map<string, PdfObject>([
    ['Type', name('Catalog')], ['Pages', ref(2)], ['AcroForm', ref(5)],
  ]));
  objects.set(2, new Map<string, PdfObject>([
    ['Type', name('Pages')], ['Count', 1], ['Kids', [ref(3)]], ['MediaBox', [0, 0, 200, 200]],
  ]));
  objects.set(3, new Map<string, PdfObject>([
    ['Type', name('Page')], ['Parent', ref(2)], ['Annots', [ref(4)]], ['Resources', new Map()],
  ]));
  objects.set(4, new Map<string, PdfObject>([
    ['Type', name('Annot')], ['Subtype', name('Widget')], ['FT', name('Sig')],
    ['T', { kind: 'string', bytes: new TextEncoder().encode('Sig1') }],
    ['Rect', [0, 0, 0, 0]], ['V', ref(6)], ['P', ref(3)],
  ]));
  objects.set(5, new Map<string, PdfObject>([['Fields', [ref(4)]], ['SigFlags', 3]]));
  objects.set(6, new Map<string, PdfObject>([
    ['Type', name('Sig')], ['Filter', name('Adobe.PPKLite')], ['SubFilter', name('adbe.pkcs7.detached')],
  ]));
  const trailer: PdfDict = new Map<string, PdfObject>([['Root', ref(1)]]);
  return { objects, trailer };
}

/** Locate the renumbered /Type /Sig object in `bytes` and return its dict. */
function findSigDict(bytes: Uint8Array): PdfDict {
  for (const [, e] of readXref(bytes).entries) {
    if (e.type !== 'offset') continue;
    const { value } = new ObjectParser(new Lexer(bytes, e.offset)).parseIndirectObject();
    if (isDict(value) && (value.get('Type') as any)?.name === 'Sig') return value;
  }
  throw new Error('no /Sig object found');
}

describe('serializeSignedDocument (sign-on-save / full rewrite)', () => {
  it('emits a /ByteRange that excludes exactly the /Contents hex digits', () => {
    const { objects, trailer } = signedFixture();
    const res = serializeSignedDocument(objects, trailer, { signatureObj: 6, placeholderBytes: 2048 });
    const [first, a, b, c] = res.byteRange;
    expect(first).toBe(0);
    expect(res.contentsLength).toBe(2 * 2048);
    expect(a).toBe(res.contentsOffset);
    expect(b).toBe(res.contentsOffset + res.contentsLength);
    expect(b + c).toBe(res.bytes.length);
    expect(res.bytes[a - 1]).toBe('<'.charCodeAt(0));
    expect(res.bytes[b]).toBe('>'.charCodeAt(0));
    for (let i = a; i < b; i++) expect(res.bytes[i]).toBe('0'.charCodeAt(0));
  });

  it('produces an openable document whose /Sig object carries the filled /ByteRange', () => {
    const { objects, trailer } = signedFixture();
    const res = serializeSignedDocument(objects, trailer, { signatureObj: 6, placeholderBytes: 512 });

    const doc = Document.Open(res.bytes);
    expect(doc.Pages.length).toBe(1);

    const sig = findSigDict(res.bytes);
    expect((sig.get('Filter') as any).name).toBe('Adobe.PPKLite');
    expect(isArray(sig.get('ByteRange')!)).toBe(true);
    expect(sig.get('ByteRange')).toEqual(res.byteRange);
    const contents = sig.get('Contents');
    expect(isString(contents!)).toBe(true);
    const cb = (contents as any).bytes as Uint8Array;
    expect(cb.length).toBe(512);
    expect(cb.every((x) => x === 0)).toBe(true);
  });

  it('does not mutate the caller object map', () => {
    const { objects, trailer } = signedFixture();
    const sigBefore = objects.get(6) as PdfDict;
    serializeSignedDocument(objects, trailer, { signatureObj: 6, placeholderBytes: 256 });
    expect(sigBefore.has('ByteRange')).toBe(false);
    expect(sigBefore.has('Contents')).toBe(false);
  });

  it('round-trips through real CMS sign + verify', async () => {
    const { objects, trailer } = signedFixture();
    const res = serializeSignedDocument(objects, trailer, { signatureObj: 6, placeholderBytes: 4096 });

    const [, a, b, c] = res.byteRange;
    const covered = new Uint8Array(a + c);
    covered.set(res.bytes.subarray(0, a), 0);
    covered.set(res.bytes.subarray(b, b + c), a);
    const digest = new Uint8Array(createHash('sha256').update(covered).digest());

    const signer = buildSigner({ type: 'ec' });
    const cms = await buildSignedData(digest, { certificate: signer.certificate, privateKey: signer.privateKey });
    fillSignature(res.bytes, res, cms);

    const sig = findSigDict(res.bytes);
    const stored = (sig.get('Contents') as any).bytes as Uint8Array;
    const result = verifySignedData(stored.subarray(0, cms.length), digest);
    expect(result.digestMatches).toBe(true);
    expect(result.signatureValid).toBe(true);
  });

  it('rejects compressed and encrypted signing (unsupported)', () => {
    const { objects, trailer } = signedFixture();
    expect(() => serializeSignedDocument(objects, trailer, { signatureObj: 6, compressed: true })).toThrow();
    expect(() => serializeSignedDocument(objects, trailer, {
      signatureObj: 6, encrypt: { userPassword: 'x' } as any,
    })).toThrow();
  });
});
