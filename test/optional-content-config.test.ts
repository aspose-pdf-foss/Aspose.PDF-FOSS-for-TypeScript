import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { isArray, isDict, isName, PdfDict } from '../src/types.js';
import { decodePng } from './helpers/decode-png.js';
import { buildOcgRenderPdf } from './helpers/build-ocg-render-pdf.js';
import { buildOcgPdf } from './helpers/build-ocg-pdf.js';

/**
 * Adopting a named configuration (q1g2.5).
 *
 * `/OCProperties /Configs` holds presets; `/D` is the one state that
 * rendering, extraction and `ApplyUsage` all read. Applying a preset COPIES it
 * into `/D` and leaves the preset in place to be chosen again.
 */

/** A hidden red block and a visible blue block, each in its own MC section. */
const TWO_LAYERS =
  '/OC /OCHid BDC 1 0 0 rg 10 10 50 50 re f EMC\n'
  + '/OC /OCVis BDC 0 0 1 rg 100 100 50 50 re f EMC\n';

const IN_HIDDEN: [number, number] = [35, 165];
const IN_VISIBLE: [number, number] = [125, 65];
const WHITE = [255, 255, 255, 255];

const pixels = (doc: Document) => {
  const png = decodePng(doc.Pages[0].ToImage());
  return (p: [number, number]) => png.at(p[0], p[1]);
};

describe('ApplyConfiguration — the acceptance criterion', () => {
  it('changes what the page renders, and leaves the preset in /Configs', () => {
    const doc = Document.Open(buildOcgRenderPdf(TWO_LAYERS));
    const oc = doc.OptionalContent;
    // A preset that inverts the default: Hidden on, Visible off.
    const preset = oc.AddConfig('Inverted');
    preset.SetVisible(oc.GetLayer('Hidden')!, true);
    preset.SetVisible(oc.GetLayer('Visible')!, false);

    expect(pixels(doc)(IN_HIDDEN)).toEqual(WHITE);          // before

    oc.ApplyConfiguration(preset);

    const at = pixels(doc);
    expect(at(IN_HIDDEN)).toEqual([255, 0, 0, 255]);        // now painted
    expect(at(IN_VISIBLE)).toEqual(WHITE);                  // now hidden
    expect(oc.GetConfig('Inverted')).toBeDefined();          // preset survives
  });

  it('changes what the page extracts', () => {
    // The same switch, seen through the OTHER consumer of /D — so the test
    // covers "the one notion of current state" rather than the renderer alone.
    const content = 'BT /F1 12 Tf 20 100 Td /OC /OCHid BDC (secret) Tj EMC ET\n';
    const doc = Document.Open(buildOcgRenderPdf(content));
    const oc = doc.OptionalContent;
    expect(doc.Pages[0].GetText()).not.toContain('secret');

    const preset = oc.AddConfig('Show all');
    preset.SetVisible(oc.GetLayer('Hidden')!, true);
    oc.ApplyConfiguration(preset);

    expect(doc.Pages[0].GetText()).toContain('secret');
  });
});

describe('ApplyConfiguration — replaces, never merges', () => {
  it('drops a /D key the preset does not state', () => {
    // The subtle wrong answer: a preset silent about /OFF leaving the old
    // /OFF standing, so the document sits in a state that is NEITHER config.
    const doc = Document.Open(buildOcgPdf());
    const oc = doc.OptionalContent;
    expect(oc.GetLayer('Layer B')!.Visible).toBe(false);     // /D /OFF holds B

    const preset = oc.AddConfig('Nothing hidden');           // states no /OFF
    oc.ApplyConfiguration(preset);

    expect(oc.Default.Dict.has('OFF')).toBe(false);
    expect(oc.GetLayer('Layer B')!.Visible).toBe(true);
  });

  it('keeps /D’s own /Name rather than adopting the preset’s', () => {
    const doc = Document.Open(buildOcgPdf());
    const oc = doc.OptionalContent;
    expect(oc.Default.Name).toBe('Default');
    oc.ApplyConfiguration(oc.GetConfig('Print')!);
    expect(oc.Default.Name).toBe('Default');
  });

  it('carries the preset’s /BaseState', () => {
    const doc = Document.Open(buildOcgPdf());
    const oc = doc.OptionalContent;
    expect(oc.Default.BaseState).toBe('ON');
    oc.ApplyConfiguration(oc.GetConfig('Print')!);            // BaseState OFF
    expect(oc.Default.BaseState).toBe('OFF');
  });

  it('carries the preset’s /AS, so ApplyUsage then reads it', () => {
    const doc = Document.Open(buildOcgPdf());
    const oc = doc.OptionalContent;
    const a = oc.GetLayer('Layer A')!;
    const preset = oc.GetConfig('Print')!;
    preset.SetUsage(a, { print: false });

    expect(oc.Default.Dict.has('AS')).toBe(false);
    oc.ApplyConfiguration(preset);
    expect(isArray(doc.resolve(oc.Default.Dict.get('AS')))).toBe(true);
    expect(oc.Default.ResolveForEvent('Print').find((s) => s.layer.Name === 'Layer A')?.visible)
      .toBe(false);
  });
});

