import type { Page } from '../../src/index.js';
import { Document } from '../../src/index.js';
import { addText, pageWidth, sectionHeader, INK, MUTED, NAVY } from './theme.js';
import { mintSigner } from './signcred.js';

export const SIGNED_PATH = 'docs/feature-showcase-signed.pdf';

/** Where the certification signature's visible widget lands on the signing
 *  page. Exported so the unsigned document can outline the same rect as an
 *  empty placeholder, and the two provably agree. */
export const SIGNATURE_RECT: [number, number, number, number] = [50, 430, 290, 530];

/** The page in the *unsigned* document: what the sibling contains, and an
 *  outline of the rect the signature will occupy there. */
export function addSigningShowcase(page: Page): void {
  const w = pageWidth(page);

  sectionHeader(page, 'Digital Signatures',
    'certification with DocMDP  •  an approval signature  •  incremental append  •  verification');

  addText(page,
    'This document is deliberately left unsigned — signing would freeze it '
    + 'against the regeneration this example exists to perform. Instead the run '
    + 're-opens the finished PDF and writes a signed sibling: first a '
    + 'certification (author) signature carrying a DocMDP transform that permits '
    + 'form filling and nothing more, then a second approval signature over the '
    + 'result.',
    [50, 620, w - 50, 700], { size: 10, color: INK, lineSpacing: 1.35 });

  addText(page,
    'Two signatures rather than one, because the second is what exercises the '
    + "incremental-append path: the first signature's bytes must survive "
    + 'verbatim underneath it, and a single signature would not distinguish an '
    + 'append from a full rewrite. Credentials are minted on every run — an '
    + "RSA-2048 keypair and a self-signed certificate built with the library's "
    + 'own DER encoder — so there is nothing checked in and nothing to expire.',
    [50, 548, w - 50, 612], { size: 10, color: INK, lineSpacing: 1.35 });

  // The placeholder outline: the same rect the certification occupies in the
  // sibling, drawn here so the two can be compared side by side.
  const g = page.Graphics();
  g.save().setStrokeColor([0.70, 0.72, 0.82]).setLineWidth(1).setDash([5, 4])
    .rect(SIGNATURE_RECT[0], SIGNATURE_RECT[1],
      SIGNATURE_RECT[2] - SIGNATURE_RECT[0], SIGNATURE_RECT[3] - SIGNATURE_RECT[1])
    .stroke().restore();
  g.apply();

  addText(page, 'Signature appears here in the signed sibling',
    [SIGNATURE_RECT[0] + 10, SIGNATURE_RECT[1] + 40,
      SIGNATURE_RECT[2] - 10, SIGNATURE_RECT[1] + 62],
    { size: 9.5, color: MUTED, align: 'center' });

  addText(page,
    'Open docs/feature-showcase-signed.pdf to see it filled. A viewer will '
    + 'report both signatures as cryptographically valid but untrusted — the '
    + 'certificates are self-signed, so there is no trust anchor to chain to. '
    + "This run's console output lists each signature's signer, integrity, "
    + 'byte-range coverage and DocMDP verdict.',
    [SIGNATURE_RECT[2] + 24, 436, w - 50, 528],
    { size: 9, color: MUTED, lineSpacing: 1.35 });

  void NAVY;
}

/** Re-open `sourcePath`, certify it, append an approval signature, and write the
 *  sibling.
 *
 *  Runs on the saved file rather than the live document because signing appends
 *  incrementally: the signed bytes must not be mutated afterwards, and the live
 *  document still has a full rewrite ahead of it. `signaturePageIndex` is
 *  0-based, as SignatureAppearance requires.
 *
 *  Each signature needs its own Save/re-open cycle. Sign() and Certify() build
 *  their /Contents against the byte image the *next* Save produces, so calling
 *  both on one Document and saving once yields a file with only the second
 *  signature — the certification is silently overwritten rather than appended
 *  under. Saving in between is what makes the second one a true incremental
 *  append over finished bytes. */
export async function signSavedDocument(
  sourcePath: string, signaturePageIndex: number,
): Promise<void> {
  const author = mintSigner('Aspose Showcase Author');
  const approver = mintSigner('Aspose Showcase Approver');

  // Pass 1 — certification, over the whole file.
  const certifying = Document.OpenFile(sourcePath);
  await certifying.Certify(
    { certificate: author.certificate, privateKey: author.privateKey },
    {
      permissions: 'form-fill',
      reason: 'Certifying the feature showcase',
      location: 'Prague, CZ',
      name: author.commonName,
      fieldName: 'ShowcaseCertification',
      appearance: {
        page: signaturePageIndex,
        rect: SIGNATURE_RECT,
        text: `Certified by ${author.commonName}\n`
          + 'DocMDP: form filling permitted\n'
          + 'Aspose.PDF FOSS for TypeScript',
      },
    },
  );

  const certifiedBytes = certifying.Save();

  // Pass 2 — approval, appended incrementally onto those finished bytes. The
  // certification's byte range must survive verbatim underneath it.
  const approving = Document.Open(certifiedBytes);
  await approving.Sign(
    { certificate: approver.certificate, privateKey: approver.privateKey },
    {
      reason: 'Approved for publication',
      name: approver.commonName,
      fieldName: 'ShowcaseApproval',
      subFilter: 'PAdES',
    },
  );

  approving.WriteTo(SIGNED_PATH);
  console.log(`signed: ${SIGNED_PATH} `
    + `(certified ${(certifiedBytes.length / 1024).toFixed(1)} KB, then appended)`);

  const reports = await Document.OpenFile(SIGNED_PATH).VerifySignatures();
  for (const r of reports) {
    console.log(`  ${r.name}: signer=${r.signerCert?.subject ?? '(unparsed)'} `
      + `integrity=${r.integrity} signature=${r.signature} `
      + `coversWholeFile=${r.coversWholeFile} docMDP=${r.docMDP}`);
  }
}
