import { describe, it, expect } from 'vitest';
import {
  checkWidgetStyle, applyWidgetStyle, type FieldBorderStyle, type WidgetStyle,
} from '../src/fieldstyle.js';
import { mkOps, widgetGeom } from '../src/appearance.js';
import { regeneratePushButtonAP } from '../src/buttonap.js';
import { makePng } from './helpers/make-png.js';
import { Document } from '../src/document.js';
import { buildBlankPage } from './helpers/build-blank-page.js';
import { PdfDict, PdfObject, isArray, isDict, isName, isStream } from '../src/types.js';

const blank = () => Document.Open(buildBlankPage());
const sub = (d: Document, w: PdfDict, k: string) => d.resolve(w.get(k)) as PdfDict;

describe('checkWidgetStyle', () => {
  it('normalizes colours and defaults', () => {
    const n = checkWidgetStyle({ backgroundColor: [1, 0, 0], borderColor: null });
    expect(n.bg).toEqual([1, 0, 0]);
    expect(n.bc).toBeNull();
    expect(n.width).toBeUndefined();
  });

  it('rejects a colour that is not three numbers', () => {
    expect(() => checkWidgetStyle({ backgroundColor: [1, 0] as never })).toThrow(TypeError);
  });

  it('rejects a colour component outside 0..1', () => {
    expect(() => checkWidgetStyle({ borderColor: [0, 0, 2] })).toThrow(TypeError);
  });

  it('rejects a negative borderWidth', () => {
    expect(() => checkWidgetStyle({ borderWidth: -1 })).toThrow(TypeError);
  });

  it('rejects an unknown borderStyle', () => {
    expect(() => checkWidgetStyle({ borderStyle: 'groovy' as never })).toThrow(TypeError);
  });

  it('rejects an empty or non-positive dashPattern', () => {
    expect(() => checkWidgetStyle({ borderStyle: 'dashed', dashPattern: [] })).toThrow(TypeError);
    expect(() => checkWidgetStyle({ borderStyle: 'dashed', dashPattern: [0] })).toThrow(TypeError);
  });

  it('rejects a dashPattern on a non-dashed border', () => {
    expect(() => checkWidgetStyle({ borderStyle: 'beveled', dashPattern: [3] }))
      .toThrow(RangeError);
  });

  it('accepts the four quarter turns and rejects anything else', () => {
    for (const rotate of [0, 90, 180, 270] as const)
      expect(checkWidgetStyle({ rotate }).rotate).toBe(rotate);
    // /MK /R is defined only in quarter turns; a viewer given 45 is entitled to
    // ignore it, so the appearance we drew would not match what it shows.
    expect(() => checkWidgetStyle({ rotate: 45 as never })).toThrow(TypeError);
    expect(() => checkWidgetStyle({ rotate: -90 as never })).toThrow(TypeError);
  });
});