describe('ApplyConfiguration — what is shared and what is copied', () => {
  it('does not let a later edit to /D reach back into the preset', () => {
    // Under this library's live-mutation model, copying the ARRAY OBJECT
    // rather than its contents makes /D and the preset one state wearing two
    // names: SetVisible on /D would silently rewrite the preset just applied.
    const doc = Document.Open(buildOcgPdf());
    const oc = doc.OptionalContent;
    const preset = oc.AddConfig('Snapshot');
    preset.SetVisible(oc.GetLayer('Layer A')!, false);
    oc.ApplyConfiguration(preset);

    oc.Default.SetVisible(oc.GetLayer('Layer A')!, true);

    expect(oc.GetConfig('Snapshot')!.IsVisible(oc.GetLayer('Layer A')!)).toBe(false);
  });

  it('does not share the array object with the preset', () => {
    // `LayerConfig.Dict` is a public live Map, so a caller can edit an array
    // IN PLACE — and that is the only way to see this rule, because every
    // writer in `src/` REPLACES a config array (`addTo` spreads, `removeFrom`
    // filters) rather than mutating one. Measured: a test built on
    // `SetVisible` passes with the clone deleted.
    const doc = Document.Open(buildOcgPdf());
    const oc = doc.OptionalContent;
    const preset = oc.AddConfig('Snapshot');
    preset.SetVisible(oc.GetLayer('Layer A')!, false);
    oc.ApplyConfiguration(preset);

    const off = doc.resolve(oc.Default.Dict.get('OFF'));
    (off as unknown[]).push(oc.GetLayer('Layer C')!.Ref);

    expect(preset.IsVisible(oc.GetLayer('Layer C')!)).toBe(true);
    expect(oc.GetLayer('Layer C')!.Visible).toBe(false);
  });

  it('does not share an /AS entry that names more than one layer', () => {
    // The discriminating shape: `SetUsage` drops a layer from every entry,
    // and it mutates the entry dict IN PLACE (`d.set('OCGs', …)`) only when
    // something is LEFT — an entry naming one layer hits `continue` first, so
    // a single-layer fixture cannot see a shared entry at all.
    const doc = Document.Open(buildOcgPdf());
    const oc = doc.OptionalContent;
    const [a, b] = oc.Layers;
    const preset = oc.GetConfig('Print')!;
    preset.SetUsage(a, { print: false });
    preset.SetUsage(b, { print: false });   // one Print entry, two layers
    oc.ApplyConfiguration(preset);

    oc.Default.SetUsage(a, { view: false }); // rewrites /D's entry to hold b

    const ocgsOf = (c: { Dict: PdfDict }) => {
      const as = doc.resolve(c.Dict.get('AS')) as unknown[];
      const entry = doc.resolve(as[0] as never) as PdfDict;
      return (doc.resolve(entry.get('OCGs')) as unknown[]).length;
    };
    expect(ocgsOf(preset)).toBe(2);
    expect(ocgsOf(oc.Default)).toBe(1);
  });

  it('applying /D to itself changes nothing', () => {
    // Without the guard, `copyConfigState` deletes each key from the
    // destination and then finds it absent in the source — which is the same
    // dict — so the document's whole optional-content state is erased.
    const doc = Document.Open(buildOcgPdf());
    const oc = doc.OptionalContent;
    const before = doc.Save();
    oc.ApplyConfiguration(oc.Default);
    expect(oc.Default.BaseState).toBe('ON');
    expect(oc.GetLayer('Layer B')!.Visible).toBe(false);
    expect(doc.Save()).toEqual(before);
  });

  it('keeps naming the same layers — an OCG ref is shared, not cloned', () => {
    // The other half: clone the REFS and /D names layers that do not exist.
    const doc = Document.Open(buildOcgPdf());
    const oc = doc.OptionalContent;
    const preset = oc.AddConfig('Only C');
    preset.SetVisible(oc.GetLayer('Layer C')!, false);
    oc.ApplyConfiguration(preset);
    expect(oc.GetLayer('Layer C')!.Visible).toBe(false);
  });

  it('does not let a later SetUsage on /D reach back into the preset’s /AS', () => {
    const doc = Document.Open(buildOcgPdf());
    const oc = doc.OptionalContent;
    const a = oc.GetLayer('Layer A')!;
    const events = (c: { Dict: PdfDict }) =>
      (isArray(doc.resolve(c.Dict.get('AS'))) ? doc.resolve(c.Dict.get('AS')) as unknown[] : [])
        .map((e) => {
          const ev = doc.resolve((doc.resolve(e as never) as PdfDict).get('Event'));
          return isName(ev) ? ev.name : '?';
        });

    const preset = oc.GetConfig('Print')!;
    preset.SetUsage(a, { print: false });
    oc.ApplyConfiguration(preset);

    // /D now states a VIEW usage instead. `SetUsage` drops the layer from
    // every entry first, so /D's Print entry — which named only this layer —
    // goes. Shared, that would strip the preset's Print entry too; a rewrite
    // that merely restated Print could not tell the two apart.
    oc.Default.SetUsage(a, { view: false });

    expect(events(preset)).toEqual(['Print']);
    expect(events(oc.Default)).toEqual(['View']);
  });

  it('but the GROUP’s own /Usage is shared, because it lives on the OCG', () => {
    // Reads like an inconsistency with the case above, so it is asserted:
    // `/AS` is a property of the CONFIGURATION and is copied, while `/Usage`
    // is a property of the GROUP and belongs to no configuration at all.
    // Applying a preset therefore moves which statements are APPLIED, never
    // what a group SAYS.
    const doc = Document.Open(buildOcgPdf());
    const oc = doc.OptionalContent;
    const a = oc.GetLayer('Layer A')!;
    oc.GetConfig('Print')!.SetUsage(a, { print: false });
    oc.ApplyConfiguration(oc.GetConfig('Print')!);

    oc.Default.SetUsage(a, { print: true });

    expect(a.Usage?.print).toBe(true);
    expect(oc.GetConfig('Print')!.ResolveForEvent('Print')
      .find((s) => s.layer.Name === 'Layer A')?.visible).toBe(true);
  });

  it('survives a round trip through Save()', () => {
    const doc = Document.Open(buildOcgPdf());
    const oc = doc.OptionalContent;
    const preset = oc.GetConfig('Print')!;
    oc.ApplyConfiguration(preset);

    const again = Document.Open(doc.Save()).OptionalContent;
    expect(again.Default.BaseState).toBe('OFF');
    expect(again.GetConfig('Print')).toBeDefined();
  });
});

