import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { isDict, isName, name, type PdfDict, type PdfObject } from '../src/types.js';
import type { PageTransition } from '../src/pagetransition.js';

/** A one-page A4 document. */
const doc1 = () => {
  const doc = Document.New();
  doc.AddPage(PageFormat.A4);
  return doc;
};
const reopen = (d: Document) => Document.Open(d.Save());

/** Seed a raw /Trans dict on page 1, bypassing the writer. */
const seed = (d: Document, entries: Array<[string, PdfObject]>): Document => {
  d.Pages[0].Dict.set('Trans', new Map<string, PdfObject>(entries));
  return d;
};

/** The live /Trans dict of page 1, or undefined. */
const transOf = (d: Document): PdfDict | undefined => {
  const t = d.resolve(d.Pages[0].Dict.get('Trans'));
  return isDict(t) ? t : undefined;
};

describe('page.Transition (read)', () => {
  it('is undefined when the page states no /Trans', () => {
    expect(doc1().Pages[0].Transition).toBeUndefined();
  });

  it('is an empty object for a present but empty /Trans', () => {
    // Presence is itself the statement that this page has a transition, so an
    // empty dict must not read the same as an absent one.
    expect(seed(doc1(), []).Pages[0].Transition).toEqual({});
  });

  it('reads every entry of Table 165', () => {
    const doc = seed(doc1(), [
      ['S', name('Fly')], ['D', 2.5], ['Dm', name('V')], ['M', name('O')],
      ['Di', 270], ['SS', 0.5], ['B', true],
    ]);
    expect(doc.Pages[0].Transition).toEqual({
      style: 'Fly', duration: 2.5, dimension: 'V', motion: 'O',
      direction: 270, scale: 0.5, opaque: true,
    });
  });

  it('reads the /Di name None', () => {
    const doc = seed(doc1(), [['S', name('Fly')], ['Di', name('None')]]);
    expect(doc.Pages[0].Transition).toEqual({ style: 'Fly', direction: 'None' });
  });

  it('drops an entry of the wrong type rather than throwing', () => {
    const pdfStr = { kind: 'string', bytes: new TextEncoder().encode('Fly') } as const;
    const doc = seed(doc1(), [['S', pdfStr], ['D', name('2')], ['B', 1]]);
    expect(doc.Pages[0].Transition).toEqual({});
  });

  it('drops a name outside its enumeration', () => {
    const doc = seed(doc1(), [['S', name('Swirl')], ['Dm', name('D')], ['M', name('X')]]);
    expect(doc.Pages[0].Transition).toEqual({});
  });

  it('drops a /Di outside its value set', () => {
    expect(seed(doc1(), [['Di', 45]]).Pages[0].Transition).toEqual({});
  });

  it('drops a /Di naming anything but None', () => {
    // /Di is a number OR the one name /None, so a name test that merely admits
    // names lets /Left through as a direction and past the type.
    expect(seed(doc1(), [['Di', name('Left')]]).Pages[0].Transition).toEqual({});
  });

  it('drops a non-finite /D', () => {
    expect(seed(doc1(), [['D', Number.POSITIVE_INFINITY]]).Pages[0].Transition).toEqual({});
  });

  it('does not inherit /Trans from the page tree', () => {
    // /Trans is not an inheritable page attribute (Table 30), unlike the
    // /Rotate and /Resources beside it.
    const doc = doc1();
    const parent = doc.resolve(doc.Pages[0].Dict.get('Parent'));
    if (!isDict(parent)) throw new Error('page has no /Parent dict');
    parent.set('Trans', new Map<string, PdfObject>([['S', name('Wipe')]]));
    expect(doc.Pages[0].Transition).toBeUndefined();
  });
});

describe('page.Duration (read)', () => {
  it('is undefined when the page states no /Dur', () => {
    expect(doc1().Pages[0].Duration).toBeUndefined();
  });

  it('reads /Dur', () => {
    const doc = doc1();
    doc.Pages[0].Dict.set('Dur', 4);
    expect(doc.Pages[0].Duration).toBe(4);
  });

  it('drops a /Dur that is not a finite number', () => {
    const doc = doc1();
    doc.Pages[0].Dict.set('Dur', name('4'));
    expect(doc.Pages[0].Duration).toBeUndefined();
  });

  it('does not inherit /Dur from the page tree', () => {
    const doc = doc1();
    const parent = doc.resolve(doc.Pages[0].Dict.get('Parent'));
    if (!isDict(parent)) throw new Error('page has no /Parent dict');
    parent.set('Dur', 4);
    expect(doc.Pages[0].Duration).toBeUndefined();
  });
});

