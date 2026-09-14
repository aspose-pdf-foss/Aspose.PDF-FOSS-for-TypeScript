import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { isDict, isArray, isName, isRef, PdfDict } from '../src/types.js';
import { buildOcgUsagePdf } from './helpers/build-ocg-usage-pdf.js';
import { buildOcgPdf } from './helpers/build-ocg-pdf.js';

const open = () => Document.Open(buildOcgUsagePdf());

/** The resolved state of the layer named `n`, for `event`. */
const stateFor = (
  doc: Document,
  event: 'View' | 'Print' | 'Export',
  n: string,
  ctx?: { zoom?: number; language?: string },
): boolean | undefined =>
  doc.OptionalContent.Default.ResolveForEvent(event, ctx)
    .find((s) => s.layer.Name === n)?.visible;

describe('Layer.Usage — reading /Usage', () => {
  it('reads a group that declines to print', () => {
    const doc = open();
    const u = doc.OptionalContent.GetLayer('Watermark')?.Usage;
    expect(u?.print).toBe(false);
    expect(u?.printSubtype).toBe('Watermark');
    expect(u?.view).toBeUndefined();
  });

  it('is undefined for a group with no /Usage', () => {
    const doc = Document.Open(buildOcgPdf());
    expect(doc.OptionalContent.GetLayer('Layer A')?.Usage).toBeUndefined();
  });
});

describe('ResolveForEvent — /Usage applied through /AS', () => {
  it('reports a not-for-print group OFF for Print and ON for View', () => {
    const doc = open();
    expect(stateFor(doc, 'Print', 'Watermark')).toBe(false);
    expect(stateFor(doc, 'View', 'Watermark')).toBe(true);
  });

  it('leaves a group with /Usage and no /AS entry at its configured state', () => {
    const doc = open();
    // "Stated" says /Print OFF and /View ON, and sits in the config's /OFF.
    // No /AS entry names it, so neither statement may move it.
    expect(stateFor(doc, 'Print', 'Stated')).toBe(false);
    expect(stateFor(doc, 'View', 'Stated')).toBe(false);
    expect(doc.OptionalContent.GetLayer('Stated')?.Visible).toBe(false);
  });

  it('reports every layer, including ones no /AS entry names', () => {
    const doc = open();
    expect(doc.OptionalContent.Default.ResolveForEvent('View').map((s) => s.layer.Name))
      .toEqual(['Watermark', 'Notes', 'Stated', 'Detail']);
  });

  it('applies an /AS entry only on its own event', () => {
    const doc = open();
    expect(stateFor(doc, 'View', 'Notes')).toBe(false);
    expect(stateFor(doc, 'Print', 'Notes')).toBe(true);
    expect(stateFor(doc, 'Export', 'Notes')).toBe(true);
  });

  it('leaves a /Zoom group alone unless a magnification is supplied', () => {
    const doc = open();
    expect(stateFor(doc, 'View', 'Detail')).toBe(true);   // configured ON
    expect(stateFor(doc, 'View', 'Detail', { zoom: 4 })).toBe(true);
    expect(stateFor(doc, 'View', 'Detail', { zoom: 1 })).toBe(false);
  });

  it('changes nothing in the document', () => {
    const doc = open();
    const before = doc.Save();
    doc.OptionalContent.Default.ResolveForEvent('Print');
    expect(doc.Save()).toEqual(before);
  });

  it('resolves against the configuration it was asked, not the default', () => {
    const doc = open();
    const cfg = doc.OptionalContent.AddConfig('Print copy');
    // The named config carries no /AS of its own, so nothing may move the
    // watermark — where the DEFAULT config's Print entry switches it off.
    // Note the two answers must be asserted together: a named config whose
    // own answer happens to agree with the default's measures nothing.
    const at = (c: { ResolveForEvent: typeof cfg.ResolveForEvent }) =>
      c.ResolveForEvent('Print').find((s) => s.layer.Name === 'Watermark')?.visible;
    expect(at(cfg)).toBe(true);
    expect(at(doc.OptionalContent.Default)).toBe(false);
  });
});

