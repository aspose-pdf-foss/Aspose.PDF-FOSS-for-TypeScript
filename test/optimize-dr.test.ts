import { describe, it, expect } from 'vitest';
import { parseContentStream } from '../src/content.js';
import { collectResourceRefs, pruneDefaultResources } from '../src/drprune.js';
import { Document } from '../src/document.js';
import { PdfDict, PdfObject, PdfRef, isDict, isStream, name } from '../src/types.js';
import {
  buildDrPdf, buildBareDrPdf, DR_TIBO_PROGRAM_BYTES, DR_IMAGE_BYTES, DrPdfOptions,
} from './helpers/build-dr-pdf.js';
import { buildBlankPage } from './helpers/build-blank-page.js';

/** Every resource reference in a content-stream fragment, sorted. */
const refs = (src: string): string[] => {
  const out = new Set<string>();
  collectResourceRefs(parseContentStream(new TextEncoder().encode(src)), out);
  return [...out].sort();
};

describe('collectResourceRefs', () => {
  it('collects one name per resource-naming operator', () => {
    expect(refs('/GS0 gs BT /Helv 9 Tf ET /Im0 Do /Sh0 sh')).toEqual(
      ['ExtGState/GS0', 'Font/Helv', 'Shading/Sh0', 'XObject/Im0'],
    );
  });

  it('ignores device colour spaces and keeps named ones', () => {
    expect(refs('/DeviceRGB cs /DeviceGray CS /CS0 cs')).toEqual(['ColorSpace/CS0']);
  });

  it('reads a pattern from the last scn operand', () => {
    expect(refs('/Pattern cs /P0 scn 1 0 0 SCN')).toEqual(['Pattern/P0']);
  });

  it('reads a marked-content property list, but not the tag', () => {
    expect(refs('/OC /MC0 BDC EMC')).toEqual(['Properties/MC0']);
  });

  it('reads an inline image colour space', () => {
    expect(refs('BI /W 1 /H 1 /BPC 8 /CS /CS0 /L 3 ID abc EI')).toEqual(['ColorSpace/CS0']);
  });

  it('is silent on a fragment that names nothing', () => {
    expect(refs('/Tx BMC EMC')).toEqual([]);
  });
});

/** The live /AcroForm /DR, or undefined once the prune has deleted it. */
function drOf(doc: Document): PdfDict | undefined {
  const acro = doc.resolve(doc.catalog().get('AcroForm'));
  if (!isDict(acro)) return undefined;
  const dr = doc.resolve(acro.get('DR'));
  return isDict(dr) ? dr : undefined;
}

/** The /DR /Font keys still present, sorted. */
function fontKeys(doc: Document): string[] {
  const dr = drOf(doc);
  const fonts = dr ? doc.resolve(dr.get('Font')) : null;
  return isDict(fonts) ? [...fonts.keys()].sort() : [];
}

const opened = (opts: DrPdfOptions = {}) => Document.Open(buildDrPdf(opts));

