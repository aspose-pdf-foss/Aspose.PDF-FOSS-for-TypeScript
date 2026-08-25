import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { deriveFileKey } from '../src/pubsec.js';

describe('PubSec file-key derivation', () => {
  const seed = new Uint8Array(20).map((_, i) => i + 1);
  const blob = new Uint8Array([0xaa, 0xbb, 0xcc]);

  it('SHA-256, 32-byte key, metadata encrypted', () => {
    const expected = new Uint8Array(
      createHash('sha256').update(Buffer.concat([seed, blob])).digest());
    const key = deriveFileKey(seed, [blob], 'sha256', 32, true);
    expect([...key]).toEqual([...expected]);
  });

  it('SHA-1, 16-byte key, appends 0xFFFFFFFF when metadata not encrypted', () => {
    const tail = Buffer.from([0xff, 0xff, 0xff, 0xff]);
    const expected = new Uint8Array(
      createHash('sha1').update(Buffer.concat([seed, blob, tail])).digest()).subarray(0, 16);
    const key = deriveFileKey(seed, [blob], 'sha1', 16, false);
    expect([...key]).toEqual([...expected]);
  });
});

import { buildPubSecEncryptor, buildPubSecDecryptor } from '../src/pubsec.js';
import { buildRsaSigner, buildSigner } from './helpers/build-signer.js';
import { isString } from '../src/types.js';

describe('PubSec encryptor/decryptor round-trip', () => {
  const id = (o: any) => o; // resolve: our /Encrypt dict holds direct objects

  for (const algorithm of ['rc4', 'aes128', 'aes256'] as const) {
    it(`round-trips a string object (${algorithm})`, () => {
      const r = buildRsaSigner('Recipient');
      const enc = buildPubSecEncryptor({
        recipients: [{ certificate: r.certificate }], algorithm,
        permissions: { copying: false },
      });
      const plain = { kind: 'string' as const, bytes: new Uint8Array([72, 105]) }; // "Hi"
      const cipher = enc.encryptObject({ kind: 'string' as const, bytes: new Uint8Array(plain.bytes) }, 5, 0);

      const dec = buildPubSecDecryptor(enc.encryptDict, r, id);
      const back = dec.decryptObject(cipher, 5, 0);
      expect(isString(back) && [...back.bytes]).toEqual([72, 105]);
      expect(dec.permissions.copying).toBe(false);
    });
  }

  it('rejects a non-matching recipient (InvalidPasswordError)', () => {
    const r = buildRsaSigner('Recipient');
    const stranger = buildRsaSigner('Stranger');
    const enc = buildPubSecEncryptor({ recipients: [{ certificate: r.certificate }] });
    expect(() => buildPubSecDecryptor(
      enc.encryptDict, { privateKey: stranger.privateKey, certificate: stranger.certificate }, id,
    )).toThrowError(/password|recipient/i);
  });

  it('gives each recipient group its own permissions from one shared seed', () => {
    const a = buildRsaSigner('Printer');   // may print
    const b = buildRsaSigner('Viewer');    // may not print
    const enc = buildPubSecEncryptor({
      recipients: [
        { certificate: a.certificate, permissions: { printing: true } },
        { certificate: b.certificate, permissions: { printing: false } },
      ],
      algorithm: 'aes256',
    });
    // Two envelopes in /Recipients (one per distinct permission set).
    const cf = (enc.encryptDict.get('CF') as Map<string, any>).get('DefaultCryptFilter') as Map<string, any>;
    expect((cf.get('Recipients') as any[]).length).toBe(2);

    const decA = buildPubSecDecryptor(enc.encryptDict, { privateKey: a.privateKey, certificate: a.certificate }, id);
    const decB = buildPubSecDecryptor(enc.encryptDict, { privateKey: b.privateKey, certificate: b.certificate }, id);
    expect(decA.permissions.printing).toBe(true);
    expect(decB.permissions.printing).toBe(false);

    // Both derive the same file key: B's decryptor reads a string encrypted once.
    const cipher = enc.encryptObject({ kind: 'string' as const, bytes: new Uint8Array([9, 9]) }, 7, 0);
    expect((decB.decryptObject(cipher, 7, 0) as any).bytes).toEqual(new Uint8Array([9, 9]));
  });
});

import { serializeDocument } from '../src/serializer.js';
import { ref, name as pdfName } from '../src/types.js';

describe('PubSec serialize', () => {
  it('emits /Filter /Adobe.PubSec in the output', () => {
    const r = buildRsaSigner('Recipient');
    const objects = new Map<number, any>([
      [1, new Map<string, any>([['Type', pdfName('Catalog')], ['Pages', ref(2)]])],
      [2, new Map<string, any>([['Type', pdfName('Pages')], ['Kids', []], ['Count', 0]])],
    ]);
    const trailer = new Map<string, any>([['Root', ref(1)]]);
    const bytes = serializeDocument(objects, trailer, {
      encrypt: { recipients: [{ certificate: r.certificate }] },
    });
    const text = new TextDecoder('latin1').decode(bytes);
    expect(text).toContain('/Adobe.PubSec');
    expect(text).toContain('/DefaultCryptFilter');
  });
});

import { Document } from '../src/document.js';

