import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildBlankPage } from './helpers/build-blank-page.js';
import { buildFormPdf } from './helpers/build-form-pdf.js';
import { isArray, isDict, isName, isRef, isString, PdfDict, PdfObject } from '../src/types.js';
import {
  addTextField, ensureAcroForm, ensureDRFont, fieldDA, nameParts, resolvePath,
} from '../src/formcreate.js';
import {
  TextField, CheckboxField, RadioField, ChoiceField, ButtonField,
} from '../src/formfield.js';
import { makePng } from './helpers/make-png.js';
import { BUTTON_POSITIONS } from '../src/buttonap.js';
import {
  FF_READONLY, FF_REQUIRED, FF_MULTILINE, FF_PASSWORD, FF_COMB,
  FF_COMBO, FF_EDIT, FF_MULTISELECT, FF_FILESELECT, FF_RICHTEXT,
  FF_DONOTSPELLCHECK, FF_DONOTSCROLL,
} from '../src/fieldflags.js';

const blank = () => Document.Open(buildBlankPage());
const twoPages = () => {
  const doc = blank();
  doc.AddPage();            // appends a blank A4 page; see document.ts:1587
  return doc;
};
const acroOf = (d: Document) => d.resolve(d.catalog().get('AcroForm')) as PdfDict;
const drFonts = (d: Document, acro: PdfDict): PdfDict =>
  d.resolve((d.resolve(acro.get('DR')) as PdfDict).get('Font')) as PdfDict;
const baseFontOf = (d: Document, fonts: PdfDict, key: string): string | undefined => {
  const fd = d.resolve(fonts.get(key)) as PdfDict;
  const bf = d.resolve(fd.get('BaseFont'));
  return isName(bf) ? bf.name : undefined;
};

describe('ensureAcroForm', () => {
  it('creates an indirect /AcroForm with an empty /Fields when absent', () => {
    const doc = blank();
    expect(doc.catalog().has('AcroForm')).toBe(false);
    const acro = ensureAcroForm(doc);
    expect(isDict(acroOf(doc))).toBe(true);
    expect(acroOf(doc)).toBe(acro);
    expect(isArray(doc.resolve(acro.get('Fields')))).toBe(true);
  });

  it('is idempotent and reuses an existing /AcroForm', () => {
    const doc = Document.Open(buildFormPdf());
    const before = acroOf(doc);
    const fieldCount = (doc.resolve(before.get('Fields')) as unknown[]).length;
    expect(ensureAcroForm(doc)).toBe(before);
    expect(ensureAcroForm(doc)).toBe(before);
    expect((doc.resolve(acroOf(doc).get('Fields')) as unknown[]).length).toBe(fieldCount);
  });
});

describe('ensureDRFont', () => {
  it("registers Helvetica under Acrobat's conventional /Helv key", () => {
    const doc = blank();
    const acro = ensureAcroForm(doc);
    expect(ensureDRFont(doc, acro, 'Helvetica')).toBe('Helv');
    const fonts = drFonts(doc, acro);
    expect(baseFontOf(doc, fonts, 'Helv')).toBe('Helvetica');
    const fd = doc.resolve(fonts.get('Helv')) as PdfDict;
    expect(isName(doc.resolve(fd.get('Encoding')))).toBe(true);
  });

  it('reuses an existing entry for the same face instead of duplicating it', () => {
    const doc = blank();
    const acro = ensureAcroForm(doc);
    ensureDRFont(doc, acro, 'Helvetica');
    expect(ensureDRFont(doc, acro, 'Helvetica')).toBe('Helv');
    expect([...drFonts(doc, acro).keys()]).toEqual(['Helv']);
  });

  it('uses a per-face key so distinct faces never collide', () => {
    const doc = blank();
    const acro = ensureAcroForm(doc);
    expect(ensureDRFont(doc, acro, 'Helvetica')).toBe('Helv');
    expect(ensureDRFont(doc, acro, 'Helvetica-Bold')).toBe('HeBo');
    expect(ensureDRFont(doc, acro, 'Times-Roman')).toBe('TiRo');
    expect([...drFonts(doc, acro).keys()]).toEqual(['Helv', 'HeBo', 'TiRo']);
  });

  it('suffixes rather than retargeting a conventional key held by another face', () => {
    const doc = blank();
    const acro = ensureAcroForm(doc);
    // A producer bound /Helv to Courier — a real thing viewers emit.
    ensureDRFont(doc, acro, 'Courier');
    const fonts = drFonts(doc, acro);
    fonts.set('Helv', fonts.get('Cour')!);
    fonts.delete('Cour');
    expect(ensureDRFont(doc, acro, 'Helvetica')).toBe('Helv2');
    expect(baseFontOf(doc, fonts, 'Helv')).toBe('Courier');
    expect(baseFontOf(doc, fonts, 'Helv2')).toBe('Helvetica');
  });

  it('omits /Encoding for the symbolic faces, which have no WinAnsi mapping', () => {
    const doc = blank();
    const acro = ensureAcroForm(doc);
    const key = ensureDRFont(doc, acro, 'ZapfDingbats');
    expect(key).toBe('ZaDb');
    expect((doc.resolve(drFonts(doc, acro).get('ZaDb')) as PdfDict).has('Encoding')).toBe(false);
  });
});

describe('fieldDA', () => {
  it('writes the font key, size and an RGB fill colour', () => {
    expect(fieldDA('Helv', 0, [0, 0, 0])).toBe('/Helv 0 Tf 0 0 0 rg');
    expect(fieldDA('TiRo', 12, [1, 0, 0.5])).toBe('/TiRo 12 Tf 1 0 0.5 rg');
  });
});

describe('nameParts', () => {
  it('splits on dots', () => {
    expect(nameParts('a')).toEqual(['a']);
    expect(nameParts('address.city')).toEqual(['address', 'city']);
  });

  it('rejects a non-string, an empty name, and any empty part', () => {
    for (const bad of ['', '.', 'a.', '.a', 'a..b'])
      expect(() => nameParts(bad)).toThrow(TypeError);
    expect(() => nameParts(undefined as unknown as string)).toThrow(TypeError);
  });
});

describe('resolvePath', () => {
  it('places a flat name directly in /AcroForm /Fields with no parent', () => {
    const doc = blank();
    const acro = ensureAcroForm(doc);
    const p = resolvePath(doc, acro, 'applicant', true);
    expect(p.partial).toBe('applicant');
    expect(p.parent).toBeUndefined();
    expect(p.container).toBe(doc.resolve(acro.get('Fields')));
  });

  it('creates an intermediate node with /T and /Kids and a /Parent back-link', () => {
    const doc = blank();
    const acro = ensureAcroForm(doc);
    const p = resolvePath(doc, acro, 'address.city', true);
    expect(p.partial).toBe('city');
    expect(isRef(p.parent!)).toBe(true);

    const fields = doc.resolve(acro.get('Fields')) as unknown[];
    expect(fields.length).toBe(1);
    const node = doc.resolve(fields[0] as never) as PdfDict;
    const t = doc.resolve(node.get('T'));
    expect(isString(t) && new TextDecoder().decode(t.bytes)).toBe('address');
    expect(p.container).toBe(doc.resolve(node.get('Kids')));
  });

  it('reuses an existing intermediate node for a sibling', () => {
    const doc = blank();
    const acro = ensureAcroForm(doc);
    const a = resolvePath(doc, acro, 'address.city', true);
    const b = resolvePath(doc, acro, 'address.zip', true);
    expect((doc.resolve(acro.get('Fields')) as unknown[]).length).toBe(1);
    expect(b.container).toBe(a.container);
    expect(b.parent).toEqual(a.parent);
  });

  it('nests to arbitrary depth', () => {
    const doc = blank();
    const acro = ensureAcroForm(doc);
    const p = resolvePath(doc, acro, 'a.b.c.d', true);
    expect(p.partial).toBe('d');
    expect((doc.resolve(acro.get('Fields')) as unknown[]).length).toBe(1);
  });

  it('rejects a duplicate terminal name', () => {
    const doc = Document.Open(buildFormPdf());
    const acro = acroOf(doc);
    expect(() => resolvePath(doc, acro, 'name', false)).toThrow(RangeError);
    expect(() => resolvePath(doc, acro, 'parent.child', false)).toThrow(RangeError);
  });

  it('descends into a genuine intermediate node from an existing document', () => {
    const doc = Document.Open(buildFormPdf());
    const p = resolvePath(doc, acroOf(doc), 'parent.sibling', false);
    expect(p.partial).toBe('sibling');
  });

  it('rejects routing through an existing terminal field', () => {
    const doc = Document.Open(buildFormPdf());
    // `name` is a terminal text field, so `name.inner` has nowhere to live.
    expect(() => resolvePath(doc, acroOf(doc), 'name.inner', false))
      .toThrow(/'name' is an existing terminal field/);
  });

  it('treats a field whose /Kids are widgets as terminal', () => {
    const doc = Document.Open(buildFormPdf());
    // `color` is a radio group: /Kids holds widgets (no /T), not child fields.
    expect(() => resolvePath(doc, acroOf(doc), 'color.inner', false)).toThrow(RangeError);
  });

  it('mutates nothing on the validation pass', () => {
    const doc = blank();
    const acro = ensureAcroForm(doc);
    const before = doc.Save().length;
    resolvePath(doc, acro, 'a.b.c', false);
    expect((doc.resolve(acro.get('Fields')) as unknown[]).length).toBe(0);
    expect(doc.Save().length).toBe(before);
  });

  it('leaves no orphan node when a deep path conflicts', () => {
    const doc = Document.Open(buildFormPdf());
    const acro = acroOf(doc);
    const before = (doc.resolve(acro.get('Fields')) as unknown[]).length;
    expect(() => resolvePath(doc, acro, 'fresh.name.inner', false)).not.toThrow();
    expect(() => resolvePath(doc, acro, 'name.inner', false)).toThrow(RangeError);
    expect((doc.resolve(acro.get('Fields')) as unknown[]).length).toBe(before);
  });
});

