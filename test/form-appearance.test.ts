import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildFormPdf } from './helpers/build-form-pdf.js';
import { isDict, isStream, name, PdfDict, PdfObject } from '../src/types.js';
import { FF_PASSWORD } from '../src/fieldflags.js';
import { buildButtonAP } from '../src/appearance.js';
import type { ResolvedDA } from '../src/da.js';
import { buildBlankPage } from './helpers/build-blank-page.js';

const acroOf = (doc: Document) => doc.resolve(doc.catalog().get('AcroForm')) as PdfDict;

const streamText = (o: unknown) =>
  isStream(o as never) ? new TextDecoder('latin1').decode((o as { raw: Uint8Array }).raw) : '';
const apText = (doc: Document, dict: PdfDict) =>
  streamText(doc.resolve((doc.resolve(dict.get('AP')) as PdfDict).get('N')));

describe('form appearance integration', () => {
  it('setter generates /AP and does not set NeedAppearances', () => {
    const doc = Document.Open(buildFormPdf());
    const field = doc.Form.Get('name')!;
    field.Value = 'Alice';
    expect(isDict(doc.resolve(field.Dict.get('AP')))).toBe(true);
    expect(acroOf(doc).has('NeedAppearances')).toBe(false);
  });

  it('GenerateAppearances builds all and clears the global flag', () => {
    const doc = Document.Open(buildFormPdf());
    acroOf(doc).set('NeedAppearances', true);
    doc.Form.GenerateAppearances();
    expect(acroOf(doc).has('NeedAppearances')).toBe(false);
    expect(isDict(doc.resolve(doc.Form.Get('name')!.Dict.get('AP')))).toBe(true);
  });

  it('round-trips a generated appearance through Save', () => {
    const doc = Document.Open(buildFormPdf());
    doc.Form.Get('name')!.Value = 'Roundtrip';
    const re = Document.Open(doc.Save());
    const fld = re.Form.Get('name')!;
    expect(fld.Value).toBe('Roundtrip');
    expect(isDict(re.resolve(fld.Dict.get('AP')))).toBe(true);
  });

  it('round-trips compressed', () => {
    const doc = Document.Open(buildFormPdf());
    doc.Form.Get('name')!.Value = 'Zipped';
    const re = Document.Open(doc.Save({ compressed: true }));
    expect(re.Form.Get('name')!.Value).toBe('Zipped');
  });
});

describe('password field appearance', () => {
  // A bullet is U+2022 -> WinAnsi 0x95, which serializeString escapes as octal.
  const BULLET = '\\225';

  it('paints the plaintext when the Password flag is absent', () => {
    const doc = Document.Open(buildFormPdf());
    const f = doc.Form.Get('name')!;
    f.Value = 'hunter2';
    expect(apText(doc, f.Dict)).toContain('hunter2');
  });

  it('masks the value: no plaintext, one bullet per character', () => {
    const doc = Document.Open(buildFormPdf());
    doc.Form.Get('name')!.Dict.set('Ff', FF_PASSWORD);
    const f = doc.Form.Get('name')!;   // re-walk, so the flag is in effect
    f.Value = 'hunter2';
    const content = apText(doc, f.Dict);
    expect(content).not.toContain('hunter2');
    expect(content.split(BULLET).length - 1).toBe(7);
  });

  it('counts by code point, so an astral character masks as one bullet', () => {
    const doc = Document.Open(buildFormPdf());
    doc.Form.Get('name')!.Dict.set('Ff', FF_PASSWORD);
    const f = doc.Form.Get('name')!;
    f.Value = 'a\u{1F600}b';           // 3 code points, 4 UTF-16 units
    expect(apText(doc, f.Dict).split(BULLET).length - 1).toBe(3);
  });

  it('masks on the read path too, via GenerateAppearances', () => {
    const doc = Document.Open(buildFormPdf());
    const dict = doc.Form.Get('name')!.Dict;
    dict.set('Ff', FF_PASSWORD);
    doc.Form.GenerateAppearances();
    const content = apText(doc, dict);
    expect(content).not.toContain('Bob');   // the fixture's /V
    expect(content).toContain(BULLET);
  });

  it('does not bake plaintext into page content when the form is flattened', () => {
    const doc = Document.Open(buildFormPdf());
    doc.Form.Get('name')!.Dict.set('Ff', FF_PASSWORD);
    doc.FlattenForm();
    const page = doc.Pages[0];
    const xo = doc.resolve((doc.resolve(page.Dict.get('Resources')) as PdfDict).get('XObject'));
    const bodies = isDict(xo)
      ? [...(xo as PdfDict).values()].map((v) => streamText(doc.resolve(v)))
      : [];
    const all = bodies.join('\n') + streamText(doc.resolve(page.Dict.get('Contents')));
    expect(all).not.toContain('Bob');
  });
});

