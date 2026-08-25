import { describe, expect, it } from 'vitest';
import { Document } from '../src/document.js';
import { buildAnnotRoundtrip } from './helpers/build-annot-roundtrip.js';
import { PdfDict, isDict, isStream } from '../src/types.js';

type Format = 'fdf' | 'xfdf';

const exportData = (doc: Document, format: Format, annotations: boolean): Uint8Array =>
  format === 'fdf'
    ? doc.ExportFdf({ annotations })
    : doc.ExportXfdf({ annotations });

const importData = (doc: Document, format: Format, bytes: Uint8Array, annotations: boolean) =>
  format === 'fdf'
    ? doc.ImportFdf(bytes, { annotations })
    : doc.ImportXfdf(bytes, { annotations });

/** The fixture with its own annotations stripped, so a test observes only what
 *  the import put there. */
function clearedTarget(): Document {
  const doc = Document.Open(buildAnnotRoundtrip());
  for (const p of doc.Pages) for (const a of p.Annotations) p.RemoveAnnotation(a);
  return doc;
}

/** The /AP /N raw bytes of an annotation, or undefined when it has none. */
function apBytes(doc: Document, dict: PdfDict): Uint8Array | undefined {
  const ap = doc.resolve(dict.get('AP'));
  if (!isDict(ap)) return undefined;
  const n = doc.resolve((ap as PdfDict).get('N'));
  return isStream(n) ? n.raw : undefined;
}

