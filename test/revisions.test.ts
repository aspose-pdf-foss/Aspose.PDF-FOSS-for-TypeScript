import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { buildSigner, TestSigner } from './helpers/build-signer.js';
import { Document } from '../src/document.js';
import { appendIncrementalUpdate } from '../src/incremental.js';

const signerOf = (t: TestSigner): { certificate: Uint8Array; privateKey: any } =>
  ({ certificate: t.certificate, privateKey: t.privateKey });

describe('Document.Revisions', () => {
  it('reports exactly one revision for a clean, never-updated file', () => {
    const base = buildClassicPdf(2);
    const doc = Document.Open(base);
    expect(doc.Revisions).toHaveLength(1);
    expect(doc.hasIncrementalUpdates).toBe(false);
    expect(doc.Revisions[0].length).toBe(base.length);
  });

  it('reports two revisions after one incremental update', () => {
    const base = buildClassicPdf(2);
    const out = appendIncrementalUpdate(base, { objects: new Map() });
    const doc = Document.Open(out);

    expect(doc.Revisions).toHaveLength(2);
    expect(doc.hasIncrementalUpdates).toBe(true);
    // Oldest first: [0] is the original document, [1] is the whole file.
    expect(doc.Revisions[0].length).toBe(base.length);
    expect(doc.Revisions[1].length).toBe(out.length);
  });

  it('reports three revisions after two, with strictly ascending lengths', () => {
    const base = buildClassicPdf(2);
    const once = appendIncrementalUpdate(base, { objects: new Map() });
    const twice = appendIncrementalUpdate(once, { objects: new Map() });
    const revs = Document.Open(twice).Revisions;

    expect(revs).toHaveLength(3);
    expect(revs.map((r) => r.length)).toEqual([base.length, once.length, twice.length]);
    expect(revs[0].xrefOffset).toBeLessThan(revs[1].xrefOffset);
    expect(revs[1].xrefOffset).toBeLessThan(revs[2].xrefOffset);
  });

  // The cross-reference STREAM branch. Its payload is compressed binary that can
  // contain the bytes '%%EOF', so the end-of-revision scan must start from the
  // parsed end of the section object, never from its offset.
  it('handles a cross-reference stream document', () => {
    const base = Document.Open(buildClassicPdf(2)).Save({ compressed: true });
    const out = appendIncrementalUpdate(base, { objects: new Map() });
    const doc = Document.Open(out);

    expect(doc.Revisions).toHaveLength(2);
    expect(doc.Revisions[0].length).toBe(base.length);
    expect(doc.Revisions[1].length).toBe(out.length);
  });

  /** A PDF whose cross-reference STREAM payload literally contains the bytes
   *  `%%EOF`, which is the hazard the end-of-revision scan is written around.
   *
   *  The stream is UNCOMPRESSED so its bytes are chosen rather than produced by
   *  deflate — `Save({ compressed: true })` emits a deflated payload that
   *  happens never to contain the marker, so it cannot exercise this at all.
   *  The marker rides in two extra rows for object numbers nothing references;
   *  their type bytes (0x25, 0x46) are neither 1 nor 2, so `readXrefStream`
   *  skips them and the document still opens. */
  function buildXrefStreamWithEofInPayload(): Uint8Array {
    const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
    const bodies = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 400 400] >>',
      '<< /Type /Page /Parent 2 0 R /Resources << >> /Contents 4 0 R >>',
      '<< /Length 0 >>\nstream\n\nendstream',
    ];
    let head = '%PDF-1.5\n';
    const offsets: number[] = [0];
    for (let i = 0; i < bodies.length; i++) {
      offsets.push(head.length);
      head += `${i + 1} 0 obj\n${bodies[i]}\nendobj\n`;
    }
    const xrefOffset = head.length;
    offsets.push(xrefOffset); // object 5, the xref stream itself

    // Rows are /W [1 2 1]: type(1) + offset(2) + gen(1).
    const rows: number[] = [0x00, 0x00, 0x00, 0xff]; // object 0, free
    for (let n = 1; n <= 5; n++)
      rows.push(0x01, (offsets[n] >> 8) & 0xff, offsets[n] & 0xff, 0x00);
    // Objects 100 and 101: the marker, spanning the row boundary.
    rows.push(0x25, 0x25, 0x45, 0x4f);
    rows.push(0x46, 0x00, 0x00, 0x00);

    const dict = `<< /Type /XRef /Size 6 /Index [0 6 100 2] /W [1 2 1] `
      + `/Root 1 0 R /Length ${rows.length} >>`;
    const parts: Uint8Array[] = [
      enc(head),
      enc(`5 0 obj\n${dict}\nstream\n`),
      new Uint8Array(rows),
      enc(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`),
    ];
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  }

  it('is not fooled by %%EOF inside a cross-reference stream payload', () => {
    const base = buildXrefStreamWithEofInPayload();
    // Sanity: the payload really does carry the marker, before the real one.
    const text = new TextDecoder('latin1').decode(base);
    expect(text.indexOf('%%EOF')).toBeLessThan(text.lastIndexOf('%%EOF'));

    const doc = Document.Open(base);
    expect(doc.Revisions).toHaveLength(1);
    expect(doc.Revisions[0].length).toBe(base.length);
  });

  it('slices a prior revision back out of the file', () => {
    const base = buildClassicPdf(2);
    const out = appendIncrementalUpdate(base, { objects: new Map() });
    const doc = Document.Open(out);

    const first = out.subarray(0, doc.Revisions[0].length);
    expect(first).toEqual(base);
    // And it is a document in its own right.
    expect(Document.Open(first).Pages).toHaveLength(2);
  });

  it('reports no revisions for a document authored in memory', () => {
    const doc = Document.New();
    expect(doc.Revisions).toHaveLength(0);
    expect(doc.hasIncrementalUpdates).toBe(false);
  });

  // A recovered document's /Prev chain is exactly the structure that could not
  // be read, so an empty list says "we do not know" rather than "exactly one" --
  // the same reason Save({ incremental: true }) refuses a recovered document.
  it('reports no revisions for a document opened by recovery', () => {
    const damaged = readFileSync('test/fixtures/corrupt/gs-x3-startxref-past-eof.pdf');
    const doc = Document.Open(new Uint8Array(damaged));
    expect(doc.recovery).toBeDefined();
    expect(doc.Revisions).toHaveLength(0);
    expect(doc.hasIncrementalUpdates).toBe(false);
  });

  // The anchor: the first revision's boundary is derived here from the /Prev
  // chain, and by the signer from the /ByteRange it wrote. Two independent
  // derivations of the same byte offset must agree.
  it('agrees with a signature /ByteRange about where the first revision ends', async () => {
    const signing = Document.Open(buildClassicPdf(2));
    await signing.Sign(signerOf(buildSigner({ type: 'rsa' })), { reason: 'first' });
    const signed = signing.Save();

    const edited = (() => {
      const d = Document.Open(signed);
      d.Pages[0].Dict.set('Rotate', 90);
      return d.Save({ incremental: true });
    })();

    const doc = Document.Open(edited);
    expect(doc.Revisions.length).toBeGreaterThanOrEqual(2);

    const sig = doc.Signatures[0];
    const [, a, b, c] = sig.byteRange!;
    expect(b + c).toBe(doc.Revisions[doc.Revisions.length - 2].length);

    // And that boundary really is the signed prefix.
    expect(edited.subarray(0, b + c).length).toBe(signed.length);
    void a; void createHash;
  });
});
