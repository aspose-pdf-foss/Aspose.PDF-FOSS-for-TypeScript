import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Document, InvalidPasswordError } from '../src/index.js';

const pdf = readFileSync(new URL('./fixtures/go-encrypted-signature/aes256.pdf', import.meta.url));

describe('Go-produced encrypted signature', () => {
  it.each([
    ['user', 'go-signature-user'],
    ['owner', 'go-signature-owner'],
  ])('decrypts the document with the %s password', (_, password) => {
    const doc = Document.Open(pdf, { password });
    expect(doc.Pages).toHaveLength(1);
    expect(doc.Pages[0].GetText()).toContain('Go encrypted signature fixture text');
    expect(doc.GetMetadata().title).toBe('Go encrypted signature fixture');
  });

  it('rejects a missing or incorrect password', () => {
    expect(() => Document.Open(pdf)).toThrow(InvalidPasswordError);
    expect(() => Document.Open(pdf, { password: 'wrong-password' })).toThrow(InvalidPasswordError);
  });

  it('verifies the detached approval signature against the stored encrypted bytes', async () => {
    const doc = Document.Open(pdf, { password: 'go-signature-user' });
    const reports = await doc.VerifySignatures();
    expect(reports).toMatchObject([{
      name: 'Signature1',
      integrity: 'valid',
      signature: 'valid',
      coversWholeFile: true,
      docMDP: 'n/a',
    }]);
    expect(reports[0].signerCert?.subject).toContain('Go encrypted fixture signer');
  });
});
