import { describe, it, expect } from 'vitest';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { buildSigner, TestSigner } from './helpers/build-signer.js';
import { Document } from '../src/document.js';
import { encodeFieldLock, readFieldLock, type FieldLock } from '../src/siglock.js';
import type { CmsSigner } from '../src/cms.js';
import type { DocMdpPermission } from '../src/signature.js';
import { isArray, isDict, name, PdfDict, PdfObject } from '../src/types.js';

const signerOf = (t: TestSigner): CmsSigner => ({ certificate: t.certificate, privateKey: t.privateKey });
const ident = (o: PdfObject | undefined) => o ?? null;

/** A form with a text field `t` and a signature field `S` carrying `lock`,
 *  signed (approval) over the incremental path. */
async function signedApproval(lock: FieldLock): Promise<Uint8Array> {
  const doc = Document.Open(buildClassicPdf(1));
  doc.Form.AddTextField({ page: 1, rect: [10, 10, 60, 20], name: 't', value: 'one' });
  doc.Form.AddSignatureField({ page: 1, rect: [10, 60, 60, 90], name: 'S', lock });
  const p = Document.Open(doc.Save());
  await p.Sign(signerOf(buildSigner()), { fieldName: 'S' });
  return p.Save();
}

/** The report for S after appending `edit` incrementally. */
async function afterEdit(signed: Uint8Array, edit: (d: Document) => void) {
  const d = Document.Open(signed);
  edit(d);
  const out = d.Save({ incremental: true });
  expect(out.subarray(0, signed.length)).toEqual(signed);
  return (await Document.Open(out).VerifySignatures()).find((r) => r.name === 'S')!;
}

const levelOnly = (permissions: DocMdpPermission): FieldLock => ({ action: 'include', fields: [], permissions });

describe('/Lock /P is written and read (puep.7)', () => {
  it('round-trips a level on every action', () => {
    for (const l of [
      { action: 'all', permissions: 'no-changes' },
      { action: 'include', fields: ['a'], permissions: 'form-fill' },
      levelOnly('form-fill-and-annotate'),
    ] as FieldLock[]) expect(readFieldLock(ident, encodeFieldLock(l))).toEqual(l);
  });

  it('writes /P as 1..3', () => {
    expect(encodeFieldLock(levelOnly('no-changes')).get('P')).toBe(1);
    expect(encodeFieldLock(levelOnly('form-fill')).get('P')).toBe(2);
    expect(encodeFieldLock(levelOnly('form-fill-and-annotate')).get('P')).toBe(3);
  });

  it('refuses an empty list with no level, and an unknown level', () => {
    expect(() => encodeFieldLock({ action: 'include', fields: [] })).toThrow(RangeError);
    expect(() => encodeFieldLock({ action: 'all', permissions: 'lock-it' as DocMdpPermission })).toThrow(RangeError);
  });

  it('reads a /P outside 1..3 as no level', () => {
    const d: PdfDict = new Map<string, PdfObject>([['Action', name('All')], ['P', 4]]);
    expect(readFieldLock(ident, d)).toEqual({ action: 'all' });
  });

  it('carries the level into the FieldMDP /TransformParams, as Acrobat does', async () => {
    const out = Document.Open(await signedApproval(levelOnly('no-changes')));
    const sig = out.Signatures.find((s) => s.name === 'S')!;
    const refs = out.resolve(sig.valueDict.get('Reference'));
    expect(isArray(refs)).toBe(true);
    const r = out.resolve((refs as PdfObject[])[0]) as PdfDict;
    const tp = out.resolve(r.get('TransformParams'));
    expect(isDict(tp) && tp.get('P')).toBe(1);
  });
});

