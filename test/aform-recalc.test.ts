// test/aform-recalc.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import type { PdfDict, PdfObject } from '../src/types.js';
import { buildBlankPage } from './helpers/build-blank-page.js';
import { buildSigner } from './helpers/build-signer.js';

const calc = (script: string) => ({ calculate: { type: 'javascript' as const, script } });

/** Point /AcroForm /CO at the named fields, in order. */
function setCO(doc: Document, names: string[]): void {
  const acro = doc.resolve(doc.catalog().get('AcroForm')) as PdfDict;
  const refs: PdfObject[] = names.map((n) => {
    const dict = doc.Form.Get(n)!.Dict;
    // objectEntries() yields [PdfRef, PdfObject]: the key is already a reference.
    for (const [ref, obj] of doc.objectEntries()) if (obj === dict) return ref;
    throw new Error(`no object for ${n}`);
  });
  acro.set('CO', refs);
}

function build(fields: { name: string; value?: string; actions?: ReturnType<typeof calc> }[], co: string[]): Document {
  const doc = Document.Open(buildBlankPage());
  fields.forEach((f, i) => doc.Form.AddTextField({ page: 1, rect: [10, 10 + i * 40, 210, 40 + i * 40], ...f }));
  setCO(doc, co);
  return doc;
}

describe('Recalculate', () => {
  it('sums in /CO order with the script Acrobat writes', () => {
    const doc = build([
      { name: 'a', value: '1.5' }, { name: 'b', value: '2' },
      { name: 'total', actions: calc('AFSimple_Calculate("SUM", new Array ("a", "b"));') },
    ], ['total']);
    const r = doc.Form.Recalculate();
    expect(r.changed).toEqual([{ field: 'total', from: '', to: '3.5' }]);
    expect(doc.Form.Get('total')!.Value).toBe('3.5');
  });

  it('runs /CO once, in order: a field listed before its input uses the stale input', () => {
    const doc = build([
      { name: 'a', value: '1' }, { name: 'b', value: '2' }, { name: 'sub', value: '0' },
      { name: 'total', actions: calc('AFSimple_Calculate("SUM", "sub")') },
    ], ['total', 'sub']);
    doc.Form.Get('sub')!.SetActions(calc('AFSimple_Calculate("SUM", "a, b")'));
    doc.Form.Recalculate();
    expect(doc.Form.Get('sub')!.Value).toBe('3');
    expect(doc.Form.Get('total')!.Value).toBe('0');
  });

  it('expands a group name and never matches a mere prefix (Review Focus 2)', () => {
    const doc = build([
      { name: 'items.x', value: '1' }, { name: 'items.y', value: '2' }, { name: 'itemsz', value: '100' },
      { name: 'a', value: '5' }, { name: 'ab', value: '50' },
      { name: 't1', actions: calc('AFSimple_Calculate("SUM", ["items"])') },
      { name: 't2', actions: calc('AFSimple_Calculate("SUM", "a,ab")') },
      { name: 't3', actions: calc('AFSimple_Calculate("SUM", "a")') },
    ], ['t1', 't2', 't3']);
    doc.Form.Recalculate();
    expect(doc.Form.Get('t1')!.Value).toBe('3');
    expect(doc.Form.Get('t2')!.Value).toBe('55');
    expect(doc.Form.Get('t3')!.Value).toBe('5');
  });

  it('leaves a custom calculate script untouched and reports it (Review Focus 3)', () => {
    const script = 'event.value = this.getField("a").value * 2;';
    const doc = build([{ name: 'a', value: '4' }, { name: 'dbl', value: '7', actions: calc(script) }], ['dbl']);
    const r = doc.Form.Recalculate();
    expect(r.unrecognised).toEqual([{ field: 'dbl', trigger: 'calculate', script }]);
    expect(r.changed).toEqual([]);
    expect(doc.Form.Get('dbl')!.Value).toBe('7');
  });

  it('reports a calculated field /CO does not list, and does not run it', () => {
    const doc = build([
      { name: 'a', value: '1' },
      { name: 'orphan', value: '9', actions: calc('AFSimple_Calculate("SUM", "a")') },
    ], []);
    const r = doc.Form.Recalculate();
    expect(r.notInOrder).toEqual(['orphan']);
    expect(doc.Form.Get('orphan')!.Value).toBe('9');
  });

  it('is a no-op on a document with no form', () => {
    const doc = Document.Open(buildBlankPage());
    expect(doc.Form.Recalculate()).toEqual({ changed: [], unrecognised: [], notInOrder: [] });
  });

  it('marks nothing modified when every total is already right (Review Focus 5)', async () => {
    const pre = build([
      { name: 'a', value: '1' }, { name: 'b', value: '2' },
      { name: 'total', value: '3', actions: calc('AFSimple_Calculate("SUM", new Array ("a", "b"));') },
    ], ['total']);
    const base = pre.Save();
    const doc = Document.Open(base);
    expect(doc.Form.Recalculate().changed).toEqual([]);
    const s = buildSigner();
    await doc.Sign({ certificate: s.certificate, privateKey: s.privateKey }, {});
    expect(doc.Save().subarray(0, base.length)).toEqual(base);
  });
});

describe('CheckValues', () => {
  it('reports each value its own recognised rule rejects', () => {
    const doc = Document.Open(buildBlankPage());
    doc.Form.AddTextField({ page: 1, rect: [10, 10, 210, 40], name: 'pct', value: '150',
      actions: { validate: { type: 'javascript', script: 'AFRange_Validate(true, 0, true, 100);' } } });
    doc.Form.AddTextField({ page: 1, rect: [10, 50, 210, 80], name: 'ok', value: '50',
      actions: { validate: { type: 'javascript', script: 'AFRange_Validate(true, 0, true, 100);' } } });
    const r = doc.Form.CheckValues();
    expect(r.rejected.map((x) => x.field)).toEqual(['pct']);
    expect(r.unrecognised).toEqual([]);
  });
});
