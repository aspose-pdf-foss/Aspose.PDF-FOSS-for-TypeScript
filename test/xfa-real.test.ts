import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Document } from '../src/document.js';
import { isDict, type PdfDict } from '../src/types.js';

const load = (n: string) =>
  new Uint8Array(readFileSync(new URL(`./fixtures/xfa/${n}`, import.meta.url)));

/**
 * Strip `/AcroForm /Fields` in a copy, leaving `/XFA` intact, so the conversion
 * runs from the TEMPLATE ALONE and cannot read the answer it is checked
 * against.
 *
 * This is what makes the comparison an oracle rather than a round trip: a
 * static XFA form carries two INDEPENDENT descriptions of one field set, and
 * only one of them is visible to the code under test.
 */
function stripAcroFields(bytes: Uint8Array): Document {
  const doc = Document.Open(bytes);
  const acro = doc.resolve(doc.catalog().get('AcroForm'));
  if (isDict(acro)) acro.set('Fields', []);
  for (const p of doc.Pages) p.Dict.delete('Annots');
  doc.markModified();
  return Document.Open(doc.Save());
}

const rectOf = (doc: Document, name: string): number[] =>
  doc.resolve(doc.Form.Get(name)!.Dict.get('Rect')) as number[];

describe('the hybrid oracle: IRS f1040, LiveCycle Designer 6.5', () => {
  const bytes = load('irs-f1040.pdf');

  const converted = (): {
    doc: Document;
    adobe: Map<string, number[] | null>;
    report: ReturnType<Document['ConvertXfaToAcroForm']>;
  } => {
    const src = Document.Open(bytes);
    const adobe = new Map(src.Form.Fields.map(
      (f) => [f.FullName, src.resolve(f.Dict.get('Rect')) as number[] | null],
    ));
    const doc = stripAcroFields(bytes);
    const report = doc.ConvertXfaToAcroForm({ removeXfa: false });
    return { doc, adobe, report };
  };

  // The strongest claim this fixture supports, and it is exact: every one of
  // the 199 names Adobe wrote is a name we synthesized from the template alone.
  // That validates the SOM expression -- occurrence indices included -- which is
  // what makes hybrid reconciliation a name equality rather than a heuristic.
  it('reproduces every field name Adobe wrote', () => {
    const { adobe, report } = converted();
    const mine = new Set(report.fields.map((f) => f.name));
    expect(adobe.size).toBe(199);
    expect([...adobe.keys()].filter((n) => !mine.has(n))).toEqual([]);
    expect(report.fields).toHaveLength(199);
  });

  // If the layout chain were read from the document ROOT, this would be ZERO:
  // f1040's root subform is `layout="tb"`. It is the evidence for the one
  // interpretation this feature adds beyond its design -- that the chain starts
  // BELOW the subform carrying the <pageSet>.
  it('places fields at all, which is what confirms where the chain begins', () => {
    const { report } = converted();
    const positioned = report.fields.filter((f) => f.route === 'positioned');
    expect(positioned.length).toBeGreaterThanOrEqual(150);
  });

  // The caption rule, asserted on the field that found it. f1_01's box is
  // x=12.7mm w=99.06mm (36pt .. 316.8pt) with <caption reserve="68.0156mm">
  // (192.8pt), so the WIDGET is the rightmost 88pt. Ignore the reserve and llx
  // is 36 rather than 228.8 -- a field drawn across its own label.
  it('subtracts the caption reserve, exactly as Adobe did', () => {
    const { doc, adobe } = converted();
    const want = adobe.get('topmostSubform[0].Page1[0].f1_01[0]')!;
    expect(want).toEqual([228.8, 732.502, 316.8, 743.501]);
    const got = rectOf(doc, 'topmostSubform[0].Page1[0].f1_01[0]');
    for (let i = 0; i < 4; i++) expect(Math.abs(got[i] - want[i])).toBeLessThanOrEqual(1);
  });

  // The margin rule, asserted on the field that found it, and it is EXACT.
  // f1_03 is a 36x12 box with a 15pt left caption reserve, rightInset 4pt and
  // topInset = bottomInset = 0.5pt: 36 - 15 - 4 = 17 wide, 12 - 1 = 11 high.
  // Before the insets were read this rect was 21x12 and 4pt too far right.
  it('subtracts the margin insets, exactly as Adobe did', () => {
    const { doc, adobe } = converted();
    const want = adobe.get('topmostSubform[0].Page1[0].f1_03[0]')!;
    expect(want).toEqual([468.6, 732.502, 485.6, 743.501]);
    const got = rectOf(doc, 'topmostSubform[0].Page1[0].f1_03[0]');
    for (let i = 0; i < 4; i++) expect(Math.abs(got[i] - want[i])).toBeLessThanOrEqual(0.01);
  });

  // The check-button rule, asserted on the field the issue named. c1_1's field
  // box is 115.2x12 with a 104.8pt caption reserve on the RIGHT and a 2pt
  // bottomInset, so the edit region is 10.4x10 -- but the WIDGET is the button,
  // 8x8 for size="2.8222mm", flush left (opposite the caption) and bottom
  // (para vAlign). Before this rule it was the whole 10.4x10 region.
  it('sizes and places a check button, exactly as Adobe did', () => {
    const { doc, adobe } = converted();
    const want = adobe.get('topmostSubform[0].Page1[0].c1_1[0]')!;
    expect(want).toEqual([36, 722, 44, 730]);
    const got = rectOf(doc, 'topmostSubform[0].Page1[0].c1_1[0]');
    for (let i = 0; i < 4; i++) expect(Math.abs(got[i] - want[i])).toBeLessThanOrEqual(0.01);
  });

  /**
   * The whole geometry pipeline against numbers we did not compute: units,
   * anchors, offset accumulation, the y-flip, page identity, the medium check,
   * the caption reserve, the margin insets and the check-button size and
   * placement.
   *
   * **This is an EQUALITY now, and that is the claim.** Every one of the 159
   * placed fields reproduces Adobe's rect to within a hundredth of a point --
   * worst 0.0006pt, which is floating-point residue from the mm-to-pt
   * conversions and nothing else. No residual geometry rule remains.
   *
   * It is a REGRESSION FENCE for three rules at once. Break the caption rule
   * and the count collapses to about 1; break the margin rule and it falls to
   * 53 with the worst error at 12pt; break the check-button rule and it falls
   * to 105 with the worst error at 6.4pt.
   *
   * 151 became 159 with `b1xv`: eight fields omit their own `x` (three omit
   * `y` too) and were refused until an absent `x`/`y` read as XFA's default
   * of 0 -- and all eight then land exactly on Adobe's rects.
   *
   * 159 became 199 with `164g.1`: the 40 fields of `Table_Dependents` are
   * laid out by the flow engine, and each lands exactly on Adobe's rect.
   */
  it('reproduces every placed rect Adobe wrote', () => {
    const { doc, adobe, report } = converted();
    let compared = 0;
    let within1 = 0;
    let exact = 0;
    let worst = 0;
    for (const f of report.fields) {
      if (f.route !== 'positioned') continue;
      const want = adobe.get(f.name);
      if (!want || want.length !== 4) continue;
      const got = rectOf(doc, f.name);
      const d = Math.max(...[0, 1, 2, 3].map((i) => Math.abs(got[i] - want[i])));
      compared += 1;
      if (d <= 1) within1 += 1;
      if (d <= 0.01) exact += 1;
      if (d > worst) worst = d;
    }
    // Pinned EXACTLY: every one of f1040's 199 fields. 151 positioned-chain
    // fields, the eight that omit x (b1xv), and the 40 flow-laid ones in
    // Table_Dependents (164g.1) -- table, row, and lr-tb.
    expect(compared).toBe(199);
    // Every one of them, EXACTLY. A 1pt bound cannot see a geometry rule that
    // is merely close -- insets applied 0.1pt short leave `within1` passing and
    // collapse `exact` to 7 -- so the exact count is what this fences on.
    expect(exact).toBe(compared);
    expect(within1).toBe(compared);
    expect(worst).toBeLessThanOrEqual(0.01);
  });

  // A `field` skip means one of two things, and both are honest: the field was
  // refused outright (a <signature>, absent from `fields`), or it converted
  // WITHOUT geometry and the skip says why (present as `bare`). What it must
  // never mean is a field that got a rect anyway -- that would be a reported
  // failure contradicted by the output.
  it('never reports a skip against a field it then placed', () => {
    const { report } = converted();
    const placed = new Set(
      report.fields.filter((f) => f.route === 'positioned').map((f) => f.name),
    );
    for (const s of report.skipped)
      if (s.name !== undefined && s.what === 'field') expect(placed.has(s.name)).toBe(false);
    // The two XDP wrapper fragments never parse, by construction.
    expect(report.skipped.filter((s) => s.what === 'packet')).toHaveLength(2);
    expect(report.packets).toContain('template');
    expect(report.packets).toContain('datasets');
  });

  // The table-laid fields used to degrade to geometry-less. With the flow
  // engine (164g.1) none is left bare.
  it('leaves no field of f1040 without a widget', () => {
    const { report } = converted();
    expect(report.fields.filter((f) => f.route === 'bare')).toEqual([]);
    // Master-page fields are reported since d3mq; this case is about reconciling.
    expect(report.skipped.filter((s) => s.what === 'field' && !s.name?.includes('#pageSet'))).toEqual([]);
    expect(report.dataOnly).toBe(false);
  });
});

