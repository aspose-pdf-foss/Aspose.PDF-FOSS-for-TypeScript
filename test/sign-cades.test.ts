import { describe, it, expect } from 'vitest';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { buildSigner, TestSigner } from './helpers/build-signer.js';
import { Document } from '../src/document.js';
import { UnsupportedFeatureError } from '../src/errors.js';

function signerOf(t: TestSigner): { certificate: Uint8Array; privateKey: any } {
  return { certificate: t.certificate, privateKey: t.privateKey };
}

describe('Document.Sign with CAdES attributes', () => {
  it('embeds commitment-type + signer-location and reads them back via VerifySignatures', async () => {
    const doc = Document.Open(buildClassicPdf(1));
    doc.SetMetadata({ title: 'CAdES' }); // force full-rewrite path
    await doc.Sign(signerOf(buildSigner({ type: 'rsa' })), {
      subFilter: 'PAdES',
      cades: {
        commitmentType: 'proof-of-origin',
        signerLocation: { country: 'DE', locality: 'Berlin', postalAddress: ['Alexanderplatz 1'] },
      },
    });
    const reopened = Document.Open(doc.Save());
    const report = (await reopened.VerifySignatures())[0];
    expect(report.signature).toBe('valid');
    expect(report.integrity).toBe('valid');
    expect(report.commitmentType).toBe('proof-of-origin');
    expect(report.signerLocation).toEqual({
      country: 'DE', locality: 'Berlin', postalAddress: ['Alexanderplatz 1'],
    });
  });

  it('rejects cades attributes without subFilter PAdES', async () => {
    const doc = Document.Open(buildClassicPdf(1));
    await expect(doc.Sign(signerOf(buildSigner()), {
      cades: { commitmentType: 'proof-of-origin' },
    })).rejects.toThrow(UnsupportedFeatureError);
  });

  it('rejects an unknown commitment type', async () => {
    const doc = Document.Open(buildClassicPdf(1));
    await expect(doc.Sign(signerOf(buildSigner()), {
      subFilter: 'PAdES', cades: { commitmentType: 'bogus' },
    })).rejects.toThrow(UnsupportedFeatureError);
  });

  it('ignores an all-empty cades object (no gate, no attributes)', async () => {
    const doc = Document.Open(buildClassicPdf(1));
    doc.SetMetadata({ title: 'empty' });
    await doc.Sign(signerOf(buildSigner()), { cades: { signerLocation: {} } });
    const report = (await Document.Open(doc.Save()).VerifySignatures())[0];
    expect(report.signature).toBe('valid');
    expect(report.commitmentType).toBeUndefined();
    expect(report.signerLocation).toBeUndefined();
  });
});

import type { CadesAttributes, CommitmentType, SignerLocation } from '../src/index.js';

describe('public surface', () => {
  it('exposes the CAdES types through the barrel', () => {
    const ct: CommitmentType = 'proof-of-origin';
    const loc: SignerLocation = { country: 'DE' };
    const cades: CadesAttributes = { commitmentType: ct, signerLocation: loc };
    // Type-level check; a runtime assertion keeps vitest happy.
    expect(cades.commitmentType).toBe('proof-of-origin');
  });
});
