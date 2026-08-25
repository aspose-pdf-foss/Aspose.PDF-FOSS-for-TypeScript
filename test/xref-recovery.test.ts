import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PdfParseError } from '../src/errors.js';
import { buildClassicPdf, buildXrefStreamPdf } from './helpers/build-pdf.js';
import { buildBlankPage } from './helpers/build-blank-page.js';
import {
  prependBytes, corruptStartxref, destroyTrailer, destroyXrefTable,
  corruptObjectBody, appendTruncatedCopy, truncateTail,
} from './helpers/damage-pdf.js';

const enc = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

/** A hand-built PDF whose object 4 has a /Length pointing at itself. */
function selfReferentialLength(): Uint8Array {
  const objs = [
    '',
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 612 792] >>',
    '<< /Type /Page /Parent 2 0 R /Resources << >> /Contents 4 0 R >>',
    '<< /Length 4 0 R >>\nstream\n\nendstream',
  ];
  let body = '%PDF-1.7\n';
  const offsets: number[] = [0];
  for (let n = 1; n <= 4; n++) {
    offsets[n] = enc(body).length;
    body += `${n} 0 obj\n${objs[n]}\nendobj\n`;
  }
  const xrefAt = enc(body).length;
  let xref = 'xref\n0 5\n0000000000 65535 f \n';
  for (let n = 1; n <= 4; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  return enc(body + xref + `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);
}

describe('parseEntry recursion guard', () => {
  it('does not hang on a self-referential /Length', () => {
    // Must terminate. Either outcome is acceptable; hanging is not.
    try {
      Document.Open(selfReferentialLength());
    } catch (e) {
      expect(e).toBeInstanceOf(PdfParseError);
    }
  }, 5000);
});

describe('recovery: stale offsets with a readable xref', () => {
  it('opens a file whose offsets are shifted by prepended bytes', () => {
    const good = buildClassicPdf(2);
    const damaged = prependBytes(good, 'X-Junk: 1\r\n', { fixStartxref: true });
    const doc = Document.Open(damaged);
    expect(doc.Pages.length).toBe(Document.Open(good).Pages.length);
    expect(doc.Pages[0].GetText()).toBe(Document.Open(good).Pages[0].GetText());
  });

  it('reports the repair', () => {
    const damaged = prependBytes(buildClassicPdf(2), 'X-Junk: 1\r\n', { fixStartxref: true });
    const doc = Document.Open(damaged);
    expect(doc.recovery?.reason).toBe('object-parse-failure');
    expect(doc.recovery!.repaired.length).toBeGreaterThan(0);
    expect(doc.recovery!.lost).toEqual([]);
  });

  it('a healthy file never sweeps', () => {
    expect(Document.Open(buildClassicPdf(2)).recovery).toBeUndefined();
  });
});

describe('recovery: unreadable xref', () => {
  it('opens a file with a corrupted startxref, matching the original', () => {
    const good = buildClassicPdf(2);
    const doc = Document.Open(corruptStartxref(good));
    const ref = Document.Open(good);
    expect(doc.Pages.length).toBe(ref.Pages.length);
    expect(doc.Pages[0].GetText()).toBe(ref.Pages[0].GetText());
    expect(doc.recovery?.reason).toBe('startxref-unreadable');
  });

  it('recovers the trailer from the trailer keyword when the table is gone', () => {
    // The `xref` keyword is destroyed but the trailer dict survives in the file.
    const doc = Document.Open(destroyXrefTable(buildClassicPdf(2)));
    expect(doc.Pages.length).toBe(2);
    expect(doc.recovery).toBeDefined();
  });

  it('synthesizes a trailer when the keyword itself is gone (dxfk.2)', () => {
    // destroyTrailer removes the keyword, so nothing survives to recover and
    // /Root is rebuilt by finding the /Type /Catalog object.
    const doc = Document.Open(destroyTrailer(buildClassicPdf(2)));
    expect(doc.Pages.length).toBe(2);
    expect(doc.recovery!.trailer!.root).toBe(1);
  });

  it('recovers the trailer from a /Type /XRef dict when there is no trailer keyword', () => {
    const good = buildXrefStreamPdf();
    const doc = Document.Open(corruptStartxref(good));
    expect(doc.Pages.length).toBe(Document.Open(good).Pages.length);
  });
});

describe('strictness', () => {
  it('throws for a structurally sound file with one corrupted object', () => {
    // xref reads, /Root resolves, object 3 is garbage and the sweep cannot
    // repair it (the bytes are overwritten in place, so there is no good copy).
    const pdf = corruptObjectBody(buildClassicPdf(2), 3);
    expect(() => Document.Open(pdf)).toThrow(PdfParseError);
  });

  it('degrades to null for an already-damaged file', () => {
    // Damaged (startxref gone) *and* carrying an object the sweep finds but
    // cannot parse. Strictness does not apply here, so it is lost, not fatal.
    const doc = Document.Open(corruptStartxref(appendTruncatedCopy(buildClassicPdf(2), 99)));
    expect(doc.recovery!.lost).toContain(99);
    expect(doc.Pages.length).toBe(2);
  });

  it('salvages a tail-truncated file by synthesizing a trailer', () => {
    // The xref, the trailer and the tail of the file are gone; every object
    // survives, so synthesis reaches the catalog.
    const doc = Document.Open(truncateTail(buildClassicPdf(2), 40));
    expect(doc.Pages.length).toBe(2);
    expect(doc.recovery!.trailer!.root).toBe(1);
  });
});

describe('duplicate candidates', () => {
  it('falls back to the earlier good copy when the last one does not parse', () => {
    const good = buildClassicPdf(2);
    const doc = Document.Open(corruptStartxref(appendTruncatedCopy(good, 3)));
    // object 3 is a page: it must have come from the intact earlier copy
    expect(doc.Pages.length).toBe(2);
    expect(doc.recovery).toBeDefined();
  });
});

describe('merge preserves object-stream entries', () => {
  it('keeps compressed objects when a swept offset repairs the container', () => {
    const compressed = Document.Open(buildBlankPage()).Save({ compressed: true });
    const damaged = prependBytes(compressed, 'X-Junk: 1\r\n', { fixStartxref: true });
    const doc = Document.Open(damaged);
    // /Root and /Pages live inside an /ObjStm. If the merge replaced the xref
    // entries instead of overlaying them, those entries would be gone and the
    // page tree would be unreachable.
    expect(doc.Pages.length).toBe(1);
    expect(doc.recovery).toBeDefined();
  });
});

describe('signing a recovered document', () => {
  it('rejects rather than appending onto damaged bytes', async () => {
    const doc = Document.Open(corruptStartxref(buildClassicPdf(2)));
    // Sign is async, so a synchronous throw surfaces as a rejected promise.
    await expect(doc.Sign({} as never)).rejects.toThrow(/recovered/i);
  });
});

describe('saving a recovered document repairs it', () => {
  it('round-trips to a file that opens cleanly', () => {
    const doc = Document.Open(corruptStartxref(buildClassicPdf(2)));
    const reopened = Document.Open(doc.Save());
    expect(reopened.recovery).toBeUndefined();
    expect(reopened.Pages.length).toBe(2);
  });
});