describe('SaveConfiguration', () => {
  it('snapshots the current /D as a named preset', () => {
    const doc = Document.Open(buildOcgPdf());
    const oc = doc.OptionalContent;
    const saved = oc.SaveConfiguration('Before');
    expect(saved.Name).toBe('Before');
    expect(oc.GetConfig('Before')).toBeDefined();
    expect(saved.IsVisible(oc.GetLayer('Layer B')!)).toBe(false); // /D's state
  });

  it('is a SNAPSHOT — later edits to /D do not reach it', () => {
    const doc = Document.Open(buildOcgPdf());
    const oc = doc.OptionalContent;
    const saved = oc.SaveConfiguration('Before');
    oc.Default.SetVisible(oc.GetLayer('Layer B')!, true);
    expect(saved.IsVisible(oc.GetLayer('Layer B')!)).toBe(false);
    expect(oc.GetLayer('Layer B')!.Visible).toBe(true);
  });

  it('round-trips /D through save-then-apply', () => {
    // The pair's whole reason for existing: /D's previous state is overwritten
    // by ApplyConfiguration, so SaveConfiguration snapshots it first.
    const doc = Document.Open(buildOcgPdf());
    const oc = doc.OptionalContent;
    oc.SaveConfiguration('Before');
    oc.ApplyConfiguration(oc.GetConfig('Print')!);
    expect(oc.Default.BaseState).toBe('OFF');

    oc.ApplyConfiguration(oc.GetConfig('Before')!);
    expect(oc.Default.BaseState).toBe('ON');
    expect(oc.GetLayer('Layer B')!.Visible).toBe(false);
  });

  it('names the snapshot rather than copying /D’s own /Name', () => {
    const doc = Document.Open(buildOcgPdf());
    const saved = doc.OptionalContent.SaveConfiguration('Before');
    expect(saved.Name).toBe('Before');
    expect(doc.OptionalContent.Default.Name).toBe('Default');
  });

  it('works on a document that had no /OCProperties', () => {
    const doc = Document.Open(buildOcgPdf());
    doc.catalog().delete('OCProperties');
    const saved = doc.OptionalContent.SaveConfiguration('Empty');
    expect(saved.Name).toBe('Empty');
    expect(isDict(doc.resolve(doc.catalog().get('OCProperties')))).toBe(true);
  });
});