const annotsOf = (d: Document) => d.resolve(d.Pages[0].Dict.get('Annots')) as unknown[];

describe('addTextField', () => {
  it('creates a merged field/widget dict wired into a fresh /AcroForm', () => {
    const doc = blank();
    const f = addTextField(doc, { page: 1, rect: [72, 700, 272, 722], name: 'applicant' });
    expect(f).toBeInstanceOf(TextField);
    expect(f.FullName).toBe('applicant');
    expect(f.Value).toBe('');

    const d = f.Dict;
    expect(isName(doc.resolve(d.get('Type')))).toBe(true);
    expect((doc.resolve(d.get('Subtype')) as { name: string }).name).toBe('Widget');
    expect((doc.resolve(d.get('FT')) as { name: string }).name).toBe('Tx');
    expect(doc.resolve(d.get('Rect'))).toEqual([72, 700, 272, 722]);
    expect(doc.resolve(d.get('F'))).toBe(4);
    expect(isRef(d.get('P')!)).toBe(true);
    expect((doc.resolve(acroOf(doc).get('Fields')) as unknown[]).length).toBe(1);
  });

  it('attaches the widget to the page it names, exactly once', () => {
    const doc = blank();
    const f = addTextField(doc, { page: 1, rect: [10, 10, 110, 30], name: 'a' });
    const annots = annotsOf(doc);
    expect(annots.length).toBe(1);
    expect(doc.resolve(annots[0] as never)).toBe(f.Dict);
    expect(doc.resolve(f.Dict.get('P'))).toBe(doc.Pages[0].Dict);
  });

  it('writes the initial value and generates an /AP matching the rect', () => {
    const doc = blank();
    const f = addTextField(doc, { page: 1, rect: [10, 10, 210, 40], name: 'a', value: 'Jane' });
    expect(f.Value).toBe('Jane');
    const ap = doc.resolve(f.Dict.get('AP')) as PdfDict;
    const n = doc.resolve(ap.get('N')) as { dict: PdfDict };
    expect(doc.resolve(n.dict.get('BBox'))).toEqual([0, 0, 200, 30]);
  });

  it('never sets /NeedAppearances, because the /AP is real', () => {
    const doc = blank();
    addTextField(doc, { page: 1, rect: [10, 10, 110, 30], name: 'a' });
    expect(acroOf(doc).has('NeedAppearances')).toBe(false);
  });

  it('defaults /DA to Helvetica at auto-size in black, and registers /DR', () => {
    const doc = blank();
    const f = addTextField(doc, { page: 1, rect: [10, 10, 110, 30], name: 'a' });
    const da = doc.resolve(f.Dict.get('DA')) as { bytes: Uint8Array };
    expect(new TextDecoder('latin1').decode(da.bytes)).toBe('/Helv 0 Tf 0 0 0 rg');
    expect(baseFontOf(doc, drFonts(doc, acroOf(doc)), 'Helv')).toBe('Helvetica');
  });

  it('honours font, fontSize and textColor in /DA', () => {
    const doc = blank();
    const f = addTextField(doc, {
      page: 1, rect: [10, 10, 110, 30], name: 'a',
      font: 'Times-Bold', fontSize: 11, textColor: [1, 0, 0],
    });
    const da = doc.resolve(f.Dict.get('DA')) as { bytes: Uint8Array };
    expect(new TextDecoder('latin1').decode(da.bytes)).toBe('/TiBo 11 Tf 1 0 0 rg');
  });

  it('sets the ReadOnly and Required /Ff bits, and omits /Ff when neither is asked for', () => {
    const doc = blank();
    const plain = addTextField(doc, { page: 1, rect: [10, 10, 110, 30], name: 'a' });
    expect(plain.Dict.has('Ff')).toBe(false);
    const both = addTextField(doc, {
      page: 1, rect: [10, 40, 110, 60], name: 'b', readOnly: true, required: true,
    });
    expect(doc.resolve(both.Dict.get('Ff'))).toBe(3);
  });

  it('survives a Save/Open round-trip', () => {
    const doc = blank();
    addTextField(doc, { page: 1, rect: [72, 700, 272, 722], name: 'applicant', value: 'Jane' });
    const back = Document.Open(doc.Save());
    const f = back.Form.Get('applicant')!;
    expect(f).toBeInstanceOf(TextField);
    expect(f.Value).toBe('Jane');
    expect(back.Pages[0].Annotations.length).toBe(1);
  });

  it('round-trips a hierarchical name with the right FullName', () => {
    const doc = blank();
    addTextField(doc, { page: 1, rect: [10, 10, 110, 30], name: 'address.city', value: 'Prague' });
    addTextField(doc, { page: 1, rect: [10, 40, 110, 60], name: 'address.zip', value: '11000' });
    const back = Document.Open(doc.Save());
    expect(back.Form.Fields.map((f) => f.FullName).sort())
      .toEqual(['address.city', 'address.zip']);
    expect(back.Form.Get('address.city')!.Value).toBe('Prague');
    expect((back.resolve(acroOf(back).get('Fields')) as unknown[]).length).toBe(1);
  });

  it('rejects bad arguments before touching the document', () => {
    const cases: Array<[unknown, RegExp | typeof TypeError | typeof RangeError]> = [
      [{ page: 0, rect: [0, 0, 1, 1], name: 'a' }, RangeError],
      [{ page: 2, rect: [0, 0, 1, 1], name: 'a' }, RangeError],
      [{ page: 1, rect: [0, 0, 1], name: 'a' }, TypeError],
      [{ page: 1, rect: [0, 0, 1, 1], name: '' }, TypeError],
      [{ page: 1, rect: [0, 0, 1, 1], name: 'a..b' }, TypeError],
      [{ page: 1, rect: [0, 0, 1, 1], name: 'a', fontSize: -1 }, TypeError],
      [{ page: 1, rect: [0, 0, 1, 1], name: 'a', textColor: [2, 0, 0] }, TypeError],
    ];
    for (const [init, err] of cases) {
      const doc = blank();
      const before = doc.Save().length;
      expect(() => addTextField(doc, init as never)).toThrow(err as never);
      expect(doc.catalog().has('AcroForm')).toBe(false);
      expect(doc.Save().length).toBe(before);
    }
  });

  it('rejects a duplicate name and leaves the document unchanged', () => {
    const doc = blank();
    addTextField(doc, { page: 1, rect: [10, 10, 110, 30], name: 'a' });
    const fieldsBefore = (doc.resolve(acroOf(doc).get('Fields')) as unknown[]).length;
    const bytesBefore = doc.Save().length;
    expect(() => addTextField(doc, { page: 1, rect: [10, 40, 110, 60], name: 'a' }))
      .toThrow(/already exists/);
    expect((doc.resolve(acroOf(doc).get('Fields')) as unknown[]).length).toBe(fieldsBefore);
    expect(annotsOf(doc).length).toBe(1);
    expect(doc.Save().length).toBe(bytesBefore);
  });
});

describe('Form.AddTextField', () => {
  it('refreshes Fields on the same instance, which would otherwise go stale', () => {
    const doc = blank();
    const form = doc.Form;
    expect(form.Fields.length).toBe(0);
    const f = form.AddTextField({ page: 1, rect: [10, 10, 110, 30], name: 'a' });
    expect(form.Fields.length).toBe(1);
    expect(form.Get('a')!.Dict).toBe(f.Dict);
    form.AddTextField({ page: 1, rect: [10, 40, 110, 60], name: 'b' });
    expect(form.Fields.map((x) => x.FullName)).toEqual(['a', 'b']);
  });

  it('adds to a document that already has an /AcroForm', () => {
    const doc = Document.Open(buildFormPdf());
    const form = doc.Form;
    const before = form.Fields.length;
    form.AddTextField({ page: 1, rect: [10, 300, 110, 320], name: 'extra' });
    expect(form.Fields.length).toBe(before + 1);
    expect(Document.Open(doc.Save()).Form.Get('extra')!.Value).toBe('');
  });
});

describe('Page.AddTextField', () => {
  it('produces the same structure as Form.AddTextField with an explicit page', () => {
    const viaPage = blank();
    const a = viaPage.Pages[0].AddTextField({ rect: [10, 10, 110, 30], name: 'a', value: 'x' });
    const viaForm = blank();
    const b = viaForm.Form.AddTextField({ page: 1, rect: [10, 10, 110, 30], name: 'a', value: 'x' });
    expect(a.FullName).toBe(b.FullName);
    expect(a.Value).toBe(b.Value);
    expect(doc0Rect(viaPage)).toEqual(doc0Rect(viaForm));
    expect(viaPage.Save().length).toBe(viaForm.Save().length);
  });

  it('binds the widget to the page it was called on', () => {
    const doc = Document.Open(buildFormPdf());
    const f = doc.Pages[0].AddTextField({ rect: [10, 300, 110, 320], name: 'onpage' });
    expect(doc.resolve(f.Dict.get('P'))).toBe(doc.Pages[0].Dict);
  });
});

function doc0Rect(d: Document): unknown {
  return d.resolve((d.Form.Fields[0]).Dict.get('Rect'));
}

