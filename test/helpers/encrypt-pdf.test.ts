import { describe, it, expect } from 'vitest';
import { buildEncryptedPdf } from './encrypt-pdf.js';

describe('buildEncryptedPdf helper', () => {
  it('produces bytes with an /Encrypt trailer and an xref', () => {
    const { bytes } = buildEncryptedPdf(
      { cipher: 'rc4', V: 2, R: 3, length: 128 },
      { info: { Title: 'Secret' }, pageContents: ['BT (Hi) Tj ET'] },
    );
    const text = Buffer.from(bytes).toString('latin1');
    expect(text).toContain('/Encrypt');
    expect(text).toContain('startxref');
    expect(text).toContain('/ID [<');
  });
});
