import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { Document, PdfParseError } from '../src/index.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/cms-signer-id/${name}.pdf`, import.meta.url));

describe('CMS SignerIdentifier in independently signed PDFs', () => {
  it.each(['issuer-serial', 'subject-key-id'])('selects the certificate matching %s', async (name) => {
    const reports = await Document.Open(fixture(name)).VerifySignatures();
    expect(reports).toMatchObject([{
      integrity: 'valid', signature: 'valid', signerCert: { subject: 'CN=CMS fixture signer', serialNumber: '11' },
    }]);
  });

  it.each(['missing-signer', 'missing-key-id', 'ambiguous-issuer-serial', 'ambiguous-key-id'])(
    'keeps digest and signer verdicts independent for %s', async (name) => {
      const getOCSP = vi.fn(() => undefined);
      const reports = await Document.Open(fixture(name)).VerifySignatures({ getOCSP });
      expect(reports).toMatchObject([{
        integrity: 'valid', signature: 'invalid', chain: 'unchecked', revocation: 'unchecked',
      }]);
      expect(reports[0].signerCert).toBeUndefined();
      expect(getOCSP).not.toHaveBeenCalled();
    },
  );

  it('still reports a changed byte-range digest with an unresolved signer', async () => {
    const bytes = fixture('missing-signer');
    const title = bytes.indexOf('CMS fixture document');
    expect(title).toBeGreaterThan(0);
    bytes[title] = 'X'.charCodeAt(0);
    expect(await Document.Open(bytes).VerifySignatures()).toMatchObject([{
      integrity: 'tampered', signature: 'invalid',
    }]);
  });

  it('rejects validation-data collection for an unresolved signer', async () => {
    const doc = Document.Open(fixture('missing-signer'));
    const getOCSP = vi.fn(() => undefined);
    await expect(doc.AddValidationData({ getOCSP })).rejects.toThrow(PdfParseError);
    expect(getOCSP).not.toHaveBeenCalled();
    expect(doc.catalog().has('DSS')).toBe(false);
  });
});
