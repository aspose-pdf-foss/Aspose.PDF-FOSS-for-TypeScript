import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildFormPdf } from './helpers/build-form-pdf.js';
import { isStream, isDict, isName, name, ref, PdfDict, PdfObject, PdfStream } from '../src/types.js';
import {
  widgetGeom, buildAppearanceXObject, fontResources, installAP, generateFieldAppearance,
} from '../src/appearance.js';
import { parseContentStream } from '../src/content.js';

function widget(doc: Document, objNum: number): PdfDict {
  return doc.resolve(ref(objNum)) as PdfDict;
}

function acroOf(doc: Document): PdfDict {
  return doc.resolve(doc.catalog().get('AcroForm')) as PdfDict;
}

function apStreamText(doc: Document, w: PdfDict): string {
  const ap = doc.resolve(w.get('AP')) as PdfDict;
  const n = doc.resolve(ap.get('N')) as PdfStream;
  return new TextDecoder().decode(n.raw);
}

describe('appearance envelope', () => {
  it('computes geometry from /Rect', () => {
    const doc = Document.Open(buildFormPdf());
    const g = widgetGeom(doc, widget(doc, 6)); // Rect [10 10 200 30]
    expect(g).toEqual({ w: 190, h: 20, rotate: 0 });
  });

  it('returns undefined for a zero-area/missing rect', () => {
    const doc = Document.Open(buildFormPdf());
    expect(widgetGeom(doc, new Map())).toBeUndefined();
  });

  it('builds a /Form XObject with BBox, Matrix and Resources', () => {
    const doc = Document.Open(buildFormPdf());
    const g = { w: 190, h: 20, rotate: 0 as const };
    fontResources(doc, 'Helvetica', 'Helv'); // smoke: allocates a font object
    const xobj = buildAppearanceXObject(doc, g, 'Helvetica', 'Helv', 'BT /Helv 12 Tf ET');
    expect(isStream(xobj)).toBe(true);
    const sub = xobj.dict.get('Subtype');
    expect(isName(sub) && sub.name).toBe('Form');
    expect(xobj.dict.get('BBox')).toEqual([0, 0, 190, 20]);
    expect(isDict(xobj.dict.get('Resources'))).toBe(true);
    expect(new TextDecoder().decode(xobj.raw)).toContain('/Helv 12 Tf');
  });

  it('installs /AP /N as a stream ref on the widget', () => {
    const doc = Document.Open(buildFormPdf());
    const w = widget(doc, 6);
    const g = { w: 190, h: 20, rotate: 0 as const };
    const xobj = buildAppearanceXObject(doc, g, 'Helvetica', 'Helv', '');
    installAP(doc, w, xobj);
    const ap = doc.resolve(w.get('AP')) as PdfDict;
    expect(isStream(doc.resolve(ap.get('N')))).toBe(true);
  });
});

describe('/MK /R rotated widgets', () => {
  const rotated = (r: number): PdfDict => new Map<string, PdfObject>([
    ['Rect', [10, 10, 210, 60]],   // 200 wide, 50 tall
    ['MK', new Map<string, PdfObject>([['R', r]])],
  ]);

  it('lays a quarter-turned widget out in the swapped box', () => {
    const doc = Document.Open(buildFormPdf());
    // Content for a 90/270 turn is composed in a 50x200 box and then rotated
    // onto the 200x50 rect; laying it out in the rect's own dimensions would
    // wrap and centre text against the wrong edges.
    expect(widgetGeom(doc, rotated(90))).toEqual({ w: 50, h: 200, rotate: 90 });
    expect(widgetGeom(doc, rotated(270))).toEqual({ w: 50, h: 200, rotate: 270 });
    expect(widgetGeom(doc, rotated(180))).toEqual({ w: 200, h: 50, rotate: 180 });
  });

  it('maps the appearance BBox exactly onto the rect at every rotation', () => {
    // PDF 32000-1 12.5.5: a viewer transforms /BBox by /Matrix, takes the
    // bounding box of the result and maps *that* onto /Rect. Anything but an
    // exact match silently scales the whole appearance.
    const doc = Document.Open(buildFormPdf());
    for (const r of [0, 90, 180, 270]) {
      const g = widgetGeom(doc, rotated(r))!;
      const xobj = buildAppearanceXObject(doc, g, 'Helvetica', 'Helv', '');
      const [bx, by, bw, bh] = xobj.dict.get('BBox') as number[];
      const [a, b, c, d, e, f] = xobj.dict.get('Matrix') as number[];
      const xs: number[] = [], ys: number[] = [];
      for (const [px, py] of [[bx, by], [bw, by], [bw, bh], [bx, bh]]) {
        xs.push(a * px + c * py + e);
        ys.push(b * px + d * py + f);
      }
      const box = [
        Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys),
      ].map((v) => Number(v.toFixed(6)));
      expect(box, `rotation ${r}`).toEqual([0, 0, 200, 50]);
    }
  });
});