describe('applyWidgetStyle', () => {
  it('writes /MK /BG and /BC, and an empty array for null', () => {
    const doc = blank();
    const w: PdfDict = new Map<string, PdfObject>();
    applyWidgetStyle(doc, w, checkWidgetStyle({ backgroundColor: [0, 0, 1], borderColor: null }));
    const mk = sub(doc, w, 'MK');
    expect(doc.resolve(mk.get('BG'))).toEqual([0, 0, 1]);
    expect(doc.resolve(mk.get('BC'))).toEqual([]);
  });

  it('writes /BS with /W 1 and /S /S by default', () => {
    const doc = blank();
    const w: PdfDict = new Map<string, PdfObject>();
    applyWidgetStyle(doc, w, checkWidgetStyle({ borderColor: [0, 0, 0] }));
    const bs = sub(doc, w, 'BS');
    expect(doc.resolve(bs.get('W'))).toBe(1);
    const s = doc.resolve(bs.get('S'));
    expect(isName(s) && s.name).toBe('S');
  });

  it('writes /BS /D only for a dashed border', () => {
    const doc = blank();
    const w: PdfDict = new Map<string, PdfObject>();
    applyWidgetStyle(doc, w, checkWidgetStyle({
      borderColor: [0, 0, 0], borderStyle: 'dashed', dashPattern: [4, 2],
    }));
    const bs = sub(doc, w, 'BS');
    const s = doc.resolve(bs.get('S'));
    expect(isName(s) && s.name).toBe('D');
    expect(doc.resolve(bs.get('D'))).toEqual([4, 2]);
  });

  it('writes no /BS at all when no border key is given', () => {
    const doc = blank();
    const w: PdfDict = new Map<string, PdfObject>();
    applyWidgetStyle(doc, w, checkWidgetStyle({ backgroundColor: [1, 1, 1] }));
    expect(w.has('BS')).toBe(false);
    expect(isDict(doc.resolve(w.get('MK')))).toBe(true);
  });

  it('writes /MK /R, creating /MK when there is nothing else to write', () => {
    const doc = blank();
    const w: PdfDict = new Map<string, PdfObject>();
    applyWidgetStyle(doc, w, checkWidgetStyle({ rotate: 90 }));
    expect(doc.resolve(sub(doc, w, 'MK').get('R'))).toBe(90);
    // A rotation alone is not a border key, so it must not conjure a /BS.
    expect(w.has('BS')).toBe(false);
  });

  it('leaves absent keys alone on an existing /MK', () => {
    const doc = blank();
    const w: PdfDict = new Map<string, PdfObject>([
      ['MK', new Map<string, PdfObject>([
        ['BG', [1, 1, 1]],
        ['CA', { kind: 'string', bytes: new Uint8Array([65]) }],
      ])],
    ]);
    applyWidgetStyle(doc, w, checkWidgetStyle({ borderColor: [0, 0, 0] }));
    const mk = sub(doc, w, 'MK');
    expect(doc.resolve(mk.get('BG'))).toEqual([1, 1, 1]);
    expect(mk.has('CA')).toBe(true);
    expect(isArray(doc.resolve(mk.get('BC')))).toBe(true);
  });
});

const styledWidget = (doc: Document, style: WidgetStyle) => {
  const w: PdfDict = new Map<string, PdfObject>([['Rect', [0, 0, 100, 20]]]);
  applyWidgetStyle(doc, w, checkWidgetStyle({
    backgroundColor: [1, 1, 1], borderColor: [0, 0, 0], ...style,
  }));
  return w;
};

describe('mkOps border styles', () => {
  it('draws all five styles differently', () => {
    const doc = blank();
    const styles: FieldBorderStyle[] =
      ['solid', 'dashed', 'beveled', 'inset', 'underline'];
    const drawn = styles.map((borderStyle) => {
      const w = styledWidget(doc, borderStyle === 'dashed'
        ? { borderStyle, dashPattern: [4, 2] } : { borderStyle });
      return mkOps(doc, w, widgetGeom(doc, w)!).ops;
    });
    for (let i = 0; i < drawn.length; i++)
      for (let j = i + 1; j < drawn.length; j++)
        expect(drawn[i], `${styles[i]} vs ${styles[j]}`).not.toBe(drawn[j]);
  });

  it('emits the dash array as a `d` operator', () => {
    const doc = blank();
    const w = styledWidget(doc, { borderStyle: 'dashed', dashPattern: [4, 2] });
    expect(mkOps(doc, w, widgetGeom(doc, w)!).ops).toContain('[4 2] 0 d');
  });

  it('insets by the border width for solid, twice that for beveled, none for underline', () => {
    const doc = blank();
    const inset = (s: FieldBorderStyle) => {
      const w = styledWidget(doc, { borderStyle: s, borderWidth: 3 });
      return mkOps(doc, w, widgetGeom(doc, w)!).inset;
    };
    expect(inset('solid')).toBe(3);
    expect(inset('beveled')).toBe(6);
    expect(inset('inset')).toBe(6);
    expect(inset('underline')).toBe(0);
  });

  it('falls back to solid for an unrecognised /BS /S', () => {
    const doc = blank();
    const solid = styledWidget(doc, { borderStyle: 'solid' });
    const weird = styledWidget(doc, {});
    (doc.resolve(weird.get('BS')) as PdfDict).set('S', { kind: 'name', name: 'Z' });
    expect(mkOps(doc, weird, widgetGeom(doc, weird)!).ops)
      .toBe(mkOps(doc, solid, widgetGeom(doc, solid)!).ops);
  });
});