describe('Field.ReadOnly / Field.Required', () => {
  it('reads the flags off an existing field', () => {
    const f = Document.Open(buildFormPdf()).Form.Get('name')!;
    expect(f.ReadOnly).toBe(false);
    expect(f.Required).toBe(false);
  });

  it('sets and clears each bit independently', () => {
    const doc = Document.Open(buildFormPdf());
    const f = doc.Form.Get('name')!;
    f.ReadOnly = true;
    expect(doc.resolve(f.Dict.get('Ff'))).toBe(FF_READONLY);
    f.Required = true;
    expect(doc.resolve(f.Dict.get('Ff'))).toBe(FF_READONLY | FF_REQUIRED);
    f.ReadOnly = false;
    expect(doc.resolve(f.Dict.get('Ff'))).toBe(FF_REQUIRED);
    expect(f.Required).toBe(true);
  });

  it('survives a Save/Open round-trip', () => {
    const doc = blank();
    doc.Form.AddTextField({ page: 1, rect: [10, 10, 110, 30], name: 'a' }).Required = true;
    expect(Document.Open(doc.Save()).Form.Get('a')!.Required).toBe(true);
  });

  it('keeps the cached effective flags in step with the dict', () => {
    // The trap: GenerateAppearance() reads Field.ff, not the dict. A setter that
    // writes only the dict regenerates the appearance from the *old* flags.
    const doc = blank();
    const f = doc.Form.AddTextField({
      page: 1, rect: [10, 10, 210, 40], name: 'a', value: 'secret',
    });
    f.setFlagForTest(FF_PASSWORD, true);
    f.GenerateAppearance();
    const ap = doc.resolve((doc.resolve(f.Dict.get('AP')) as PdfDict).get('N')) as { raw: Uint8Array };
    expect(new TextDecoder('latin1').decode(ap.raw)).not.toContain('secret');
  });
});

describe('TextField flag accessors', () => {
  const mk = (doc: Document) =>
    doc.Form.AddTextField({ page: 1, rect: [10, 10, 210, 60], name: 'a', value: 'x' });
  const str = (o: unknown) => new TextDecoder('latin1').decode((o as { bytes: Uint8Array }).bytes);

  it('round-trips each flag as the right /Ff bit', () => {
    const doc = blank();
    const f = mk(doc);
    expect(f.Multiline).toBe(false);
    f.Multiline = true;
    expect(doc.resolve(f.Dict.get('Ff'))).toBe(FF_MULTILINE);
    expect(f.Multiline).toBe(true);
    f.Multiline = false;
    f.Password = true;
    expect(doc.resolve(f.Dict.get('Ff'))).toBe(FF_PASSWORD);
    expect(f.Password).toBe(true);
  });

  it('reads MaxLen as 0 when absent and deletes the entry when set to 0', () => {
    const doc = blank();
    const f = mk(doc);
    expect(f.MaxLen).toBe(0);
    f.MaxLen = 12;
    expect(doc.resolve(f.Dict.get('MaxLen'))).toBe(12);
    f.MaxLen = 0;
    expect(f.Dict.has('MaxLen')).toBe(false);
    expect(f.MaxLen).toBe(0);
  });

  it('accepts Comb once MaxLen is set', () => {
    const doc = blank();
    const f = mk(doc);
    f.MaxLen = 9;
    f.Comb = true;
    expect(doc.resolve(f.Dict.get('Ff'))).toBe(FF_COMB);
  });

  it('rejects Comb without MaxLen, and leaves /Ff untouched', () => {
    const doc = blank();
    const f = mk(doc);
    expect(() => { f.Comb = true; }).toThrow(RangeError);
    expect(f.Dict.has('Ff')).toBe(false);
    expect(f.Comb).toBe(false);
  });

  it('rejects the pairs the specification forbids, from either side', () => {
    const doc = blank();
    const f = mk(doc);
    f.MaxLen = 9;
    f.Comb = true;
    expect(() => { f.Multiline = true; }).toThrow(RangeError);
    expect(() => { f.Password = true; }).toThrow(RangeError);
    expect(() => { f.MaxLen = 0; }).toThrow(RangeError);
    expect(doc.resolve(f.Dict.get('Ff'))).toBe(FF_COMB);
    expect(f.MaxLen).toBe(9);

    const g = doc.Form.AddTextField({ page: 1, rect: [10, 70, 210, 120], name: 'b' });
    g.Multiline = true;
    g.MaxLen = 9;
    expect(() => { g.Comb = true; }).toThrow(RangeError);
  });

  it('rejects a non-integer or negative MaxLen', () => {
    const doc = blank();
    const f = mk(doc);
    for (const bad of [-1, 1.5, NaN]) expect(() => { f.MaxLen = bad; }).toThrow(TypeError);
    expect(f.Dict.has('MaxLen')).toBe(false);
  });

  it('round-trips FileSelect and RichText as their /Ff bits', () => {
    const doc = blank();
    const f = mk(doc);
    expect(f.FileSelect).toBe(false);
    expect(f.RichText).toBe(false);
    f.FileSelect = true;
    expect(doc.resolve(f.Dict.get('Ff'))).toBe(FF_FILESELECT);
    f.FileSelect = false;
    f.RichText = true;
    expect(doc.resolve(f.Dict.get('Ff'))).toBe(FF_RICHTEXT);
    expect(f.RichText).toBe(true);
  });

  it('round-trips DoNotSpellCheck and DoNotScroll as their /Ff bits', () => {
    const doc = blank();
    const f = mk(doc);
    expect(f.DoNotSpellCheck).toBe(false);
    expect(f.DoNotScroll).toBe(false);
    f.DoNotSpellCheck = true;
    expect(doc.resolve(f.Dict.get('Ff'))).toBe(FF_DONOTSPELLCHECK);
    f.DoNotSpellCheck = false;
    f.DoNotScroll = true;
    expect(doc.resolve(f.Dict.get('Ff'))).toBe(FF_DONOTSCROLL);
    expect(f.DoNotScroll).toBe(true);
  });

  it('rejects Comb with FileSelect, from either side', () => {
    // Table 228: Comb is meaningful only with Multiline, Password *and*
    // FileSelect clear. FileSelect was the one the earlier pass missed.
    const doc = blank();
    const f = mk(doc);
    f.MaxLen = 9;
    f.FileSelect = true;
    expect(() => { f.Comb = true; }).toThrow(RangeError);
    expect(f.Comb).toBe(false);

    const g = doc.Form.AddTextField({ page: 1, rect: [10, 70, 210, 120], name: 'b' });
    g.MaxLen = 9;
    g.Comb = true;
    expect(() => { g.FileSelect = true; }).toThrow(RangeError);
    expect(g.FileSelect).toBe(false);
    expect(doc.resolve(g.Dict.get('Ff'))).toBe(FF_COMB);
  });

  it('round-trips /RV through RichTextValue', () => {
    const doc = blank();
    const f = mk(doc);
    expect(f.RichTextValue).toBeUndefined();
    f.RichText = true;
    f.RichTextValue = '<body><p><b>x</b></p></body>';
    expect(str(doc.resolve(f.Dict.get('RV')))).toBe('<body><p><b>x</b></p></body>');
    expect(f.RichTextValue).toBe('<body><p><b>x</b></p></body>');
    f.RichTextValue = undefined;
    expect(f.Dict.has('RV')).toBe(false);
    expect(f.RichTextValue).toBeUndefined();
  });

  it('refuses a rich text value on a field that is not rich text', () => {
    // /RV is meaningful only with the flag set (table 228), so writing one
    // without it stores a payload every viewer ignores.
    const doc = blank();
    const f = mk(doc);
    expect(() => { f.RichTextValue = '<body/>'; }).toThrow(RangeError);
    expect(f.Dict.has('RV')).toBe(false);
    expect(() => { f.RichTextValue = 7 as never; }).toThrow(TypeError);
  });

  it('reads a /RV carried as a stream', () => {
    // Acrobat writes the stream form for anything sizeable; the string form is
    // the only one we write, so this is the shape we would otherwise miss.
    const doc = blank();
    const f = mk(doc);
    f.RichText = true;
    f.Dict.set('RV', doc.allocObject({
      kind: 'stream',
      dict: new Map<string, PdfObject>(),
      raw: new TextEncoder().encode('<body><p>streamed</p></body>'),
    }));
    expect(f.RichTextValue).toBe('<body><p>streamed</p></body>');
  });

  it('leaves the plain /V alone when the rich value changes', () => {
    const doc = blank();
    const f = mk(doc);
    f.RichText = true;
    f.RichTextValue = '<body><p>rich</p></body>';
    // /V is the plain-text equivalent and stays the thing the appearance draws.
    expect(f.Value).toBe('x');
  });

  it('regenerates the appearance when a flag changes', () => {
    const doc = blank();
    const f = doc.Form.AddTextField({
      page: 1, rect: [10, 10, 210, 60], name: 'a', value: 'one two three four five',
    });
    const apOf = () => {
      const n = doc.resolve((doc.resolve(f.Dict.get('AP')) as PdfDict).get('N')) as { raw: Uint8Array };
      return new TextDecoder('latin1').decode(n.raw);
    };
    const before = apOf();
    f.Multiline = true;
    expect(apOf()).not.toBe(before);
  });
});

