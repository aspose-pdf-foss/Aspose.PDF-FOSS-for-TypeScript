import { describe, it, expect } from 'vitest';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { buildPdfaPdf } from './helpers/build-pdfa-pdf.js';
import { buildSigner, TestSigner } from './helpers/build-signer.js';
import { Document } from '../src/document.js';
import { name } from '../src/types.js';

function signerOf(t: TestSigner): { certificate: Uint8Array; privateKey: any } {
  return { certificate: t.certificate, privateKey: t.privateKey };
}

const headerOf = (bytes: Uint8Array) => new TextDecoder('latin1').decode(bytes.subarray(0, 8));

/** 909q. The sign-on-save (full-rewrite) writer emitted a hardcoded %PDF-1.7,
 *  where every other save path emits the catalog /Version through
 *  headerVersion(). Signing a converted document therefore breached the very
 *  version rule the conversion had just satisfied.
 *
 *  Note which path these exercise and why it is the reachable one: choosePath()
 *  takes the full rewrite when the document is `modified`, and every
 *  ConvertToPdfA calls markModified() — so convert-then-sign is exactly the
 *  flow that lands here. The incremental path is asserted separately below,
 *  where the ORIGINAL header must survive untouched. */
describe('signing emits the catalog /Version as its header (909q)', () => {
  it('signs a PDF/A-4 document with a 2.0 header', async () => {
    const doc = Document.Open(buildPdfaPdf({ headerVersion: '1.7' }, 4));
    const report = doc.ConvertToPdfA('4');
    expect(report.passed).toBe(true);          // the conversion satisfied 6.1.2-1
    await doc.Sign(signerOf(buildSigner()), {});
    const saved = doc.Save();

    expect(headerOf(saved)).toBe('%PDF-2.0');
    // And the file still conforms: a 1.7 header is a Version error at part 4,
    // which is what makes this a conformance bug rather than a cosmetic one.
    const reopened = Document.Open(saved);
    expect(reopened.ValidatePdfA('4').Errors.map((e) => e.rule)).not.toContain('Version');
  });

  it('signs a PDF/A-1 document without exceeding its 1.4 ceiling', async () => {
    const doc = Document.Open(buildPdfaPdf({ headerVersion: '1.4' }, 1));
    doc.ConvertToPdfA('1b');
    await doc.Sign(signerOf(buildSigner()), {});
    const saved = doc.Save();

    expect(headerOf(saved)).toBe('%PDF-1.4');
    expect(Document.Open(saved).ValidatePdfA('1b').Errors.map((e) => e.rule)).not.toContain('Version');
  });

  it('defaults to 1.7 when the catalog states no /Version', async () => {
    const doc = Document.Open(buildClassicPdf(1));
    doc.Pages[0].MediaBox = [0, 0, 123, 456];  // dirty, so the full rewrite runs
    await doc.Sign(signerOf(buildSigner()), {});

    expect(headerOf(doc.Save())).toBe('%PDF-1.7');
  });

  it('keeps the signature verifiable at a non-default header version', async () => {
    // The header is inside the signed byte range, so getting it wrong is not
    // only a conformance question - this is what proves the fix did not move
    // the /ByteRange out from under the digest.
    const doc = Document.Open(buildClassicPdf(1));
    doc.catalog().set('Version', name('2.0'));
    await doc.Sign(signerOf(buildSigner()), {});
    const reopened = Document.Open(doc.Save());

    const report = (await reopened.VerifySignatures())[0];
    expect(report.integrity).toBe('valid');
    expect(report.signature).toBe('valid');
  });

  it('leaves the ORIGINAL header alone on the incremental path', async () => {
    // An incremental update appends to a prior byte image and must not rewrite
    // a byte of it, header included - even one that disagrees with the catalog.
    const base = Document.Open(buildClassicPdf(1));
    base.catalog().set('Version', name('2.0'));
    const saved = base.Save();
    expect(headerOf(saved)).toBe('%PDF-2.0');

    const doc = Document.Open(saved);           // pristine: appends rather than rewrites
    await doc.Sign(signerOf(buildSigner()), {});
    const signed = doc.Save();

    expect(headerOf(signed)).toBe('%PDF-2.0');
    expect(signed.subarray(0, saved.length)).toEqual(saved);   // byte-identical prefix
  });
});