/** Body-field counts Adobe wrote: the claim is that EVERY one is placed. */
const EXPECTED: Record<string, number> = { 'irs-fw9.pdf': 23, 'uscis-i130.pdf': 438, 'uscis-i765.pdf': 154 };

/** The 0-based page Adobe put a field's widget on, from the page /Annots. */
function adobePage(src: Document, name: string): number {
  const f = src.Form.Get(name)!;
  const widgets = new Set<unknown>([f.Dict]);
  const kids = src.resolve(f.Dict.get('Kids'));
  if (Array.isArray(kids)) for (const k of kids) widgets.add(src.resolve(k));
  return src.Pages.findIndex((p) => {
    const annots = src.resolve(p.Dict.get('Annots'));
    return Array.isArray(annots) && annots.some((a) => widgets.has(src.resolve(a)));
  });
}

// 164g.3: each of these declares ONE <pageArea> for a multi-page document --
// LiveCycle's ordinary way of saying "this page repeats" -- and was refused
// outright until pages became an output of layout. Each page subform is as
// tall as its content area (fw9's odd pages 0.003pt taller, placed under the
// p. 295 override), so the layout produces exactly the document's pages, and
// every rect is compared with the one Adobe wrote. Master-page fields (the
// USCIS barcode) are d3mq's and left out.
describe('the paginated hybrid oracle (164g.3)', () => {
  for (const [file, pages] of [['irs-fw9.pdf', 6], ['uscis-i130.pdf', 12], ['uscis-i765.pdf', 7]] as const) {
    it(`${file}: lays out ${String(pages)} pages and reproduces every placed rect and page Adobe wrote`, () => {
      const bytes = load(file);
      const src = Document.Open(bytes);
      const adobe = new Map(src.Form.Fields
        .filter((f) => !f.FullName.includes('#pageSet'))
        .map((f) => [f.FullName, src.resolve(f.Dict.get('Rect')) as number[] | null]));
      const doc = stripAcroFields(bytes);
      const report = doc.ConvertXfaToAcroForm({ removeXfa: false });
      expect(report.skipped.filter((s) => s.what === 'document' || s.what === 'page')).toEqual([]);
      let compared = 0;
      let exact = 0;
      let worst = 0;
      for (const f of report.fields) {
        if (f.route !== 'positioned') continue;
        const want = adobe.get(f.name);
        if (!want || want.length !== 4) continue;
        expect(f.page! - 1, `${f.name} page`).toBe(adobePage(src, f.name));
        const got = rectOf(doc, f.name);
        const d = Math.max(...[0, 1, 2, 3].map((i) => Math.abs(got[i] - want[i])));
        compared += 1;
        if (d <= 0.01) exact += 1;
        if (d > worst) worst = d;
      }
      expect(compared, 'fields compared').toBe(EXPECTED[file]);
      expect(exact, 'exact').toBe(compared);
      expect(worst).toBeLessThanOrEqual(0.01);
    });
  }
});

