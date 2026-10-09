import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { Document } from '../src/document.js';
import { isDict } from '../src/types.js';
import { decodeStream } from '../src/filters.js';
import { decodeXfaPackets } from '../src/xfapacket.js';
import { parseXfaTemplate, type XfaTemplate } from '../src/xfatemplate.js';
import { layoutPage, type LayoutNode } from '../src/xfaflow.js';
import { parseXfaDatasets, parseXfaDataGroups } from '../src/xfadata.js';
import { xfaMeasurer } from '../src/xfaconvert.js';
import {
  DYNAMIC_VARIANTS, deriveVariant, dynamicGoldens, loadDynamicPdf, packetText, sha256,
  type GoldenNode,
} from './helpers/xfa-dynamic.js';

/**
 * The DYNAMIC-XFA oracle (`164g.6`): OPM Form 1644, laid out by pdf.js's XFA
 * engine in headless Chrome, as published and in two derived variants. The
 * flow oracle (`164g.5`, `xfa-flow-oracle.test.ts`) has no `tb` chain, no
 * `<occur>` and no page breaking; this one has all three.
 *
 * pdf.js is a REIMPLEMENTATION, so this is independent evidence and not Adobe
 * conformance. See `test/fixtures/xfa-dynamic/PROVENANCE.md`.
 */
const goldens = dynamicGoldens();
const source = loadDynamicPdf();

function templateOf(doc: Document): XfaTemplate {
  const acro = doc.resolve(doc.catalog().get('AcroForm'));
  const packets = decodeXfaPackets(
    isDict(acro) ? acro : undefined, (o) => doc.resolve(o), (s) => decodeStream(s),
  );
  if ('reason' in packets) throw new Error(packets.reason);
  return parseXfaTemplate(packets.packets.get('template')!,
    parseXfaDataGroups(packets.packets.get('datasets')));
}

const nodes = (v: (typeof DYNAMIC_VARIANTS)[number]) => goldens.variants[v].nodes;
const one = (v: (typeof DYNAMIC_VARIANTS)[number], som: string): GoldenNode => {
  const all = nodes(v).filter((n) => n.som === som);
  expect(all, som).toHaveLength(1);
  return all[0];
};
/** A field's golden key: the goldens are keyed by DATA path, layout results by
 *  SOM name, and the two differ at an unnamed container (fdq3). Anything that is
 *  not a field passes through. */
const dataOf = (tpl: XfaTemplate, som: string): string =>
  tpl.fields.find((f) => f.name === som)?.dataPath ?? som;

const fieldNames = (v: (typeof DYNAMIC_VARIANTS)[number]) =>
  new Set(nodes(v).filter((n) => n.kind === 'field').map((n) => n.som));