describe('buildButtonAP', () => {
  // The /DA these widgets would resolve to: Helvetica, auto-size, black.
  const da: ResolvedDA =
    { fontName: 'Helv', std: 'Helvetica', size: 0, color: [0, 0, 0] };

  const widgetWithRect = (): PdfDict => new Map<string, PdfObject>([
    ['Type', name('Annot')],
    ['Subtype', name('Widget')],
    ['Rect', [10, 10, 30, 30]],
  ]);

  const states = (doc: Document, w: PdfDict) =>
    doc.resolve((doc.resolve(w.get('AP')) as PdfDict).get('N')) as PdfDict;

  it('installs exactly the named on-state and Off', () => {
    const doc = Document.Open(buildBlankPage());
    const w = widgetWithRect();
    buildButtonAP(doc, w, 'On', 'checkbox', da);
    expect([...states(doc, w).keys()].sort()).toEqual(['Off', 'On']);
  });

  it('honours the name it is given rather than defaulting to Yes', () => {
    const doc = Document.Open(buildBlankPage());
    const w = widgetWithRect();
    buildButtonAP(doc, w, 'Approved', 'checkbox', da);
    const keys = [...states(doc, w).keys()];
    expect(keys).toContain('Approved');
    expect(keys).not.toContain('Yes');
  });

  it('draws a ZapfDingbats mark on the on-state only', () => {
    const doc = Document.Open(buildBlankPage());
    const w = widgetWithRect();
    buildButtonAP(doc, w, 'On', 'checkbox', da);
    const n = states(doc, w);
    expect(streamText(doc.resolve(n.get('On')))).toContain('/ZaDb');
    expect(streamText(doc.resolve(n.get('Off')))).not.toContain('/ZaDb');
  });

  it('uses a different glyph for radio than for checkbox', () => {
    const doc = Document.Open(buildBlankPage());
    const check = widgetWithRect();
    const radio = widgetWithRect();
    buildButtonAP(doc, check, 'On', 'checkbox', da);
    buildButtonAP(doc, radio, 'On', 'radio', da);
    const body = (w: PdfDict) => streamText(doc.resolve(states(doc, w).get('On')));
    expect(body(check)).not.toBe(body(radio));
  });

  it('does nothing when the widget has no usable geometry', () => {
    const doc = Document.Open(buildBlankPage());
    const w: PdfDict = new Map<string, PdfObject>([['Type', name('Annot')]]);
    buildButtonAP(doc, w, 'On', 'checkbox', da);
    expect(w.has('AP')).toBe(false);
  });
});

describe('choice fields with distinct export and display values', () => {
  const s = (t: string): PdfObject => ({ kind: 'string', bytes: new TextEncoder().encode(t) });

  /** Give the fixture's `size` list box a paired /Opt. It is the only choice
   *  field in the fixture with a /Rect, so it is the only one that can carry
   *  an appearance at all. */
  const paired = (doc: Document, opts: { combo?: boolean; value?: PdfObject } = {}) => {
    const d = doc.Form.Get('size')!.Dict;
    d.set('Opt', [
      [s('us'), s('United States')],
      [s('gb'), s('United Kingdom')],
    ] as PdfObject);
    d.delete('I');                       // force the fallback path
    d.set('V', opts.value ?? s('gb'));
    if (opts.combo) d.set('Ff', 131072); // spec bit 18, Combo
    return d;
  };

  it('draws the display text in a combo box, not the export value', () => {
    const doc = Document.Open(buildFormPdf());
    const d = paired(doc, { combo: true });
    doc.Form.GenerateAppearances();
    const content = apText(doc, d);
    expect(content).toContain('United Kingdom');
    expect(content).not.toContain('(gb)');
  });

  it("renders an editable combo box's free text as typed", () => {
    const doc = Document.Open(buildFormPdf());
    const d = paired(doc, { combo: true, value: s('Freeform') });
    d.set('Ff', 131072 | 262144);        // Combo + Edit
    doc.Form.GenerateAppearances();
    expect(apText(doc, d)).toContain('Freeform');
  });

  it('highlights the list-box row whose export matches /V', () => {
    const doc = Document.Open(buildFormPdf());
    const d = paired(doc);
    doc.Form.GenerateAppearances();
    const content = apText(doc, d);
    expect(content.split('0.6 0.6 0.6 rg').length - 1).toBe(1);
    expect(content).toContain('United Kingdom');
  });

  it('still matches by display text, for producers that store it in /V', () => {
    const doc = Document.Open(buildFormPdf());
    const d = paired(doc, { value: s('United States') });
    doc.Form.GenerateAppearances();
    expect(apText(doc, d).split('0.6 0.6 0.6 rg').length - 1).toBe(1);
  });

  it('highlights every selected row of a multi-select list box', () => {
    const doc = Document.Open(buildFormPdf());
    const d = paired(doc, { value: [s('us'), s('gb')] as PdfObject });
    d.set('Ff', 2097152);                // spec bit 22, MultiSelect
    doc.Form.GenerateAppearances();
    expect(apText(doc, d).split('0.6 0.6 0.6 rg').length - 1).toBe(2);
  });

  it('still honours /I when present', () => {
    const doc = Document.Open(buildFormPdf());
    const d = paired(doc);
    d.set('I', [0]);                     // contradicts /V (gb) on purpose
    doc.Form.GenerateAppearances();
    expect(apText(doc, d).split('0.6 0.6 0.6 rg').length - 1).toBe(1);
  });
});