describe('AddTextField flags', () => {
  it('sets the flag bits and /MaxLen at creation', () => {
    const doc = blank();
    const f = doc.Form.AddTextField({
      page: 1, rect: [10, 10, 210, 60], name: 'notes',
      value: 'hello', multiline: true, maxLen: 200,
    });
    expect(doc.resolve(f.Dict.get('Ff'))).toBe(FF_MULTILINE);
    expect(doc.resolve(f.Dict.get('MaxLen'))).toBe(200);
    expect(f.Multiline).toBe(true);
    expect(f.MaxLen).toBe(200);
  });

  it('combines flag options with the type-neutral ones', () => {
    const doc = blank();
    const f = doc.Form.AddTextField({
      page: 1, rect: [10, 10, 210, 60], name: 'a',
      password: true, readOnly: true, required: true,
    });
    expect(doc.resolve(f.Dict.get('Ff')))
      .toBe(FF_PASSWORD | FF_READONLY | FF_REQUIRED);
  });

  it('omits /MaxLen when maxLen is absent or 0', () => {
    const doc = blank();
    expect(doc.Form.AddTextField({ page: 1, rect: [10, 10, 110, 30], name: 'a' })
      .Dict.has('MaxLen')).toBe(false);
    expect(doc.Form.AddTextField({ page: 1, rect: [10, 40, 110, 60], name: 'b', maxLen: 0 })
      .Dict.has('MaxLen')).toBe(false);
  });

  it('positions one glyph per character in its own comb cell', () => {
    const doc = blank();
    const f = doc.Form.AddTextField({
      page: 1, rect: [10, 10, 190, 40], name: 'ssn', value: '123456789',
      comb: true, maxLen: 9,
    });
    expect(doc.resolve(f.Dict.get('Ff'))).toBe(FF_COMB);
    const n = doc.resolve((doc.resolve(f.Dict.get('AP')) as PdfDict).get('N')) as { raw: Uint8Array };
    const content = new TextDecoder('latin1').decode(n.raw);
    // combText emits one Td per character of the value, truncated to maxLen.
    // The value here is exactly 9 characters, so 9 is both counts.
    expect(content.split(' Td').length - 1).toBe(9);
    // A shorter value fills only as many cells as it has characters.
    const g = doc.Form.AddTextField({
      page: 1, rect: [10, 50, 190, 80], name: 'short', value: '123',
      comb: true, maxLen: 9,
    });
    const gn = doc.resolve((doc.resolve(g.Dict.get('AP')) as PdfDict).get('N')) as { raw: Uint8Array };
    expect(new TextDecoder('latin1').decode(gn.raw).split(' Td').length - 1).toBe(3);
  });

  it('masks a password field created with a value', () => {
    const doc = blank();
    const f = doc.Form.AddTextField({
      page: 1, rect: [10, 10, 210, 40], name: 'pw', value: 'hunter2', password: true,
    });
    const n = doc.resolve((doc.resolve(f.Dict.get('AP')) as PdfDict).get('N')) as { raw: Uint8Array };
    const content = new TextDecoder('latin1').decode(n.raw);
    expect(content).not.toContain('hunter2');
    expect(content.split('\\225').length - 1).toBe(7);
  });

  it('sets FileSelect and RichText at creation', () => {
    const doc = blank();
    const f = doc.Form.AddTextField({
      page: 1, rect: [10, 10, 210, 40], name: 'attach', fileSelect: true,
    });
    expect(doc.resolve(f.Dict.get('Ff'))).toBe(FF_FILESELECT);
    const g = doc.Form.AddTextField({
      page: 1, rect: [10, 50, 210, 80], name: 'notes', richText: true, multiline: true,
    });
    expect(doc.resolve(g.Dict.get('Ff'))).toBe(FF_RICHTEXT | FF_MULTILINE);
  });

  it('sets DoNotSpellCheck and DoNotScroll at creation', () => {
    const doc = blank();
    const f = doc.Form.AddTextField({
      page: 1, rect: [10, 10, 210, 40], name: 'code', doNotSpellCheck: true,
    });
    expect(doc.resolve(f.Dict.get('Ff'))).toBe(FF_DONOTSPELLCHECK);
    const g = doc.Form.AddTextField({
      page: 1, rect: [10, 50, 210, 100], name: 'fixed',
      doNotScroll: true, multiline: true,
    });
    expect(doc.resolve(g.Dict.get('Ff'))).toBe(FF_DONOTSCROLL | FF_MULTILINE);
    // The accessors read the /Ff captured by the tree walk, so a reopened
    // document is what proves the bits are the ones the walk hands back.
    const back = Document.Open(doc.Save()).Form;
    expect((back.Get('code') as TextField).DoNotSpellCheck).toBe(true);
    expect((back.Get('code') as TextField).DoNotScroll).toBe(false);
    expect((back.Get('fixed') as TextField).DoNotScroll).toBe(true);
  });

  it('writes /RV alongside the plain /V at creation', () => {
    const doc = blank();
    const f = doc.Form.AddTextField({
      page: 1, rect: [10, 10, 210, 40], name: 'notes',
      value: 'bold', richText: true, richTextValue: '<body><p><b>bold</b></p></body>',
    });
    expect(f.RichTextValue).toBe('<body><p><b>bold</b></p></body>');
    expect(f.Value).toBe('bold');
    const back = Document.Open(doc.Save()).Form.Get('notes') as TextField;
    expect(back.RichText).toBe(true);
    expect(back.RichTextValue).toBe('<body><p><b>bold</b></p></body>');
  });

  it('rejects the forbidden combinations without mutating the document', () => {
    const bad: Array<[Record<string, unknown>, typeof TypeError | typeof RangeError]> = [
      [{ comb: true }, RangeError],
      [{ comb: true, maxLen: 0 }, RangeError],
      [{ comb: true, maxLen: 9, multiline: true }, RangeError],
      [{ comb: true, maxLen: 9, password: true }, RangeError],
      [{ comb: true, maxLen: 9, fileSelect: true }, RangeError],
      [{ richTextValue: '<body/>' }, RangeError],
      [{ richText: true, richTextValue: 7 }, TypeError],
      [{ maxLen: -1 }, TypeError],
      [{ maxLen: 1.5 }, TypeError],
    ];
    for (const [extra, err] of bad) {
      const doc = blank();
      const before = doc.Save().length;
      expect(() => doc.Form.AddTextField({
        page: 1, rect: [10, 10, 110, 30], name: 'a', ...extra,
      } as never)).toThrow(err as never);
      expect(doc.catalog().has('AcroForm')).toBe(false);
      expect(doc.Save().length).toBe(before);
    }
  });

  it('survives a Save/Open round-trip with flags intact', () => {
    const doc = blank();
    doc.Form.AddTextField({
      page: 1, rect: [10, 10, 210, 60], name: 'notes', multiline: true, maxLen: 40,
    });
    const back = Document.Open(doc.Save());
    const f = back.Form.Get('notes') as TextField;
    expect(f).toBeInstanceOf(TextField);
    expect(f.Multiline).toBe(true);
    expect(f.MaxLen).toBe(40);
  });
});

describe('AddCheckbox', () => {
  const apStates = (doc: Document, f: { Dict: PdfDict }) =>
    doc.resolve((doc.resolve(f.Dict.get('AP')) as PdfDict).get('N')) as PdfDict;

  it('creates an unchecked checkbox with both appearance states', () => {
    const doc = blank();
    const f = doc.Form.AddCheckbox({ page: 1, rect: [10, 10, 30, 30], name: 'agree' });
    expect(f).toBeInstanceOf(CheckboxField);
    expect(f.Type).toBe('checkbox');
    expect((doc.resolve(f.Dict.get('FT')) as { name: string }).name).toBe('Btn');
    expect(f.Dict.has('Ff')).toBe(false);
    expect((doc.resolve(f.Dict.get('V')) as { name: string }).name).toBe('Off');
    expect((doc.resolve(f.Dict.get('AS')) as { name: string }).name).toBe('Off');
    expect([...apStates(doc, f).keys()].sort()).toEqual(['Off', 'Yes']);
    expect(f.Value).toBe(false);
    expect(f.Options).toEqual(['Yes']);
  });

  it('sets /V and /AS to the export name when checked', () => {
    const doc = blank();
    const f = doc.Form.AddCheckbox({
      page: 1, rect: [10, 10, 30, 30], name: 'agree', checked: true,
    });
    expect((doc.resolve(f.Dict.get('V')) as { name: string }).name).toBe('Yes');
    expect((doc.resolve(f.Dict.get('AS')) as { name: string }).name).toBe('Yes');
    expect(f.Value).toBe(true);
  });

  it('keys the /AP by a custom export value even when unchecked', () => {
    // The regression this guards: an unchecked box has /AS /Off and /V /Off and
    // no /Opt, so synthOnState would fall through to its 'Yes' default and build
    // the appearance under the wrong key.
    const doc = blank();
    const f = doc.Form.AddCheckbox({
      page: 1, rect: [10, 10, 30, 30], name: 'agree', exportValue: 'On',
    });
    expect([...apStates(doc, f).keys()].sort()).toEqual(['Off', 'On']);
    expect(f.Options).toEqual(['On']);
  });

  it('attaches the widget to its page exactly once', () => {
    const doc = blank();
    const f = doc.Form.AddCheckbox({ page: 1, rect: [10, 10, 30, 30], name: 'a' });
    const annots = doc.resolve(doc.Pages[0].Dict.get('Annots')) as unknown[];
    expect(annots.length).toBe(1);
    expect(doc.resolve(annots[0] as never)).toBe(f.Dict);
  });

  it('drives the existing Value setter', () => {
    const doc = blank();
    const f = doc.Form.AddCheckbox({
      page: 1, rect: [10, 10, 30, 30], name: 'a', exportValue: 'On',
    });
    f.Value = true;
    expect((doc.resolve(f.Dict.get('V')) as { name: string }).name).toBe('On');
    expect((doc.resolve(f.Dict.get('AS')) as { name: string }).name).toBe('On');
    f.Value = false;
    expect((doc.resolve(f.Dict.get('V')) as { name: string }).name).toBe('Off');
  });

  it('survives a Save/Open round-trip', () => {
    const doc = blank();
    doc.Form.AddCheckbox({
      page: 1, rect: [10, 10, 30, 30], name: 'agree', exportValue: 'On', checked: true,
    });
    const f = Document.Open(doc.Save()).Form.Get('agree')!;
    expect(f.Type).toBe('checkbox');
    expect(f.Value).toBe(true);
    expect(f.Options).toEqual(['On']);
  });

  it('forwards from the page', () => {
    const doc = blank();
    const f = doc.Pages[0].AddCheckbox({ rect: [10, 10, 30, 30], name: 'a' });
    expect(doc.resolve(f.Dict.get('P'))).toBe(doc.Pages[0].Dict);
  });

  it('rejects a bad export value without mutating the document', () => {
    for (const bad of ['Off', '', 42]) {
      const doc = blank();
      const before = doc.Save().length;
      expect(() => doc.Form.AddCheckbox({
        page: 1, rect: [10, 10, 30, 30], name: 'a', exportValue: bad as never,
      })).toThrow();
      expect(doc.catalog().has('AcroForm')).toBe(false);
      expect(doc.Save().length).toBe(before);
    }
  });
});