describe('the dynamic XFA oracle: OPM 1644', () => {
  it('is the genuinely dynamic form the goldens were made from', () => {
    expect(createHash('sha256').update(source).digest('hex')).toBe(goldens.meta.sourceSha256);
    const doc = Document.Open(source);
    // Dynamic: the viewer must lay it out, and there is no AcroForm to fall
    // back on -- which is exactly what makes pdf.js take its XFA path.
    expect(doc.catalog().get('NeedsRendering')).toBe(true);
    expect(doc.Form.Fields).toHaveLength(0);
    const tpl = templateOf(doc);
    expect(tpl.pages).toHaveLength(1);
    expect(tpl.fields).toHaveLength(61);
  });

  // The suite derives the same documents the generator fed pdf.js, or every
  // assertion below is about some other form.
  it('derives each variant byte for byte in the packets that matter', () => {
    const base = Document.Open(source);
    for (const v of DYNAMIC_VARIANTS) {
      const doc = deriveVariant(source, v);
      expect(sha256(packetText(doc, 'template')), v).toBe(goldens.variants[v].template);
      expect(sha256(packetText(doc, 'datasets')), v).toBe(goldens.variants[v].datasets);
    }
    // ...and each variant changes exactly the packets it says it does.
    const pub = goldens.variants.published;
    expect(pub.template).toBe(sha256(packetText(base, 'template')));
    expect(pub.datasets).toBe(sha256(packetText(base, 'datasets')));
    expect(goldens.variants.header.template).toBe(pub.template);
    expect(goldens.variants.header.datasets).not.toBe(pub.datasets);
    expect(goldens.variants.pages.template).not.toBe(pub.template);
    expect(goldens.variants.pages.datasets).not.toBe(pub.datasets);
  });

  // pdf.js's naming and ours were derived independently -- its from element
  // ids in the rendered DOM, ours from the template -- so set equality is
  // evidence for both, not one checked against itself. The golden `som` leaves
  // an UNNAMED container out and numbers below it by the nearest NAMED one,
  // which is our DATA path (fdq3): the SOM name spells that level `#subform[n]`.
  it('names every field exactly as the converter does', () => {
    const ours = new Set(templateOf(Document.Open(source)).fields.map((f) => f.dataPath));
    expect(fieldNames('published')).toEqual(ours);
    expect(fieldNames('header')).toEqual(ours);
  });

  it('pins what each variant contains', () => {
    const summary = Object.fromEntries(DYNAMIC_VARIANTS.map((v) => {
      const kinds: Record<string, number> = {};
      for (const n of nodes(v)) kinds[n.kind] = (kinds[n.kind] ?? 0) + 1;
      return [v, { pages: goldens.variants[v].pages, ...kinds }];
    }));
    expect(summary).toEqual({
      published: { pages: 2, subform: 59, draw: 45, field: 61 },
      header: { pages: 2, subform: 61, draw: 47, field: 61 },
      pages: { pages: 4, subform: 101, draw: 75, field: 85 },
    });
  });

  // The tb root breaks pages: each page subform is a page tall, so OF1644 is
  // split across two instances of the ONE pageArea -- the same node, so the
  // same SOM name, on both.
  it('breaks the tb root across two instances of one pageArea', () => {
    const roots = nodes('published').filter((n) => n.som === 'OF1644[0]');
    expect(roots.map((n) => n.page)).toEqual([1, 2]);
    for (const [som, page] of [['OF1644[0].Page1[0]', 1], ['OF1644[0].Page2[0]', 2]] as const) {
      const n = one('published', som);
      expect([n.page, n.x, n.y, n.w, n.h]).toEqual([page, 0, 0, 612, 792]);
    }
  });

  // Data-driven repetition inside a table: three Header data groups make three
  // Header instances, stacked at the row pitch, pushing SectionI's own rows
  // down -- while SectionII, a POSITIONED sibling, does not move.
  it('repeats a table row once per data group', () => {
    const h = [0, 1, 2].map((i) => one('header', `OF1644[0].Page1[0].SectionI[0].Header[${String(i)}]`));
    for (let i = 1; i < 3; i++) {
      expect(h[i].x).toBe(h[0].x);
      expect(h[i].w).toBe(h[0].w);
      expect(h[i].y).toBeCloseTo(h[i - 1].y + h[i - 1].h, 2);
    }
    const row1 = (v: 'published' | 'header') => one(v, 'OF1644[0].Page1[0].SectionI[0].Row1[0]');
    expect(row1('header').y - row1('published').y).toBeCloseTo(2 * h[0].h, 2);
    const s2 = (v: 'published' | 'header') => one(v, 'OF1644[0].Page1[0].SectionII[0]');
    expect(s2('header')).toEqual(s2('published'));
  });

  // A subform repeated ACROSS page breaks: Page2[k] on page k + 2, every
  // instance laid out identically, each bound to its OWN data group.
  it('repeats a page subform across page breaks', () => {
    const p2 = nodes('pages').filter((n) => /^OF1644\[0\]\.Page2\[\d\]\./.test(n.som));
    const base = new Map(p2.filter((n) => n.som.startsWith('OF1644[0].Page2[0].'))
      .map((n) => [n.som.slice('OF1644[0].Page2[0].'.length), n]));
    expect(base.size).toBeGreaterThan(40);
    for (const k of [0, 1, 2]) {
      const prefix = `OF1644[0].Page2[${String(k)}].`;
      const inst = p2.filter((n) => n.som.startsWith(prefix));
      expect(inst).toHaveLength(base.size);
      for (const n of inst) {
        const b = base.get(n.som.slice(prefix.length))!;
        expect(n.page).toBe(k + 2);
        expect([n.x, n.y, n.w, n.h]).toEqual([b.x, b.y, b.w, b.h]);
      }
      expect(one('pages', `${prefix}SectionIV[0].Row3[0].FieldQ1FinInst[0]`).value)
        .toBe(`Bank ${String(k + 1)}`);
    }
    // The template's own fields are the [0] instances; the rest are copies.
    const ours = new Set(templateOf(deriveVariant(source, 'pages')).fields.map((f) => f.dataPath));
    const theirs = fieldNames('pages');
    for (const f of ours) expect(theirs.has(f), f).toBe(true);
    expect(theirs.size - ours.size).toBe(2 * [...ours].filter((f) => f.includes('.Page2[0].')).length);
  });

  // Evidence the boxes describe a table rather than fields that happen to sit
  // near each other: SectionIIIpt2's data rows abut and its columns align.
  it('describes a table: abutting rows, aligned columns', () => {
    const rows = [4, 5, 6, 7, 8].map((r) =>
      one('published', `OF1644[0].Page1[0].SectionIIIpt2[0].Row${String(r)}[0]`));
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].y).toBeCloseTo(rows[i - 1].y + rows[i - 1].h, 1);
      expect(rows[i].x).toBe(rows[0].x);
    }
    const col = (r: number, name: string) =>
      one('published', `OF1644[0].Page1[0].SectionIIIpt2[0].Row${String(r)}[0].${name}`);
    expect(col(5, 'd2[0]').x).toBe(col(4, 'TextField6[0]').x);
    expect(col(5, 'NumericFieldF2[0]').x).toBe(col(4, 'NumericField2[0]').x);
  });

  // What the oracle is FOR. Every field our engine places must land on
  // pdf.js's box. Since 164g.2 a repeating Header row is instantiated per data
  // group, so the tables no longer refuse at their Header; this loop runs with
  // NO text measurer, so text-sized fields still refuse here and the count
  // rises only from 35 to 37 (the measured tables are checked table by table
  // below). Page2 still resolves to no layout root, being a second instance of
  // the one pageArea (164g.3), and `pages`' Page2 repetition is refused for
  // 164g.3. The count is pinned so the issue that changes it updates it.
  it('agrees with every box the flow engine places', () => {
    const placed: Record<string, number> = {};
    for (const v of DYNAMIC_VARIANTS) {
      const tpl = templateOf(deriveVariant(source, v));
      placed[v] = 0;
      for (const root of tpl.roots) {
        for (const [name, p] of layoutPage(root.node)) {
          if (!('box' in p)) continue;
          placed[v]++;
          const g = one(v, dataOf(tpl, name));
          for (const k of ['x', 'y', 'w', 'h'] as const)
            expect(Math.abs(p.box[k] - g[k]), `${v} ${name} ${k}`).toBeLessThanOrEqual(0.05);
        }
      }
    }
    expect(placed).toEqual({ published: 37, header: 37, pages: 37 });
  });
});