// cb07: these two USCIS hybrids made ConvertXfaToAcroForm THROW, where its
// contract is to report what it cannot convert. They are kept for exactly
// that, and assert only what cb07 settled: i-130's own item lists repeat an
// export and hold an empty one, and i-765's datasets bind an EMPTY datum to
// its State lists.
describe('USCIS hybrids that threw (cb07)', () => {
  it('i-130: transcribes item lists that repeat an export or hold an empty one', () => {
    const src = Document.Open(load('uscis-i130.pdf'));
    const adobe = src.Form.Fields.find((f) => /Pt2Line10_State\[0\]$/.test(f.FullName))!;
    expect(adobe.Options.filter((o) => o === 'UT')).toHaveLength(2);

    // From the template ALONE: since fdq3 the hybrid reconciles, and a
    // reconciled field keeps Adobe's own /Opt, which would measure nothing here.
    const doc = stripAcroFields(load('uscis-i130.pdf'));
    doc.ConvertXfaToAcroForm({ removeXfa: false });
    expect(doc.Form.Get(adobe.FullName)!.Options).toEqual(adobe.Options);
    const coa = src.Form.Fields.find((f) => /Pt4Line21a_ClassOfAdmission\[0\]$/.test(f.FullName))!;
    expect(doc.Form.Get(coa.FullName)!.Options).toContain('');
  });

  it('i-765: an empty datum on a State list reconciles to no selection', () => {
    const doc = Document.Open(load('uscis-i765.pdf'));
    const report = doc.ConvertXfaToAcroForm({ removeXfa: false });
    // 154: every body field. It read 151 until fdq3, the other three sitting
    // under an unnamed <area> whose name the converter spelled differently.
    expect(report.fields.filter((f) => f.route === 'reconciled')).toHaveLength(154);
    // Master-page fields are reported since d3mq; this case is about reconciling.
    expect(report.skipped.filter((s) => s.what === 'field' && !s.name?.includes('#pageSet'))).toEqual([]);
    const states = doc.Form.Fields.filter((f) => /_State\[0\]$/.test(f.FullName));
    expect(states).toHaveLength(4);
    for (const f of states) expect(f.Dict.has('V')).toBe(false);
  });
});