const streamText = (o: unknown) =>
  isStream(o as never) ? new TextDecoder('latin1').decode((o as { raw: Uint8Array }).raw) : '';

describe('button mark colour', () => {
  it('draws a checkbox check in the /DA colour, not black', () => {
    const doc = blank();
    const f = doc.Form.AddCheckbox({
      page: 1, rect: [10, 10, 30, 30], name: 'agree',
      checked: true, textColor: [1, 0, 0],
    });
    const ap = doc.resolve(f.Dict.get('AP')) as PdfDict;
    const n = doc.resolve(ap.get('N')) as PdfDict;
    const on = streamText(doc.resolve(n.get('Yes')));
    expect(on).toContain('/ZaDb');
    expect(on).toContain('1 0 0 rg');
    expect(on).not.toContain('0 g\n');
  });
});

describe('styling at creation', () => {
  it('lands the style on a text field widget and its /DA', () => {
    const doc = blank();
    const f = doc.Form.AddTextField({
      page: 1, rect: [10, 10, 200, 30], name: 'nm',
      backgroundColor: [0.9, 0.9, 1], borderColor: [0, 0, 0.5],
      borderWidth: 2, borderStyle: 'beveled',
      font: 'Times-Bold', fontSize: 11, textColor: [1, 0, 0],
    });
    const mk = sub(doc, f.Dict, 'MK');
    expect(doc.resolve(mk.get('BG'))).toEqual([0.9, 0.9, 1]);
    expect(doc.resolve(mk.get('BC'))).toEqual([0, 0, 0.5]);
    const bs = sub(doc, f.Dict, 'BS');
    expect(doc.resolve(bs.get('W'))).toBe(2);
    const s = doc.resolve(bs.get('S'));
    expect(isName(s) && s.name).toBe('B');
    const da = doc.resolve(f.Dict.get('DA')) as { bytes: Uint8Array };
    expect(new TextDecoder('latin1').decode(da.bytes)).toBe('/TiBo 11 Tf 1 0 0 rg');
  });

  it('puts /MK and /BS on each radio kid, and the colour in the parent /DA', () => {
    const doc = blank();
    const f = doc.Form.AddRadioGroup({
      name: 'pick',
      options: [
        { page: 1, rect: [10, 10, 30, 30], export: 'a' },
        { page: 1, rect: [40, 10, 60, 30], export: 'b' },
      ],
      backgroundColor: [1, 1, 1], borderColor: [0, 0, 0], textColor: [0, 0.5, 0],
    });
    expect(f.Dict.has('MK')).toBe(false);
    expect(f.Dict.has('BS')).toBe(false);
    const kids = doc.resolve(f.Dict.get('Kids')) as PdfObject[];
    expect(kids.length).toBe(2);
    for (const k of kids) {
      const w = doc.resolve(k) as PdfDict;
      expect(doc.resolve(sub(doc, w, 'MK').get('BG'))).toEqual([1, 1, 1]);
      expect(sub(doc, w, 'BS').has('S')).toBe(true);
    }
    const da = doc.resolve(f.Dict.get('DA')) as { bytes: Uint8Array };
    expect(new TextDecoder('latin1').decode(da.bytes)).toContain('0 0.5 0 rg');
  });

  it('leaves the document byte-identical when the style is rejected', () => {
    const doc = blank();
    doc.Form.AddTextField({ page: 1, rect: [10, 10, 200, 30], name: 'ok' });
    const before = doc.Save().length;
    expect(() => doc.Form.AddTextField({
      page: 1, rect: [10, 40, 200, 60], name: 'bad', borderColor: [0, 0, 5],
    })).toThrow(TypeError);
    expect(doc.Save().length).toBe(before);
  });
});

