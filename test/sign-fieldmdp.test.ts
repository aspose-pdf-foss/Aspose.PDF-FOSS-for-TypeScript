import { describe, it, expect } from 'vitest';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { buildSigner, TestSigner } from './helpers/build-signer.js';
import { Document } from '../src/document.js';
import type { FieldLock } from '../src/siglock.js';
import type { CmsSigner } from '../src/cms.js';
import { isArray, isDict, isName, isRef } from '../src/types.js';

const signerOf = (t: TestSigner): CmsSigner => ({ certificate: t.certificate, privateKey: t.privateKey });

/** A form with text fields a, b, grp.x, grp.y and an unsigned signature field
 *  Later, plus the field S carrying `lock` — then S is SIGNED, over the
 *  incremental path, so what follows is appended after the signed revision. */
async function signedWithLock(lock: FieldLock, certify = false): Promise<Uint8Array> {
  const doc = Document.Open(buildClassicPdf(1));
  const f = doc.Form;
  f.AddTextField({ page: 1, rect: [10, 10, 60, 20], name: 'a', value: 'one' });
  f.AddTextField({ page: 1, rect: [10, 30, 60, 40], name: 'b', value: 'two' });
  f.AddTextField({ page: 1, rect: [10, 50, 60, 60], name: 'grp.x', value: 'x' });
  f.AddTextField({ page: 1, rect: [70, 50, 120, 60], name: 'grp.y', value: 'y' });
  f.AddTextField({ page: 1, rect: [70, 10, 120, 20], name: 'ab', value: 'ab' });
  f.AddSignatureField({ page: 1, rect: [130, 10, 190, 40], name: 'Later' });
  f.AddSignatureField({ page: 1, rect: [130, 150, 190, 190], name: 'S', lock });
  const prepared = Document.Open(doc.Save());
  if (certify) await prepared.Certify(signerOf(buildSigner()), { fieldName: 'S', permissions: 'form-fill' });
  else await prepared.Sign(signerOf(buildSigner()), { fieldName: 'S' });
  return prepared.Save();
}

/** Append an edit setting field `name` to `value`, then verify S. */
async function afterEditing(signed: Uint8Array, name: string, value = 'changed') {
  const doc = Document.Open(signed);
  doc.Form.Get(name)!.Value = value;
  const out = doc.Save({ incremental: true });
  expect(out.subarray(0, signed.length)).toEqual(signed);
  const reports = await Document.Open(out).VerifySignatures();
  return reports.find((r) => r.name === 'S')!;
}

describe('the lock is carried into the signature (puep.4)', () => {
  it('writes an indirect /Lock on the field and reads it back', async () => {
    const doc = Document.Open(buildClassicPdf(1));
    doc.Form.AddSignatureField({ page: 1, rect: [10, 10, 60, 40], name: 'S', lock: { action: 'include', fields: ['a'] } });
    const back = Document.Open(doc.Save());
    expect(isRef(back.Form.Get('S')!.Dict.get('Lock'))).toBe(true);
    expect(back.Signatures[0].lock).toEqual({ action: 'include', fields: ['a'] });
  });

  it('a rejected lock leaves the document byte-identical', () => {
    const doc = Document.Open(buildClassicPdf(1));
    const before = doc.Save();
    expect(() => doc.Form.AddSignatureField({
      page: 1, rect: [10, 10, 60, 40], name: 'S', lock: { action: 'include', fields: [] },
    })).toThrow(RangeError);
    expect(doc.Save()).toEqual(before);
  });

  it('signing puts a FieldMDP /Reference whose /Data is the catalog', async () => {
    const out = Document.Open(await signedWithLock({ action: 'include', fields: ['a'] }));
    const sig = out.Signatures.find((s) => s.name === 'S')!;
    const refs = out.resolve(sig.valueDict.get('Reference'));
    expect(isArray(refs)).toBe(true);
    const r = out.resolve((refs as unknown[])[0] as never);
    expect(isDict(r)).toBe(true);
    const tm = (r as Map<string, unknown>).get('TransformMethod');
    expect(isName(tm as never) && (tm as { name: string }).name).toBe('FieldMDP');
    const data = (r as Map<string, unknown>).get('Data');
    const root = out.trailer.get('Root');
    expect(isRef(data as never) && isRef(root) && (data as { num: number }).num === root.num).toBe(true);
  });

  it('a certification carries DocMDP and FieldMDP side by side', async () => {
    const out = Document.Open(await signedWithLock({ action: 'all' }, true));
    const sig = out.Signatures.find((s) => s.name === 'S')!;
    const refs = out.resolve(sig.valueDict.get('Reference')) as unknown[];
    const methods = refs.map((x) => (out.resolve(x as never) as Map<string, { name: string }>).get('TransformMethod')!.name);
    expect(methods).toEqual(['DocMDP', 'FieldMDP']);
  });

  it('a field with no /Lock signs with no FieldMDP and reports n/a', async () => {
    const doc = Document.Open(buildClassicPdf(1));
    doc.Form.AddSignatureField({ page: 1, rect: [10, 10, 60, 40], name: 'S' });
    await doc.Sign(signerOf(buildSigner()), { fieldName: 'S' });
    const out = Document.Open(doc.Save());
    expect(out.Signatures[0].valueDict.has('Reference')).toBe(false);
    const [r] = await out.VerifySignatures();
    expect(r.fieldMDP).toBe('n/a');
    expect(r.lockedFieldsChanged).toBeUndefined();
  });
});