// fdq3: an UNNAMED container is named by CLASS in the SOM -- `#subform[n]`,
// `#area[n]` -- with every index below it counted over the nearest NAMED
// container, and that is what LiveCycle writes into /AcroForm. Fields on
// a master page (`#pageSet[0]...`) are not converted at all, so they are left
// out of the comparison and asserted absent separately.
describe('unnamed containers are named by class, as LiveCycle writes them (fdq3)', () => {
  const body = (names: Iterable<string>) => [...names].filter((n) => !n.includes('#pageSet')).sort();

  for (const file of ['uscis-i130.pdf', 'uscis-i765.pdf']) {
    it(`${file}: the template alone reproduces every body field name Adobe wrote`, () => {
      const adobe = body(Document.Open(load(file)).Form.Fields.map((f) => f.FullName));
      const doc = stripAcroFields(load(file));
      const report = doc.ConvertXfaToAcroForm({ removeXfa: false });
      expect(body(report.fields.map((f) => f.name))).toEqual(adobe);
    });

    it(`${file}: the hybrid reconciles every body field and creates none`, () => {
      const doc = Document.Open(load(file));
      const before = doc.Form.Fields.length;
      const report = doc.ConvertXfaToAcroForm({ removeXfa: false });
      expect(report.fields.filter((f) => f.route !== 'reconciled')).toEqual([]);
      expect(doc.Form.Fields.length).toBe(before);
    });
  }
});

