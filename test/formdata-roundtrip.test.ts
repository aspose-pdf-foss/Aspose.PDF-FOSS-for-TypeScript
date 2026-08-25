import { describe, expect, it } from 'vitest';
import { Document } from '../src/document.js';
import { buildFormPdf } from './helpers/build-form-pdf.js';

const open = () => Document.Open(buildFormPdf());

/** Fill every settable field, export, then import into a fresh document. */
function roundTrip(kind: 'fdf' | 'xfdf'): Document {
  const src = open();
  const form = src.Form;
  form.Get('name')!.Value = 'Ada';
  form.Get('agree')!.Value = true;
  form.Get('color')!.Value = 'Green';
  form.Get('size')!.Value = 'L';
  form.Get('tags')!.Value = ['a', 'b'];
  form.Get('parent.child')!.Value = 'kid';

  const bytes = kind === 'fdf' ? src.ExportFdf() : src.ExportXfdf();
  const dst = open();
  const report = kind === 'fdf' ? dst.ImportFdf(bytes) : dst.ImportXfdf(bytes);
  expect(report.skipped).toEqual([]);
  expect(report.imported).toHaveLength(6);
  return dst;
}

describe.each(['fdf', 'xfdf'] as const)('%s round trip', (kind) => {
  it('preserves every settable field value', () => {
    const form = roundTrip(kind).Form;
    expect(form.Get('name')!.Value).toBe('Ada');
    expect(form.Get('agree')!.Value).toBe(true);
    expect(form.Get('color')!.Value).toBe('Green');
    expect(form.Get('size')!.Value).toBe('L');
    expect(form.Get('tags')!.Value).toEqual(['a', 'b']);
    expect(form.Get('parent.child')!.Value).toBe('kid');
  });

  it('survives a save and reopen', () => {
    const reopened = Document.Open(roundTrip(kind).Save());
    expect(reopened.Form.Get('name')!.Value).toBe('Ada');
    expect(reopened.Form.Get('color')!.Value).toBe('Green');
  });

  it('generates appearances for imported fields', () => {
    const doc = roundTrip(kind);
    expect(doc.resolve(doc.Form.Get('name')!.Dict.get('AP'))).not.toBeNull();
  });

  it('ignores unknown fields gracefully', () => {
    const src = open();
    src.Form.Get('name')!.Value = 'Ada';
    const bytes = kind === 'fdf' ? src.ExportFdf() : src.ExportXfdf();

    const dst = open();
    dst.Form.Get('name')!.Dict.set('T', { kind: 'string', bytes: new TextEncoder().encode('renamed') });
    const report = kind === 'fdf' ? dst.ImportFdf(bytes) : dst.ImportXfdf(bytes);
    // The renamed field has no match and is reported; the fixture's other
    // pre-filled fields still import normally around it.
    expect(report.skipped).toEqual([{ name: 'name', reason: 'no such field' }]);
    expect(report.imported).not.toContain('name');
    expect(dst.Form.Get('renamed')!.Value).toBe('Bob'); // left untouched
  });

  it('exports only non-empty fields by default and all with includeEmpty', () => {
    const src = open();
    const lean = kind === 'fdf' ? src.ExportFdf() : src.ExportXfdf();
    const full = kind === 'fdf'
      ? src.ExportFdf({ includeEmpty: true })
      : src.ExportXfdf({ includeEmpty: true });
    expect(full.length).toBeGreaterThan(lean.length);
  });

  it('exports a well-formed empty file from a document with no form', () => {
    const doc = open();
    doc.catalog().delete('AcroForm');
    const bytes = kind === 'fdf' ? doc.ExportFdf() : doc.ExportXfdf();
    expect(bytes.length).toBeGreaterThan(0);
    // and it reads back as an empty data set rather than throwing
    const back = open();
    const report = kind === 'fdf' ? back.ImportFdf(bytes) : back.ImportXfdf(bytes);
    expect(report.imported).toEqual([]);
    expect(report.skipped).toEqual([]);
  });

  it('carries the /F reference into the import report', () => {
    const src = open();
    src.Form.Get('name')!.Value = 'Ada';
    const bytes = kind === 'fdf'
      ? src.ExportFdf({ file: 'form.pdf' })
      : src.ExportXfdf({ file: 'form.pdf' });
    const dst = open();
    const report = kind === 'fdf' ? dst.ImportFdf(bytes) : dst.ImportXfdf(bytes);
    expect(report.sourceFile).toBe('form.pdf');
  });
});
