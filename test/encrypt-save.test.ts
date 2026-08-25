import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { InvalidPasswordError } from '../src/errors.js';
import { permissionsToP } from '../src/encrypt.js';
import { buildStampTarget } from './helpers/build-stamp-target.js';

const ALGOS = ['aes256', 'aes128', 'rc4'] as const;

describe('encrypted Save — classic', () => {
  for (const algorithm of ALGOS) {
    it(`${algorithm}: user password round-trips text`, () => {
      const doc = Document.Open(buildStampTarget());
      const bytes = doc.Save({ encrypt: { userPassword: 'u', ownerPassword: 'o', algorithm } });
      const reopened = Document.Open(bytes, { password: 'u' });
      expect(reopened.Pages[0].GetText()).toContain('Original');
    });

    it(`${algorithm}: wrong password throws InvalidPasswordError`, () => {
      const doc = Document.Open(buildStampTarget());
      const bytes = doc.Save({ encrypt: { userPassword: 'u', algorithm } });
      expect(() => Document.Open(bytes, { password: 'x' })).toThrow(InvalidPasswordError);
    });
  }

  it('aes256: owner password also opens', () => {
    const doc = Document.Open(buildStampTarget());
    const bytes = doc.Save({ encrypt: { userPassword: 'u', ownerPassword: 'o', algorithm: 'aes256' } });
    expect(() => Document.Open(bytes, { password: 'o' })).not.toThrow();
  });

  it('no encrypt option leaves output unencrypted', () => {
    const doc = Document.Open(buildStampTarget());
    const bytes = doc.Save();
    const text = new TextDecoder('latin1').decode(bytes);
    expect(text).not.toContain('/Encrypt');
    expect(Document.Open(bytes).Pages[0].GetText()).toContain('Original');
  });
});

describe('encrypted Save — compressed', () => {
  for (const algorithm of ALGOS) {
    it(`${algorithm}: user password round-trips text (compressed)`, () => {
      const doc = Document.Open(buildStampTarget());
      const bytes = doc.Save({ compressed: true, encrypt: { userPassword: 'u', algorithm } });
      const reopened = Document.Open(bytes, { password: 'u' });
      expect(reopened.Pages[0].GetText()).toContain('Original');
    });
  }

  it('compressed + no encrypt stays unencrypted', () => {
    const doc = Document.Open(buildStampTarget());
    const bytes = doc.Save({ compressed: true });
    expect(new TextDecoder('latin1').decode(bytes)).not.toContain('/Encrypt');
  });
});

describe('encrypted Save — options', () => {
  it('writes the computed /P for restricted permissions', () => {
    const perms = { copying: false, printing: false };
    const doc = Document.Open(buildStampTarget());
    const bytes = doc.Save({ encrypt: { userPassword: 'u', permissions: perms } });
    const text = new TextDecoder('latin1').decode(bytes);
    expect(text).toContain(`/P ${permissionsToP(perms)}`);
  });

  it('encryptMetadata:false emits /EncryptMetadata false and still opens', () => {
    const doc = Document.Open(buildStampTarget());
    const bytes = doc.Save({ encrypt: { userPassword: 'u', encryptMetadata: false } });
    expect(new TextDecoder('latin1').decode(bytes)).toContain('/EncryptMetadata false');
    expect(Document.Open(bytes, { password: 'u' }).Pages[0].GetText()).toContain('Original');
  });

  it('unknown algorithm throws TypeError', () => {
    const doc = Document.Open(buildStampTarget());
    // @ts-expect-error invalid algorithm on purpose
    expect(() => doc.Save({ encrypt: { algorithm: 'des' } })).toThrow(TypeError);
  });
});