// d3mq: master-page fields, one instance per page. DD 1391 and DD 1155 carry
// the only FILLABLE master-page fields found; the USCIS forms carry a barcode
// on every page, which is refused for its kind but reported under every name
// Adobe gives it.
describe('master-page fields, against Adobe (d3mq)', () => {
  // DD 2952 (164g.10) is three pages on THREE page areas, reached by
  // breakBefore targetType="pageArea"; its Reset sits on Page2, the SECOND
  // page. Adobe names it Page2[0], which a page-index count would make [1].
  // DD 350 (164g.24) is four pages of ONE page area: its Reset is the only
  // master field on real bytes REPEATED across pages, Page1[0] to Page1[3].
  for (const file of ['dod-dd1391.pdf', 'dod-dd1155.pdf', 'dod-dd2952.pdf', 'dod-dd350.pdf']) {
    it(`${file}: creates every master-page field Adobe wrote, on Adobe's page and rect`, () => {
      const bytes = load(file);
      const src = Document.Open(bytes);
      const adobe = new Map(src.Form.Fields.filter((f) => f.FullName.includes('#pageSet'))
        .map((f) => [f.FullName, src.resolve(f.Dict.get('Rect')) as number[]]));
      const doc = stripAcroFields(bytes);
      const report = doc.ConvertXfaToAcroForm({ removeXfa: false });
      const made = report.fields.filter((f) => f.name.includes('#pageSet'));
      expect(made.map((f) => f.name).sort()).toEqual([...adobe.keys()].sort());
      let exact = 0;
      let worst = 0;
      for (const f of made) {
        expect(f.page! - 1, f.name).toBe(adobePage(src, f.name));
        const got = rectOf(doc, f.name);
        const want = adobe.get(f.name)!;
        const d = Math.max(...[0, 1, 2, 3].map((i) => Math.abs(got[i] - want[i])));
        if (d <= 0.01) exact += 1;
        worst = Math.max(worst, d);
      }
      // EXACT, not a 1pt bound: a bound accepted a nearly-right inset rule once (mw1m).
      expect(exact, `exact of ${String(made.length)}`).toBe(made.length);
      expect(worst).toBeLessThanOrEqual(0.01);
      // Adobe writes no Save/Print: they sit in a presence="inactive" subform.
      expect(made.some((f) => /SaveButton|PrintButton/.test(f.name))).toBe(false);
    });

  }

  // DD 1155 carries an (unsigned) signature field, and any document with one is
  // refused as published -- a rule that predates master fields -- so only DD
  // 1391 and DD 2952 can show the hybrid reconciling. Their stripped copies are
  // converted above.
  for (const file of ['dod-dd1391.pdf', 'dod-dd2952.pdf']) {
  it(`${file}: the hybrid as published reconciles its master fields and creates none`, () => {
    const doc = Document.Open(load(file));
    const before = doc.Form.Fields.length;
    const report = doc.ConvertXfaToAcroForm({ removeXfa: false });
    const master = report.fields.filter((f) => f.name.includes('#pageSet'));
    expect(master.length).toBeGreaterThan(0);
    expect(master.filter((f) => f.route !== 'reconciled')).toEqual([]);
    expect(doc.Form.Fields.length).toBe(before);
  });
  }

  for (const [file, pages] of [['uscis-i130.pdf', 12], ['uscis-i765.pdf', 7]] as const) {
    it(`${file}: reports the barcode under every one of Adobe's ${String(pages)} instance names`, () => {
      const adobe = Document.Open(load(file)).Form.Fields.map((f) => f.FullName)
        .filter((n) => n.includes('#pageSet')).sort();
      expect(adobe).toHaveLength(pages);
      const doc = stripAcroFields(load(file));
      const report = doc.ConvertXfaToAcroForm({ removeXfa: false });
      const barcode = report.skipped.filter((s) => s.name?.includes('PDF417BarCode1'));
      expect(barcode.map((s) => s.name).sort()).toEqual(adobe);
      for (const s of barcode) expect(s.reason).toMatch(/<barcode>/);
      // The two hidden counters, which Adobe does not write, are reported once each.
      expect(report.skipped.filter((s) => /CurrentPagep1|PageCountp1/.test(s.name ?? '')).map((s) => s.name)).toEqual([
        'form1[0].#pageSet[0].Page1[0].CurrentPagep1[0]',
        'form1[0].#pageSet[0].Page1[0].PageCountp1[0]',
      ]);
      expect(report.fields.some((f) => f.name.includes('#pageSet'))).toBe(false);
    });
  }
});

