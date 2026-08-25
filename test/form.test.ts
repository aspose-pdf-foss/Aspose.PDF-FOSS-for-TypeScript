import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildFormPdf } from './helpers/build-form-pdf.js';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { isDict, isName, MaybeObj, PdfDict, PdfObject } from '../src/types.js';
import {
  Field, TextField, CheckboxField, RadioField, ChoiceField,
} from '../src/formfield.js';

const open = () => Document.Open(buildFormPdf());
const reopen = (d: Document) => Document.Open(d.Save());
const acroForm = (d: Document): PdfDict => d.resolve(d.catalog().get('AcroForm')) as PdfDict;
const nameOf = (o: MaybeObj) => (isName(o) ? o.name : undefined);

describe('form fixture', () => {
  it('opens with one page and an /AcroForm dict', () => {
    const doc = open();
    expect(doc.Pages.length).toBe(1);
    expect(isDict(doc.resolve(doc.catalog().get('AcroForm')))).toBe(true);
  });
});

describe('Form enumeration', () => {
  it('lists terminal fields in tree order with Name/FullName/Type', () => {
    const form = open().Form;
    expect(form.Fields.map((f) => [f.FullName, f.Type])).toEqual([
      ['name', 'text'],
      ['agree', 'checkbox'],
      ['color', 'radio'],
      ['size', 'choice'],
      ['parent.child', 'text'],
      ['tags', 'choice'],
      ['sig', 'signature'],
      ['font', 'choice'],
    ]);
  });

  it('Get finds a field by FullName; Name is the partial name', () => {
    const form = open().Form;
    const child = form.Get('parent.child');
    expect(child).toBeDefined();
    expect(child!.Name).toBe('child');
    expect(form.Get('nope')).toBeUndefined();
  });

  it('Dict is the live terminal field dict', () => {
    const doc = open();
    const f = doc.Form.Get('name')!;
    expect(isDict(f.Dict)).toBe(true);
    expect(isName(f.Dict.get('FT') as MaybeObj)).toBe(true);
  });
});

describe('Field.Value getter', () => {
  it('reads text, checkbox, radio, and choice values', () => {
    const form = open().Form;
    expect(form.Get('name')!.Value).toBe('Bob');
    expect(form.Get('agree')!.Value).toBe(false);   // /V /Off
    expect(form.Get('color')!.Value).toBe('Red');
    expect(form.Get('size')!.Value).toBe('M');
  });

  it('resolves /V inherited from a parent field', () => {
    expect(open().Form.Get('parent.child')!.Value).toBe('inherited');
  });

  it('returns "" for absent values', () => {
    const form = open().Form;
    expect(form.Get('tags')!.Value).toBe('');
    expect(form.Get('sig')!.Value).toBe('');
  });
});

describe('Field.Options', () => {
  it('returns choice /Opt export values (pairs contribute the export element)', () => {
    const form = open().Form;
    expect(form.Get('size')!.Options).toEqual(['S', 'M', 'L']);
    expect(form.Get('tags')!.Options).toEqual(['a', 'b', 'c']);
  });

  it('returns widget on-states for radio groups and checkboxes', () => {
    const form = open().Form;
    expect(form.Get('color')!.Options).toEqual(['Red', 'Green']);
    expect(form.Get('agree')!.Options).toEqual(['Yes']);
  });

  it('returns [] for other field types', () => {
    expect(open().Form.Get('name')!.Options).toEqual([]);
  });
});

describe('text setter', () => {
  it('sets /V, generates /AP without NeedAppearances, and round-trips through Save', () => {
    const doc = open();
    doc.Form.Get('name')!.Value = 'Алиса';            // non-ASCII → UTF-16BE path
    expect(doc.Form.Get('name')!.Value).toBe('Алиса');
    expect(isDict(doc.resolve(doc.Form.Get('name')!.Dict.get('AP')))).toBe(true);
    expect(acroForm(doc).has('NeedAppearances')).toBe(false);
    const re = reopen(doc);
    expect(re.Form.Get('name')!.Value).toBe('Алиса');
    expect(isDict(re.resolve(re.Form.Get('name')!.Dict.get('AP')))).toBe(true);
  });

  it('writes the inherited-V child field without touching the parent /V', () => {
    const doc = open();
    doc.Form.Get('parent.child')!.Value = 'own';
    expect(doc.Form.Get('parent.child')!.Value).toBe('own');
    const re = reopen(doc);
    expect(re.Form.Get('parent.child')!.Value).toBe('own');
  });

  it('rejects non-string values with TypeError, leaving the dict unchanged', () => {
    const doc = open();
    const f = doc.Form.Get('name')!;
    expect(() => { f.Value = true; }).toThrow(TypeError);
    expect(f.Value).toBe('Bob');
    expect(acroForm(doc).get('NeedAppearances')).toBeUndefined();
  });
});

