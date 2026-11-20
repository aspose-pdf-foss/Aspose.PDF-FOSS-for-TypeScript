import { describe, expect, it } from 'vitest';
import { Document } from '../src/document.js';
import { buildAnnotRoundtrip } from './helpers/build-annot-roundtrip.js';
import { PdfDict, isDict, isStream } from '../src/types.js';

type Format = 'fdf' | 'xfdf';
const encode = (s: string): Uint8Array => new TextEncoder().encode(s);

function replyOnly(format: Format, page: number, name: string, parent: string): Uint8Array {
  return encode(format === 'fdf'
    ? `%FDF-1.2\n1 0 obj\n<< /FDF << /Annots [<< /Subtype /Text /Page ${page} ` +
      `/NM (${name}) /Rect [0 0 20 20] /IRT (${parent}) >>] >> >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF`
    : `<xfdf><annots><text page="${page}" name="${name}" rect="0,0,20,20" inreplyto="${parent}"/>` +
      `</annots></xfdf>`);
}

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

    it('reconnects existing replies and the popup when importing only their parent', () => {
      const src = Document.New();
      const { page } = src.AddPage();
      const update = page.AddTextNote({ rect: [10, 20, 30, 40], contents: 'updated note' });
      update.Name = 'note-1';

      const dst = Document.Open(buildAnnotRoundtrip());
      dst.Pages[0].Annotations.find((a) => a.Name === 'hi-1')!.ReplyType = 'Group';
      const originalPopup = dst.Pages[0].Annotations.find((a) => a.Name === 'popup-1')!;
      originalPopup.Dict.set('Subtype', dst.allocObject(originalPopup.Dict.get('Subtype')!));
      importData(dst, format, exportData(src, format, true), true);
      for (const doc of [dst, Document.Open(dst.Save())]) {
        const annots = doc.Pages[0].Annotations;
        const note = annots.find((a) => a.Name === 'note-1')!;
        const reply = annots.find((a) => a.Name === 'hi-1')!;
        const popup = annots.find((a) => a.Name === 'popup-1')!;
        expect(note.Contents).toBe('updated note');
        expect(reply.InReplyTo?.Dict).toBe(note.Dict);
        expect(reply.ReplyType).toBe('Group');
        expect(doc.resolve(note.Dict.get('Popup'))).toBe(popup.Dict);
        expect(doc.resolve(popup.Dict.get('Parent'))).toBe(note.Dict);
      }
    });

    it('imports a reply alone and resolves its parent on the same page', () => {
      const doc = Document.Open(buildAnnotRoundtrip());
      importData(doc, format, replyOnly(format, 0, 'incoming', 'note-1'), true);
      importData(doc, format, replyOnly(format, 1, 'incoming', 'note-1'), true);

      const note = doc.Pages[0].Annotations.find((a) => a.Name === 'note-1')!;
      const local = doc.Pages[0].Annotations.find((a) => a.Name === 'incoming')!;
      const remote = doc.Pages[1].Annotations.find((a) => a.Name === 'incoming')!;
      expect(local.InReplyTo?.Dict).toBe(note.Dict);
      expect(remote.InReplyTo).toBeUndefined();
    });

    it('omits an incoming reply link that would create a cycle with an existing reply', () => {
      const doc = Document.Open(buildAnnotRoundtrip());
      importData(doc, format, replyOnly(format, 0, 'note-1', 'hi-1'), true);

      const annots = doc.Pages[0].Annotations;
      const note = annots.find((a) => a.Name === 'note-1')!;
      const reply = annots.find((a) => a.Name === 'hi-1')!;
      expect(note.Rect).toEqual([0, 0, 20, 20]);
      expect(note.InReplyTo?.Name).toBeUndefined();
      expect(reply.InReplyTo?.Dict).toBe(note.Dict);
    });

    it('keeps an existing group primary from becoming a reply', () => {
      const doc = Document.Open(buildAnnotRoundtrip());
      const page = doc.Pages[0];
      page.Annotations.find((a) => a.Name === 'hi-1')!.ReplyType = 'Group';
      page.AddTextNote({ rect: [0, 0, 20, 20], contents: 'another note' }).Name = 'other-note';
      importData(doc, format, replyOnly(format, 0, 'note-1', 'other-note'), true);

      const note = page.Annotations.find((a) => a.Name === 'note-1')!;
      const member = page.Annotations.find((a) => a.Name === 'hi-1')!;
      expect(note.InReplyTo?.Name).toBeUndefined();
      expect(member.InReplyTo?.Dict).toBe(note.Dict);
      expect(member.ReplyType).toBe('Group');
    });

    it('reconnects an existing parent when importing only its popup', () => {
      const bytes = encode(format === 'fdf'
        ? `%FDF-1.2\n1 0 obj\n<< /FDF << /Annots [<< /Subtype /Popup /Page 0 ` +
          `/NM (popup-1) /Rect [40 20 160 90] >>] >> >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF`
        : `<xfdf><annots><popup page="0" name="popup-1" rect="40,20,160,90"/></annots></xfdf>`);
      const doc = Document.Open(buildAnnotRoundtrip());
      importData(doc, format, bytes, true);

      const note = doc.Pages[0].Annotations.find((a) => a.Name === 'note-1')!;
      const popup = doc.Pages[0].Annotations.find((a) => a.Name === 'popup-1')!;
      expect(popup.Rect).toEqual([40, 20, 160, 90]);
      expect(doc.resolve(note.Dict.get('Popup'))).toBe(popup.Dict);
      expect(doc.resolve(popup.Dict.get('Parent'))).toBe(note.Dict);
    });

    it('round-trips annotations that reuse parent, popup, and reply names across pages', () => {
      const src = Document.New();
      for (const index of [0, 1]) {
        const { page } = src.AddPage();
        const note = page.AddTextNote({ rect: [10, 20, 30, 40], contents: `note ${index}`,
          popup: { rect: [40, 20, 200, 90 + index] } });
        note.Name = 'note-1';
        page.Annotations.find((a) => a.Subtype === 'Popup')!.Name = 'popup-1';
        note.AddReply({ contents: `reply ${index}` }).Name = 'reply-1';
      }

      const dst = clearedTarget();
      importData(dst, format, exportData(src, format, true), true);
      for (const [index, page] of dst.Pages.entries()) {
        const annots = page.Annotations;
        const localNote = annots.find((a) => a.Name === 'note-1')!;
        const localPopup = annots.find((a) => a.Name === 'popup-1')!;
        const localReply = annots.find((a) => a.Name === 'reply-1')!;
        expect(annots.map((a) => a.Name).sort()).toEqual(['note-1', 'popup-1', 'reply-1']);
        expect(localNote.Contents).toBe(`note ${index}`);
        expect(localPopup.Rect).toEqual([40, 20, 200, 90 + index]);
        expect(localReply.InReplyTo?.Dict).toBe(localNote.Dict);
        expect(dst.resolve(localNote.Dict.get('Popup'))).toBe(localPopup.Dict);
        expect(dst.resolve(localPopup.Dict.get('Parent'))).toBe(localNote.Dict);
      }
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

it('imports an unnamed XFDF popup by its owner and leaves another note’s popup attached', () => {
  const doc = Document.Open(buildAnnotRoundtrip());
  const bytes = encode('<xfdf><annots><text page="0" name="other-note" rect="0,0,20,20">' +
    '<popup page="0" rect="30,20,55,90"/></text></annots></xfdf>');
  importData(doc, 'xfdf', bytes, true);
  importData(doc, 'xfdf', bytes, true);

  const reopened = Document.Open(doc.Save());
  const annots = reopened.Pages[0].Annotations;
  const note = annots.find((a) => a.Name === 'note-1')!;
  const otherNote = annots.find((a) => a.Name === 'other-note')!;
  const namedPopup = annots.find((a) => a.Name === 'popup-1')!;
  const popups = annots.filter((a) => a.Subtype === 'Popup');
  expect(popups).toHaveLength(2);
  const otherPopup = popups.find((a) => a !== namedPopup)!;
  expect(otherPopup.Rect).toEqual([30, 20, 55, 90]);
  expect(reopened.resolve(note.Dict.get('Popup')) === namedPopup.Dict).toBe(true);
  expect(reopened.resolve(namedPopup.Dict.get('Parent')) === note.Dict).toBe(true);
  expect(reopened.resolve(otherNote.Dict.get('Popup')) === otherPopup.Dict).toBe(true);
  expect(reopened.resolve(otherPopup.Dict.get('Parent')) === otherNote.Dict).toBe(true);
});