// bkdi: DoD DD forms flow their bodies as lr-tb lines of mixed heights. Every
// field lands on Adobe's rect only under both rules: the next line below the
// TALLEST item, and a container's min* unapplied in a flowed parent (DD 1155's
// `thirty`). Each rival reddens DD 1155: the last item 84/87, the first 85/87,
// min* applied 80/84 with page 1 overflowing.
describe('lr-tb bodies of mixed heights, against Adobe (bkdi)', () => {
  for (const [file, count] of [['dod-dd1391.pdf', 62], ['dod-dd1155.pdf', 87], ['dod-dd2952.pdf', 53], ['dod-dd350.pdf', 93]] as const) {
    it(`${file}: places all ${String(count)} fields on Adobe's page and rect`, () => {
      const bytes = load(file);
      const src = Document.Open(bytes);
      const adobe = new Map(src.Form.Fields.map((f) =>
        [f.FullName, src.resolve(f.Dict.get('Rect')) as number[] | null]));
      const doc = stripAcroFields(bytes);
      const report = doc.ConvertXfaToAcroForm({ removeXfa: false });
      expect(report.skipped.map((s) => s.reason).filter((r) => /mixed heights|would need splitting|needs splitting/.test(r))).toEqual([]);
      let compared = 0;
      let exact = 0;
      for (const f of report.fields) {
        if (f.route !== 'positioned') continue;
        const want = adobe.get(f.name);
        if (!want || want.length !== 4) continue;
        expect(f.page! - 1, `${f.name} page`).toBe(adobePage(src, f.name));
        const got = rectOf(doc, f.name);
        compared += 1;
        if (Math.max(...[0, 1, 2, 3].map((i) => Math.abs(got[i] - want[i]))) <= 0.01) exact += 1;
      }
      expect(compared, 'fields compared').toBe(count);
      expect(exact, 'exact').toBe(count);
    });
  }
});

