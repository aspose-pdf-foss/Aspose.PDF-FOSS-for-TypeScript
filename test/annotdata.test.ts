import { describe, expect, it } from 'vitest';
import { Document } from '../src/document.js';
import { inlineRefs, allocStreams, collectAnnots, applyAnnots, type AnnotData } from '../src/annotdata.js';
import type { ImportReport } from '../src/formdata.js';
import { buildAnnotTarget } from './helpers/build-annot-target.js';
import { buildAnnotRoundtrip } from './helpers/build-annot-roundtrip.js';
import { buildFormPdf } from './helpers/build-form-pdf.js';
import { PdfDict, PdfObject, isDict, isName, isRef, isStream, isString, name } from '../src/types.js';

/** An annotation's /NM as a string; '' when absent. */
const nmOf = (a: AnnotData): string => {
  const nm = a.dict.get('NM');
  return isString(nm) ? new TextDecoder('latin1').decode(nm.bytes) : '';
};

const byName = (as: AnnotData[], nm: string) => as.find((a) => nmOf(a) === nm);

const subtypeOf = (a: AnnotData): string => {
  const s = a.dict.get('Subtype');
  return isName(s) ? s.name : '';
};

describe('inlineRefs', () => {
  it('replaces a reference with the object it points at', () => {
    const doc = Document.Open(buildAnnotTarget());
    const inner: PdfDict = new Map<string, PdfObject>([['X', 7]]);
    const dict: PdfDict = new Map<string, PdfObject>([['Sub', doc.allocObject(inner)]]);
    const out = inlineRefs(doc, dict) as PdfDict;
    const sub = out.get('Sub');
    expect(isRef(sub)).toBe(false);
    expect(isDict(sub)).toBe(true);
    expect((sub as PdfDict).get('X')).toBe(7);
  });

  it('copies rather than aliasing, so edits do not touch the document', () => {
    const doc = Document.Open(buildAnnotTarget());
    const inner: PdfDict = new Map<string, PdfObject>([['X', 7]]);
    const dict: PdfDict = new Map<string, PdfObject>([['Sub', doc.allocObject(inner)]]);
    const out = inlineRefs(doc, dict) as PdfDict;
    (out.get('Sub') as PdfDict).set('X', 99);
    expect(inner.get('X')).toBe(7);
  });

  it('inlines through arrays and stream dictionaries', () => {
    const doc = Document.Open(buildAnnotTarget());
    const font: PdfDict = new Map<string, PdfObject>([['BaseFont', name('Helvetica')]]);
    const res: PdfDict = new Map<string, PdfObject>([['Font', doc.allocObject(font)]]);
    const stream: PdfObject = {
      kind: 'stream',
      dict: new Map<string, PdfObject>([['Resources', doc.allocObject(res)]]),
      raw: new TextEncoder().encode('q Q'),
    };
    const dict: PdfDict = new Map<string, PdfObject>([['AP', [doc.allocObject(stream)]]]);
    const out = inlineRefs(doc, dict) as PdfDict;
    const arr = out.get('AP') as PdfObject[];
    expect(isStream(arr[0])).toBe(true);
    const resOut = (arr[0] as { dict: PdfDict }).dict.get('Resources') as PdfDict;
    expect(isDict(resOut.get('Font'))).toBe(true);
  });

  it('breaks a reference cycle instead of recursing forever', () => {
    const doc = Document.Open(buildAnnotTarget());
    const a: PdfDict = new Map<string, PdfObject>();
    const ref = doc.allocObject(a);
    a.set('Self', ref);
    const out = inlineRefs(doc, a) as PdfDict;
    const self = out.get('Self') as PdfDict;
    expect(self.get('Self')).toBe(null);   // the cycle terminates in null
  });
});

describe('allocStreams', () => {
  it('replaces an inline stream with a reference to an allocated object', () => {
    const doc = Document.Open(buildAnnotTarget());
    const stream: PdfObject = {
      kind: 'stream',
      dict: new Map<string, PdfObject>(),
      raw: new TextEncoder().encode('q Q'),
    };
    const dict: PdfDict = new Map<string, PdfObject>([
      ['AP', new Map<string, PdfObject>([['N', stream]])],
    ]);
    const out = allocStreams(doc, dict) as PdfDict;
    const ap = out.get('AP') as PdfDict;
    const n = ap.get('N');
    expect(isRef(n)).toBe(true);
    expect(isStream(doc.resolve(n))).toBe(true);
  });

  it('leaves a dict with no streams unchanged in value', () => {
    const doc = Document.Open(buildAnnotTarget());
    const dict: PdfDict = new Map<string, PdfObject>([['Rect', [0, 0, 1, 1]]]);
    const out = allocStreams(doc, dict) as PdfDict;
    expect(out.get('Rect')).toEqual([0, 0, 1, 1]);
  });
});