describe('pruneDefaultResources', () => {
  it('removes a face no /DA and no appearance names', () => {
    const doc = opened();
    const r = pruneDefaultResources(doc);
    expect(r.removed).toContain('Font/TiBo');
    expect(r.removed).toContain('Font/Shared');
    expect(r.skipped).toBeUndefined();
    expect(fontKeys(doc)).not.toContain('TiBo');
  });

  it('keeps the face the AcroForm-level /DA names', () => {
    const doc = opened();
    pruneDefaultResources(doc);
    expect(fontKeys(doc)).toContain('Helv');
  });

  it("keeps the face a field's own /DA names", () => {
    const doc = opened();
    pruneDefaultResources(doc);
    expect(fontKeys(doc)).toContain('HeBo');
  });

  it("keeps the face a kid widget's /DA names", () => {
    const doc = opened();
    pruneDefaultResources(doc);
    expect(fontKeys(doc)).toContain('TiRo');
  });

  it('keeps a face only a FreeText annotation names, and drops it otherwise', () => {
    const withNote = opened({ freeText: true });
    pruneDefaultResources(withNote);
    expect(fontKeys(withNote)).toContain('TiIt');

    const without = opened();
    expect(pruneDefaultResources(without).removed).toContain('Font/TiIt');
  });

  it('prunes categories other than /Font', () => {
    const doc = opened();
    expect(pruneDefaultResources(doc).removed).toContain('XObject/Im0');
    const dr = drOf(doc);
    expect(dr?.has('XObject')).toBe(false);
  });

  it('counts the orphaned program and the orphaned image, but not a shared program', () => {
    const doc = opened();
    const r = pruneDefaultResources(doc);
    // /Shared's program is the page font's: pruning that entry frees two dicts
    // and no stream payload.
    expect(r.bytesSaved).toBe(DR_TIBO_PROGRAM_BYTES + DR_IMAGE_BYTES);
  });

  it('leaves a program the page still reaches in the document', () => {
    const doc = opened();
    pruneDefaultResources(doc);
    const res = doc.resolve(doc.Pages[0].Dict.get('Resources')) as PdfDict;
    const fonts = doc.resolve(res.get('Font')) as PdfDict;
    const font = doc.resolve(fonts.get('F1')) as PdfDict;
    const fd = doc.resolve(font.get('FontDescriptor')) as PdfDict;
    expect(isStream(doc.resolve(fd.get('FontFile2')))).toBe(true);
  });

  it('deletes a category dict and /DR itself once the prune empties them', () => {
    const doc = Document.Open(buildBareDrPdf());
    expect(pruneDefaultResources(doc).removed).toEqual(['Font/TiBo']);
    expect(drOf(doc)).toBeUndefined();
  });

  it('keeps a face only a /Resources-free appearance names', () => {
    const doc = opened({ apNoResources: true });
    pruneDefaultResources(doc);
    expect(fontKeys(doc)).toContain('Helv2');
  });

  it('drops that face when no appearance names it', () => {
    expect(pruneDefaultResources(opened()).removed).toContain('Font/Helv2');
  });

  it('keeps an /ExtGState an appearance names but its own /Resources lacks', () => {
    const doc = opened({ apUsesExtGState: true });
    const r = pruneDefaultResources(doc);
    expect(r.removed).not.toContain('ExtGState/GS0');
    const gs = doc.resolve(drOf(doc)!.get('ExtGState'));
    expect(isDict(gs) && gs.has('GS0')).toBe(true);
  });

  it('drops an /ExtGState nothing names', () => {
    expect(pruneDefaultResources(opened()).removed).toContain('ExtGState/GS0');
  });

  it('does not charge a name the appearance resolves locally', () => {
    // /HeBo lives in the /AP's own /Resources *and* in the field /DA, so the
    // entry survives — but it must survive on the /DA, not on a name the
    // appearance already resolved for itself.
    const doc = opened();
    pruneDefaultResources(doc);
    expect(fontKeys(doc)).toContain('HeBo');
  });

  it('keeps a face named by a /DR form XObject the appearance draws', () => {
    // /DR /XObject /Im0 is unreferenced, so it goes; a *referenced* /DR stream
    // that names another /DR entry must keep it alive.
    const doc = opened({ apNoResources: true });
    const dr = drOf(doc)!;
    const xobjects = doc.resolve(dr.get('XObject')) as PdfDict;
    // A form XObject with no /Resources of its own, drawn by the appearance.
    const form = doc.allocObject({
      kind: 'stream',
      dict: new Map<string, PdfObject>([
        ['Type', name('XObject')], ['Subtype', name('Form')],
        ['BBox', [0, 0, 10, 10]],
      ]),
      raw: new TextEncoder().encode('BT /TiIt 9 Tf (x) Tj ET'),
    });
    xobjects.set('Fx0', form);

    // Make the appearance draw it, so /XObject /Fx0 is referenced.
    const field = doc.Form.Get('name')!;
    const ap = doc.resolve(field.Dict.get('AP')) as PdfDict;
    const n = doc.resolve(ap.get('N'));
    if (!isStream(n)) throw new Error('no /AP /N stream');
    doc.replaceObject((ap.get('N') as PdfRef).num, {
      kind: 'stream', dict: n.dict,
      raw: new TextEncoder().encode('/Tx BMC q /Fx0 Do BT /Helv2 9 Tf (Bob) Tj ET Q EMC'),
    });

    const r = pruneDefaultResources(doc);
    expect(r.removed).not.toContain('XObject/Fx0');
    expect(r.removed).not.toContain('Font/TiIt');
    expect(fontKeys(doc)).toContain('TiIt');
  });

  it('declines a document whose appearance cannot be read', () => {
    const doc = opened({ badAp: true });
    const before = doc.Save();
    const r = pruneDefaultResources(doc);
    expect(r.removed).toEqual([]);
    expect(r.bytesSaved).toBe(0);
    expect(r.skipped).toMatch(/appearance/);
    expect(fontKeys(doc)).toContain('TiBo');
    expect(doc.Save()).toEqual(before);
  });

  it('declines a hybrid XFA document', () => {
    const doc = opened({ xfa: true });
    const before = doc.Save();
    const r = pruneDefaultResources(doc);
    expect(r.removed).toEqual([]);
    expect(r.skipped).toMatch(/XFA/);
    expect(fontKeys(doc)).toContain('TiBo');
    expect(doc.Save()).toEqual(before);
  });

  it('leaves a document with no /DR alone', () => {
    const doc = Document.Open(buildBareDrPdf());
    pruneDefaultResources(doc);
    const again = pruneDefaultResources(doc);
    expect(again.removed).toEqual([]);
    expect(again.bytesSaved).toBe(0);
  });
});