describe('push button defaults', () => {
  const mkOf = (doc: Document, f: { Dict: PdfDict }) => sub(doc, f.Dict, 'MK');

  it('applies the grey face when neither colour is given', () => {
    const doc = blank();
    const f = doc.Form.AddPushButton({ page: 1, rect: [10, 10, 90, 34], name: 'go', caption: 'Go' });
    expect(doc.resolve(mkOf(doc, f).get('BG'))).toEqual([0.86, 0.86, 0.86]);
    expect(doc.resolve(mkOf(doc, f).get('BC'))).toEqual([0.5, 0.5, 0.5]);
  });

  it('drops both defaults as soon as either colour is given', () => {
    const doc = blank();
    const f = doc.Form.AddPushButton({
      page: 1, rect: [10, 10, 90, 34], name: 'go', caption: 'Go',
      backgroundColor: [0, 0, 1],
    });
    expect(doc.resolve(mkOf(doc, f).get('BG'))).toEqual([0, 0, 1]);
    expect(mkOf(doc, f).has('BC')).toBe(false);
  });

  it('lets null suppress the default face', () => {
    const doc = blank();
    const f = doc.Form.AddPushButton({
      page: 1, rect: [10, 10, 90, 34], name: 'go', caption: 'Go',
      backgroundColor: null, borderColor: null,
    });
    expect(doc.resolve(mkOf(doc, f).get('BG'))).toEqual([]);
    const ap = doc.resolve(f.Dict.get('AP')) as PdfDict;
    expect(streamText(doc.resolve(ap.get('N')))).not.toContain(' re f');
  });
});

describe('regeneratePushButtonAP', () => {
  it('rebuilds all three streams, keeping caption, layout and icon', () => {
    const doc = blank();
    const f = doc.Form.AddPushButton({
      page: 1, rect: [10, 10, 90, 44], name: 'go',
      caption: 'Go', downCaption: 'Going', icon: makePng(),
      iconPosition: 'icon-above-caption',
    });
    const acro = doc.resolve(doc.catalog().get('AcroForm')) as PdfDict;
    const beforeN = (doc.resolve(f.Dict.get('AP')) as PdfDict).get('N');

    regeneratePushButtonAP(doc, f.Dict, acro);

    const after = doc.resolve(f.Dict.get('AP')) as PdfDict;
    expect([...after.keys()].sort()).toEqual(['D', 'N', 'R']);
    expect(after.get('N')).not.toBe(beforeN);       // a fresh stream
    const n = streamText(doc.resolve(after.get('N')));
    expect(n).toContain('(Go) Tj');
    expect(n).toContain('/BtnIco Do');
    expect(streamText(doc.resolve(after.get('D')))).toContain('(Going) Tj');
  });

  it('recovers the icon from /MK /I when there is no appearance to read', () => {
    const doc = blank();
    const f = doc.Form.AddPushButton({
      page: 1, rect: [10, 10, 90, 44], name: 'go',
      caption: 'Go', icon: makePng(), iconPosition: 'icon-only',
    });
    const acro = doc.resolve(doc.catalog().get('AcroForm')) as PdfDict;
    const icon = (doc.resolve(f.Dict.get('MK')) as PdfDict).get('I');
    // A producer that wrote /MK but left the appearance to the viewer. The
    // /AP resources are the usual source for the icon and there are none, so
    // /MK /I is the only thing left saying the button has one at all.
    f.Dict.delete('AP');

    regeneratePushButtonAP(doc, f.Dict, acro);

    const ap = doc.resolve(f.Dict.get('AP')) as PdfDict;
    expect(streamText(doc.resolve(ap.get('N')))).toContain('/BtnIco Do');
    // And it is still the same object, not a second copy.
    const n = doc.resolve(ap.get('N')) as { dict: PdfDict };
    const res = doc.resolve(n.dict.get('Resources')) as PdfDict;
    expect((doc.resolve(res.get('XObject')) as PdfDict).get('BtnIco')).toEqual(icon);
  });

  it('still sizes an icon an earlier release stored as a bare image', () => {
    const doc = blank();
    const f = doc.Form.AddPushButton({
      page: 1, rect: [10, 10, 90, 44], name: 'go', icon: makePng(),
      iconPosition: 'icon-only',
    });
    const acro = doc.resolve(doc.catalog().get('AcroForm')) as PdfDict;
    // Unwrap it back to what earlier releases wrote: the 2x2 image itself in
    // the appearance resources, with no form around it.
    const mk = doc.resolve(f.Dict.get('MK')) as PdfDict;
    const form = doc.resolve(mk.get('I')) as { dict: PdfDict };
    const inner = doc.resolve(form.dict.get('Resources')) as PdfDict;
    const imgRef = (doc.resolve(inner.get('XObject')) as PdfDict).get('Im0')!;
    mk.delete('I');
    mk.delete('IF');
    const n = doc.resolve((doc.resolve(f.Dict.get('AP')) as PdfDict).get('N')) as { dict: PdfDict };
    (doc.resolve(doc.resolve(n.dict.get('Resources')) as PdfDict) as PdfDict)
      .set('XObject', new Map<string, PdfObject>([['BtnIco', imgRef]]));

    regeneratePushButtonAP(doc, f.Dict, acro);

    // An image draws into the unit square, so the `cm` carries the drawn size
    // (32pt square, centred in the 78x32 inset box). Reading its /BBox instead
    // would find none and drop the icon; treating it as a form would scale it
    // by 16 and draw a 2pt speck.
    const rebuilt = streamText(doc.resolve((doc.resolve(f.Dict.get('AP')) as PdfDict).get('N')));
    expect(rebuilt).toContain('32 0 0 32 24 1 cm');
  });

  it('reuses the icon object rather than embedding it again', () => {
    const doc = blank();
    const f = doc.Form.AddPushButton({
      page: 1, rect: [10, 10, 90, 44], name: 'go',
      caption: 'Go', icon: makePng(), iconPosition: 'icon-only',
    });
    const acro = doc.resolve(doc.catalog().get('AcroForm')) as PdfDict;
    const iconRefOf = (): PdfObject => {
      const ap = doc.resolve(f.Dict.get('AP')) as PdfDict;
      const n = doc.resolve(ap.get('N')) as { dict: PdfDict };
      const res = doc.resolve(n.dict.get('Resources')) as PdfDict;
      return (doc.resolve(res.get('XObject')) as PdfDict).get('BtnIco')!;
    };
    const first = iconRefOf();
    regeneratePushButtonAP(doc, f.Dict, acro);
    regeneratePushButtonAP(doc, f.Dict, acro);
    expect(iconRefOf()).toEqual(first);
  });
});