describe('page.Transition (write)', () => {
  it('writes the entries it is given, with /Type /Trans', () => {
    const doc = doc1();
    doc.Pages[0].Transition = {
      style: 'Fly', duration: 2, motion: 'O', direction: 90, scale: 0.25, opaque: true,
    };
    const t = transOf(doc);
    if (!t) throw new Error('no /Trans written');
    expect(isName(t.get('Type')) && (t.get('Type') as { name: string }).name).toBe('Trans');
    expect(isName(t.get('S')) && (t.get('S') as { name: string }).name).toBe('Fly');
    expect(t.get('D')).toBe(2);
    expect(isName(t.get('M')) && (t.get('M') as { name: string }).name).toBe('O');
    expect(t.get('Di')).toBe(90);
    expect(t.get('SS')).toBe(0.25);
    expect(t.get('B')).toBe(true);
  });

  it('writes only the stated keys, materializing no defaults', () => {
    const doc = doc1();
    doc.Pages[0].Transition = { style: 'Wipe' };
    expect([...(transOf(doc) as PdfDict).keys()].sort()).toEqual(['S', 'Type']);
  });

  it('writes the /Di name None', () => {
    const doc = doc1();
    doc.Pages[0].Transition = { style: 'Fly', direction: 'None' };
    const di = (transOf(doc) as PdfDict).get('Di');
    expect(isName(di) && (di as { name: string }).name).toBe('None');
  });

  it('writes an empty /Trans for an empty object', () => {
    // Presence is the statement that the page has a transition; the spec's
    // defaults then describe it.
    const doc = doc1();
    doc.Pages[0].Transition = {};
    expect([...(transOf(doc) as PdfDict).keys()]).toEqual(['Type']);
    expect(doc.Pages[0].Transition).toEqual({});
  });

  it('replaces WHOLLY, clearing a key the new value does not state', () => {
    const doc = doc1();
    doc.Pages[0].Transition = { style: 'Fly', scale: 0.5, opaque: true };
    doc.Pages[0].Transition = { style: 'Wipe', direction: 180 };
    expect(doc.Pages[0].Transition).toEqual({ style: 'Wipe', direction: 180 });
  });

  it('deletes the dictionary for null and for undefined', () => {
    for (const empty of [null, undefined] as const) {
      const doc = doc1();
      doc.Pages[0].Transition = { style: 'Wipe' };
      doc.Pages[0].Transition = empty;
      expect(doc.Pages[0].Dict.has('Trans')).toBe(false);
    }
  });

  it('deleting from a page that has no /Trans writes nothing', () => {
    const doc = doc1();
    doc.Pages[0].Transition = null;
    expect(doc.Pages[0].Dict.has('Trans')).toBe(false);
  });

  it('survives a save and reopen', () => {
    const doc = doc1();
    doc.Pages[0].Transition = { style: 'Glitter', duration: 0.5, direction: 315 };
    expect(reopen(doc).Pages[0].Transition).toEqual({
      style: 'Glitter', duration: 0.5, direction: 315,
    });
  });
});

describe('page.Transition (validation)', () => {
  const rejects = (t: unknown, err: ErrorConstructor) => {
    const doc = doc1();
    expect(() => { doc.Pages[0].Transition = t as PageTransition; }).toThrow(err);
  };

  it('rejects a field of the wrong kind with TypeError', () => {
    rejects({ style: 7 }, TypeError);
    rejects({ duration: '2' }, TypeError);
    rejects({ opaque: 1 }, TypeError);
    rejects({ direction: true }, TypeError);
    rejects('Wipe', TypeError);
  });

  it('rejects a non-finite number with TypeError', () => {
    rejects({ duration: Number.NaN }, TypeError);
    rejects({ scale: Number.POSITIVE_INFINITY }, TypeError);
  });

  it('rejects a name outside its enumeration with RangeError', () => {
    rejects({ style: 'Swirl' }, RangeError);
    rejects({ dimension: 'D' }, RangeError);
    rejects({ motion: 'X' }, RangeError);
    rejects({ direction: 45 }, RangeError);
  });

  it('rejects a negative duration or scale with RangeError', () => {
    rejects({ duration: -1 }, RangeError);
    rejects({ scale: -0.5 }, RangeError);
  });

  it('rejects the direction 315 for any style but Glitter', () => {
    // 315 is Glitter's alone (Table 165); on a Wipe it is a value no viewer
    // honours, which renders as a plain transition rather than as an error.
    rejects({ style: 'Wipe', direction: 315 }, RangeError);
    rejects({ direction: 315 }, RangeError);
    const doc = doc1();
    expect(() => { doc.Pages[0].Transition = { style: 'Glitter', direction: 315 }; }).not.toThrow();
  });

  it("rejects the direction 'None' for any style but Fly", () => {
    rejects({ style: 'Wipe', direction: 'None' }, RangeError);
    rejects({ direction: 'None' }, RangeError);
    const doc = doc1();
    expect(() => { doc.Pages[0].Transition = { style: 'Fly', direction: 'None' }; }).not.toThrow();
  });

  it('leaves the page untouched when it rejects', () => {
    const doc = doc1();
    doc.Pages[0].Transition = { style: 'Wipe', duration: 3 };
    expect(() => {
      doc.Pages[0].Transition = { style: 'Fly', duration: 1, direction: 315 };
    }).toThrow(RangeError);
    expect(doc.Pages[0].Transition).toEqual({ style: 'Wipe', duration: 3 });
  });
});

describe('page.Duration (write)', () => {
  it('writes /Dur and survives a save and reopen', () => {
    const doc = doc1();
    doc.Pages[0].Duration = 4.5;
    expect(doc.Pages[0].Dict.get('Dur')).toBe(4.5);
    expect(reopen(doc).Pages[0].Duration).toBe(4.5);
  });

  it('deletes /Dur for null and for undefined', () => {
    for (const empty of [null, undefined] as const) {
      const doc = doc1();
      doc.Pages[0].Duration = 4;
      doc.Pages[0].Duration = empty;
      expect(doc.Pages[0].Dict.has('Dur')).toBe(false);
    }
  });

  it('rejects a non-number with TypeError and a negative with RangeError', () => {
    const doc = doc1();
    expect(() => { doc.Pages[0].Duration = '4' as unknown as number; }).toThrow(TypeError);
    expect(() => { doc.Pages[0].Duration = Number.NaN; }).toThrow(TypeError);
    expect(() => { doc.Pages[0].Duration = -1; }).toThrow(RangeError);
    expect(doc.Pages[0].Dict.has('Dur')).toBe(false);
  });
});