const DR_ONLY = { fonts: false, dedup: false, compress: false } as const;

describe('Optimize({ dr })', () => {
  it('prunes by default and reports the removed keys', () => {
    const doc = opened();
    const report = doc.Optimize(DR_ONLY);
    expect(report.dr.removed).toContain('Font/TiBo');
    expect(fontKeys(doc)).not.toContain('TiBo');
  });

  it('honors the opt-out', () => {
    const doc = opened();
    const report = doc.Optimize({ ...DR_ONLY, dr: false });
    expect(report.dr.removed).toEqual([]);
    expect(fontKeys(doc)).toContain('TiBo');
  });

  it('folds its bytes into the total', () => {
    const doc = opened();
    const report = doc.Optimize(DR_ONLY);
    expect(report.dr.bytesSaved).toBe(DR_TIBO_PROGRAM_BYTES + DR_IMAGE_BYTES);
    expect(report.bytesSaved).toBe(report.dr.bytesSaved);
  });

  it('is idempotent — a second run finds nothing more', () => {
    const doc = opened();
    doc.Optimize(DR_ONLY);
    expect(doc.Optimize(DR_ONLY).dr.removed).toEqual([]);
  });

  it('does not let a later pass claim bytes for an object it orphaned', () => {
    // compress would otherwise re-deflate the orphaned /DR program and report
    // bytes for a stream Save() never writes.
    const doc = opened();
    const report = doc.Optimize({ fonts: false, dedup: false });
    expect(report.compress.bytesSaved + report.dr.bytesSaved).toBe(report.bytesSaved);
    expect(Document.Open(doc.Save()).Pages.length).toBe(1);
  });

  it('drops the face a removed field had registered', () => {
    const doc = Document.Open(buildBlankPage());
    doc.Form.AddTextField({ page: 1, rect: [10, 10, 210, 40], name: 'keep' });
    doc.Form.AddTextField({ page: 1, rect: [10, 50, 210, 80], name: 'gone', font: 'Times-Bold' });
    expect(doc.Form.RemoveField('gone')).toBe(true);

    const report = doc.Optimize(DR_ONLY);
    expect(report.dr.removed).toEqual(['Font/TiBo']);
    // /Helv stays: the first created field's face became the AcroForm /DA.
    expect(fontKeys(doc)).toEqual(['Helv']);

    const reopened = Document.Open(doc.Save());
    expect(reopened.Form.Get('keep')).toBeDefined();
    expect(reopened.Form.Fields.length).toBe(1);
  });
});