describe('AddRadioGroup', () => {
  const opts = () => [
    { page: 1, rect: [10, 700, 26, 716] as [number, number, number, number], export: 'red' },
    { page: 1, rect: [10, 680, 26, 696] as [number, number, number, number], export: 'green' },
  ];
  const kidsOf = (doc: Document, f: { Dict: PdfDict }) =>
    (doc.resolve(f.Dict.get('Kids')) as unknown[]).map((k) => doc.resolve(k as never) as PdfDict);
  const nameOf = (o: unknown) => (o as { name: string }).name;

  it('builds a parent field that is not itself a widget', () => {
    const doc = blank();
    const f = doc.Form.AddRadioGroup({ name: 'color', options: opts() });
    expect(f).toBeInstanceOf(RadioField);
    expect(f.Type).toBe('radio');
    expect(nameOf(doc.resolve(f.Dict.get('FT')))).toBe('Btn');
    expect(doc.resolve(f.Dict.get('Ff'))).toBe(32768);
    expect(f.Dict.has('Subtype')).toBe(false);
    expect(f.Dict.has('Rect')).toBe(false);
    expect(kidsOf(doc, f).length).toBe(2);
  });

  it('gives each kid a /Parent back-link and its own two /AP states', () => {
    const doc = blank();
    const f = doc.Form.AddRadioGroup({ name: 'color', options: opts() });
    const kids = kidsOf(doc, f);
    const wanted = ['red', 'green'];
    kids.forEach((k, i) => {
      expect(doc.resolve(k.get('Parent'))).toBe(f.Dict);
      expect(nameOf(doc.resolve(k.get('Subtype')))).toBe('Widget');
      const n = doc.resolve((doc.resolve(k.get('AP')) as PdfDict).get('N')) as PdfDict;
      expect([...n.keys()].sort()).toEqual(['Off', wanted[i]].sort());
    });
    expect(f.Options).toEqual(wanted);
  });

  it('defaults to nothing selected', () => {
    const doc = blank();
    const f = doc.Form.AddRadioGroup({ name: 'color', options: opts() });
    expect(nameOf(doc.resolve(f.Dict.get('V')))).toBe('Off');
    for (const k of kidsOf(doc, f)) expect(nameOf(doc.resolve(k.get('AS')))).toBe('Off');
    // Field.Value returns /V verbatim, so an unselected group reads 'Off'
    // rather than ''. Writing /V /Off explicitly is what setRadio accepts.
    expect(f.Value).toBe('Off');
  });

  it('sets /V and exactly one kid /AS when selected', () => {
    const doc = blank();
    const f = doc.Form.AddRadioGroup({ name: 'color', options: opts(), selected: 'green' });
    expect(nameOf(doc.resolve(f.Dict.get('V')))).toBe('green');
    const as = kidsOf(doc, f).map((k) => nameOf(doc.resolve(k.get('AS'))));
    expect(as).toEqual(['Off', 'green']);
    expect(f.Value).toBe('green');
  });

  it('drives the existing Value setter', () => {
    const doc = blank();
    const f = doc.Form.AddRadioGroup({ name: 'color', options: opts() });
    f.Value = 'red';
    expect(nameOf(doc.resolve(f.Dict.get('V')))).toBe('red');
    expect(kidsOf(doc, f).map((k) => nameOf(doc.resolve(k.get('AS'))))).toEqual(['red', 'Off']);
    expect(() => { f.Value = 'purple'; }).toThrow(RangeError);
  });

  it('places each widget on its own page and nowhere else', () => {
    const doc = twoPages();
    const f = doc.Form.AddRadioGroup({
      name: 'color',
      options: [
        { page: 1, rect: [10, 700, 26, 716], export: 'red' },
        { page: 2, rect: [10, 700, 26, 716], export: 'blue' },
      ],
    });
    const annots = (i: number) => doc.resolve(doc.Pages[i].Dict.get('Annots')) as unknown[];
    expect(annots(0).length).toBe(1);
    expect(annots(1).length).toBe(1);
    const kids = kidsOf(doc, f);
    expect(doc.resolve(annots(0)[0] as never)).toBe(kids[0]);
    expect(doc.resolve(annots(1)[0] as never)).toBe(kids[1]);
  });

  it('survives a Save/Open round-trip across pages', () => {
    const doc = twoPages();
    doc.Form.AddRadioGroup({
      name: 'color', selected: 'blue',
      options: [
        { page: 1, rect: [10, 700, 26, 716], export: 'red' },
        { page: 2, rect: [10, 700, 26, 716], export: 'blue' },
      ],
    });
    const f = Document.Open(doc.Save()).Form.Get('color')!;
    expect(f.Type).toBe('radio');
    expect(f.Options).toEqual(['red', 'blue']);
    expect(f.Value).toBe('blue');
  });

  it('supports a hierarchical name', () => {
    const doc = blank();
    doc.Form.AddRadioGroup({ name: 'prefs.color', options: opts() });
    const back = Document.Open(doc.Save());
    expect(back.Form.Get('prefs.color')!.Type).toBe('radio');
  });

  it('rejects bad input and leaves the document untouched', () => {
    const cases: Array<[Record<string, unknown>, typeof TypeError | typeof RangeError]> = [
      [{ options: [] }, TypeError],
      [{ options: [{ page: 1, rect: [0, 0, 1, 1], export: '' }] }, TypeError],
      [{ options: [{ page: 1, rect: [0, 0, 1, 1], export: 'Off' }] }, RangeError],
      [{ options: [
        { page: 1, rect: [0, 0, 1, 1], export: 'a' },
        { page: 1, rect: [0, 2, 1, 3], export: 'a' },
      ] }, RangeError],
      [{ options: [{ page: 9, rect: [0, 0, 1, 1], export: 'a' }] }, RangeError],
      [{ options: [{ page: 1, rect: [0, 0, 1], export: 'a' }] }, TypeError],
      [{ options: [{ page: 1, rect: [0, 0, 1, 1], export: 'a' }], selected: 'zzz' }, RangeError],
    ];
    for (const [extra, err] of cases) {
      const doc = blank();
      const before = doc.Save().length;
      expect(() => doc.Form.AddRadioGroup({ name: 'color', ...extra } as never))
        .toThrow(err as never);
      expect(doc.catalog().has('AcroForm')).toBe(false);
      expect(doc.Save().length).toBe(before);
    }
  });

  it('leaves no orphan parent when a later option is rejected', () => {
    // The atomicity that matters: validating item 3 only after the parent and
    // two kids are wired would strand all three.
    const doc = blank();
    const before = doc.Save().length;
    expect(() => doc.Form.AddRadioGroup({
      name: 'color',
      options: [
        { page: 1, rect: [10, 700, 26, 716], export: 'red' },
        { page: 1, rect: [10, 680, 26, 696], export: 'green' },
        { page: 1, rect: [10, 660, 26, 676], export: 'red' },
      ],
    })).toThrow(RangeError);
    expect(doc.catalog().has('AcroForm')).toBe(false);
    expect(doc.Pages[0].Dict.has('Annots')).toBe(false);
    expect(doc.Save().length).toBe(before);
  });
});

