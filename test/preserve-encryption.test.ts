import { describe, it, expect } from 'vitest';
import { buildEncryptedPdf } from './helpers/encrypt-pdf.js';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { Document } from '../src/document.js';
import { Encryptor } from '../src/encrypt.js';

export const encryptedPdf = (cipher: 'rc4' | 'aes128' | 'aes256'): Uint8Array => {
  const cfg = cipher === 'rc4'
    ? { cipher, R: 3, V: 2, length: 128 } as const
    : cipher === 'aes128'
      ? { cipher, R: 4, V: 4, length: 128 } as const
      : { cipher, R: 6, V: 5, length: 256 } as const;
  return buildEncryptedPdf(cfg, { info: { Title: 'SecretTitle' }, pageContents: ['BT ET'] }).bytes;
};

const retained = (d: Document): Encryptor | undefined =>
  (d as unknown as { preservedEncryptor?: Encryptor }).preservedEncryptor;

describe('Document retains the crypto it opened with', () => {
  for (const cipher of ['rc4', 'aes128', 'aes256'] as const) {
    it(`retains an encryptor for ${cipher}`, () => {
      const doc = Document.Open(encryptedPdf(cipher));
      expect(retained(doc)).toBeDefined();
    });
  }

  // "Verbatim" is asserted on /O and /U rather than on object identity, which
  // is an implementation detail: build() captures the dict from the RAW
  // resolver while doc.resolve returns the live map's copy, so they are equal
  // and not the same object. /O and /U are the sharper test anyway — a rebuilt
  // dict provably cannot reproduce them, since /O is a hash of an owner
  // password we do not hold.
  it('retains the ORIGINAL /Encrypt dict rather than a rebuilt one', () => {
    const doc = Document.Open(encryptedPdf('rc4'));
    const live = doc.resolve(doc.trailer.get('Encrypt')) as Map<string, { bytes: Uint8Array }>;
    const kept = retained(doc)!.encryptDict as Map<string, { bytes: Uint8Array }>;
    expect(kept.get('O')!.bytes).toEqual(live.get('O')!.bytes);
    expect(kept.get('U')!.bytes).toEqual(live.get('U')!.bytes);
    expect(kept.get('P')).toEqual(live.get('P'));
  });

  it('retains nothing for an unencrypted document', () => {
    expect(retained(Document.Open(buildClassicPdf(1)))).toBeUndefined();
  });
});

const visible = (b: Uint8Array, s: string): boolean =>
  new TextDecoder('latin1').decode(b).includes(s);

describe('Save preserves encryption', () => {
  for (const cipher of ['rc4', 'aes128', 'aes256'] as const) {
    it(`round-trips a ${cipher} document`, () => {
      const out = Document.Open(encryptedPdf(cipher)).Save();
      // The sharp assertion: actually encrypted, not merely carrying /Encrypt.
      expect(visible(out, 'SecretTitle')).toBe(false);
      expect(Document.Open(out).GetMetadata().title).toBe('SecretTitle');
    });
  }

  it('writes plaintext when asked explicitly', () => {
    const out = Document.Open(encryptedPdf('rc4')).Save({ encrypt: false });
    expect(visible(out, 'SecretTitle')).toBe(true);
    expect(Document.Open(out).GetMetadata().title).toBe('SecretTitle');
  });

  it('lets an explicit encrypt option win over the retained one', () => {
    const out = Document.Open(encryptedPdf('rc4'))
      .Save({ encrypt: { userPassword: 'new', ownerPassword: 'owner' } });
    expect(Document.Open(out, { password: 'new' }).GetMetadata().title).toBe('SecretTitle');
    expect(() => Document.Open(out)).toThrow();
  });

  it('preserves /ID byte for byte, which the retained key depends on', () => {
    const base = encryptedPdf('rc4');
    const idOf = (b: Uint8Array): string => {
      const arr = Document.Open(b).trailer.get('ID') as { bytes: Uint8Array }[];
      return Buffer.from(arr[0].bytes).toString('hex');
    };
    expect(idOf(Document.Open(base).Save())).toBe(idOf(base));
  });

  it('leaves an unencrypted document byte-identical', () => {
    const base = buildClassicPdf(2);
    expect(Document.Open(base).Save()).toEqual(Document.Open(base).Save());
    expect(visible(Document.Open(base).Save(), '/Encrypt')).toBe(false);
  });

  // The retained key is only valid against the SAME /ID, and resolveIds would
  // invent a fresh random one -- producing a file nothing can decrypt.
  it('refuses to preserve when the trailer names no /ID', () => {
    const doc = Document.Open(encryptedPdf('rc4'));
    doc.trailer.delete('ID');
    expect(() => doc.Save()).toThrow(/names no \/ID/);
    // But the two explicit routes still work.
    expect(() => doc.Save({ encrypt: false })).not.toThrow();
    expect(() => doc.Save({ encrypt: { userPassword: 'new' } })).not.toThrow();
  });
});

describe('an incremental save keeps the document encrypted', () => {
  it('reopens with BOTH old and new content decrypting', () => {
    const doc = Document.Open(encryptedPdf('rc4'));
    doc.Pages[0].Dict.set('Rotate', 90);
    const out = doc.Save({ incremental: true });

    // The x8kx regression: the original /Info used to decode to garbage.
    const re = Document.Open(out);
    expect(re.GetMetadata().title).toBe('SecretTitle');
    expect(re.Pages[0].Dict.get('Rotate')).toBe(90);
  });

  it('carries /Encrypt into the appended trailer', () => {
    const base = encryptedPdf('rc4');
    const doc = Document.Open(base);
    doc.Pages[0].Dict.set('Rotate', 90);
    const appended = new TextDecoder('latin1')
      .decode(doc.Save({ incremental: true }).subarray(base.length));
    expect(appended).toMatch(/\/Encrypt \d+ \d+ R/);
  });

  it('preserves the original bytes verbatim', () => {
    const base = encryptedPdf('rc4');
    const doc = Document.Open(base);
    doc.Pages[0].Dict.set('Rotate', 90);
    expect(doc.Save({ incremental: true }).subarray(0, base.length)).toEqual(base);
  });
});

describe('Save preserves certificate-based (PubSec) encryption', () => {
  it('round-trips a PubSec document', async () => {
    const { buildRsaSigner } = await import('./helpers/build-signer.js');
    const r = buildRsaSigner('Recipient');

    const authored = Document.Open(buildClassicPdf(1));
    authored.SetMetadata({ title: 'SecretTitle' });
    const encrypted = authored.Save({
      encrypt: { recipients: [{ certificate: r.certificate }], algorithm: 'aes256' },
    });

    const out = Document.Open(encrypted, { recipient: r }).Save();
    expect(visible(out, 'SecretTitle')).toBe(false);
    expect(Document.Open(out, { recipient: r }).GetMetadata().title).toBe('SecretTitle');
  });
});