describe('single-line text appearance', () => {
  it('emits BT/Tf/Td/Tj/ET with the value', () => {
    const doc = Document.Open(buildFormPdf());
    const field = widget(doc, 6); // text 'Bob'
    generateFieldAppearance(doc, acroOf(doc), field, 'text', 0, doc.resolve(field.get('V')));
    const t = apStreamText(doc, field);
    const ops = parseContentStream(new TextEncoder().encode(t)).map((o) => o.operator);
    expect(ops).toEqual(expect.arrayContaining(['BT', 'Tf', 'Td', 'Tj', 'ET']));
    expect(t).toContain('(Bob)');
  });

  it('right-aligns when /Q is 2', () => {
    const doc = Document.Open(buildFormPdf());
    const field = widget(doc, 6);
    field.set('Q', 2);
    generateFieldAppearance(doc, acroOf(doc), field, 'text', 0, doc.resolve(field.get('V')));
    const t = apStreamText(doc, field);
    const m = t.match(/([\d.]+) [\d.]+ Td/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(90); // box width 190 -> right-aligned x > half
  });
});

describe('multiline text appearance', () => {
  const FF_MULTILINE = 1 << 12;
  it('wraps a long value onto multiple lines', () => {
    const doc = Document.Open(buildFormPdf());
    const field = widget(doc, 6);
    const long = 'the quick brown fox jumps over the lazy dog again and again';
    field.set('V', { kind: 'string', bytes: new TextEncoder().encode(long) });
    field.set('Ff', FF_MULTILINE);
    generateFieldAppearance(doc, acroOf(doc), field, 'text', FF_MULTILINE, doc.resolve(field.get('V')));
    const t = apStreamText(doc, field);
    expect((t.match(/Tj/g) ?? []).length).toBeGreaterThan(1);
  });
});

describe('comb text appearance', () => {
  const FF_COMB = 1 << 24;
  it('emits one Tj per character across MaxLen cells', () => {
    const doc = Document.Open(buildFormPdf());
    const field = widget(doc, 6);
    field.set('V', { kind: 'string', bytes: new TextEncoder().encode('ABCD') });
    field.set('Ff', FF_COMB);
    field.set('MaxLen', 5);
    generateFieldAppearance(doc, acroOf(doc), field, 'text', FF_COMB, doc.resolve(field.get('V')));
    const t = apStreamText(doc, field);
    expect((t.match(/Tj/g) ?? []).length).toBe(4);
  });
});

describe('button + choice appearance', () => {
  const FF_COMBO = 1 << 17;

  it('preserves existing checkbox AP states', () => {
    const doc = Document.Open(buildFormPdf());
    const field = widget(doc, 7); // has AP Yes/Off
    const before = doc.resolve(field.get('AP'));
    generateFieldAppearance(doc, acroOf(doc), field, 'checkbox', 0, doc.resolve(field.get('V')));
    expect(doc.resolve(field.get('AP'))).toBe(before); // untouched
  });

  it('renders a combo box selected value', () => {
    const doc = Document.Open(buildFormPdf());
    const field = widget(doc, 11); // choice 'size' V=M, has Rect
    field.set('Ff', FF_COMBO);
    generateFieldAppearance(doc, acroOf(doc), field, 'choice', FF_COMBO, doc.resolve(field.get('V')));
    expect(apStreamText(doc, field)).toContain('(M)');
  });

  it('renders a list box with a highlight rect for the selection', () => {
    const doc = Document.Open(buildFormPdf());
    const field = widget(doc, 11);
    field.set('Ff', 0);
    generateFieldAppearance(doc, acroOf(doc), field, 'choice', 0, doc.resolve(field.get('V')));
    const t = apStreamText(doc, field);
    expect(t).toContain(' re'); // highlight rectangle
    expect(t).toContain('(M)');
  });
});

describe('content clip rect', () => {
  it('clips single-line text to the widget box', () => {
    const doc = Document.Open(buildFormPdf());
    const field = widget(doc, 6); // Rect [10 10 200 30] -> 190 x 20, no /MK
    generateFieldAppearance(doc, acroOf(doc), field, 'text', 0, doc.resolve(field.get('V')));
    const t = apStreamText(doc, field);
    expect(t).toContain('0 0 190 20 re W n');
  });

  it('insets the clip by the border width and clips after painting the border', () => {
    const doc = Document.Open(buildFormPdf());
    const field = widget(doc, 6);
    field.set('MK', new Map([['BC', [0, 0, 0]]]));
    field.set('BS', new Map([['W', 2]]));
    generateFieldAppearance(doc, acroOf(doc), field, 'text', 0, doc.resolve(field.get('V')));
    const t = apStreamText(doc, field);
    expect(t).toContain('2 2 186 16 re W n'); // box inset by border width 2
    const borderIdx = t.indexOf('re S'); // /MK border stroke
    const clipIdx = t.indexOf('re W n');
    expect(borderIdx).toBeGreaterThanOrEqual(0);
    expect(clipIdx).toBeGreaterThan(borderIdx); // clip applied after the border is drawn
  });

  it('clips list-box content too', () => {
    const doc = Document.Open(buildFormPdf());
    const field = widget(doc, 11);
    field.set('Ff', 0);
    generateFieldAppearance(doc, acroOf(doc), field, 'choice', 0, doc.resolve(field.get('V')));
    expect(apStreamText(doc, field)).toContain('re W n');
  });
});

describe('synthesized button on-state name', () => {
  const onKeys = (doc: Document, w: PdfDict) => {
    const ap = doc.resolve(w.get('AP')) as PdfDict;
    const n = doc.resolve(ap.get('N')) as PdfDict;
    return [...n.keys()].sort();
  };

  it('derives the on-state from the widget /AS', () => {
    const doc = Document.Open(buildFormPdf());
    const w = widget(doc, 7); // checkbox; strip its author AP
    w.delete('AP');
    w.set('AS', name('Yes'));
    generateFieldAppearance(doc, acroOf(doc), w, 'checkbox', 0, doc.resolve(w.get('V')));
    expect(onKeys(doc, w)).toEqual(['Off', 'Yes']);
  });

  it('derives the on-state from the field /V when /AS is absent', () => {
    const doc = Document.Open(buildFormPdf());
    const w = widget(doc, 7);
    w.delete('AP');
    w.delete('AS');
    w.set('V', name('Checked'));
    generateFieldAppearance(doc, acroOf(doc), w, 'checkbox', 0, doc.resolve(w.get('V')));
    expect(onKeys(doc, w)).toEqual(['Checked', 'Off']);
  });

  it('derives the on-state from a per-widget /Opt export value', () => {
    const doc = Document.Open(buildFormPdf());
    const w = widget(doc, 7);
    w.delete('AP');
    w.delete('AS');
    w.delete('V');
    w.set('Opt', [{ kind: 'string', bytes: new TextEncoder().encode('Export0') }]);
    generateFieldAppearance(doc, acroOf(doc), w, 'checkbox', 0, null);
    expect(onKeys(doc, w)).toEqual(['Export0', 'Off']);
  });

  it('falls back to Yes when nothing is derivable', () => {
    const doc = Document.Open(buildFormPdf());
    const w = widget(doc, 7);
    w.delete('AP');
    w.delete('AS');
    w.delete('V');
    generateFieldAppearance(doc, acroOf(doc), w, 'checkbox', 0, null);
    expect(onKeys(doc, w)).toEqual(['Off', 'Yes']);
  });

  it('setter on a checkbox with no appearances leaves /AS pointing at a real on-state', () => {
    const doc = Document.Open(buildFormPdf());
    const w = widget(doc, 7);
    w.delete('AP');
    w.delete('AS');
    w.delete('V');
    const field = doc.Form.Get('agree')!;
    field.Value = true;
    const as = doc.resolve(w.get('AS'));
    const ap = doc.resolve(w.get('AP')) as PdfDict;
    const n = doc.resolve(ap.get('N')) as PdfDict;
    expect(isName(as)).toBe(true);
    expect((as as { name: string }).name).not.toBe('Off');
    expect(n.has((as as { name: string }).name)).toBe(true); // /AS resolves to a real appearance
  });
});