describe('AddComboBox / AddListBox', () => {
  const optOf = (doc: Document, f: { Dict: PdfDict }) =>
    doc.resolve(f.Dict.get('Opt')) as unknown[];
  const str = (o: unknown) => new TextDecoder('latin1').decode((o as { bytes: Uint8Array }).bytes);

  it('writes a plain /Opt string when export and display are the same', () => {
    const doc = blank();
    const f = doc.Form.AddComboBox({
      page: 1, rect: [10, 10, 210, 30], name: 'size', options: ['S', 'M', 'L'],
    });
    expect(f).toBeInstanceOf(ChoiceField);
    expect(f.Type).toBe('choice');
    expect(optOf(doc, f).map((e) => str(doc.resolve(e as never)))).toEqual(['S', 'M', 'L']);
    expect(f.Options).toEqual(['S', 'M', 'L']);
  });

  it('writes an [export, display] pair when they differ', () => {
    const doc = blank();
    const f = doc.Form.AddListBox({
      page: 1, rect: [10, 10, 210, 90], name: 'country',
      options: [
        { export: 'us', display: 'United States' },
        { export: 'gb', display: 'United Kingdom' },
        { export: 'plain' },
      ],
    });
    const opt = optOf(doc, f);
    const first = doc.resolve(opt[0] as never) as unknown[];
    expect(Array.isArray(first)).toBe(true);
    expect(first.map((e) => str(doc.resolve(e as never)))).toEqual(['us', 'United States']);
    expect(Array.isArray(doc.resolve(opt[2] as never))).toBe(false);
    expect(f.Options).toEqual(['us', 'gb', 'plain']);
  });

  it('sets the combo and edit flags', () => {
    const doc = blank();
    const plain = doc.Form.AddComboBox({
      page: 1, rect: [10, 10, 210, 30], name: 'a', options: ['x'],
    });
    expect(doc.resolve(plain.Dict.get('Ff'))).toBe(131072);
    const editable = doc.Form.AddComboBox({
      page: 1, rect: [10, 40, 210, 60], name: 'b', options: ['x'], editable: true,
    });
    expect(doc.resolve(editable.Dict.get('Ff'))).toBe(131072 | 262144);
  });

  it('sets no flag for a plain list box and MultiSelect when asked', () => {
    const doc = blank();
    const plain = doc.Form.AddListBox({
      page: 1, rect: [10, 10, 210, 90], name: 'a', options: ['x'],
    });
    expect(plain.Dict.has('Ff')).toBe(false);
    const multi = doc.Form.AddListBox({
      page: 1, rect: [10, 100, 210, 180], name: 'b', options: ['x'], multiSelect: true,
    });
    expect(doc.resolve(multi.Dict.get('Ff'))).toBe(2097152);
  });

  it('writes /V and an ascending /I for a single selection', () => {
    const doc = blank();
    const f = doc.Form.AddListBox({
      page: 1, rect: [10, 10, 210, 90], name: 'a', options: ['x', 'y', 'z'], value: 'y',
    });
    expect(str(doc.resolve(f.Dict.get('V')))).toBe('y');
    expect(doc.resolve(f.Dict.get('I'))).toEqual([1]);
    expect(f.Value).toBe('y');
  });

  it('writes an array /V and a sorted /I for a multi-selection', () => {
    const doc = blank();
    const f = doc.Form.AddListBox({
      page: 1, rect: [10, 10, 210, 90], name: 'a',
      options: ['x', 'y', 'z'], multiSelect: true, value: ['z', 'x'],
    });
    expect((doc.resolve(f.Dict.get('V')) as unknown[]).map((e) => str(doc.resolve(e as never))))
      .toEqual(['z', 'x']);
    expect(doc.resolve(f.Dict.get('I'))).toEqual([0, 2]);
    expect(f.Value).toEqual(['z', 'x']);
  });

  it('omits /V and /I when nothing is selected', () => {
    const doc = blank();
    const f = doc.Form.AddListBox({
      page: 1, rect: [10, 10, 210, 90], name: 'a', options: ['x'],
    });
    expect(f.Dict.has('V')).toBe(false);
    expect(f.Dict.has('I')).toBe(false);
  });

  it('accepts free text on an editable combo and omits /I for it', () => {
    const doc = blank();
    const f = doc.Form.AddComboBox({
      page: 1, rect: [10, 10, 210, 30], name: 'a',
      options: ['x'], editable: true, value: 'typed',
    });
    expect(str(doc.resolve(f.Dict.get('V')))).toBe('typed');
    expect(f.Dict.has('I')).toBe(false);
  });

  it('allows an empty option list on an editable combo', () => {
    const doc = blank();
    const f = doc.Form.AddComboBox({
      page: 1, rect: [10, 10, 210, 30], name: 'a', options: [], editable: true,
    });
    expect(f.Options).toEqual([]);
  });

  it('forwards from the page', () => {
    const doc = blank();
    const a = doc.Pages[0].AddComboBox({ rect: [10, 10, 210, 30], name: 'a', options: ['x'] });
    const b = doc.Pages[0].AddListBox({ rect: [10, 40, 210, 120], name: 'b', options: ['x'] });
    expect(doc.resolve(a.Dict.get('P'))).toBe(doc.Pages[0].Dict);
    expect(doc.resolve(b.Dict.get('P'))).toBe(doc.Pages[0].Dict);
  });

  it('survives a Save/Open round-trip with both /Opt halves intact', () => {
    const doc = blank();
    doc.Form.AddListBox({
      page: 1, rect: [10, 10, 210, 90], name: 'country',
      options: [
        { export: 'us', display: 'United States' },
        { export: 'gb', display: 'United Kingdom' },
      ],
      value: 'gb',
    });
    const back = Document.Open(doc.Save());
    const f = back.Form.Get('country')!;
    expect(f.Options).toEqual(['us', 'gb']);
    expect(f.Value).toBe('gb');
    const first = back.resolve((back.resolve(f.Dict.get('Opt')) as unknown[])[0] as never) as unknown[];
    expect(first.map((e) => str(back.resolve(e as never)))).toEqual(['us', 'United States']);
  });

  it('drives the existing Value setter', () => {
    const doc = blank();
    const f = doc.Form.AddListBox({
      page: 1, rect: [10, 10, 210, 90], name: 'a',
      options: ['x', 'y'], multiSelect: true, value: 'x',
    });
    f.Value = ['x', 'y'];
    expect(f.Value).toEqual(['x', 'y']);
    expect(f.Dict.has('I')).toBe(false);
    expect(() => { f.Value = 'zzz'; }).toThrow(RangeError);
  });

  it('rejects bad input without mutating the document', () => {
    type Adder = 'AddComboBox' | 'AddListBox';
    const cases: Array<[Adder, Record<string, unknown>, typeof TypeError | typeof RangeError]> = [
      ['AddComboBox', { options: 'nope' }, TypeError],
      ['AddComboBox', { options: [42] }, TypeError],
      ['AddComboBox', { options: [{ display: 'no export' }] }, TypeError],
      ['AddComboBox', { options: [''] }, TypeError],
      ['AddComboBox', { options: [{ export: 'a', display: 7 }] }, TypeError],
      ['AddComboBox', { options: ['a', 'a'] }, RangeError],
      ['AddComboBox', { options: ['a'], value: 'zzz' }, RangeError],
      ['AddComboBox', { options: ['a'], value: ['a'] }, TypeError],
      ['AddComboBox', { options: ['a'], multiSelect: true }, RangeError],
      ['AddListBox', { options: ['a'], editable: true }, RangeError],
      ['AddListBox', { options: ['a'], value: ['a'] }, TypeError],
    ];
    for (const [adder, extra, err] of cases) {
      const doc = blank();
      const before = doc.Save().length;
      expect(() => doc.Form[adder]({
        page: 1, rect: [10, 10, 210, 30], name: 'a', ...extra,
      } as never)).toThrow(err as never);
      expect(doc.catalog().has('AcroForm')).toBe(false);
      expect(doc.Save().length).toBe(before);
    }
  });
});