describe('VerifySignatures reports a change to a locked field (puep.4 acceptance)', () => {
  it('reports nothing when nothing followed the signature', async () => {
    const [r] = (await Document.Open(await signedWithLock({ action: 'all' })).VerifySignatures())
      .filter((x) => x.name === 'S');
    expect(r.fieldMDP).toBe('ok');
    expect(r.lockedFieldsChanged).toEqual([]);
  });

  it('changing a LOCKED field after signing is a violation', async () => {
    const r = await afterEditing(await signedWithLock({ action: 'include', fields: ['a'] }), 'a');
    expect(r.fieldMDP).toBe('violated');
    expect(r.lockedFieldsChanged).toEqual(['a']);
    // The signature itself still verifies: a lock violation is a separate verdict.
    expect([r.integrity, r.signature]).toEqual(['valid', 'valid']);
  });

  it('changing an UNLOCKED field is not', async () => {
    const r = await afterEditing(await signedWithLock({ action: 'include', fields: ['a'] }), 'b');
    expect(r.fieldMDP).toBe('ok');
    expect(r.lockedFieldsChanged).toEqual([]);
  });

  it('an EXCLUDE list inverts', async () => {
    const signed = await signedWithLock({ action: 'exclude', fields: ['a'] });
    expect((await afterEditing(signed, 'a')).fieldMDP).toBe('ok');
    const r = await afterEditing(signed, 'b');
    expect(r.fieldMDP).toBe('violated');
    expect(r.lockedFieldsChanged).toEqual(['b']);
  });

  it('a listed parent locks its subtree, and a name prefix locks nothing', async () => {
    expect((await afterEditing(await signedWithLock({ action: 'include', fields: ['grp'] }), 'grp.y')).fieldMDP)
      .toBe('violated');
    expect((await afterEditing(await signedWithLock({ action: 'include', fields: ['a'] }), 'ab')).fieldMDP)
      .toBe('ok');
  });

  it('removing a locked field is a violation', async () => {
    const signed = await signedWithLock({ action: 'include', fields: ['b'] });
    const doc = Document.Open(signed);
    doc.Form.RemoveField('b');
    const out = doc.Save({ incremental: true });
    expect(out.subarray(0, signed.length)).toEqual(signed);
    const r = (await Document.Open(out).VerifySignatures()).find((x) => x.name === 'S')!;
    expect(r.fieldMDP).toBe('violated');
    expect(r.lockedFieldsChanged).toEqual(['b']);
  });

  it('signing an UNSIGNED signature field under an all-lock is exempt', async () => {
    const doc = Document.Open(await signedWithLock({ action: 'all' }));
    await doc.Sign(signerOf(buildSigner()), { fieldName: 'Later' });
    const reports = await Document.Open(doc.Save()).VerifySignatures();
    const s = reports.find((x) => x.name === 'S')!;
    expect(s.fieldMDP).toBe('ok');
    expect(s.lockedFieldsChanged).toEqual([]);
    const later = reports.find((x) => x.name === 'Later')!;
    expect([later.integrity, later.signature]).toEqual(['valid', 'valid']);
  });

  it('a change to an ALREADY-SIGNED signature field is not exempt', async () => {
    // First is signed BEFORE the locking signature S, then altered after it.
    const doc = Document.Open(buildClassicPdf(1));
    doc.Form.AddSignatureField({ page: 1, rect: [10, 10, 60, 40], name: 'First' });
    doc.Form.AddSignatureField({ page: 1, rect: [10, 60, 60, 90], name: 'S', lock: { action: 'all' } });
    const a = Document.Open(doc.Save());
    await a.Sign(signerOf(buildSigner()), { fieldName: 'First' });
    const b = Document.Open(a.Save());
    await b.Sign(signerOf(buildSigner()), { fieldName: 'S' });
    const signed = b.Save();
    const c = Document.Open(signed);
    c.Form.Get('First')!.Dict.set('F', 4 | 2);   // hide the earlier signature
    const out = c.Save({ incremental: true });
    const r = (await Document.Open(out).VerifySignatures()).find((x) => x.name === 'S')!;
    expect(r.fieldMDP).toBe('violated');
    expect(r.lockedFieldsChanged).toEqual(['First']);
  });

  it('a change to a locked field\'s separate WIDGET is a violation', async () => {
    // A radio group is a parent field with kid widgets, unlike the merged
    // field/widget dict every Add*Field creates — the only shape where a widget
    // changes without its field dict changing too.
    const doc = Document.Open(buildClassicPdf(1));
    doc.Form.AddRadioGroup({
      name: 'r', options: [
        { page: 1, rect: [10, 10, 20, 20], export: 'x' }, { page: 1, rect: [30, 10, 40, 20], export: 'y' },
      ],
    });
    doc.Form.AddSignatureField({ page: 1, rect: [10, 60, 60, 90], name: 'S', lock: { action: 'include', fields: ['r'] } });
    const p = Document.Open(doc.Save());
    await p.Sign(signerOf(buildSigner()), { fieldName: 'S' });
    const signed = p.Save();
    const c = Document.Open(signed);
    c.Form.Get('r')!.Widgets[1].set('Rect', [100, 10, 110, 20]);
    const out = c.Save({ incremental: true });
    const r = (await Document.Open(out).VerifySignatures()).find((x) => x.name === 'S')!;
    expect(r.fieldMDP).toBe('violated');
    expect(r.lockedFieldsChanged).toEqual(['r']);
  });

  it('judges by the lock the SIGNATURE carries, not the field\'s later /Lock', async () => {
    const signed = await signedWithLock({ action: 'include', fields: ['a'] });
    const doc = Document.Open(signed);
    // Rewrite the field's /Lock to name b instead, then edit a: the signature
    // still froze a, and a rewritten /Lock cannot unfreeze it.
    const lock = doc.resolve(doc.Form.Get('S')!.Dict.get('Lock')) as Map<string, unknown>;
    lock.set('Fields', [{ kind: 'string', bytes: new TextEncoder().encode('b') }]);
    doc.Form.Get('a')!.Value = 'changed';
    const out = doc.Save({ incremental: true });
    const r = (await Document.Open(out).VerifySignatures()).find((x) => x.name === 'S')!;
    expect(r.fieldMDP).toBe('violated');
    expect(r.lockedFieldsChanged).toEqual(['a']);
  });

  it('an all-lock still catches a text field edit', async () => {
    const r = await afterEditing(await signedWithLock({ action: 'all' }), 'grp.x');
    expect(r.fieldMDP).toBe('violated');
    expect(r.lockedFieldsChanged).toEqual(['grp.x']);
  });
});
