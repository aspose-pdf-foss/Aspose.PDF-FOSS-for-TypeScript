import { describe, expect, it } from 'vitest';
import { Document } from '../src/document.js';
import { appendPsPages, type PsPageOutput } from '../src/pspdf.js';
import { PsBudget } from '../src/psbudget.js';
import { LoadLimits } from '../src/loadlimits.js';
import { name, ref, type PdfDict, type PdfObject } from '../src/types.js';
import { runGraphics } from './helpers/ps-graphics.js';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { buildSigner } from './helpers/build-signer.js';

const outputs = () => runGraphics('0 0 2 2 rectfill showpage showpage').graphics.finish();
function cyclic(base: PsPageOutput): PsPageOutput {
  const cycle: PdfDict = new Map(); cycle.set('cycle', cycle);
  return { ...base, resources: new Map([['XObject', cycle]]) };
}
function unchanged(doc: Document, action: () => void, error: unknown) {
  const bytes = doc.Save(), first = doc.Pages[0], dict = first?.Dict;
  const objects = [...doc.objectEntries()], modified = doc.isModifiedInternal();
  expect(action).toThrow(error as any);
  expect(doc.Save()).toEqual(bytes);
  expect(doc.Pages[0]).toBe(first);
  expect(first?.Dict).toBe(dict);
  expect([...doc.objectEntries()]).toEqual(objects);
  expect(doc.isModifiedInternal()).toBe(modified);
}
describe('atomic PostScript page append', () => {
  it('does not leak resources or dirty a document when a later resource is cyclic', () => {
    const doc = Document.Open(buildClassicPdf(1)), pages = outputs();
    unchanged(doc, () => appendPsPages(doc, [pages[0]!, cyclic(pages[1]!)]), /cyclic/i);
  });
  it('preserves pending signed output on installation failure', async () => {
    const signer = buildSigner(), doc = Document.Open(buildClassicPdf(1));
    await doc.Sign({ certificate: signer.certificate, privateKey: signer.privateKey });
    const pages = outputs();
    unchanged(doc, () => appendPsPages(doc, [pages[0]!, cyclic(pages[1]!)]), /cyclic/i);
    const reopened = Document.Open(doc.Save());
    unchanged(reopened, () => appendPsPages(reopened, [pages[0]!, cyclic(pages[1]!)]), /cyclic/i);
  });
  it('retains existing handles, hierarchy, inherited resources and metadata on success', () => {
    const doc = Document.Open(buildClassicPdf(1)), first = doc.Pages[0]!, root = doc.resolve(doc.catalog().get('Pages')) as PdfDict;
    const kids = root.get('Kids')!, branch: PdfDict = new Map<string, PdfObject>([
      ['Type', name('Pages')], ['Kids', kids], ['Count', 1], ['MediaBox', [0, 0, 80, 90]], ['Resources', new Map()],
    ]);
    const branchRef = doc.allocObject(branch);
    root.set('Kids', [branchRef]); first.Dict.delete('MediaBox'); first.Dict.delete('Resources'); first.Dict.set('Parent', branchRef);
    doc.SetMetadata({ title: 'Existing' });
    const appended = appendPsPages(doc, outputs());
    expect(doc.Pages[0]).toBe(first);
    expect(first.MediaBox).toEqual([0, 0, 80, 90]);
    expect((root.get('Kids') as PdfObject[])[0]).toEqual(branchRef);
    expect(appended).toEqual(doc.Pages.slice(1)); expect(appended.map(p => p.Number)).toEqual([2, 3]);
    appended[0]!.Dict.set('Rotate', 90);
    const reopened = Document.Open(doc.Save());
    expect(reopened.Pages[0]!.MediaBox).toEqual([0, 0, 80, 90]);
    expect(reopened.Pages[1]!.Dict.get('Rotate')).toBe(90);
    expect(reopened.GetMetadata().title).toBe('Existing');
  });
  it.each(['maxObjects', 'maxPostScriptOperations', 'maxNestingDepth'] as const)('preflights %s before publication', limit => {
    const doc = Document.Open(buildClassicPdf(1));
    // Unreachable objects count too; their maximum number is unrelated to count.
    for (let n = 0; n < 3; n++) doc.allocObject(null);
    const allowed = limit === 'maxObjects' ? [...doc.objectEntries()].length + 1 : 1;
    doc.loadLimits = LoadLimits.defaults.with({ [limit]: allowed });
    const pages = outputs();
    const nested = pages.map(p => ({ ...p, resources: new Map([['XObject', new Map([['nested', new Map()]])]]) }));
    unchanged(doc, () => appendPsPages(doc, nested, new PsBudget(doc.loadLimits)), expect.objectContaining({ limit, allowed }));
  });
  it('refuses an inline page root without mutation but permits an empty append', () => {
    const original = Document.Open(buildClassicPdf(1));
    original.catalog().set('Pages', original.resolve(original.catalog().get('Pages')));
    const doc = Document.Open(original.Save());
    expect(appendPsPages(doc, [])).toEqual([]);
    unchanged(doc, () => appendPsPages(doc, outputs()), /indirect/);
  });
});