describe('ApplyUsage — making the resolved states the document’s own', () => {
  it('writes the resolved states into the configuration', () => {
    const doc = open();
    doc.OptionalContent.Default.ApplyUsage('Print');
    expect(doc.OptionalContent.GetLayer('Watermark')?.Visible).toBe(false);
  });

  it('returns only the layers whose state moved', () => {
    const doc = open();
    expect(doc.OptionalContent.Default.ApplyUsage('Print').map((l) => l.Name))
      .toEqual(['Watermark']);
  });

  it('leaves the /AS entries in place, so the statement is not destroyed', () => {
    const doc = open();
    doc.OptionalContent.Default.ApplyUsage('Print');
    const as = doc.resolve(doc.OptionalContent.Default.Dict.get('AS'));
    expect(isArray(as) && as.length).toBe(3);
  });

  it('is idempotent — a second call moves nothing', () => {
    const doc = open();
    doc.OptionalContent.Default.ApplyUsage('Print');
    expect(doc.OptionalContent.Default.ApplyUsage('Print')).toEqual([]);
  });

  it('survives a round trip through Save()', () => {
    const doc = open();
    doc.OptionalContent.Default.ApplyUsage('Print');
    const again = Document.Open(doc.Save());
    expect(again.OptionalContent.GetLayer('Watermark')?.Visible).toBe(false);
    expect(again.OptionalContent.GetLayer('Watermark')?.Usage?.print).toBe(false);
  });
});

