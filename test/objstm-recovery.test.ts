import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { ref } from '../src/types.js';
import { buildClassicPdf } from './helpers/build-pdf.js';
import {
  corruptObjStmPayload, corruptObjectBody, prependBytes,
} from './helpers/damage-pdf.js';

/** Save({ compressed: true }) puts the catalog, the page-tree node and every
 *  page dict into one /ObjStm, in object order. Damaging the payload therefore
 *  costs whatever the header names after the damage point — which is what makes
 *  this the fixture for "objects before the truncation are present". */
const compressed = (pages = 12) =>
  Document.Open(buildClassicPdf(pages)).Save({ compressed: true });

/** 0.9 leaves the catalog, the page tree and the first pages intact. Below
 *  ~0.7 the damage reaches /Pages and there is no document to return. */
const damaged = () => corruptObjStmPayload(compressed(), 0.9);

describe('a damaged /ObjStm', () => {
  it('opens the document and keeps what survived the damage', () => {
    const doc = Document.Open(damaged());

    expect(doc.recovery!.reason).toBe('objstm-undecodable');
    expect(doc.Pages.length).toBeGreaterThan(0);
    // Present *and correct*: compared against the same page of the healthy
    // file, or this passes on a page recovered as an empty husk.
    expect(doc.Pages[0].GetText())
      .toBe(Document.Open(buildClassicPdf(12)).Pages[0].GetText());
  });

  it('surfaces the dropped objects rather than losing them silently', () => {
    const doc = Document.Open(damaged());
    const damage = doc.recovery!.objectStreams!;

    expect(damage.length).toBe(1);
    expect(damage[0].recovered.length).toBeGreaterThan(0);
    expect(damage[0].lost.length).toBeGreaterThan(0);
    expect(damage[0].detail).toBeTruthy();
    // Every dropped object reaches the caller-facing list too.
    for (const n of damage[0].lost) expect(doc.recovery!.lost).toContain(n);
  });

  it('resolves a reference to a dropped object as null', () => {
    // The spec rule for a reference to a non-existent object, and the defined
    // behaviour the issue asks for.
    const doc = Document.Open(damaged());
    for (const n of doc.recovery!.objectStreams![0].lost) {
      expect(doc.resolve(ref(n))).toBe(null);
    }
  });

  it('leaves an undamaged compressed file alone', () => {
    // The partial-inflate path must cost nothing on the healthy path.
    const clean = compressed();
    expect(Document.Open(clean).recovery).toBeUndefined();
    expect(Document.Open(clean).Pages.length).toBe(12);
  });

  it('still throws when a sound file has an object that will not parse', () => {
    // The exemption is narrow: it covers objects inside a damaged container and
    // nothing else. This is the assertion that catches it widening.
    expect(() => Document.Open(corruptObjectBody(buildClassicPdf(2), 3)))
      .toThrow();
  });

  it('does not throw when the sweep repaired everything it could reach', () => {
    // The exemption's real test, and the only fixture that reaches the rethrow
    // at all: stale offsets make the first pass fail (reason
    // 'object-parse-failure', so the sweep runs) while the /ObjStm is damaged
    // too. The sweep repairs every offset object, and what is left unrecovered
    // lives inside the container — where no `N G obj` header exists and the
    // sweep never had anything to find.
    //
    // Widening the rethrow to `pass.failed.size > 0 || pass.lostInObjStm.size > 0`
    // refuses this document. Every other test here passes under that mutation,
    // because their reason is 'objstm-undecodable' and the sweep is skipped.
    const both = prependBytes(
      corruptObjStmPayload(compressed(), 0.9), 'X-Junk: 1\r\n', { fixStartxref: true },
    );
    const doc = Document.Open(both);

    expect(doc.recovery!.reason).toBe('object-parse-failure');
    expect(doc.recovery!.objectStreams!.length).toBe(1);
    expect(doc.recovery!.lost.length).toBeGreaterThan(0);
    expect(doc.Pages.length).toBeGreaterThan(0);
  });

  it('throws when the damage reaches the page tree', () => {
    // Not degradable: with no /Pages there is no document to return. The
    // catalog is written first into the container, so destroying nearly the
    // whole payload is what reaches it.
    expect(() => Document.Open(corruptObjStmPayload(compressed(), 0.02)))
      .toThrow();
  });
});