// 164g.33: two shapes fdq3's numbering did not cover, each found by 164g.24's
// scan of archived DD forms, which read these older revisions. A named DRAW
// takes an occurrence index (DD 3183's <draw name="title"> makes the field
// title[1]; DD 3019's <draw name="Pulses"> makes the subform Pulses[1]), and an
// <exclGroup> whose members are UNNAMED is still a radio group (DD 3183's
// RadioButtonList, dropped whole with nothing reported before).
describe('occurrence numbering against Adobe (164g.33)', () => {
  const kidsOf = (doc: Document, name: string): Array<PdfDict> => {
    const f = doc.Form.Get(name)!;
    const kids = doc.resolve(f.Dict.get('Kids'));
    return (Array.isArray(kids) ? kids.map((k) => doc.resolve(k)) : [f.Dict]) as Array<PdfDict>;
  };
  const onState = (doc: Document, w: PdfDict): string => {
    const n = doc.resolve((doc.resolve(w.get('AP')) as PdfDict).get('N')) as PdfDict;
    return [...n.keys()].filter((k) => k !== 'Off')[0];
  };
  const near = (a: number[], b: number[]) => [0, 1, 2, 3].every((i) => Math.abs(a[i] - b[i]) <= 0.01);

  // DD 3019 places 952 fields, every one on Adobe's rect. Until 164g.36 it
  // placed 959: one LFT row of 7 sat 8pt too high, because a caption stating no
  // reserve took nothing. It is sized from its text now, and in Myriad Pro,
  // which nothing here resolves, so those 7 are REFUSED by name rather than
  // placed wrongly. Its DPL check box was an eighth miss until 164g.34.
  for (const [file, names, placed] of [['dod-dd3183.pdf', 69, 69], ['dod-dd3019.pdf', 1065, 952]] as const) {
    it(`${file}: the template alone reproduces all ${String(names)} names Adobe wrote`, () => {
      const src = Document.Open(load(file));
      const adobe = src.Form.Fields.filter((f) => f.Type !== 'signature').map((f) => f.FullName).sort();
      expect(adobe).toHaveLength(names);
      const report = stripAcroFields(load(file)).ConvertXfaToAcroForm({ removeXfa: false });
      expect(report.fields.map((f) => f.name).sort()).toEqual(adobe);
    });

    it(`${file}: places ${String(placed)} fields on Adobe's page and rects`, () => {
      const bytes = load(file);
      const src = Document.Open(bytes);
      const doc = stripAcroFields(bytes);
      const report = doc.ConvertXfaToAcroForm({ removeXfa: false });
      let exact = 0;
      let positioned = 0;
      for (const f of report.fields) {
        if (f.route !== 'positioned') continue;
        positioned += 1;
        expect(f.page! - 1, `${f.name} page`).toBe(adobePage(src, f.name));
        // Every widget, matched to Adobe's by rect: a radio group's kids are
        // not written in one order by both.
        const want = kidsOf(src, f.name).map((w) => src.resolve(w.get('Rect')) as number[]);
        const got = kidsOf(doc, f.name).map((w) => doc.resolve(w.get('Rect')) as number[]);
        if (got.length === want.length && got.every((g) => want.some((w) => near(g, w)))) exact += 1;
      }
      expect(exact).toBe(placed);
      expect(positioned).toBe(placed);
    });
  }

  it('dod-dd3019.pdf: refuses the LFT row whose reserve-less captions it cannot measure (164g.36)', () => {
    const report = stripAcroFields(load('dod-dd3019.pdf')).ConvertXfaToAcroForm({ removeXfa: false });
    const lft = ['fio2[0]', 'pH[0]', 'pCo2[0]', 'p02[0]', 'BE[0]', 'BE[4]', 'hc03[0]']
      .map((n) => `form1[0].#subform[21].LFT[0].${n}`);
    for (const name of lft) {
      expect(report.fields.find((f) => f.name === name)?.route, name).toBe('bare');
      expect(report.skipped.find((s) => s.name === name)?.reason, name)
        .toMatch(/caption states no reserve and no face named "Myriad Pro"/);
    }
  });

  // Adobe writes these groups with an /Opt array, so its state names are the
  // INDICES and the export values are /Opt's (32000-1 12.7.4.2.4). Since
  // 164g.37 we write the same: the same /Opt, and each widget the same index
  // state as its Adobe twin -- which also makes the exports agree.
  it("dod-dd3183.pdf: every radio group carries Adobe's /Opt and index states", () => {
    const bytes = load('dod-dd3183.pdf');
    const src = Document.Open(bytes);
    const doc = stripAcroFields(bytes);
    doc.ConvertXfaToAcroForm({ removeXfa: false });
    const radios = src.Form.Fields.filter((f) => f.Type === 'radio');
    expect(radios).toHaveLength(15);
    const optOf = (d: Document, f: { Dict: Map<string, unknown> }): string[] =>
      (d.resolve(f.Dict.get('Opt') as never) as Array<{ bytes: Uint8Array }>)
        .map((o) => new TextDecoder('latin1').decode(o.bytes));
    for (const g of radios) {
      const ours = doc.Form.Get(g.FullName)!;
      expect(optOf(doc, ours), g.FullName).toEqual(optOf(src, g));
      expect(ours.Options, g.FullName).toEqual(g.Options);
      const mine = kidsOf(doc, g.FullName);
      for (const w of kidsOf(src, g.FullName)) {
        const twin = mine.find((m) => near(doc.resolve(m.get('Rect')) as number[], src.resolve(w.get('Rect')) as number[]))!;
        expect(onState(doc, twin), g.FullName).toBe(onState(src, w));
      }
    }
  });
});