describe('Field.SetStyle', () => {
  it('restyles a text field parsed back from saved bytes', () => {
    const src = blank();
    src.Form.AddTextField({ page: 1, rect: [10, 10, 200, 30], name: 'nm', value: 'hi' });
    const doc = Document.Open(src.Save());

    const f = doc.Form.Get('nm')!;
    f.SetStyle({ backgroundColor: [1, 1, 0], borderColor: [1, 0, 0], borderWidth: 2 });

    expect(doc.resolve(sub(doc, f.Dict, 'MK').get('BG'))).toEqual([1, 1, 0]);
    const ap = doc.resolve(f.Dict.get('AP')) as PdfDict;
    expect(streamText(doc.resolve(ap.get('N')))).toContain('1 1 0 rg');
  });

  it('keeps unspecified /DA parts and rewrites the given ones', () => {
    const doc = blank();
    const f = doc.Form.AddTextField({
      page: 1, rect: [10, 10, 200, 30], name: 'nm', font: 'Times-Bold', fontSize: 11,
    });
    f.SetStyle({ textColor: [0, 0, 1] });
    const da = doc.resolve(f.Dict.get('DA')) as { bytes: Uint8Array };
    expect(new TextDecoder('latin1').decode(da.bytes)).toBe('/TiBo 11 Tf 0 0 1 rg');
  });

  it('replaces a checkbox appearance that already has /AP states', () => {
    const doc = blank();
    const f = doc.Form.AddCheckbox({
      page: 1, rect: [10, 10, 30, 30], name: 'agree', exportValue: 'On', checked: true,
    });
    const n = () => doc.resolve((doc.resolve(f.Dict.get('AP')) as PdfDict).get('N')) as PdfDict;
    expect(streamText(doc.resolve(n().get('On')))).not.toContain('0 0 1 rg');
    f.SetStyle({ textColor: [0, 0, 1], backgroundColor: [1, 1, 1] });
    // The on-state is still keyed by the export value, and it was rebuilt.
    expect([...n().keys()].sort()).toEqual(['Off', 'On']);
    expect(streamText(doc.resolve(n().get('On')))).toContain('0 0 1 rg');
  });

  it('restyles a push button without losing its icon or captions', () => {
    const doc = blank();
    const f = doc.Form.AddPushButton({
      page: 1, rect: [10, 10, 90, 44], name: 'go',
      caption: 'Go', icon: makePng(), iconPosition: 'icon-above-caption',
    });
    f.SetStyle({ backgroundColor: [0, 0, 0.5], borderStyle: 'beveled', borderWidth: 2 });
    const ap = doc.resolve(f.Dict.get('AP')) as PdfDict;
    expect([...ap.keys()].sort()).toEqual(['D', 'N', 'R']);
    const n = streamText(doc.resolve(ap.get('N')));
    expect(n).toContain('(Go) Tj');
    expect(n).toContain('/BtnIco Do');
    expect(n).toContain('0 0 0.5 rg');
  });

  it('leaves the document byte-identical when the style is rejected', () => {
    const doc = blank();
    const f = doc.Form.AddTextField({ page: 1, rect: [10, 10, 200, 30], name: 'nm' });
    const before = doc.Save().length;
    expect(() => f.SetStyle({ borderWidth: -3 })).toThrow(TypeError);
    expect(() => f.SetStyle({ borderStyle: 'beveled', dashPattern: [2] })).toThrow(RangeError);
    expect(doc.Save().length).toBe(before);
  });
});

