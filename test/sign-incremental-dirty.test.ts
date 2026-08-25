import { describe, it, expect } from 'vitest';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { buildFormPdf } from './helpers/build-form-pdf.js';
import { buildSigner, TestSigner } from './helpers/build-signer.js';
import { Document } from '../src/document.js';

function signerOf(t: TestSigner): { certificate: Uint8Array; privateKey: any } {
  return { certificate: t.certificate, privateKey: t.privateKey };
}

/** A one-page classic PDF whose /AcroForm references its /Fields array
 *  *indirectly* (object 6), so signing must mutate that array object in place. */
function buildIndirectFieldsPdf(): Uint8Array {
  const enc = (s: string) => new TextEncoder().encode(s);
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R /AcroForm 5 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 400 400] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Resources << >> /Contents 4 0 R >>`;
  objects[4] = `<< /Length 0 >>\nstream\n\nendstream`;
  objects[5] = `<< /Fields 6 0 R /SigFlags 3 >>`;
  objects[6] = `[ ]`; // the indirect /Fields array
  const maxObj = 6;

  let body = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = new Array(maxObj + 1).fill(0);
  for (let n = 1; n <= maxObj; n++) {
    offsets[n] = enc(body).length;
    body += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefOffset = enc(body).length;
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return enc(body + xref + trailer);
}

/** A one-page classic PDF whose *page* references its /Annots array indirectly
 *  (object 5), so attaching the signature widget mutates that array object in
 *  place — the /Annots counterpart of buildIndirectFieldsPdf. */
function buildIndirectAnnotsPdf(): Uint8Array {
  const enc = (s: string) => new TextEncoder().encode(s);
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 400 400] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Resources << >> /Contents 4 0 R /Annots 5 0 R >>`;
  objects[4] = `<< /Length 0 >>\nstream\n\nendstream`;
  objects[5] = `[ ]`; // the indirect /Annots array
  const maxObj = 5;

  let body = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = new Array(maxObj + 1).fill(0);
  for (let n = 1; n <= maxObj; n++) {
    offsets[n] = enc(body).length;
    body += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefOffset = enc(body).length;
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return enc(body + xref + trailer);
}

describe('Sign — incremental dirty-tracking (stw.17 #2)', () => {
  // These edits touch a page the signature itself does NOT (the signature widget
  // lands on page 0), so the change rides along only if the in-place edit flipped
  // Document.modified and forced a full rewrite — the gap this issue fixes.

  it('an annotation removed from another page survives a subsequent sign', async () => {
    // Author a 2-page doc with a sticky note on page 2.
    const authored = Document.Open(buildClassicPdf(2));
    authored.Pages[1].AddTextNote({ rect: [10, 10, 30, 30], contents: 'note' });
    const withNote = authored.Save();
    expect(Document.Open(withNote).Pages[1].Annotations.length).toBe(1);

    // Reopen (pristine), remove the note in place, sign (widget on page 0).
    const doc = Document.Open(withNote);
    doc.Pages[1].RemoveAnnotation(doc.Pages[1].Annotations[0]);
    await doc.Sign(signerOf(buildSigner()), {});
    const reopened = Document.Open(doc.Save());

    expect(reopened.Pages[1].Annotations.filter((a) => a.Subtype === 'Text').length).toBe(0);
    const report = (await reopened.VerifySignatures())[0];
    expect(report.integrity).toBe('valid');
    expect(report.signature).toBe('valid');
  });

  it('a page-box edit on another page survives a subsequent sign', async () => {
    const doc = Document.Open(buildClassicPdf(2)); // pristine
    doc.Pages[1].MediaBox = [0, 0, 123, 456];
    await doc.Sign(signerOf(buildSigner()), {});
    const reopened = Document.Open(doc.Save());

    expect(reopened.Pages[1].MediaBox).toEqual([0, 0, 123, 456]);
    const report = (await reopened.VerifySignatures())[0];
    expect(report.integrity).toBe('valid');
    expect(report.signature).toBe('valid');
  });

  it('a form-field value edit survives a subsequent sign', async () => {
    const doc = Document.Open(buildFormPdf());
    doc.Form.Get('name')!.Value = 'Carol';
    await doc.Sign(signerOf(buildSigner()), {});
    const reopened = Document.Open(doc.Save());

    expect(reopened.Form.Get('name')!.Value).toBe('Carol');
    const report = (await reopened.VerifySignatures())[0];
    expect(report.integrity).toBe('valid');
    expect(report.signature).toBe('valid');
  });
});

describe('Sign — indirect /Fields array delta (stw.17 #3)', () => {
  it('appends the new signature field into an indirect /Fields array', async () => {
    const base = buildIndirectFieldsPdf();
    const doc = Document.Open(base); // pristine → incremental append
    await doc.Sign(signerOf(buildSigner()), {});
    const bytes = doc.Save();

    // Incremental append keeps the original bytes verbatim as a prefix.
    expect(bytes.subarray(0, base.length)).toEqual(base);

    // The new signature field made it into the (indirect) /Fields array, so the
    // signature is discoverable and verifies.
    const reopened = Document.Open(bytes);
    const sigs = reopened.Signatures.filter((s) => s.isSigned);
    expect(sigs.length).toBe(1);
    const report = (await reopened.VerifySignatures())[0];
    expect(report.integrity).toBe('valid');
    expect(report.signature).toBe('valid');
  });
});

describe('Sign — indirect /Annots array delta', () => {
  it('attaches the signature widget to an indirect /Annots array', async () => {
    const base = buildIndirectAnnotsPdf();
    const doc = Document.Open(base); // pristine → incremental append
    await doc.Sign(signerOf(buildSigner()), {});
    const bytes = doc.Save();

    expect(bytes.subarray(0, base.length)).toEqual(base);

    // Pushing into an indirect /Annots mutates *that* object, not the page, so
    // the array has to join the incremental delta on its own account. Recording
    // only the page writes bytes that did not change and drops the widget.
    const reopened = Document.Open(bytes);
    const annots = reopened.resolve(reopened.Pages[0].Dict.get('Annots')) as unknown[];
    expect(Array.isArray(annots)).toBe(true);
    expect(annots.length).toBe(1);
    const widget = reopened.resolve(annots[0] as never) as Map<string, unknown>;
    expect((reopened.resolve(widget.get('FT') as never) as { name: string }).name).toBe('Sig');
  });
});
