import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { buildSigner, TestSigner } from './helpers/build-signer.js';
import { buildJpeg } from './helpers/build-embed-images.js';
import { Document } from '../src/document.js';
import { verifySignedData } from '../src/cms.js';
import { isDict, isStream, PdfDict, PdfObject, PdfStream } from '../src/types.js';

function signerOf(t: TestSigner): { certificate: Uint8Array; privateKey: any } {
  return { certificate: t.certificate, privateKey: t.privateKey };
}

/** Recompute the /ByteRange digest and verify the embedded CMS against it. */
function verifyFirstSignature(bytes: Uint8Array): { digestMatches: boolean; signatureValid: boolean } {
  const sig = Document.Open(bytes).Signatures[0];
  const [, a, b, c] = sig.byteRange!;
  const covered = new Uint8Array(a + c);
  covered.set(bytes.subarray(0, a), 0);
  covered.set(bytes.subarray(b, b + c), a);
  const digest = new Uint8Array(createHash('sha256').update(covered).digest());
  return verifySignedData(sig.contents!.subarray(0, sig.cmsLength!), digest);
}

/** The signature widget (the last field added to the AcroForm). */
function sigWidget(doc: Document): PdfDict {
  const acro = doc.resolve(doc.catalog().get('AcroForm')) as PdfDict;
  const fields = doc.resolve(acro.get('Fields')) as PdfObject[];
  return doc.resolve(fields[fields.length - 1]) as PdfDict;
}

/** The widget's /AP /N appearance stream. */
function apStream(doc: Document, widget: PdfDict): PdfStream {
  const ap = doc.resolve(widget.get('AP')) as PdfDict;
  const n = doc.resolve(ap.get('N'));
  if (!isStream(n)) throw new Error('no /AP /N stream');
  return n;
}

function apContent(doc: Document, widget: PdfDict): string {
  return new TextDecoder().decode(apStream(doc, widget).raw);
}

const RECT: [number, number, number, number] = [72, 72, 272, 144];

describe('Document.Sign — visible signature appearance (F2)', () => {
  it('installs an /AP /N Form XObject at the given rect and still verifies', async () => {
    const doc = Document.Open(buildClassicPdf(1));
    await doc.Sign(signerOf(buildSigner({ type: 'rsa' })), {
      name: 'Alice', reason: 'I approve',
      appearance: { page: 0, rect: RECT },
    });
    const bytes = doc.Save();

    const reopened = Document.Open(bytes);
    const widget = sigWidget(reopened);
    const rect = (reopened.resolve(widget.get('Rect')) as number[]).map(Number);
    expect(rect).toEqual(RECT);
    const ap = apStream(reopened, widget);
    expect(ap.dict.get('Subtype')).toEqual({ kind: 'name', name: 'Form' });
    expect(ap.dict.get('BBox')).toEqual([0, 0, 200, 72]);

    const v = verifyFirstSignature(bytes);
    expect(v.digestMatches).toBe(true);
    expect(v.signatureValid).toBe(true);
  });

  it('auto-generates name/date/reason text when no override is given', async () => {
    const doc = Document.Open(buildClassicPdf(1));
    await doc.Sign(signerOf(buildSigner()), {
      name: 'Bob', reason: 'review', location: 'NYC',
      appearance: { page: 0, rect: RECT },
    });
    const content = apContent(doc, sigWidget(doc));
    expect(content).toContain('Digitally signed by');
    expect(content).toContain('Bob');
    expect(content).toContain('review');
    expect(content).toContain('NYC');
  });

  it('uses the certificate subject as the name when none is provided', async () => {
    const doc = Document.Open(buildClassicPdf(1));
    await doc.Sign(signerOf(buildSigner()), { appearance: { page: 0, rect: RECT } });
    // build-signer issues a cert with a recognizable subject CN.
    expect(apContent(doc, sigWidget(doc))).toContain('Digitally signed by');
  });

  it('honors a custom text override verbatim', async () => {
    const doc = Document.Open(buildClassicPdf(1));
    await doc.Sign(signerOf(buildSigner()), {
      name: 'Carol',
      appearance: { page: 0, rect: RECT, text: 'Approved for release' },
    });
    const content = apContent(doc, sigWidget(doc));
    expect(content).toContain('Approved for release');
    expect(content).not.toContain('Digitally signed by');
  });

  it('embeds an image XObject into the appearance Resources', async () => {
    const doc = Document.Open(buildClassicPdf(1));
    await doc.Sign(signerOf(buildSigner()), {
      name: 'Dave',
      appearance: { page: 0, rect: RECT, image: buildJpeg(100, 50, 3) },
    });
    const ap = apStream(doc, sigWidget(doc));
    const res = doc.resolve(ap.dict.get('Resources')) as PdfDict;
    const xobj = doc.resolve(res.get('XObject')) as PdfDict;
    expect(isDict(xobj)).toBe(true);
    const imgKey = [...xobj.keys()][0];
    const img = doc.resolve(xobj.get(imgKey)) as PdfStream;
    expect(img.dict.get('Subtype')).toEqual({ kind: 'name', name: 'Image' });
    // The image is painted (Do) and the text is still present beside it.
    const content = new TextDecoder().decode(ap.raw);
    expect(content).toContain(`/${imgKey} Do`);
    expect(content).toContain('Digitally signed by');
    expect(verifyFirstSignature(doc.Save()).signatureValid).toBe(true);
  });

  it('places the widget on the requested page', async () => {
    const doc = Document.Open(buildClassicPdf(3));
    await doc.Sign(signerOf(buildSigner()), { appearance: { page: 1, rect: RECT } });
    const widget = sigWidget(doc);
    const page = doc.Pages[1];
    const annots = doc.resolve(page.Dict.get('Annots')) as PdfObject[];
    const refs = annots.map((a) => doc.resolve(a));
    expect(refs).toContain(widget);
    // The first page has no signature widget.
    expect(doc.resolve(doc.Pages[0].Dict.get('Annots')) ?? []).not.toContain(widget);
  });

  it('rejects an out-of-range page index', async () => {
    const doc = Document.Open(buildClassicPdf(1));
    await expect(
      doc.Sign(signerOf(buildSigner()), { appearance: { page: 5, rect: RECT } }),
    ).rejects.toThrow();
  });

  it('rejects a degenerate (zero-area) rect', async () => {
    const doc = Document.Open(buildClassicPdf(1));
    await expect(
      doc.Sign(signerOf(buildSigner()), { appearance: { page: 0, rect: [10, 10, 10, 10] } }),
    ).rejects.toThrow();
  });
});