// 164g.35: Adobe lays out in whole MILLIPOINTS, each measurement rounded on
// the way in (xfageom.ts's measureToPt). In floating point the per-measurement
// loss accumulated down a flow: DD 3218's stated mm heights left 55 fields
// 0.0101-0.0145pt below Adobe's by the foot of a page.
describe('millipoint layout, against Adobe (164g.35)', () => {
  const residuals = (file: string): { placed: number; exact: number; worst: number; over: string[] } => {
    const bytes = load(file);
    const src = Document.Open(bytes);
    const adobe = new Map(src.Form.Fields.map((f) =>
      [f.FullName, src.resolve(f.Dict.get('Rect')) as number[] | null]));
    const doc = stripAcroFields(bytes);
    const report = doc.ConvertXfaToAcroForm({ removeXfa: false });
    let placed = 0;
    let exact = 0;
    let worst = 0;
    const over: string[] = [];
    for (const f of report.fields) {
      const want = adobe.get(f.name);
      if (f.route !== 'positioned' || !want || want.length !== 4) continue;
      placed += 1;
      const got = rectOf(doc, f.name);
      const d = Math.max(...[0, 1, 2, 3].map((i) => Math.abs(got[i] - want[i])));
      if (d > 0.01) continue; // a defect of its own (164g.36), not a residual
      exact += 1;
      worst = Math.max(worst, d);
      if (d > 0.0005 + 1e-9) over.push(f.name);
    }
    return { placed, exact, worst, over };
  };

  it('dod-dd3218.pdf: places all 331 fields on Adobe\'s rects', () => {
    const { placed, exact, worst } = residuals('dod-dd3218.pdf');
    expect([placed, exact]).toEqual([331, 331]);
    expect(worst).toBeLessThanOrEqual(0.0005 + 1e-9);
  });

  // The sharper fence: what is left is Adobe writing its rects to three
  // decimals, at most 0.0005, on every vendored form. In floating point
  // DD 2952 reached 0.0024 and fw9 0.0007 while still inside the 0.01 bound.
  // DD 3019's six left-captioned Myriad Pro fields sit exactly one millipoint
  // right of Adobe's (164g.38): no rule over the measurements explains them,
  // and the rects are Designer's, so no Reader probe can reproduce them.
  const OVER: Record<string, string[]> = {
    'dod-dd3019.pdf': [
      'form1[0].#subform[0].Arrival[0].TransitTime[0]',
      'form1[0].#subform[21].CT[0].time[1]',
      'form1[0].#subform[34].#subform[49].plus-minus[0]',
      'form1[0].#subform[34].#subform[49].plus-minus[1]',
      'form1[0].#subform[34].#subform[50].plus-minus[2]',
      'form1[0].#subform[34].#subform[50].plus-minus[3]',
    ],
  };
  for (const file of ['irs-f1040.pdf', 'irs-fw9.pdf', 'uscis-i130.pdf', 'uscis-i765.pdf', 'dod-dd1155.pdf',
    'dod-dd1391.pdf', 'dod-dd2952.pdf', 'dod-dd350.pdf', 'dod-dd3183.pdf', 'dod-dd3019.pdf', 'dod-dd3207.pdf']) {
    it(`${file}: every matched rect is within Adobe's own 0.0005 rounding`, () => {
      const { exact, worst, over } = residuals(file);
      expect(exact).toBeGreaterThan(0);
      expect(over.sort()).toEqual((OVER[file] ?? []).sort());
      expect(worst).toBeLessThanOrEqual(0.001 + 1e-9);
    });
  }
});

// 164g.34: a check button beside a LEFT caption that reserves space sits flush
// LEFT, next to it. f1040 and fw9 held no such button, so the default read
// "caption on the left" from caption-less ones and put it flush right. DD 3207's
// yes/no are two of the corpus's three such buttons (DD 3019's DPL is the third).
describe('check buttons beside a left caption, against Adobe (164g.34)', () => {
  it("dod-dd3207.pdf: places all 605 non-signature fields on Adobe's page and rects", () => {
    const bytes = load('dod-dd3207.pdf');
    const src = Document.Open(bytes);
    const adobe = new Map(src.Form.Fields.map((f) =>
      [f.FullName, src.resolve(f.Dict.get('Rect')) as number[] | null]));
    const doc = stripAcroFields(bytes);
    const report = doc.ConvertXfaToAcroForm({ removeXfa: false });
    let exact = 0;
    for (const f of report.fields) {
      const want = adobe.get(f.name);
      if (f.route !== 'positioned' || !want || want.length !== 4) continue;
      expect(f.page! - 1, `${f.name} page`).toBe(adobePage(src, f.name));
      const got = rectOf(doc, f.name);
      if (Math.max(...[0, 1, 2, 3].map((i) => Math.abs(got[i] - want[i]))) <= 0.01) exact += 1;
    }
    expect(exact).toBe(605);
    // Flush left of each edit region, which is 13.943pt and 49.402pt wide: flush
    // right put them 3.943 and 39.402pt too far right.
    for (const [n, x] of [['yes', 57.827], ['no', 97.132]] as const)
      expect(rectOf(doc, `form1[0].#subform[117].yn[0].${n}[0]`)[0]).toBeCloseTo(x, 2);
  });
});