/**
 * 164g.7 against pdf.js, one table at a time. Since 164g.2 the Header rows are
 * instantiated per data group, so no re-labelling is needed; each table is still
 * laid out ALONE on a synthetic page, because page-level layout of Page2 waits on
 * 164g.3.
 */
describe('164g.7: measured layout against pdf.js, table by table', () => {
  const doc = Document.Open(source);
  const acro = doc.resolve(doc.catalog().get('AcroForm'));
  const packets = decodeXfaPackets(isDict(acro) ? acro : undefined, (o) => doc.resolve(o), (s) => decodeStream(s));
  if ('reason' in packets) throw new Error(packets.reason);
  const tpl = parseXfaTemplate(packets.packets.get('template')!,
    parseXfaDataGroups(packets.packets.get('datasets')));
  const values = parseXfaDatasets(packets.packets.get('datasets')!);
  const measure = xfaMeasurer(doc, tpl, values);
  const page1 = tpl.roots[0].node.children[0];
  const tableNode = (label: string): LayoutNode =>
    page1.children.find((c) => c.label === label)!;
  const alone = (label: string) => layoutPage(
    { kind: 'page', label: 'contentArea', layout: 'position', geom: { w: '612pt', h: '792pt' }, children: [tableNode(label)] },
    measure,
  );
  const golden = (som: string) => one('published', dataOf(tpl, som));
  const PT = (mm: number) => (mm * 72) / 25.4;

  // pdf.js measures Q1 at 10pt Arial plus its insets, 14.05pt, and ignores its
  // minH; the spec (p. 276) makes minH a floor in every parent, so our row is
  // minH tall. Everything below Q1 therefore sits lower by exactly
  // minH - 14.05 -- the recorded divergence, asserted, not tolerated.
  it('SectionII: every field agrees with pdf.js, shifted by exactly the Q1 minH divergence', () => {
    const out = alone('SectionII[0]');
    const q1 = page1.children.find((c) => c.label === 'SectionII[0]')!.children
      .find((c) => c.label === 'Row1[0]')!.children[0];
    const natural = measure(q1, { width: golden('OF1644[0].Page1[0].SectionII[0].Row1[0].Q1[0]').w });
    if ('reason' in natural) throw new Error(natural.reason);
    expect(natural.h).toBeCloseTo(golden('OF1644[0].Page1[0].SectionII[0].Row1[0].Q1[0]').h, 1);
    const shift = PT(5.842) - natural.h;
    // The oracle's own precision: Chrome holds lengths in 1/64-px layout
    // units, so each 5.842mm row (16.5603pt) comes back 16.547pt and the loss
    // ACCUMULATES down the table -- measured at 0.013pt a row, 0.066pt five
    // rows down. Our sums are exact. So each field is held to 0.02pt plus ONE
    // layout unit (1/64pt) per table row pdf.js stacked above it: Row2, the
    // first row below Q1, pins the divergence to 0.036pt, and the deepest
    // field is still held to a fifth of the divergence.
    const rows = nodes('published').filter((r) => r.kind === 'subform'
      && /^OF1644\[0\]\.Page1\[0\]\.SectionII\[0\]\.(?:Row7\[0\]\.Table2SecII\[0\]\.)?Row\d+\[0\]$/.test(r.som)
      && r.som !== 'OF1644[0].Page1[0].SectionII[0].Row7[0]');
    let n = 0;
    for (const [name, p] of out) {
      if (!('box' in p)) throw new Error(`${name}: ${p.reason}`);
      const g = golden(name);
      const above = rows.filter((r) => r.y + r.h <= g.y + 0.01).length;
      const tol = 0.02 + above / 64;
      expect(Math.abs(p.box.x - g.x), name).toBeLessThanOrEqual(0.05);
      expect(Math.abs(p.box.w - g.w), name).toBeLessThanOrEqual(0.05);
      expect(Math.abs(p.box.h - g.h), name).toBeLessThanOrEqual(0.05);
      expect(Math.abs(p.box.y - g.y - shift), name).toBeLessThanOrEqual(tol);
      n++;
    }
    expect(n).toBe(12);
  });

  // p. 329: the w="30mm" draws in Row3 take their narrower columns, as pdf.js
  // draws them; every field below agrees with pdf.js.
  it('SectionIIIpt2: over-wide cells take their columns, every field agrees', () => {
    const out = alone('SectionIIIpt2[0]');
    let n = 0;
    for (const [name, p] of out) {
      if (!('box' in p)) throw new Error(`${name}: ${p.reason}`);
      const g = golden(name);
      for (const k of ['x', 'y', 'w', 'h'] as const) expect(p.box[k], `${name} ${k}`).toBeCloseTo(g[k], 1);
      n++;
    }
    expect(n).toBe(nodes('published').filter((x) => x.kind === 'field'
      && x.som.startsWith('OF1644[0].Page1[0].SectionIIIpt2[0].')).length);
  });

  // 164g.2: three Header data groups make three 18pt Header rows, so every
  // SectionI row below them sits EXACTLY 2 x 18pt lower than in `published`.
  // pdf.js agrees to the hundredth (Row2.FieldQ1Name 173.69 -> 209.69), and
  // SectionII does not move: Page1 positions its sections absolutely.
  it('header: three Header instances push SectionI\'s rows down by exactly 36pt', () => {
    const sectionIOf = (v: (typeof DYNAMIC_VARIANTS)[number]) => {
      const d = deriveVariant(source, v);
      const a = d.resolve(d.catalog().get('AcroForm'));
      const p = decodeXfaPackets(isDict(a) ? a : undefined, (o) => d.resolve(o), (s) => decodeStream(s));
      if ('reason' in p) throw new Error(p.reason);
      const t = parseXfaTemplate(p.packets.get('template')!, parseXfaDataGroups(p.packets.get('datasets')));
      const m = xfaMeasurer(d, t, parseXfaDatasets(p.packets.get('datasets')!));
      const s = t.roots[0].node.children[0].children.find((c) => c.label === 'SectionI[0]')!;
      return layoutPage(
        { kind: 'page', label: 'contentArea', layout: 'position', geom: { w: '612pt', h: '792pt' }, children: [s] },
        m,
      );
    };
    const pub = sectionIOf('published');
    const hdr = sectionIOf('header');
    for (const f of ['Row2[0].FieldQ1Name[0]', 'Row4[0].FieldQ2FedAgency[0]']) {
      const name = `OF1644[0].Page1[0].SectionI[0].${f}`;
      const a = pub.get(name);
      const b = hdr.get(name);
      if (!a || 'reason' in a) throw new Error(`${name} (published): ${a ? a.reason : 'no result'}`);
      if (!b || 'reason' in b) throw new Error(`${name} (header): ${b ? b.reason : 'no result'}`);
      expect(b.box.y - a.box.y, name).toBeCloseTo(36, 6);
      expect(one('header', name).y - one('published', name).y, name).toBeCloseTo(36, 2);
    }
  });
});