describe('ChoiceField.AddOption / RemoveOption', () => {
  const str = (o: unknown) => new TextDecoder('latin1').decode((o as { bytes: Uint8Array }).bytes);
  const listBox = (doc: Document, extra: Record<string, unknown> = {}) =>
    doc.Form.AddListBox({
      page: 1, rect: [10, 10, 210, 90], name: 'a',
      options: ['x', 'y', 'z'], ...extra,
    } as never);

  it('appends an option to the end of the list', () => {
    const doc = blank();
    const f = listBox(doc);
    f.AddOption('w');
    expect(f.Options).toEqual(['x', 'y', 'z', 'w']);
  });

  it('appends an [export, display] pair', () => {
    const doc = blank();
    const f = listBox(doc);
    f.AddOption({ export: 'gb', display: 'United Kingdom' });
    expect(f.Options).toEqual(['x', 'y', 'z', 'gb']);
    const opt = doc.resolve(f.Dict.get('Opt')) as unknown[];
    const last = doc.resolve(opt[3] as never) as unknown[];
    expect(last.map((e) => str(doc.resolve(e as never)))).toEqual(['gb', 'United Kingdom']);
  });

  it('adds to a field that has no /Opt at all', () => {
    const doc = blank();
    const f = doc.Form.AddComboBox({
      page: 1, rect: [10, 10, 210, 30], name: 'a', options: [], editable: true,
    });
    f.Dict.delete('Opt');
    f.AddOption('x');
    expect(f.Options).toEqual(['x']);
  });

  it('rejects a duplicate export and a malformed option, changing nothing', () => {
    const doc = blank();
    const f = listBox(doc);
    const before = doc.Save().length;
    expect(() => f.AddOption('y')).toThrow(RangeError);
    expect(() => f.AddOption('')).toThrow(TypeError);
    expect(() => f.AddOption(42 as never)).toThrow(TypeError);
    expect(() => f.AddOption({ export: 'q', display: 7 } as never)).toThrow(TypeError);
    expect(f.Options).toEqual(['x', 'y', 'z']);
    expect(doc.Save().length).toBe(before);
  });

  it('renumbers /I when an earlier option is removed', () => {
    const doc = blank();
    const f = listBox(doc, { value: 'z' });
    expect(doc.resolve(f.Dict.get('I'))).toEqual([2]);

    f.RemoveOption('x');

    // /I holds *indices* into /Opt, so dropping an earlier entry shifts every
    // later one. Leaving it at 2 would highlight nothing at all.
    expect(f.Options).toEqual(['y', 'z']);
    expect(doc.resolve(f.Dict.get('I'))).toEqual([1]);
    expect(f.Value).toBe('z');
  });

  it('drops the value when the selected option is removed', () => {
    const doc = blank();
    const f = listBox(doc, { value: 'y' });
    f.RemoveOption('y');
    expect(f.Options).toEqual(['x', 'z']);
    expect(f.Dict.has('V')).toBe(false);
    expect(f.Dict.has('I')).toBe(false);
    expect(f.Value).toBe('');
  });

  it('keeps the other selections when one of several is removed', () => {
    const doc = blank();
    const f = listBox(doc, { multiSelect: true, value: ['x', 'y', 'z'] });
    f.RemoveOption('y');
    expect(f.Value).toEqual(['x', 'z']);
    expect(doc.resolve(f.Dict.get('I'))).toEqual([0, 1]);
  });

  it('leaves free text on an editable combo alone', () => {
    const doc = blank();
    const f = doc.Form.AddComboBox({
      page: 1, rect: [10, 10, 210, 30], name: 'a',
      options: ['x', 'y'], editable: true, value: 'typed',
    });
    f.RemoveOption('x');
    // The value was never an option, so removing one cannot invalidate it.
    expect(f.Value).toBe('typed');
    expect(f.Options).toEqual(['y']);
  });

  it('rejects removing an option that is not there', () => {
    const doc = blank();
    const f = listBox(doc);
    const before = doc.Save().length;
    expect(() => f.RemoveOption('nope')).toThrow(RangeError);
    expect(() => f.RemoveOption(7 as never)).toThrow(TypeError);
    expect(doc.Save().length).toBe(before);
  });

  it('matches on the export half, not the display half', () => {
    const doc = blank();
    const f = doc.Form.AddListBox({
      page: 1, rect: [10, 10, 210, 90], name: 'a',
      options: [{ export: 'us', display: 'United States' }, 'gb'],
    });
    // /V holds the export, so the export is the identity a caller removes by.
    expect(() => f.RemoveOption('United States')).toThrow(RangeError);
    f.RemoveOption('us');
    expect(f.Options).toEqual(['gb']);
  });

  it('redraws the appearance so the list shows the new options', () => {
    const doc = blank();
    const f = listBox(doc);
    const drawn = () => {
      const ap = doc.resolve(f.Dict.get('AP')) as PdfDict;
      return new TextDecoder('latin1').decode(
        (doc.resolve(ap.get('N')) as { raw: Uint8Array }).raw,
      );
    };
    expect(drawn()).toContain('(y) Tj');
    f.RemoveOption('y');
    expect(drawn()).not.toContain('(y) Tj');
    f.AddOption('w');
    expect(drawn()).toContain('(w) Tj');
  });

  it('keeps /TI inside the shortened list', () => {
    const doc = blank();
    const f = listBox(doc);
    f.Dict.set('TI', 2);          // scrolled to the last option
    f.RemoveOption('z');
    // A first-visible index past the end scrolls the list clean off its box.
    expect(doc.resolve(f.Dict.get('TI'))).toBe(1);
  });

  it('survives a Save/Open round-trip', () => {
    const doc = blank();
    const f = listBox(doc, { value: 'z' });
    f.RemoveOption('x');
    f.AddOption({ export: 'w', display: 'Double-u' });
    const back = Document.Open(doc.Save());
    const g = back.Form.Get('a')!;
    expect(g.Options).toEqual(['y', 'z', 'w']);
    expect(g.Value).toBe('z');
    expect(back.resolve(g.Dict.get('I'))).toEqual([1]);
  });
});

describe('ChoiceField flag accessors', () => {
  it('reports Combo without allowing it to be changed', () => {
    const doc = blank();
    const combo = doc.Form.AddComboBox({
      page: 1, rect: [10, 10, 210, 30], name: 'a', options: ['x'],
    });
    const list = doc.Form.AddListBox({
      page: 1, rect: [10, 40, 210, 120], name: 'b', options: ['x'],
    });
    expect(combo.Combo).toBe(true);
    expect(list.Combo).toBe(false);
    // Read-only: no setter exists on the prototype.
    expect(Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(combo), 'Combo',
    )!.set).toBeUndefined();
  });

  it('toggles Editable on a combo box', () => {
    const doc = blank();
    const f = doc.Form.AddComboBox({
      page: 1, rect: [10, 10, 210, 30], name: 'a', options: ['x'],
    });
    expect(f.Editable).toBe(false);
    f.Editable = true;
    expect(doc.resolve(f.Dict.get('Ff'))).toBe(FF_COMBO | FF_EDIT);
    expect(f.Editable).toBe(true);
    f.Editable = false;
    expect(doc.resolve(f.Dict.get('Ff'))).toBe(FF_COMBO);
  });

  it('toggles MultiSelect on a list box', () => {
    const doc = blank();
    const f = doc.Form.AddListBox({
      page: 1, rect: [10, 10, 210, 90], name: 'a', options: ['x'],
    });
    expect(f.MultiSelect).toBe(false);
    f.MultiSelect = true;
    expect(doc.resolve(f.Dict.get('Ff'))).toBe(FF_MULTISELECT);
    expect(f.MultiSelect).toBe(true);
  });

  it('rejects each flag on the wrong field type, from either side', () => {
    const doc = blank();
    const combo = doc.Form.AddComboBox({
      page: 1, rect: [10, 10, 210, 30], name: 'a', options: ['x'],
    });
    const list = doc.Form.AddListBox({
      page: 1, rect: [10, 40, 210, 120], name: 'b', options: ['x'],
    });
    expect(() => { combo.MultiSelect = true; }).toThrow(RangeError);
    expect(() => { list.Editable = true; }).toThrow(RangeError);
    expect(doc.resolve(combo.Dict.get('Ff'))).toBe(FF_COMBO);
    expect(list.Dict.has('Ff')).toBe(false);
  });

  it('allows clearing a flag on the wrong type, which is a no-op', () => {
    const doc = blank();
    const list = doc.Form.AddListBox({
      page: 1, rect: [10, 10, 210, 90], name: 'a', options: ['x'],
    });
    // Only *setting* is rejected; clearing an already-clear flag is harmless.
    expect(() => { list.Editable = false; }).not.toThrow();
    expect(list.Editable).toBe(false);
  });
});

describe('Field additional actions (/AA)', () => {
  const js = (script: string) => ({ type: 'javascript' as const, script });
  const aaOf = (doc: Document, f: { Dict: PdfDict }) =>
    doc.resolve(f.Dict.get('AA')) as PdfDict;
  const mk = (doc: Document) =>
    doc.Form.AddTextField({ page: 1, rect: [10, 10, 210, 40], name: 'amount' });

  it('reports no actions when there is no /AA', () => {
    const doc = blank();
    expect(mk(doc).Actions).toEqual({});
  });

  it('writes each trigger to its own /AA key', () => {
    const doc = blank();
    const f = mk(doc);
    f.SetActions({
      keystroke: js('AFNumber_Keystroke(2,0,0,0,"$",true);'),
      format: js('AFNumber_Format(2,0,0,0,"$",true);'),
      validate: js('AFRange_Validate(true,0,true,100);'),
      calculate: js('AFSimple_Calculate("SUM",["a","b"]);'),
    });
    // Table 197 names them /K, /F, /V and /C.
    expect([...aaOf(doc, f).keys()].sort()).toEqual(['C', 'F', 'K', 'V']);
    expect(f.Actions.format).toEqual(js('AFNumber_Format(2,0,0,0,"$",true);'));
    expect(f.Actions.calculate).toEqual(js('AFSimple_Calculate("SUM",["a","b"]);'));
  });

  it('leaves an absent trigger alone and deletes one set to null', () => {
    const doc = blank();
    const f = mk(doc);
    f.SetActions({ format: js('a'), validate: js('b') });
    f.SetActions({ format: js('c') });          // validate untouched
    expect(f.Actions.format).toEqual(js('c'));
    expect(f.Actions.validate).toEqual(js('b'));
    f.SetActions({ validate: null });
    expect(f.Actions.validate).toBeUndefined();
    expect(f.Actions.format).toEqual(js('c'));
  });

  it('removes /AA once its last entry goes', () => {
    const doc = blank();
    const f = mk(doc);
    f.SetActions({ format: js('a') });
    f.SetActions({ format: null });
    expect(f.Dict.has('AA')).toBe(false);
  });

  it('does not disturb an annotation trigger sharing the dict', () => {
    // A created field is a merged field/widget dict, so /AA holds the
    // annotation's own triggers (/E, /X, ...) in the same dictionary as the
    // field's. Rewriting it whole would silently drop them.
    const doc = blank();
    const f = mk(doc);
    f.Dict.set('AA', new Map<string, PdfObject>([
      ['E', new Map<string, PdfObject>([['S', { kind: 'name', name: 'JavaScript' }]])],
    ]));
    f.SetActions({ format: js('a') });
    expect([...aaOf(doc, f).keys()].sort()).toEqual(['E', 'F']);
    f.SetActions({ format: null });
    expect([...aaOf(doc, f).keys()]).toEqual(['E']);   // /AA still needed
  });

  it('validates every trigger before writing any of them', () => {
    const doc = blank();
    const f = mk(doc);
    f.SetActions({ format: js('good') });
    expect(() => f.SetActions({
      validate: js('also good'),
      calculate: { type: 'bogus' } as never,
    })).toThrow(TypeError);
    expect([...aaOf(doc, f).keys()]).toEqual(['F']);
    expect(f.Actions.validate).toBeUndefined();
  });

  it('applies to any field type, not just text', () => {
    const doc = blank();
    const c = doc.Form.AddCheckbox({ page: 1, rect: [10, 10, 30, 30], name: 'agree' });
    c.SetActions({ validate: js('check') });
    expect(c.Actions.validate).toEqual(js('check'));
  });

  it('sets actions at creation and survives a round-trip', () => {
    const doc = blank();
    doc.Form.AddTextField({
      page: 1, rect: [10, 10, 210, 40], name: 'amount',
      actions: { format: js('AFNumber_Format(2,0,0,0,"$",true);') },
    });
    const back = Document.Open(doc.Save());
    expect(back.Form.Get('amount')!.Actions.format)
      .toEqual(js('AFNumber_Format(2,0,0,0,"$",true);'));
  });

  it('sets actions on a radio group, whose init is its own shape', () => {
    // RadioGroupInit is deliberately not a FieldInit, so it has to carry the
    // key itself or the option is silently unavailable for one field type.
    const doc = blank();
    const g = doc.Form.AddRadioGroup({
      name: 'pick',
      options: [{ export: 'a', page: 1, rect: [10, 10, 30, 30] }],
      actions: { validate: js('check') },
    });
    expect(g.Actions.validate).toEqual(js('check'));

    const before = doc.Save().length;
    expect(() => doc.Form.AddRadioGroup({
      name: 'other',
      options: [{ export: 'a', page: 1, rect: [10, 40, 30, 60] }],
      actions: { validate: { type: 'bogus' } as never },
    })).toThrow(TypeError);
    expect(doc.Save().length).toBe(before);
  });

  it('rejects a bad action at creation without mutating the document', () => {
    const doc = blank();
    const before = doc.Save().length;
    expect(() => doc.Form.AddTextField({
      page: 1, rect: [10, 10, 210, 40], name: 'amount',
      actions: { format: { type: 'uri', uri: '' } },
    })).toThrow(TypeError);
    expect(doc.catalog().has('AcroForm')).toBe(false);
    expect(doc.Save().length).toBe(before);
  });

  it('keeps a push button’s activation /A separate from its /AA', () => {
    const doc = blank();
    const b = doc.Form.AddPushButton({
      page: 1, rect: [10, 10, 110, 40], name: 'go', caption: 'Go',
      action: { type: 'reset' },
    });
    b.SetActions({ calculate: js('calc') });
    // /A is what activating the button does; /AA /C is a form-recalculation
    // trigger. Different keys, and neither may overwrite the other.
    expect(b.Action).toEqual({ type: 'reset' });
    expect(b.Actions.calculate).toEqual(js('calc'));
  });
});

