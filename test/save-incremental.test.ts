import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { buildEncryptedPdf } from './helpers/encrypt-pdf.js';
import { Document } from '../src/document.js';
import { diffObjects } from '../src/incrementaldelta.js';
import { PdfObject } from '../src/types.js';

/** Reach the private baseline for testing without widening the public API. */
const baselineOf = (doc: Document): Map<number, PdfObject> =>
  (doc as unknown as { baselineObjects(): Map<number, PdfObject> }).baselineObjects();
const liveOf = (doc: Document): Map<number, PdfObject> =>
  (doc as unknown as { objects: Map<number, PdfObject> }).objects;

/** The appended region: everything after the original byte image. */
const appended = (out: Uint8Array, base: Uint8Array): string =>
  new TextDecoder('latin1').decode(out.subarray(base.length));

/** The object number holding `obj` in the live map. */
const numOf = (doc: Document, obj: PdfObject): number => {
  const live = liveOf(doc);
  for (const [n, v] of live) if (v === obj) return n;
  throw new Error('object not found in the live map');
};

describe('baselineObjects', () => {
  it('matches the live map exactly for an unmodified document', () => {
    const doc = Document.Open(buildClassicPdf(2));
    const d = diffObjects(baselineOf(doc), liveOf(doc));
    expect([...d.replaced]).toEqual([]);
    expect([...d.added]).toEqual([]);
    expect([...d.freed]).toEqual([]);
  });

  it('reports exactly the object a direct Dict mutation changed', () => {
    const doc = Document.Open(buildClassicPdf(2));
    // Deliberately bypasses every markModified() site: this is the case a
    // dirty-set design cannot see.
    doc.Pages[0].Dict.set('Rotate', 90);
    const d = diffObjects(baselineOf(doc), liveOf(doc));
    expect(d.replaced.size).toBe(1);
    expect([...d.added]).toEqual([]);
    expect([...d.freed]).toEqual([]);
  });

  it('throws for a document authored in memory', () => {
    const doc = Document.New();
    expect(() => baselineOf(doc)).toThrow(/authored in memory/);
  });
});

describe('Save({ incremental: true })', () => {
  it('preserves the original bytes verbatim as a prefix', () => {
    const base = buildClassicPdf(2);
    const doc = Document.Open(base);
    doc.Pages[0].Dict.set('Rotate', 90);
    const out = doc.Save({ incremental: true });
    expect(out.length).toBeGreaterThan(base.length);
    expect(out.subarray(0, base.length)).toEqual(base);
  });

  it('appends no objects when nothing was edited', () => {
    const base = buildClassicPdf(2);
    const out = Document.Open(base).Save({ incremental: true });
    expect(appended(out, base)).not.toMatch(/\d+ \d+ obj/);
    expect(appended(out, base)).toContain('xref\n0 0\n');
  });

  it('appends exactly one object for one edit to one existing object', () => {
    const base = buildClassicPdf(2);
    const doc = Document.Open(base);
    doc.Pages[0].Dict.set('Rotate', 90);
    const text = appended(doc.Save({ incremental: true }), base);
    expect(text.match(/\d+ \d+ obj/g)).toHaveLength(1);
    expect(text).toContain('/Rotate 90');
  });

  it('catches an edit made directly through the public Dict handle', () => {
    const base = buildClassicPdf(2);
    const doc = Document.Open(base);
    // No markModified() site is involved. Under a dirty-set design this
    // produces a revision that silently omits the edit.
    doc.Pages[1].Dict.set('Rotate', 180);
    expect(appended(doc.Save({ incremental: true }), base)).toContain('/Rotate 180');
  });

  it('writes a free entry for an object deleted from the live map', () => {
    const base = buildClassicPdf(2);
    const doc = Document.Open(base);
    // RemovePage only splices /Kids and leaves the page object in the map, so
    // deletion is driven from the live map -- which is what diffObjects keys on.
    const orphan = doc.Pages[1].Dict;
    const orphanNum = numOf(doc, orphan);
    doc.RemovePage(2);
    liveOf(doc).delete(orphanNum);

    const out = doc.Save({ incremental: true });
    expect(out.subarray(0, base.length)).toEqual(base);
    expect(appended(out, base)).toMatch(/^0000000000 00001 f $/m);
  });

  // The inversion of Save's mark-sweep. RemovePage is the natural fixture: it
  // splices /Kids and leaves the page object in the map, so the object is
  // live-but-unreachable -- exactly the shape a mark-sweep drops and an
  // appended revision must keep, because the previous revision's /Kids still
  // points at it.
  it('writes a changed object that is no longer reachable from /Root', () => {
    const base = buildClassicPdf(2);
    const doc = Document.Open(base);
    const orphan = doc.Pages[1].Dict;
    const orphanNum = numOf(doc, orphan);
    doc.RemovePage(2);          // splices /Kids; the page object stays in the map
    (orphan as Map<string, PdfObject>).set('Rotate', 270); // and is still edited

    const text = appended(doc.Save({ incremental: true }), base);
    expect(text).toContain('/Rotate 270');
    expect(text).toContain(`${orphanNum} 0 obj`);
  });

  it('refuses a document authored in memory', () => {
    expect(() => Document.New().Save({ incremental: true }))
      .toThrow(/authored in memory/);
  });

  it('refuses a document that was opened by recovery', () => {
    const damaged = readFileSync('test/fixtures/corrupt/gs-x3-startxref-past-eof.pdf');
    const doc = Document.Open(new Uint8Array(damaged));
    expect(doc.recovery).toBeDefined();
    expect(() => doc.Save({ incremental: true })).toThrow(/opened by recovery/);
  });

  // This refused until 0cr3 taught the append to encrypt what it writes and to
  // carry /Encrypt into the appended trailer.
  it('now supports an encrypted document', () => {
    const { bytes } = buildEncryptedPdf(
      { cipher: 'rc4', R: 3, V: 2, length: 128 },
      { pageContents: ['BT ET'] },
    );
    const doc = Document.Open(bytes);
    doc.Pages[0].Dict.set('Rotate', 90);
    expect(() => doc.Save({ incremental: true })).not.toThrow();
  });

  it('refuses each option an append cannot honour', () => {
    const doc = Document.Open(buildClassicPdf(1));
    for (const opt of ['compressed', 'linearized'] as const)
      expect(() => doc.Save({ incremental: true, [opt]: true }))
        .toThrow(/cannot save incrementally/);
    expect(() => doc.Save({ incremental: true, streamFilter: 'ASCII85Decode' }))
      .toThrow(/cannot save incrementally/);
  });
});