describe('widget rotation (/MK /R)', () => {
  const bboxOf = (doc: Document, f: { Dict: PdfDict }): number[] => {
    const ap = doc.resolve(f.Dict.get('AP')) as PdfDict;
    const n = doc.resolve(ap.get('N')) as { dict: PdfDict };
    return doc.resolve(n.dict.get('BBox')) as number[];
  };

  it('turns a field at creation and lays its appearance out sideways', () => {
    const doc = blank();
    const f = doc.Form.AddTextField({
      page: 1, rect: [10, 10, 210, 60], name: 'nm', value: 'sideways', rotate: 90,
    });
    expect(doc.resolve(sub(doc, f.Dict, 'MK').get('R'))).toBe(90);
    // 200 x 50 on the page, composed in a 50 x 200 box.
    expect(bboxOf(doc, f)).toEqual([0, 0, 50, 200]);
  });

  it('writes no /MK /R for an unrotated field', () => {
    const doc = blank();
    const f = doc.Form.AddTextField({ page: 1, rect: [10, 10, 210, 60], name: 'nm' });
    const mk = doc.resolve(f.Dict.get('MK'));
    expect(!isDict(mk) || !(mk as PdfDict).has('R')).toBe(true);
  });

  it('re-lays a push button out when a restyle turns it', () => {
    const doc = blank();
    const f = doc.Form.AddPushButton({
      page: 1, rect: [10, 10, 90, 44], name: 'go',
      caption: 'Go', icon: makePng(), iconPosition: 'icon-above-caption',
    });
    expect(bboxOf(doc, f)).toEqual([0, 0, 80, 34]);

    f.SetStyle({ rotate: 270 });

    expect(doc.resolve(sub(doc, f.Dict, 'MK').get('R'))).toBe(270);
    expect(bboxOf(doc, f)).toEqual([0, 0, 34, 80]);
    // The rebuild still carries the whole face across.
    const ap = doc.resolve(f.Dict.get('AP')) as PdfDict;
    expect(streamText(doc.resolve(ap.get('N')))).toContain('(Go) Tj');
    expect(streamText(doc.resolve(ap.get('N')))).toContain('/BtnIco Do');
  });

  it('turns a rotation back off', () => {
    const doc = blank();
    const f = doc.Form.AddTextField({
      page: 1, rect: [10, 10, 210, 60], name: 'nm', rotate: 90,
    });
    f.SetStyle({ rotate: 0 });
    expect(doc.resolve(sub(doc, f.Dict, 'MK').get('R'))).toBe(0);
    expect(bboxOf(doc, f)).toEqual([0, 0, 200, 50]);
  });
});
