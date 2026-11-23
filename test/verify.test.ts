import { describe, it, expect } from 'vitest';
import { buildClassicPdf, buildSharedFontPdf } from './helpers/build-pdf.js';
import { buildSigner, TestSigner } from './helpers/build-signer.js';
import { Document } from '../src/document.js';
import { streamOf } from '../src/pagecontent.js';
import { pdfString } from '../src/signature.js';
import { isArray, isDict, isRef, isStream, name, type PdfDict } from '../src/types.js';

function signerOf(t: TestSigner): { certificate: Uint8Array; privateKey: any } {
  return { certificate: t.certificate, privateKey: t.privateKey };
}

/** Sign a fresh document (full rewrite) and return the saved bytes. */
async function signedBytes(type: 'rsa' | 'ec' | 'ed25519' = 'rsa'): Promise<Uint8Array> {
  const doc = Document.Open(buildClassicPdf(1));
  doc.SetMetadata({ title: 'doc' }); // force full rewrite
  await doc.Sign(signerOf(buildSigner({ type, commonName: 'Acme Signer' })), { reason: 'ok' });
  return doc.Save();
}

describe('Document.VerifySignatures (V1: integrity + crypto + coverage)', () => {
  it('reports a freshly-signed document as valid and whole-file', async () => {
    const bytes = await signedBytes('rsa');
    const reports = await Document.Open(bytes).VerifySignatures();
    expect(reports.length).toBe(1);
    const r = reports[0];
    expect(r.integrity).toBe('valid');
    expect(r.signature).toBe('valid');
    expect(r.coversWholeFile).toBe(true);
    expect(r.modifications).toEqual([]);
    expect(r.unsignedContent).toEqual({ pages: [], annotations: [], widgets: [], fields: [] });
    expect(r.shadowAnalysis).toBeUndefined();
    expect(r.chain).toBe('unchecked');
    expect(r.revocation).toBe('unchecked');
    expect(r.docMDP).toBe('n/a');
    expect(r.signerCert?.subject).toContain('Acme Signer');
  });

  it('verifies ECDSA and Ed25519 signatures too', async () => {
    for (const type of ['ec', 'ed25519'] as const) {
      const reports = await Document.Open(await signedBytes(type)).VerifySignatures();
      expect(reports[0].integrity).toBe('valid');
      expect(reports[0].signature).toBe('valid');
    }
  });

  it('flags tampered content: digest fails but the CMS signature still verifies', async () => {
    const bytes = await signedBytes('rsa');
    const sig = Document.Open(bytes).Signatures[0];
    const [, a] = sig.byteRange!;
    bytes[Math.floor(a / 2)] ^= 0xff; // flip a byte inside the first signed range

    const r = (await Document.Open(bytes).VerifySignatures({ shadowAnalysis: true }))[0];
    expect(r.integrity).toBe('tampered');
    expect(r.signature).toBe('valid'); // signed attributes are intact
    expect(r.unsignedContent).toBeUndefined();
    expect(r.shadowAnalysis).toBeUndefined();
  });

  it('verifies an incrementally-signed document and preserves whole-file coverage', async () => {
    const base = buildClassicPdf(2);
    const doc = Document.Open(base); // unmodified -> incremental append
    await doc.Sign(signerOf(buildSigner()), {});
    const bytes = doc.Save();
    expect(bytes.subarray(0, base.length)).toEqual(base);

    const r = (await Document.Open(bytes).VerifySignatures())[0];
    expect(r.integrity).toBe('valid');
    expect(r.coversWholeFile).toBe(true);
    expect(r.modifications).toEqual([]);
  });

  it('reports post-signing changes for an earlier signature in a doubly-signed file', async () => {
    // First signature (incremental append).
    const first = Document.Open(buildClassicPdf(1));
    await first.Sign(signerOf(buildSigner({ commonName: 'First' })), {});
    const once = first.Save();

    // Second signature: open the signed file (has a prior sig) -> incremental append.
    const second = Document.Open(once);
    await second.Sign(signerOf(buildSigner({ commonName: 'Second' })), {});
    const twice = second.Save();

    const reports = await Document.Open(twice).VerifySignatures({ shadowAnalysis: true });
    expect(reports.length).toBe(2);
    const earliest = reports.reduce((m, r) => (r.coversWholeFile ? m : r));
    const latest = reports.find((r) => r.coversWholeFile)!;

    // Both signatures verify cryptographically.
    for (const r of reports) {
      expect(r.integrity).toBe('valid');
      expect(r.signature).toBe('valid');
    }
    // The earlier signature does NOT cover the appended second revision, and the
    // change report lists the objects added after it.
    expect(earliest.coversWholeFile).toBe(false);
    expect(earliest.modifications.length).toBeGreaterThan(0);
    expect(latest.coversWholeFile).toBe(true);
    expect(earliest.unsignedContent).toBeUndefined();
    expect(latest.unsignedContent).toEqual({ pages: [], annotations: [], widgets: [], fields: [] });
    expect(earliest.shadowAnalysis).toEqual({ findings: [], skippedPages: [] });
    expect(latest.shadowAnalysis).toEqual({ findings: [], skippedPages: [] });
  });

  it('attributes post-signing changes to pages, annotations, widgets, and their fields', async () => {
    const original = Document.Open(buildClassicPdf(3));
    original.Pages[1].AddTextNote({ rect: [10, 30, 20, 40], contents: 'before' });
    original.Pages[2].AddTextNote({ rect: [10, 30, 20, 40], contents: 'unchanged' });
    original.Form.AddRadioGroup({ name: 'prefs.choice', options: [
      { page: 2, rect: [10, 10, 20, 20], export: 'one' }, { page: 3, rect: [10, 10, 20, 20], export: 'two' },
    ] });
    await original.Sign(signerOf(buildSigner({ type: 'ec' })), {});

    const edit = Document.Open(original.Save());
    const contents = edit.Pages[0].Dict.get('Contents');
    if (!isRef(contents)) throw new Error('expected indirect page contents');
    edit.replaceObject(contents.num, streamOf(new TextEncoder().encode('0 0 10 10 re f')));
    const note = edit.Pages[1].Annotations.find((a) => a.Subtype === 'Text')!;
    note.Contents = 'after';
    const widget = edit.Form.Get('prefs.choice')!.Widgets[0];
    widget.set('Rect', [12, 10, 22, 20]);
    const objectOf = (dict: PdfDict) => [...edit.objectEntries()].find(([, obj]) => obj === dict)![0].num;
    const report = (await Document.Open(edit.Save({ incremental: true }))
      .VerifySignatures({ shadowAnalysis: true }))[0];

    expect(report.integrity).toBe('valid');
    expect(report.shadowAnalysis?.findings).toContainEqual({ page: 1, kind: 'replace', overlay: false });
    expect(report.unsignedContent).toEqual({
      pages: [1, 2],
      annotations: [{ page: 2, object: objectOf(note.Dict), subtype: 'Text' }],
      widgets: [{ page: 2, object: objectOf(widget), subtype: 'Widget', field: 'prefs.choice' }],
      fields: ['prefs.choice'],
    });
  });

  it('summarizes only the last signed revision, even when its field comes first', async () => {
    const original = Document.Open(buildClassicPdf(1));
    original.Form.AddSignatureField({ page: 1, rect: [10, 10, 50, 20], name: 'Latest' });
    original.Form.AddSignatureField({ page: 1, rect: [10, 30, 50, 40], name: 'Earlier' });
    const signer = signerOf(buildSigner({ type: 'ec' }));
    await original.Sign(signer, { fieldName: 'Earlier' });
    const later = Document.Open(original.Save());
    await later.Sign(signer, { fieldName: 'Latest' });
    const edit = Document.Open(later.Save());
    edit.SetMetadata({ title: 'Only metadata changed' });
    const reports = await Document.Open(edit.Save({ incremental: true })).VerifySignatures();

    expect(reports.map((report) => report.name)).toEqual(['Latest', 'Earlier']);
    expect(reports.every((report) => !report.coversWholeFile)).toBe(true);
    expect(reports[0].modifications.length).toBeGreaterThan(0);
    expect(reports[0].unsignedContent).toEqual({ pages: [], annotations: [], widgets: [], fields: [] });
    expect(reports[1].unsignedContent).toBeUndefined();
  });

  it('attributes changes in shared page resources and indirect widget appearances', async () => {
    const original = Document.Open(buildSharedFontPdf());
    original.Form.AddCheckbox({ page: 2, rect: [10, 10, 20, 20], name: 'approved' });
    original.Pages[0].AddTextNote({ rect: [30, 10, 40, 20] }).Dict.set('Contents', original.allocObject(pdfString('before')));
    await original.Sign(signerOf(buildSigner({ type: 'ec' })), {});

    const edit = Document.Open(original.Save());
    const fonts = edit.resolve(edit.Pages[0].Resources?.get('Font'));
    const font = isDict(fonts) ? edit.resolve(fonts.get('F1')) : undefined;
    if (!isDict(font)) throw new Error('expected shared font');
    font.set('BaseFont', name('Courier'));

    const widget = edit.Form.Get('approved')!.Widgets[0];
    const ap = edit.resolve(widget.get('AP'));
    const normal = isDict(ap) ? edit.resolve(ap.get('N')) : undefined;
    const off = isDict(normal) ? normal.get('Off') : undefined;
    const appearance = edit.resolve(off);
    if (!isRef(off) || !isStream(appearance)) throw new Error('expected an indirect appearance');
    const raw = new TextEncoder().encode('0 g 0 0 10 10 re f');
    const dict = new Map(appearance.dict);
    dict.delete('Filter');
    dict.delete('DecodeParms');
    dict.set('Length', raw.length);
    edit.replaceObject(off.num, { kind: 'stream', dict, raw });

    const note = edit.Pages[0].Annotations.find((a) => a.Subtype === 'Text')!;
    const noteContents = note.Dict.get('Contents');
    if (!isRef(noteContents)) throw new Error('expected indirect note contents');
    edit.replaceObject(noteContents.num, pdfString('after'));

    const object = [...edit.objectEntries()].find(([, obj]) => obj === widget)![0].num;
    const noteObject = [...edit.objectEntries()].find(([, obj]) => obj === note.Dict)![0].num;
    const [report] = await Document.Open(edit.Save({ incremental: true })).VerifySignatures();
    expect(report.modifications.map((change) => change.object)).not.toContain(object);
    expect(report.modifications.map((change) => change.object)).not.toContain(noteObject);
    expect(report.unsignedContent).toEqual({
      pages: [1, 2], annotations: [{ page: 1, object: noteObject, subtype: 'Text' }], fields: ['approved'],
      widgets: [{ page: 2, object, subtype: 'Widget', field: 'approved' }],
    });
  });

  it.each(['added', 'removed'])('reports affected pages when inherited rotation is %s', async (change) => {
    const original = Document.Open(buildClassicPdf(2));
    const own = original.Pages[1].Dict;
    own.set('MediaBox', [0, 0, 200, 200]);
    own.set('CropBox', [0, 0, 200, 200]);
    own.set('Rotate', 0);
    const originalParent = original.resolve(original.Pages[0].Dict.get('Parent'));
    if (!isDict(originalParent)) throw new Error('expected the original page-tree parent');
    if (change === 'removed') originalParent.set('Rotate', 90);
    original.SetMetadata({ title: 'Persist the authored page tree' });
    await original.Sign(signerOf(buildSigner({ type: 'ec' })), {});
    const edit = Document.Open(original.Save());
    const parent = edit.resolve(edit.Pages[0].Dict.get('Parent'));
    if (!isDict(parent)) throw new Error('expected the page-tree parent');
    if (change === 'removed') parent.delete('Rotate');
    else parent.set('Rotate', 90);
    const [report] = await Document.Open(edit.Save({ incremental: true })).VerifySignatures();
    expect(report.unsignedContent).toEqual({ pages: [1], annotations: [], widgets: [], fields: [] });
  });

  it('does not attribute a new page to siblings with unchanged inherited settings', async () => {
    const original = Document.Open(buildClassicPdf(1));
    await original.Sign(signerOf(buildSigner({ type: 'ec' })), {});
    const edit = Document.Open(original.Save());
    edit.AddPage();
    const [report] = await Document.Open(edit.Save({ incremental: true })).VerifySignatures();
    expect(report.unsignedContent).toEqual({ pages: [2], annotations: [], widgets: [], fields: [] });
  });

  it('reports a terminal field whose value changed on its parent', async () => {
    const original = Document.Open(buildClassicPdf(2));
    const field = original.Form.AddTextField({ page: 2, rect: [10, 10, 40, 20], name: 'group.value' });
    field.Dict.delete('V');
    await original.Sign(signerOf(buildSigner({ type: 'ec' })), {});
    const edit = Document.Open(original.Save());
    const parent = edit.resolve(edit.Form.Get('group.value')!.Dict.get('Parent'));
    if (!isDict(parent)) throw new Error('expected the field parent');
    parent.set('V', pdfString('inherited'));
    const [report] = await Document.Open(edit.Save({ incremental: true })).VerifySignatures();
    expect(report.unsignedContent).toEqual({ pages: [2], annotations: [], widgets: [], fields: ['group.value'] });
  });

  it.each(['options', 'selected value', 'group name'])('attributes a change to a field’s %s', async (change) => {
    const original = Document.Open(buildClassicPdf(2));
    const field = original.Form.AddListBox({
      page: 2, rect: [10, 10, 40, 40], name: 'group.choice', options: ['a', 'b'], multiSelect: true,
    });
    if (change === 'options') field.Dict.set('Opt', original.allocObject([pdfString('a'), pdfString('b')]));
    if (change === 'selected value') field.Dict.set('V', [original.allocObject(pdfString('a'))]);
    await original.Sign(signerOf(buildSigner({ type: 'ec' })), {});
    const edit = Document.Open(original.Save());
    const choice = edit.Form.Get('group.choice')!.Dict;
    if (change === 'group name') {
      const parent = edit.resolve(choice.get('Parent'));
      if (!isDict(parent)) throw new Error('expected field group');
      parent.set('T', pdfString('renamed'));
    } else {
      const selected = choice.get('V');
      const value = change === 'options' ? choice.get('Opt') : isArray(selected) ? selected[0] : undefined;
      if (!isRef(value)) throw new Error('expected an indirect field property');
      edit.replaceObject(value.num, change === 'options' ? [pdfString('a'), pdfString('c')] : pdfString('b'));
    }
    const [report] = await Document.Open(edit.Save({ incremental: true })).VerifySignatures();
    expect(report.unsignedContent).toEqual({
      pages: [2], annotations: [], widgets: [], fields: [change === 'group name' ? 'renamed.choice' : 'group.choice'],
    });
  });
});