describe('collectAnnots', () => {
  it('collects every annotation with its 0-based page index', () => {
    const doc = Document.Open(buildAnnotRoundtrip());
    const got = collectAnnots(doc);
    expect(got.map((a) => a.page).sort()).toEqual([0, 0, 0, 1]);
  });

  it('excludes widget annotations, which travel as form fields', () => {
    const doc = Document.Open(buildAnnotRoundtrip());
    for (const a of collectAnnots(doc)) expect(subtypeOf(a)).not.toBe('Widget');
  });

  it('lifts /Popup and /IRT into name references and strips the raw keys', () => {
    const doc = Document.Open(buildAnnotRoundtrip());
    const got = collectAnnots(doc);
    const note = byName(got, 'note-1')!;
    expect(note.popupName).toBe('popup-1');
    expect(note.dict.has('Popup')).toBe(false);
    const hi = byName(got, 'hi-1')!;
    expect(hi.inReplyTo).toBe('note-1');
    expect(hi.dict.has('IRT')).toBe(false);
  });

  it('strips the page and structure back-references', () => {
    const doc = Document.Open(buildAnnotRoundtrip());
    for (const a of collectAnnots(doc)) {
      expect(a.dict.has('P')).toBe(false);
      expect(a.dict.has('Parent')).toBe(false);
      expect(a.dict.has('StructParent')).toBe(false);
    }
  });

  it('mints an /NM for an annotation that has none', () => {
    const doc = Document.Open(buildAnnotTarget());   // its annots carry no /NM
    const got = collectAnnots(doc);
    expect(got.length).toBe(2);
    for (const a of got) expect(a.dict.has('NM')).toBe(true);
    expect(new Set(got.map(nmOf)).size).toBe(2);     // distinct
  });

  it('writes the minted /NM back to the live document so it is stable', () => {
    const doc = Document.Open(buildAnnotTarget());
    const first = collectAnnots(doc);
    const second = collectAnnots(doc);
    expect(first.map(nmOf)).toEqual(second.map(nmOf));
  });

  it('returns an empty list for a document with no annotations', () => {
    const doc = Document.Open(buildFormPdf());
    expect(collectAnnots(doc)).toEqual([]);
  });
});

const emptyReport = (): ImportReport =>
  ({ imported: [], skipped: [], importedAnnots: [], skippedAnnots: [] });

/** The two-page fixture with its own annotations removed, so a test observes
 *  only what was imported. buildAnnotTarget has a single page and cannot
 *  receive the page-1 annotation. */
function clearedTarget(): Document {
  const doc = Document.Open(buildAnnotRoundtrip());
  for (const p of doc.Pages) for (const a of p.Annotations) p.RemoveAnnotation(a);
  return doc;
}

/** Round-trip through the neutral model only: collect from one doc, apply to another. */
function transplant(from: Document, to: Document): ImportReport {
  const report = emptyReport();
  applyAnnots(to, collectAnnots(from), report);
  return report;
}

