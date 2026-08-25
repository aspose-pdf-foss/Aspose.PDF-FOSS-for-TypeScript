// Every appearance stream we generate must name only font resources it actually
// registers. The key is an implicit contract between the code that emits the
// `Tf` operator and the code that fills /Resources /Font, and those are
// different functions in different modules — so nothing but a test holds them
// together. A viewer that falls back to a default font hides the breach, which
// is how /Helv-in-an-F0-form survived in FreeText appearances (bug cu3b).
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildBlankPage } from './helpers/build-annot-target.js';
import { isDict, isStream, PdfDict, PdfStream } from '../src/types.js';
import { inflateStream } from '../src/flate.js';
import { regenerateAppearance } from '../src/annotdraw.js';

/** Every font key used by a `/<key> <size> Tf` operator in `body`. */
function fontKeysUsed(body: string): string[] {
  return [...body.matchAll(/\/([A-Za-z0-9]+)\s+[\d.]+\s+Tf/g)].map((m) => m[1]);
}

/** The font resource keys a form XObject registers. */
function fontKeysRegistered(doc: Document, ap: PdfStream): string[] {
  const res = doc.resolve(ap.dict.get('Resources'));
  if (!isDict(res)) return [];
  const fonts = doc.resolve((res as PdfDict).get('Font'));
  return isDict(fonts) ? [...(fonts as PdfDict).keys()] : [];
}

/** '<label>: body names /X, resources have [...]' for each unresolvable key in
 *  the annotation's /AP /N (or in each state of an /AS-keyed /N subdictionary). */
function mismatches(doc: Document, label: string, dict: PdfDict): string[] {
  const ap = doc.resolve(dict.get('AP'));
  if (!isDict(ap)) return [];
  const n = doc.resolve((ap as PdfDict).get('N'));

  const streams: [string, PdfStream][] = [];
  if (isStream(n)) streams.push([label, n as PdfStream]);
  else if (isDict(n)) {
    for (const [state, v] of n as PdfDict) {
      const st = doc.resolve(v);
      if (isStream(st)) streams.push([`${label} /${state}`, st as PdfStream]);
    }
  }

  const out: string[] = [];
  for (const [lbl, st] of streams) {
    const body = new TextDecoder('latin1').decode(inflateStream(st));
    const registered = fontKeysRegistered(doc, st);
    for (const used of fontKeysUsed(body)) {
      if (!registered.includes(used)) {
        out.push(`${lbl}: body names /${used}, resources have [${registered.join(', ')}]`);
      }
    }
  }
  return out;
}

describe('generated appearances name only fonts they register', () => {
  it('holds for every text-bearing annotation appearance', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const found = [
      ...mismatches(doc, 'FreeText',
        page.AddFreeText({ rect: [10, 10, 200, 60], contents: 'hello there' }).Dict),
      ...mismatches(doc, 'FreeText callout',
        page.AddFreeText({ rect: [10, 70, 200, 120], contents: 'note', callout: [5, 5, 8, 40, 10, 80] }).Dict),
      ...mismatches(doc, 'Caret /Sy /P',
        page.AddCaret({ rect: [10, 130, 30, 150], symbol: 'paragraph' }).Dict),
      ...mismatches(doc, 'Stamp name',
        page.AddStamp({ rect: [10, 160, 120, 200], name: 'Approved' }).Dict),
      ...mismatches(doc, 'Stamp text',
        page.AddStamp({ rect: [10, 210, 120, 250], text: 'DRAFT' }).Dict),
    ];
    expect(found).toEqual([]);
  });

  it('holds for every form-field appearance', () => {
    const doc = Document.Open(buildBlankPage());
    doc.Form.AddTextField({ page: 1, rect: [10, 10, 210, 40], name: 'txt', value: 'abc' });
    doc.Form.AddCheckbox({ page: 1, rect: [10, 50, 30, 70], name: 'chk' });
    doc.Form.AddRadioGroup({ name: 'rad', options: [{ page: 1, export: 'a', rect: [10, 90, 30, 110] }] });
    doc.Form.AddComboBox({ page: 1, rect: [10, 130, 210, 160], name: 'cmb', options: ['x', 'y'] });
    doc.Form.AddListBox({ page: 1, rect: [10, 170, 210, 230], name: 'lst', options: ['x', 'y'] });
    doc.Form.AddPushButton({ page: 1, rect: [10, 240, 110, 270], name: 'btn', caption: 'Go' });
    doc.Form.GenerateAppearances();

    const found = doc.Pages[0].Annotations
      .flatMap((a, i) => mismatches(doc, `field #${i}`, a.Dict));
    expect(found).toEqual([]);
  });

  it('holds for appearances regenerated from an existing dict', () => {
    // regenerateAppearance is the import path (ImportXfdf/ImportFdf with an
    // unreadable <appearance>), and builds bodies through the same helpers.
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const ft = page.AddFreeText({ rect: [10, 10, 200, 60], contents: 'regenerate me' });
    const caret = page.AddCaret({ rect: [10, 70, 30, 90], symbol: 'paragraph' });
    for (const a of [ft, caret]) a.Dict.delete('AP');

    // Re-derive both from their properties, then re-check the contract.
    expect(regenerateAppearance(doc, ft.Dict)).toBe(true);
    expect(regenerateAppearance(doc, caret.Dict)).toBe(true);

    expect([
      ...mismatches(doc, 'regenerated FreeText', ft.Dict),
      ...mismatches(doc, 'regenerated Caret', caret.Dict),
    ]).toEqual([]);
  });
});