function tinyDoc(): Map<number, any> {
  return new Map<number, any>([
    [1, new Map<string, any>([['Type', pdfName('Catalog')], ['Pages', ref(2)],
      ['Marker', { kind: 'string', bytes: new TextEncoder().encode('secret') }]])],
    [2, new Map<string, any>([['Type', pdfName('Pages')], ['Kids', []], ['Count', 0]])],
  ]);
}

describe('PubSec Open round-trip', () => {
  it('encrypts on Save and decrypts on Open (aes256, KeyObject recipient)', () => {
    const r = buildRsaSigner('Recipient');
    const bytes = serializeDocument(tinyDoc(), new Map([['Root', ref(1)]]), {
      encrypt: { recipients: [{ certificate: r.certificate }], permissions: { printing: false } },
    });
    const doc = Document.Open(bytes, { recipient: { privateKey: r.privateKey, certificate: r.certificate } });
    const marker = doc.catalog().get('Marker');
    expect(marker && isString(marker) && new TextDecoder().decode(marker.bytes)).toBe('secret');
    expect(doc.Permissions?.printing).toBe(false);
  });

  it('throws InvalidPasswordError without a recipient', () => {
    const r = buildRsaSigner('Recipient');
    const bytes = serializeDocument(tinyDoc(), new Map([['Root', ref(1)]]), {
      encrypt: { recipients: [{ certificate: r.certificate }] },
    });
    expect(() => Document.Open(bytes)).toThrowError(/password|recipient/i);
  });

  it('encrypts to an EC recipient and decrypts on Open (ECDH-ES)', () => {
    const r = buildSigner({ type: 'ec', namedCurve: 'P-256' });
    const bytes = serializeDocument(tinyDoc(), new Map([['Root', ref(1)]]), {
      encrypt: { recipients: [{ certificate: r.certificate }], permissions: { printing: false } },
    });
    const doc = Document.Open(bytes, { recipient: { privateKey: r.privateKey, certificate: r.certificate } });
    const marker = doc.catalog().get('Marker');
    expect(marker && isString(marker) && new TextDecoder().decode(marker.bytes)).toBe('secret');
    expect(doc.Permissions?.printing).toBe(false);
  });
});

import { buildPkcs12 } from './helpers/build-pkcs12.js';

describe('PubSec coverage matrix', () => {
  const encToBytes = (r: { certificate: Uint8Array }, extra: any = {}) =>
    serializeDocument(tinyDoc(), new Map([['Root', ref(1)]]),
      { encrypt: { recipients: [{ certificate: r.certificate }], ...extra } });

  for (const algorithm of ['rc4', 'aes128', 'aes256'] as const) {
    it(`end-to-end via Document (${algorithm})`, () => {
      const r = buildRsaSigner('Recipient');
      const bytes = encToBytes(r, { algorithm });
      const doc = Document.Open(bytes, { recipient: { privateKey: r.privateKey, certificate: r.certificate } });
      const marker = doc.catalog().get('Marker');
      expect(marker && isString(marker) && new TextDecoder().decode(marker.bytes)).toBe('secret');
    });
  }

  it('opens via a pkcs12 recipient bundle', () => {
    const bundle = buildPkcs12();
    const bytes = serializeDocument(tinyDoc(), new Map([['Root', ref(1)]]),
      { encrypt: { recipients: [{ certificate: bundle.certificate }] } });
    const doc = Document.Open(bytes, { recipient: { pkcs12: bundle.p12 } });
    expect(isString(doc.catalog().get('Marker'))).toBe(true);
  });

  it('rejects an unrelated recipient with InvalidPasswordError', () => {
    const r = buildRsaSigner('Recipient');
    const stranger = buildRsaSigner('Stranger');
    const bytes = encToBytes(r);
    expect(() => Document.Open(bytes, {
      recipient: { privateKey: stranger.privateKey, certificate: stranger.certificate },
    })).toThrowError(/password|recipient/i);
  });

  it('supports two recipients (each opens the file)', () => {
    const a = buildRsaSigner('A'); const b = buildRsaSigner('B');
    const bytes = serializeDocument(tinyDoc(), new Map([['Root', ref(1)]]),
      { encrypt: { recipients: [{ certificate: a.certificate }, { certificate: b.certificate }] } });
    for (const who of [a, b]) {
      const doc = Document.Open(bytes, { recipient: { privateKey: who.privateKey, certificate: who.certificate } });
      expect(isString(doc.catalog().get('Marker'))).toBe(true);
    }
  });

  it('round-trips with encryptMetadata: false', () => {
    const r = buildRsaSigner('Recipient');
    const bytes = encToBytes(r, { encryptMetadata: false });
    expect(new TextDecoder('latin1').decode(bytes)).toContain('/EncryptMetadata false');
    const doc = Document.Open(bytes, { recipient: { privateKey: r.privateKey, certificate: r.certificate } });
    expect(isString(doc.catalog().get('Marker'))).toBe(true);
  });

  it('round-trips compressed PubSec output', () => {
    const r = buildRsaSigner('Recipient');
    const bytes = serializeDocument(tinyDoc(), new Map([['Root', ref(1)]]),
      { compressed: true, encrypt: { recipients: [{ certificate: r.certificate }] } });
    const doc = Document.Open(bytes, { recipient: { privateKey: r.privateKey, certificate: r.certificate } });
    expect(isString(doc.catalog().get('Marker'))).toBe(true);
  });
});