describe('checkbox setter', () => {
  it('checks via /V + /AS using the AP on-state, and round-trips', () => {
    const doc = open();
    const f = doc.Form.Get('agree')!;
    f.Value = true;
    expect(f.Value).toBe(true);
    expect(nameOf(f.Dict.get('V'))).toBe('Yes');
    expect(nameOf(f.Dict.get('AS'))).toBe('Yes');
    expect(acroForm(doc).get('NeedAppearances')).toBeUndefined(); // buttons reuse appearances
    const re = reopen(doc);
    expect(re.Form.Get('agree')!.Value).toBe(true);
  });

  it('unchecks back to /Off', () => {
    const doc = open();
    const f = doc.Form.Get('agree')!;
    f.Value = true;
    f.Value = false;
    expect(f.Value).toBe(false);
    expect(nameOf(f.Dict.get('V'))).toBe('Off');
    expect(nameOf(f.Dict.get('AS'))).toBe('Off');
  });

  it('rejects non-boolean values with TypeError', () => {
    expect(() => { open().Form.Get('agree')!.Value = 'Yes'; }).toThrow(TypeError);
  });
});

const kidDicts = (doc: Document, kids: MaybeObj): PdfDict[] =>
  (doc.resolve(kids) as PdfObject[]).map((k) => doc.resolve(k) as PdfDict);

describe('radio setter', () => {
  it('sets /V on the group and /AS on the matching kid only; round-trips', () => {
    const doc = open();
    const f = doc.Form.Get('color')!;
    f.Value = 'Green';
    expect(f.Value).toBe('Green');
    const [red, green] = kidDicts(doc, f.Dict.get('Kids'));
    expect(nameOf(red.get('AS'))).toBe('Off');
    expect(nameOf(green.get('AS'))).toBe('Green');
    expect(acroForm(doc).get('NeedAppearances')).toBeUndefined();
    expect(reopen(doc).Form.Get('color')!.Value).toBe('Green');
  });

  it('accepts Off to clear the group', () => {
    const doc = open();
    const f = doc.Form.Get('color')!;
    f.Value = 'Off';
    expect(f.Value).toBe('Off');
    const [red, green] = kidDicts(doc, f.Dict.get('Kids'));
    expect(nameOf(red.get('AS'))).toBe('Off');
    expect(nameOf(green.get('AS'))).toBe('Off');
  });

  it('rejects an unknown export value with RangeError, leaving state intact', () => {
    const doc = open();
    const f = doc.Form.Get('color')!;
    expect(() => { f.Value = 'Blue'; }).toThrow(RangeError);
    expect(f.Value).toBe('Red');
  });

  it('rejects non-string values with TypeError', () => {
    expect(() => { open().Form.Get('color')!.Value = true; }).toThrow(TypeError);
  });
});

describe('choice setter', () => {
  it('sets a valid option, deletes stale /I, generates /AP, round-trips', () => {
    const doc = open();
    const f = doc.Form.Get('size')!;
    f.Value = 'L';
    expect(f.Value).toBe('L');
    expect(f.Dict.has('I')).toBe(false);
    expect(isDict(doc.resolve(f.Dict.get('AP')))).toBe(true);
    expect(acroForm(doc).has('NeedAppearances')).toBe(false);
    expect(reopen(doc).Form.Get('size')!.Value).toBe('L');
  });

  it('rejects a value outside /Opt with RangeError', () => {
    const doc = open();
    const f = doc.Form.Get('size')!;
    expect(() => { f.Value = 'XL'; }).toThrow(RangeError);
    expect(f.Value).toBe('M');
  });

  it('rejects an array on a non-multiselect field with TypeError', () => {
    expect(() => { open().Form.Get('size')!.Value = ['S', 'M']; }).toThrow(TypeError);
  });

  it('accepts string[] on a multiselect field and round-trips the array', () => {
    const doc = open();
    doc.Form.Get('tags')!.Value = ['a', 'c'];
    expect(doc.Form.Get('tags')!.Value).toEqual(['a', 'c']);
    expect(reopen(doc).Form.Get('tags')!.Value).toEqual(['a', 'c']);
  });

  it('allows free text on an editable combo (no /Opt validation)', () => {
    const doc = open();
    doc.Form.Get('font')!.Value = 'Times';
    expect(doc.Form.Get('font')!.Value).toBe('Times');
  });

  it('rejects non-string/array values with TypeError', () => {
    expect(() => { open().Form.Get('size')!.Value = true; }).toThrow(TypeError);
  });
});

describe('edges', () => {
  it('throws UnsupportedFeatureError when setting a signature field', () => {
    expect(() => { open().Form.Get('sig')!.Value = 'x'; }).toThrow(UnsupportedFeatureError);
  });

  it('yields an empty Form for a document without /AcroForm', () => {
    const doc = Document.Open(buildClassicPdf(1));
    expect(doc.Form.Fields).toEqual([]);
    expect(doc.Form.Get('name')).toBeUndefined();
  });
});

describe('typed field handles', () => {
  it('returns a subclass per field type from Form.Fields', () => {
    const form = open().Form;
    expect(form.Get('name')).toBeInstanceOf(TextField);
    expect(form.Get('agree')).toBeInstanceOf(CheckboxField);
    expect(form.Get('color')).toBeInstanceOf(RadioField);
    expect(form.Get('size')).toBeInstanceOf(ChoiceField);
    expect(form.Get('parent.child')).toBeInstanceOf(TextField);
  });

  it('returns the base Field for signature fields, which are not creatable', () => {
    const sig = open().Form.Get('sig')!;
    expect(sig).toBeInstanceOf(Field);
    expect(sig).not.toBeInstanceOf(TextField);
    expect(sig.Type).toBe('signature');
  });

  it('keeps every subclass a Field, so existing readers are unaffected', () => {
    for (const f of open().Form.Fields) expect(f).toBeInstanceOf(Field);
  });
});