describe('AddPushButton', () => {
  const mkOf = (doc: Document, f: { Dict: PdfDict }) => doc.resolve(f.Dict.get('MK')) as PdfDict;
  const pbStr = (o: unknown) => new TextDecoder('latin1').decode((o as { bytes: Uint8Array }).bytes);

  it('creates a pushbutton with /MK characteristics and no value', () => {
    const doc = blank();
    const f = doc.Form.AddPushButton({
      page: 1, rect: [10, 10, 110, 40], name: 'go', caption: 'Go',
    });
    expect(f).toBeInstanceOf(ButtonField);
    expect(f.Type).toBe('pushbutton');
    expect(doc.resolve(f.Dict.get('Ff'))).toBe(65536);   // spec bit 17
    expect(f.Dict.has('V')).toBe(false);
    const mk = mkOf(doc, f);
    expect(pbStr(mk.get('CA'))).toBe('Go');
    expect(pbStr(mk.get('RC'))).toBe('Go');              // falls back to the caption
    expect(pbStr(mk.get('AC'))).toBe('Go');
    expect(doc.resolve(mk.get('TP'))).toBe(0);
    expect(doc.resolve(mk.get('BG'))).toEqual([0.86, 0.86, 0.86]);
    expect(doc.resolve(mk.get('BC'))).toEqual([0.5, 0.5, 0.5]);
  });

  it('keeps distinct rollover and down captions', () => {
    const doc = blank();
    const f = doc.Form.AddPushButton({
      page: 1, rect: [10, 10, 110, 40], name: 'go',
      caption: 'Go', rolloverCaption: 'Hover', downCaption: 'Press',
    });
    const mk = mkOf(doc, f);
    expect(pbStr(mk.get('RC'))).toBe('Hover');
    expect(pbStr(mk.get('AC'))).toBe('Press');
  });

  it('installs all three appearance streams', () => {
    const doc = blank();
    const f = doc.Form.AddPushButton({
      page: 1, rect: [10, 10, 110, 40], name: 'go', caption: 'Go',
    });
    expect([...(doc.resolve(f.Dict.get('AP')) as PdfDict).keys()].sort())
      .toEqual(['D', 'N', 'R']);
  });

  it('writes the /TP value for the chosen layout and embeds the icon', () => {
    const doc = blank();
    const f = doc.Form.AddPushButton({
      page: 1, rect: [10, 10, 110, 40], name: 'go', caption: 'Go',
      icon: makePng(), iconPosition: 'icon-above-caption',
    });
    expect(doc.resolve(mkOf(doc, f).get('TP'))).toBe(2);
    const n = doc.resolve((doc.resolve(f.Dict.get('AP')) as PdfDict).get('N')) as { dict: PdfDict };
    const res = doc.resolve(n.dict.get('Resources')) as PdfDict;
    expect(isDict(doc.resolve(res.get('XObject')))).toBe(true);
  });

  it('creates every layout table 189 defines, each with its own /TP', () => {
    const seen = new Map<number, string>();
    for (const iconPosition of BUTTON_POSITIONS) {
      const doc = blank();
      const f = doc.Form.AddPushButton({
        page: 1, rect: [10, 10, 110, 40], name: 'go', caption: 'Go',
        iconPosition,
        icon: iconPosition === 'caption-only' ? undefined : makePng(),
      });
      const tp = doc.resolve(mkOf(doc, f).get('TP')) as number;
      expect(seen.has(tp), `${iconPosition} reuses /TP ${tp}`).toBe(false);
      seen.set(tp, iconPosition);
      // It survives the writer, which is what a viewer actually reads.
      const reopened = Document.Open(doc.Save());
      const back = reopened.Form.Get('go')!;
      expect(reopened.resolve(mkOf(reopened, back).get('TP'))).toBe(tp);
    }
    expect([...seen.keys()].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('defaults to icon-only when an icon is given with no caption', () => {
    const doc = blank();
    const f = doc.Form.AddPushButton({
      page: 1, rect: [10, 10, 110, 40], name: 'go', icon: makePng(),
    });
    expect(doc.resolve(mkOf(doc, f).get('TP'))).toBe(1);
  });

  it('writes the action and reads it back', () => {
    const doc = blank();
    const f = doc.Form.AddPushButton({
      page: 1, rect: [10, 10, 110, 40], name: 'go', caption: 'Submit',
      action: { type: 'submit', url: 'https://example.com/post', format: 'html' },
    });
    expect(f.Action).toEqual({
      type: 'submit', url: 'https://example.com/post', format: 'html',
    });
    f.Action = { type: 'reset' };
    expect(f.Action).toEqual({ type: 'reset' });
    f.Action = undefined;
    expect(f.Dict.has('A')).toBe(false);
    expect(f.Action).toBeUndefined();
  });

  it('forwards from the page', () => {
    const doc = blank();
    const f = doc.Pages[0].AddPushButton({ rect: [10, 10, 110, 40], name: 'go', caption: 'Go' });
    expect(doc.resolve(f.Dict.get('P'))).toBe(doc.Pages[0].Dict);
  });

  it('survives a Save/Open round-trip', () => {
    const doc = blank();
    doc.Form.AddPushButton({
      page: 1, rect: [10, 10, 110, 40], name: 'go', caption: 'Go',
      action: { type: 'uri', uri: 'https://example.com' },
    });
    const f = Document.Open(doc.Save()).Form.Get('go')!;
    expect(f.Type).toBe('pushbutton');
    expect((f as ButtonField).Action).toEqual({ type: 'uri', uri: 'https://example.com' });
  });

  it('rejects bad input without mutating the document', () => {
    // Each case is a complete options object, so nothing depends on a
    // conditional spread and each rejection is readable on its own line.
    const cases: Array<[Record<string, unknown>, typeof TypeError | typeof RangeError]> = [
      [{ caption: 7 }, TypeError],
      [{ rolloverCaption: 7 }, TypeError],
      [{ downCaption: 7 }, TypeError],
      [{ iconPosition: 'sideways' }, TypeError],
      [{ caption: 'x', iconPosition: 'icon-only' }, RangeError],
      [{ caption: 'x', iconPosition: 'icon-above-caption' }, RangeError],
      [{ caption: 'x', iconPosition: 'icon-below-caption' }, RangeError],
      [{ caption: 'x', iconPosition: 'icon-left-of-caption' }, RangeError],
      [{ caption: 'x', iconPosition: 'icon-right-of-caption' }, RangeError],
      [{ caption: 'x', iconPosition: 'caption-over-icon' }, RangeError],
      [{ caption: 'x', iconPosition: 'caption-only', icon: makePng() }, RangeError],
      [{ action: { type: 'uri', uri: '' } }, TypeError],
      [{ action: { type: 'goto', page: 9 } }, RangeError],
      [{ action: { type: 'bogus' } }, TypeError],
    ];
    for (const [extra, err] of cases) {
      const doc = blank();
      const before = doc.Save().length;
      expect(() => doc.Form.AddPushButton({
        page: 1, rect: [10, 10, 110, 40], name: 'go', ...extra,
      } as never)).toThrow(err as never);
      expect(doc.catalog().has('AcroForm')).toBe(false);
      expect(doc.Save().length).toBe(before);
    }
  });
});
