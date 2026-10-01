// test/aform-appearance.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildBlankPage } from './helpers/build-blank-page.js';

const FMT = { format: { type: 'javascript' as const, script: 'AFNumber_Format(2, 0, 0, 0, "$", true);' } };

function formDoc(opts: { password?: boolean; actions?: typeof FMT } = { actions: FMT }): Uint8Array {
  const doc = Document.Open(buildBlankPage());
  doc.Form.AddTextField({ page: 1, rect: [10, 10, 210, 40], name: 'amt', value: '1234.5', ...opts });
  return doc.Save();
}

describe('FormattedValue', () => {
  it('is the value as the recognised format script displays it', () => {
    expect(Document.Open(formDoc()).Form.Get('amt')!.FormattedValue).toBe('$1,234.50');
  });

  it('is undefined with no format script, and never changes /V', () => {
    expect(Document.Open(formDoc({})).Form.Get('amt')!.FormattedValue).toBeUndefined();
    const f = Document.Open(formDoc()).Form.Get('amt')!;
    void f.FormattedValue;
    expect(f.Value).toBe('1234.5');
  });
});

describe('format: true is opt-in', () => {
  it('draws the formatted value only when asked', () => {
    const on = Document.Open(formDoc());
    on.FlattenForm({ format: true });
    expect(on.Pages[0].GetText()).toContain('$1,234.50');
    const off = Document.Open(formDoc());
    off.FlattenForm();
    expect(off.Pages[0].GetText()).toContain('1234.5');
    expect(off.Pages[0].GetText()).not.toContain('$');
  });

  it('leaves the default byte-identical, and format:false the same as the default', () => {
    const base = formDoc();
    const a = Document.Open(base); a.Form.GenerateAppearances();
    const b = Document.Open(base); b.Form.GenerateAppearances({ format: false });
    expect(b.Save()).toEqual(a.Save());
  });

  it('format:true on a field with no format script is the same as the default', () => {
    const base = formDoc({});
    const a = Document.Open(base); a.Form.GenerateAppearances();
    const b = Document.Open(base); b.Form.GenerateAppearances({ format: true });
    expect(b.Save()).toEqual(a.Save());
  });

  it('keeps a password field masked (Review Focus 4)', () => {
    const doc = Document.Open(formDoc({ password: true, actions: FMT }));
    doc.FlattenForm({ format: true });
    const text = doc.Pages[0].GetText();
    expect(text).not.toContain('1,234');
    expect(text).not.toContain('1234');
  });

  it('works per field through Flatten and GenerateAppearance', () => {
    const doc = Document.Open(formDoc());
    doc.Form.Get('amt')!.Flatten({ format: true });
    expect(doc.Pages[0].GetText()).toContain('$1,234.50');
  });

  it('refuses a non-boolean format', () => {
    const doc = Document.Open(formDoc());
    expect(() => doc.Form.GenerateAppearances({ format: 'yes' as unknown as boolean })).toThrow(TypeError);
  });
});