describe('an approval signature is judged against its lock level (puep.7 acceptance)', () => {
  it('a /Lock /P 1 field signed by Sign reports a later change as violated', async () => {
    const r = await afterEdit(await signedApproval(levelOnly('no-changes')), (d) => { d.Form.Get('t')!.Value = 'two'; });
    expect(r.docMDP).toBe('violated');
    expect([r.integrity, r.signature]).toEqual(['valid', 'valid']);
  });

  it('a change level 2 permits (form filling) is ok at /P 2', async () => {
    const r = await afterEdit(await signedApproval(levelOnly('form-fill')), (d) => { d.Form.Get('t')!.Value = 'two'; });
    expect(r.docMDP).toBe('ok');
  });

  it('a content change is violated even at /P 3', async () => {
    const r = await afterEdit(await signedApproval(levelOnly('form-fill-and-annotate')),
      (d) => { d.Pages[0].Dict.set('Rotate', 90); });
    expect(r.docMDP).toBe('violated');
  });

  it('a lock with no level leaves docMDP n/a', async () => {
    const r = await afterEdit(await signedApproval({ action: 'include', fields: ['t'] }),
      (d) => { d.Form.Get('t')!.Value = 'two'; });
    expect(r.docMDP).toBe('n/a');
    expect(r.fieldMDP).toBe('violated');
  });

  it('nothing after the signature is ok', async () => {
    const [r] = await Document.Open(await signedApproval(levelOnly('no-changes'))).VerifySignatures();
    expect(r.docMDP).toBe('ok');
  });

  it('reads the level from the SIGNED revision: a /Lock /P added afterwards is not applied', async () => {
    const doc = Document.Open(buildClassicPdf(1));
    doc.Form.AddTextField({ page: 1, rect: [10, 10, 60, 20], name: 't', value: 'one' });
    doc.Form.AddSignatureField({ page: 1, rect: [10, 60, 60, 90], name: 'S' });
    const base = Document.Open(doc.Save());
    await base.Sign(signerOf(buildSigner()), { fieldName: 'S' });
    const signedNoLock = base.Save();
    // Now give the field a /Lock /P 1 AFTER signing, then edit: the level was
    // not in the signed revision, so it must not be applied.
    const r1 = await afterEdit(signedNoLock, (d) => {
      d.Form.Get('S')!.Dict.set('Lock', encodeFieldLock(levelOnly('no-changes')));
      d.Form.Get('t')!.Value = 'two';
    });
    expect(r1.docMDP).toBe('n/a');
  });

  it('a level stated ONLY in the signed field\'s /Lock /P is honoured (a foreign signer)', async () => {
    // A /Lock holding /P and no /Action is not a lock our reader recognises,
    // so signing writes no FieldMDP reference and carries no level — the shape
    // of a signer that records the level on the field alone. The verdict must
    // then come from the field's /Lock /P AS SIGNED, read on its own the way
    // pyHanko reads lock_dict['/P'].
    const doc = Document.Open(buildClassicPdf(1));
    doc.Form.AddTextField({ page: 1, rect: [10, 10, 60, 20], name: 't', value: 'one' });
    doc.Form.AddSignatureField({ page: 1, rect: [10, 60, 60, 90], name: 'S' });
    const withLock = Document.Open(doc.Save());
    withLock.Form.Get('S')!.Dict.set('Lock', new Map<string, PdfObject>([['Type', name('SigFieldLock')], ['P', 1]]));
    const prepared = Document.Open(withLock.Save());
    await prepared.Sign(signerOf(buildSigner()), { fieldName: 'S' });
    const signed = prepared.Save();
    expect(Document.Open(signed).Signatures.find((s) => s.name === 'S')!.valueDict.has('Reference')).toBe(false);
    const r = await afterEdit(signed, (d) => { d.Form.Get('t')!.Value = 'two'; });
    expect(r.docMDP).toBe('violated');
  });
});

describe('Certify and a lock level (puep.7)', () => {
  it('takes the STRICTER of the field\'s level and its own', async () => {
    const doc = Document.Open(buildClassicPdf(1));
    doc.Form.AddSignatureField({ page: 1, rect: [10, 60, 60, 90], name: 'S', lock: levelOnly('no-changes') });
    const p = Document.Open(doc.Save());
    await p.Certify(signerOf(buildSigner()), { fieldName: 'S', permissions: 'form-fill-and-annotate' });
    const out = Document.Open(p.Save());
    const sig = out.Signatures[0];
    const refs = out.resolve(sig.valueDict.get('Reference')) as PdfObject[];
    const docmdp = out.resolve(refs[0]) as PdfDict;
    expect((out.resolve(docmdp.get('TransformParams')) as PdfDict).get('P')).toBe(1);
  });

  it('keeps its own level when the field\'s is looser', async () => {
    const doc = Document.Open(buildClassicPdf(1));
    doc.Form.AddSignatureField({ page: 1, rect: [10, 60, 60, 90], name: 'S', lock: levelOnly('form-fill-and-annotate') });
    const p = Document.Open(doc.Save());
    await p.Certify(signerOf(buildSigner()), { fieldName: 'S', permissions: 'form-fill' });
    const out = Document.Open(p.Save());
    const refs = out.resolve(out.Signatures[0].valueDict.get('Reference')) as PdfObject[];
    expect((out.resolve((out.resolve(refs[0]) as PdfDict).get('TransformParams')) as PdfDict).get('P')).toBe(2);
  });
});
