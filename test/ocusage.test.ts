import { describe, it, expect } from 'vitest';
import { readUsage, writeUsage, applyUsageEntry, combineUsageStates } from '../src/ocusage.js';
import { PdfObject, PdfDict, isName, isDict, isString, name } from '../src/types.js';
import { encodePdfText, decodePdfText } from '../src/metadata.js';

/** A `Resolve` for hand-built dicts: nothing here is indirect. */
const R = (o: PdfObject | undefined): PdfObject => (o === undefined ? null : o);

const dict = (entries: [string, PdfObject][]): PdfDict => new Map(entries);
const sub = (key: string, entries: [string, PdfObject][]): PdfDict =>
  dict([[key, dict(entries)]]);

describe('readUsage — /Usage to the typed model', () => {
  it('reads the three state categories', () => {
    const u = readUsage(R, dict([
      ['View', dict([['ViewState', name('OFF')]])],
      ['Print', dict([['PrintState', name('ON')]])],
      ['Export', dict([['ExportState', name('OFF')]])],
    ]));
    expect(u.view).toBe(false);
    expect(u.print).toBe(true);
    expect(u.export).toBe(false);
  });

  it('leaves a category absent rather than defaulting it', () => {
    const u = readUsage(R, sub('View', [['ViewState', name('ON')]]));
    expect(u.view).toBe(true);
    expect(u.print).toBeUndefined();
    expect(u.export).toBeUndefined();
    expect(u.zoom).toBeUndefined();
    expect(u.language).toBeUndefined();
  });

  it('reads a /Print /Subtype beside the state', () => {
    const u = readUsage(R, sub('Print', [
      ['PrintState', name('OFF')],
      ['Subtype', name('Watermark')],
    ]));
    expect(u.print).toBe(false);
    expect(u.printSubtype).toBe('Watermark');
  });

  it('reads /Zoom, defaulting min to 0 and leaving max open', () => {
    const u = readUsage(R, sub('Zoom', [['max', 2]]));
    expect(u.zoom).toEqual({ min: 0, max: 2 });
    const v = readUsage(R, sub('Zoom', [['min', 0.5]]));
    expect(v.zoom).toEqual({ min: 0.5, max: undefined });
  });

  it('reads /Language with its /Preferred flag', () => {
    const u = readUsage(R, sub('Language', [
      ['Lang', { kind: 'string', bytes: encodePdfText('de-AT') } as PdfObject],
      ['Preferred', name('ON')],
    ]));
    expect(u.language).toEqual({ lang: 'de-AT', preferred: true });
  });

  it('reads /PageElement, /CreatorInfo and /User, which it never evaluates', () => {
    const u = readUsage(R, dict([
      ['PageElement', dict([['Subtype', name('FG')]])],
      ['CreatorInfo', dict([
        ['Creator', { kind: 'string', bytes: encodePdfText('Acme CAD') } as PdfObject],
        ['Subtype', name('Technical')],
      ])],
      ['User', dict([
        ['Type', name('Org')],
        ['Name', { kind: 'string', bytes: encodePdfText('Engineering') } as PdfObject],
      ])],
    ]));
    expect(u.pageElement).toBe('FG');
    expect(u.creatorInfo).toEqual({ creator: 'Acme CAD', subtype: 'Technical' });
    expect(u.user).toEqual({ type: 'Org', name: ['Engineering'] });
  });

  it('reads a /User /Name array whole', () => {
    const u = readUsage(R, sub('User', [
      ['Type', name('Ind')],
      ['Name', [
        { kind: 'string', bytes: encodePdfText('Ada') },
        { kind: 'string', bytes: encodePdfText('Grace') },
      ] as PdfObject],
    ]));
    expect(u.user).toEqual({ type: 'Ind', name: ['Ada', 'Grace'] });
  });

  it('ignores a state that is neither ON nor OFF', () => {
    const u = readUsage(R, sub('View', [['ViewState', name('Maybe')]]));
    expect(u.view).toBeUndefined();
  });
});

describe('writeUsage — the typed model to /Usage', () => {
  it('writes only the categories the model states', () => {
    const d = writeUsage({ print: false });
    expect([...d.keys()]).toEqual(['Print']);
    const p = d.get('Print');
    expect(isDict(p) && isName(p.get('PrintState')) && (p.get('PrintState') as { name: string }).name)
      .toBe('OFF');
  });

  it('round-trips every category through readUsage', () => {
    const u = {
      view: true,
      print: false,
      printSubtype: 'Watermark',
      export: false,
      zoom: { min: 0.5, max: 2 },
      language: { lang: 'de', preferred: true },
      pageElement: 'BG' as const,
      creatorInfo: { creator: 'Acme', subtype: 'Technical' },
      user: { type: 'Org' as const, name: ['Engineering'] },
    };
    expect(readUsage(R, writeUsage(u))).toEqual(u);
  });

  it('writes a /Zoom min of 0 rather than omitting it', () => {
    const z = writeUsage({ zoom: { min: 0, max: 1 } }).get('Zoom');
    expect(isDict(z) ? z.get('min') : undefined).toBe(0);
  });

  it('writes /Language /Lang as a text string', () => {
    const l = writeUsage({ language: { lang: 'de-AT' } }).get('Language');
    const lang = isDict(l) ? l.get('Lang') : undefined;
    expect(isString(lang) && decodePdfText(lang.bytes)).toBe('de-AT');
    expect(isDict(l) && l.has('Preferred')).toBe(false);
  });
});