describe('applyAnnots', () => {
  it('reports every applied annotation with its page and subtype', () => {
    const src = Document.Open(buildAnnotRoundtrip());
    const report = transplant(src, clearedTarget());
    expect(report.importedAnnots.length).toBe(4);
    expect(report.skippedAnnots).toEqual([]);
    expect(report.importedAnnots).toContainEqual({ page: 1, subtype: 'Sound', name: 'snd-1' });
  });

  it('puts each annotation on the page index it carried', () => {
    const src = Document.Open(buildAnnotRoundtrip());
    const dst = clearedTarget();
    transplant(src, dst);
    expect(dst.Pages[1].Annotations.some((a) => a.Subtype === 'Sound')).toBe(true);
    expect(dst.Pages[0].Annotations.length).toBe(3);
  });

  it('replaces by /NM instead of duplicating, so import is idempotent', () => {
    const src = Document.Open(buildAnnotRoundtrip());
    const dst = Document.Open(buildAnnotRoundtrip());
    const data = collectAnnots(src);
    applyAnnots(dst, data, emptyReport());
    const afterFirst = dst.Pages.map((p) => p.Annotations.length);
    applyAnnots(dst, data, emptyReport());
    expect(dst.Pages.map((p) => p.Annotations.length)).toEqual(afterFirst);
  });

  it('relinks /Popup and /IRT to the grafted siblings', () => {
    const src = Document.Open(buildAnnotRoundtrip());
    const dst = clearedTarget();
    transplant(src, dst);
    const annots = dst.Pages[0].Annotations;
    const note = annots.find((a) => a.Name === 'note-1')!;
    const hi = annots.find((a) => a.Name === 'hi-1')!;
    const popup = dst.resolve(note.Dict.get('Popup'));
    expect(isDict(popup)).toBe(true);
    expect((popup as PdfDict).get('Subtype')).toEqual(name('Popup'));
    expect(dst.resolve(hi.Dict.get('IRT'))).toBe(note.Dict);
  });

  it('drops a dangling name link rather than failing the import', () => {
    const dst = Document.Open(buildAnnotTarget());
    const orphan: AnnotData = {
      page: 0,
      dict: new Map<string, PdfObject>([
        ['Type', name('Annot')], ['Subtype', name('Square')], ['Rect', [0, 0, 10, 10]],
      ]),
      inReplyTo: 'nobody',
    };
    const report = emptyReport();
    applyAnnots(dst, [orphan], report);
    expect(report.importedAnnots.length).toBe(1);
    expect(report.skippedAnnots).toEqual([]);
    const added = dst.Pages[0].Annotations.at(-1)!;
    expect(added.Dict.has('IRT')).toBe(false);
  });

  it('skips an out-of-range page index', () => {
    const dst = Document.Open(buildAnnotTarget());   // 1 page
    const far: AnnotData = {
      page: 9,
      dict: new Map<string, PdfObject>([['Subtype', name('Square')], ['Rect', [0, 0, 10, 10]]]),
    };
    const report = emptyReport();
    applyAnnots(dst, [far], report);
    expect(report.importedAnnots).toEqual([]);
    expect(report.skippedAnnots).toEqual([{ page: 9, subtype: 'Square', reason: 'no such page' }]);
  });

  it('skips a subtype outside the XFDF vocabulary', () => {
    const dst = Document.Open(buildAnnotTarget());
    const odd: AnnotData = {
      page: 0,
      dict: new Map<string, PdfObject>([['Subtype', name('Movie')], ['Rect', [0, 0, 10, 10]]]),
    };
    const report = emptyReport();
    applyAnnots(dst, [odd], report);
    expect(report.skippedAnnots).toEqual(
      [{ page: 0, subtype: 'Movie', reason: 'unsupported annotation type' }]);
  });

  it('regenerates an appearance when the data carries none', () => {
    const dst = Document.Open(buildAnnotTarget());
    const sq: AnnotData = {
      page: 0,
      dict: new Map<string, PdfObject>([
        ['Type', name('Annot')], ['Subtype', name('Square')],
        ['Rect', [0, 0, 60, 30]], ['C', [1, 0, 0]],
      ]),
    };
    applyAnnots(dst, [sq], emptyReport());
    expect(dst.Pages[0].Annotations.at(-1)!.Dict.has('AP')).toBe(true);
  });

  it('keeps an appearance that arrived with the data, without regenerating', () => {
    const dst = Document.Open(buildAnnotTarget());
    const marker = new TextEncoder().encode('q 1 0 0 rg 0 0 5 5 re f Q');
    const sq: AnnotData = {
      page: 0,
      dict: new Map<string, PdfObject>([
        ['Type', name('Annot')], ['Subtype', name('Square')], ['Rect', [0, 0, 60, 30]],
        ['AP', new Map<string, PdfObject>([['N', {
          kind: 'stream',
          dict: new Map<string, PdfObject>([['Subtype', name('Form')], ['BBox', [0, 0, 60, 30]]]),
          raw: marker,
        }]])],
      ]),
    };
    applyAnnots(dst, [sq], emptyReport());
    const added = dst.Pages[0].Annotations.at(-1)!;
    const ap = dst.resolve(added.Dict.get('AP')) as PdfDict;
    const n = dst.resolve(ap.get('N'));
    expect(isStream(n)).toBe(true);
    expect((n as { raw: Uint8Array }).raw).toEqual(marker);
  });
});