for (const format of ['fdf', 'xfdf'] as const) {
  describe(`${format} annotation round-trip`, () => {
    /** Export from a fresh fixture, import into a cleared one. */
    function roundTrip() {
      const src = Document.Open(buildAnnotRoundtrip());
      const bytes = exportData(src, format, true);
      const dst = clearedTarget();
      const report = importData(dst, format, bytes, true);
      return { src, dst, report, bytes };
    }

    it('carries every non-widget annotation to the right page', () => {
      const { dst, report } = roundTrip();
      expect(report.importedAnnots.length).toBe(4);
      expect(report.skippedAnnots).toEqual([]);
      expect(dst.Pages[0].Annotations.length).toBe(3);
      expect(dst.Pages[1].Annotations.length).toBe(1);
    });

    it('never carries the widget annotation', () => {
      const { dst } = roundTrip();
      for (const p of dst.Pages)
        for (const a of p.Annotations) expect(a.Subtype).not.toBe('Widget');
    });

    it('preserves properties on the highlight', () => {
      const { dst } = roundTrip();
      const hi = dst.Pages[0].Annotations.find((a) => a.Subtype === 'Highlight')!;
      expect(hi.Rect).toEqual([0, 0, 100, 20]);
      expect(hi.Color).toEqual([1, 1, 0]);
      expect(hi.Opacity).toBeCloseTo(0.4, 6);
      expect(hi.Contents).toBe('a reply');
    });

    it('preserves the text note author and contents', () => {
      const { dst } = roundTrip();
      const note = dst.Pages[0].Annotations.find((a) => a.Subtype === 'Text')!;
      expect(note.Contents).toBe('a note');
      expect(note.Dict.has('T')).toBe(true);
    });

    it('carries a subtype with no typed class (Sound) through unchanged', () => {
      const { dst } = roundTrip();
      const snd = dst.Pages[1].Annotations.find((a) => a.Subtype === 'Sound')!;
      expect(snd.Rect).toEqual([5, 5, 25, 25]);
      expect(snd.Name).toBe('snd-1');
    });

    it('preserves an appearance stream byte-for-byte', () => {
      const src = Document.Open(buildAnnotRoundtrip());
      // Give the square a real appearance, so there is one to preserve.
      const hi = src.Pages[0].Annotations.find((a) => a.Subtype === 'Highlight')!;
      const before = apBytes(src, hi.Dict);
      expect(before).toBeUndefined();   // the fixture ships without one

      // Regenerate one via the import path, export it, and re-import.
      const staged = clearedTarget();
      importData(staged, format, exportData(src, format, true), true);
      const stagedHi = staged.Pages[0].Annotations.find((a) => a.Subtype === 'Highlight')!;
      const generated = apBytes(staged, stagedHi.Dict);
      expect(generated).toBeDefined();

      const dst = clearedTarget();
      importData(dst, format, exportData(staged, format, true), true);
      const finalHi = dst.Pages[0].Annotations.find((a) => a.Subtype === 'Highlight')!;
      expect(apBytes(dst, finalHi.Dict)).toEqual(generated);
    });

    it('regenerates an appearance for an annotation that arrived without one', () => {
      const { dst } = roundTrip();
      const hi = dst.Pages[0].Annotations.find((a) => a.Subtype === 'Highlight')!;
      expect(apBytes(dst, hi.Dict)).toBeDefined();
    });

    it('leaves a generator-less subtype without an appearance, without failing', () => {
      const { dst, report } = roundTrip();
      const snd = dst.Pages[1].Annotations.find((a) => a.Subtype === 'Sound')!;
      expect(apBytes(dst, snd.Dict)).toBeUndefined();
      expect(report.skippedAnnots).toEqual([]);   // not reported as a skip
    });

    it('relinks the popup and the reply', () => {
      const { dst } = roundTrip();
      const note = dst.Pages[0].Annotations.find((a) => a.Subtype === 'Text')!;
      const hi = dst.Pages[0].Annotations.find((a) => a.Subtype === 'Highlight')!;
      expect(isDict(dst.resolve(note.Dict.get('Popup')))).toBe(true);
      expect(dst.resolve(hi.Dict.get('IRT'))).toBe(note.Dict);
    });

    it('is idempotent: importing twice does not duplicate', () => {
      const src = Document.Open(buildAnnotRoundtrip());
      const bytes = exportData(src, format, true);
      const dst = Document.Open(buildAnnotRoundtrip());
      importData(dst, format, bytes, true);
      const afterFirst = dst.Pages.map((p) => p.Annotations.length);
      importData(dst, format, bytes, true);
      expect(dst.Pages.map((p) => p.Annotations.length)).toEqual(afterFirst);
    });

    it('carries no annotations when the export flag is off', () => {
      const src = Document.Open(buildAnnotRoundtrip());
      const bytes = exportData(src, format, false);
      const dst = clearedTarget();
      const report = importData(dst, format, bytes, true);
      expect(report.importedAnnots).toEqual([]);
    });

    it('ignores annotations in the file when the import flag is off', () => {
      const src = Document.Open(buildAnnotRoundtrip());
      const bytes = exportData(src, format, true);
      const dst = clearedTarget();
      const report = importData(dst, format, bytes, false);
      expect(report.importedAnnots).toEqual([]);
      expect(dst.Pages[0].Annotations.length).toBe(0);
    });

    it('still carries field values alongside the annotations', () => {
      const src = Document.Open(buildAnnotRoundtrip());
      const bytes = exportData(src, format, true);
      const dst = Document.Open(buildAnnotRoundtrip());
      const report = importData(dst, format, bytes, true);
      expect(report.imported).toContain('field1');
    });

    it('reports an out-of-range page rather than throwing', () => {
      const src = Document.Open(buildAnnotRoundtrip());
      const bytes = exportData(src, format, true);
      // A one-page document cannot receive the page-1 annotation.
      const dst = Document.Open(buildAnnotRoundtrip());
      dst.RemovePage(1);
      const report = importData(dst, format, bytes, true);
      expect(report.skippedAnnots).toContainEqual(
        { page: 1, subtype: 'Sound', reason: 'no such page' });
      expect(report.importedAnnots.length).toBe(3);
    });

    it('survives a Save/Open cycle', () => {
      const { dst } = roundTrip();
      const reopened = Document.Open(dst.Save());
      expect(reopened.Pages[0].Annotations.length).toBe(3);
      expect(reopened.Pages[1].Annotations.length).toBe(1);
      const note = reopened.Pages[0].Annotations.find((a) => a.Subtype === 'Text')!;
      expect(note.Contents).toBe('a note');
    });
  });
}