describe('SetUsage — writing /Usage and the /AS entry that applies it', () => {
  it('writes the group’s /Usage', () => {
    const doc = Document.Open(buildOcgPdf());
    const a = doc.OptionalContent.GetLayer('Layer A')!;
    a.SetUsage({ print: false, printSubtype: 'Watermark' });
    expect(a.Usage).toEqual({ print: false, printSubtype: 'Watermark' });
  });

  it('writes the /AS entry that applies it, so the statement is not inert', () => {
    const doc = Document.Open(buildOcgPdf());
    const a = doc.OptionalContent.GetLayer('Layer A')!;
    a.SetUsage({ print: false });
    expect(a.Visible).toBe(true);
    expect(doc.OptionalContent.Default.ResolveForEvent('Print')
      .find((s) => s.layer.Name === 'Layer A')?.visible).toBe(false);
  });

  it('puts each category on the event it is applied for', () => {
    const doc = Document.Open(buildOcgPdf());
    doc.OptionalContent.GetLayer('Layer A')!.SetUsage({
      view: true, print: false, export: false, zoom: { min: 2 },
    });
    const as = doc.resolve(doc.OptionalContent.Default.Dict.get('AS'));
    const seen = (isArray(as) ? as : []).map((e) => {
      const d = doc.resolve(e) as PdfDict;
      const ev = doc.resolve(d.get('Event'));
      const cats = doc.resolve(d.get('Category'));
      return `${isName(ev) ? ev.name : '?'}:${(isArray(cats) ? cats : [])
        .map((c) => (isName(c) ? c.name : '?')).join(',')}`;
    });
    expect(seen.sort()).toEqual(['Export:Export', 'Print:Print', 'View:View', 'View:Zoom']);
  });

  it('writes no /AS entry for a category it never evaluates', () => {
    const doc = Document.Open(buildOcgPdf());
    doc.OptionalContent.GetLayer('Layer A')!.SetUsage({
      pageElement: 'BG',
      user: { type: 'Org', name: ['Engineering'] },
      creatorInfo: { creator: 'Acme', subtype: 'Technical' },
    });
    expect(doc.resolve(doc.OptionalContent.Default.Dict.get('AS'))).toBeNull();
  });

  it('adds a second group to the /AS entry it shares rather than duplicating it', () => {
    const doc = Document.Open(buildOcgPdf());
    const oc = doc.OptionalContent;
    oc.GetLayer('Layer A')!.SetUsage({ print: false });
    oc.GetLayer('Layer B')!.SetUsage({ print: false });
    const as = doc.resolve(oc.Default.Dict.get('AS'));
    expect(isArray(as) && as.length).toBe(1);
    const entry = doc.resolve((as as unknown[])[0] as never) as PdfDict;
    expect(isArray(doc.resolve(entry.get('OCGs')))
      && (doc.resolve(entry.get('OCGs')) as unknown[]).length).toBe(2);
  });

  it('does not list a group twice when its usage is rewritten', () => {
    const doc = Document.Open(buildOcgPdf());
    const a = doc.OptionalContent.GetLayer('Layer A')!;
    a.SetUsage({ print: false });
    a.SetUsage({ print: true });
    const as = doc.resolve(doc.OptionalContent.Default.Dict.get('AS'));
    const entry = doc.resolve((as as unknown[])[0] as never) as PdfDict;
    expect((doc.resolve(entry.get('OCGs')) as unknown[]).length).toBe(1);
    expect(a.Usage?.print).toBe(true);
  });

  it('drops the /AS entry for a category the rewrite no longer states', () => {
    const doc = Document.Open(buildOcgPdf());
    const a = doc.OptionalContent.GetLayer('Layer A')!;
    a.SetUsage({ print: false });
    a.SetUsage({ view: false });
    const as = doc.resolve(doc.OptionalContent.Default.Dict.get('AS'));
    const events = (isArray(as) ? as : []).map((e) => {
      const ev = doc.resolve((doc.resolve(e) as PdfDict).get('Event'));
      return isName(ev) ? ev.name : '?';
    });
    expect(events).toEqual(['View']);
  });

  it('writes into the configuration it was asked, not only the default', () => {
    const doc = Document.Open(buildOcgPdf());
    const oc = doc.OptionalContent;
    const cfg = oc.GetConfig('Print')!;
    cfg.SetUsage(oc.GetLayer('Layer A')!, { print: false });
    expect(isArray(doc.resolve(cfg.Dict.get('AS')))).toBe(true);
    expect(doc.resolve(oc.Default.Dict.get('AS'))).toBeNull();
  });

  it('round-trips the /AS entry through Save()', () => {
    const doc = Document.Open(buildOcgPdf());
    doc.OptionalContent.GetLayer('Layer A')!.SetUsage({ print: false });
    const again = Document.Open(doc.Save());
    expect(again.OptionalContent.Default.ResolveForEvent('Print')
      .find((s) => s.layer.Name === 'Layer A')?.visible).toBe(false);
  });
});

describe('/AS reading — damage costs the entry, never the document', () => {
  const asOf = (doc: Document): PdfDict => {
    const d = doc.OptionalContent.Default.Dict;
    return doc.resolve(d.get('AS')) as unknown as PdfDict;
  };

  it('ignores an entry naming no event', () => {
    const doc = open();
    const as = asOf(doc) as unknown as unknown[];
    const entry = doc.resolve(as[0] as never) as PdfDict;
    entry.delete('Event');
    expect(stateFor(doc, 'Print', 'Watermark')).toBe(true);
  });

  it('ignores an entry whose /OCGs is not an array', () => {
    const doc = open();
    const as = asOf(doc) as unknown as unknown[];
    const entry = doc.resolve(as[0] as never) as PdfDict;
    entry.set('OCGs', 7);
    expect(stateFor(doc, 'Print', 'Watermark')).toBe(true);
  });

  it('ignores an /AS that is not an array', () => {
    const doc = open();
    doc.OptionalContent.Default.Dict.set('AS', 7);
    expect(stateFor(doc, 'Print', 'Watermark')).toBe(true);
  });
});