describe('combineUsageStates — any category saying OFF wins', () => {
  it('is OFF when one of several categories says OFF', () => {
    expect(combineUsageStates([true, false, true])).toBe(false);
  });

  it('is ON when every category that speaks says ON', () => {
    expect(combineUsageStates([true, true])).toBe(true);
  });

  it('states nothing when no category speaks, leaving the configured state', () => {
    expect(combineUsageStates([])).toBeUndefined();
    expect(combineUsageStates([undefined, undefined])).toBeUndefined();
  });

  it('ignores the categories that decline beside one that speaks', () => {
    expect(combineUsageStates([undefined, false, undefined])).toBe(false);
    expect(combineUsageStates([undefined, true])).toBe(true);
  });
});

describe('applyUsageEntry — what one /AS entry makes of its groups', () => {
  it('turns /Print /PrintState OFF into an OFF state', () => {
    expect(applyUsageEntry([{ print: false }], ['Print'], {})).toEqual([false]);
  });

  it('states nothing for a category the group does not carry', () => {
    expect(applyUsageEntry([{ view: false }], ['Print'], {})).toEqual([undefined]);
  });

  it('states nothing for a group with no /Usage at all', () => {
    expect(applyUsageEntry([undefined], ['View', 'Print'], {})).toEqual([undefined]);
  });

  it('combines the categories one entry names, OFF winning', () => {
    const u = { view: true, print: false };
    expect(applyUsageEntry([u], ['View', 'Print'], {})).toEqual([false]);
  });

  it('answers per group, in the order it was given them', () => {
    expect(applyUsageEntry([{ print: false }, { print: true }, {}], ['Print'], {}))
      .toEqual([false, true, undefined]);
  });

  it('never evaluates /User, even when the category names it', () => {
    expect(applyUsageEntry([{ user: { type: 'Org', name: ['Engineering'] } }], ['User'], {}))
      .toEqual([undefined]);
  });

  it('never evaluates /PageElement, which carries no state', () => {
    expect(applyUsageEntry([{ pageElement: 'BG' }], ['PageElement'], {})).toEqual([undefined]);
  });

  it('states nothing for a category outside 8.11.4.4', () => {
    expect(applyUsageEntry([{ view: false }], ['Nonsense'], {})).toEqual([undefined]);
  });
});

describe('applyUsageEntry — /Zoom', () => {
  const zoomed = [{ zoom: { min: 0.5, max: 2 } }];

  it('leaves the group alone when no magnification is supplied', () => {
    expect(applyUsageEntry(zoomed, ['Zoom'], {})).toEqual([undefined]);
  });

  it('is ON inside the range and OFF outside it', () => {
    expect(applyUsageEntry(zoomed, ['Zoom'], { zoom: 1 })).toEqual([true]);
    expect(applyUsageEntry(zoomed, ['Zoom'], { zoom: 0.25 })).toEqual([false]);
    expect(applyUsageEntry(zoomed, ['Zoom'], { zoom: 4 })).toEqual([false]);
  });

  it('is half-open: min is inside the range and max is not', () => {
    expect(applyUsageEntry(zoomed, ['Zoom'], { zoom: 0.5 })).toEqual([true]);
    expect(applyUsageEntry(zoomed, ['Zoom'], { zoom: 2 })).toEqual([false]);
  });

  it('treats an absent /max as unbounded', () => {
    const u = [{ zoom: { min: 1 } }];
    expect(applyUsageEntry(u, ['Zoom'], { zoom: 1000 })).toEqual([true]);
    expect(applyUsageEntry(u, ['Zoom'], { zoom: 0.9 })).toEqual([false]);
  });
});

describe('applyUsageEntry — /Language', () => {
  const de = [{ language: { lang: 'de' } }];

  it('leaves the group alone when no language is supplied', () => {
    expect(applyUsageEntry(de, ['Language'], {})).toEqual([undefined]);
  });

  it('matches whole subtags: de covers de-AT but not den', () => {
    expect(applyUsageEntry(de, ['Language'], { language: 'de-AT' })).toEqual([true]);
    expect(applyUsageEntry([{ language: { lang: 'den' } }], ['Language'], { language: 'de-AT' }))
      .toEqual([false]);
  });

  it('is OFF for a language that does not match', () => {
    expect(applyUsageEntry(de, ['Language'], { language: 'en-GB' })).toEqual([false]);
  });

  it('keeps a /Preferred group ON when nothing in the entry matches exactly', () => {
    const groups = [{ language: { lang: 'de', preferred: true } }, { language: { lang: 'fr' } }];
    expect(applyUsageEntry(groups, ['Language'], { language: 'en' })).toEqual([true, false]);
  });

  it('turns a /Preferred group OFF when another group matches exactly', () => {
    const groups = [{ language: { lang: 'de', preferred: true } }, { language: { lang: 'en' } }];
    expect(applyUsageEntry(groups, ['Language'], { language: 'en' })).toEqual([false, true]);
  });

  it('reads the exact match across the whole entry, not per group', () => {
    // The preferred group is LAST here: a per-group test would never see the
    // exact match that precedes it.
    const groups = [{ language: { lang: 'en' } }, { language: { lang: 'de', preferred: true } }];
    expect(applyUsageEntry(groups, ['Language'], { language: 'en' })).toEqual([true, false]);
  });

  it('does not count a mere subtag match as the exact one /Preferred asks about', () => {
    const groups = [{ language: { lang: 'de', preferred: true } }, { language: { lang: 'en' } }];
    expect(applyUsageEntry(groups, ['Language'], { language: 'en-GB' })).toEqual([true, true]);
  });
});
