import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { Document } from '../src/document.js';
import { decodeXfaPackets } from '../src/xfapacket.js';
import { decodeStream } from '../src/filters.js';
import { parseXfaTemplate } from '../src/xfatemplate.js';
import { parseXfaDatasets, parseXfaDataGroups } from '../src/xfadata.js';
import { layoutPage } from '../src/xfaflow.js';
import { layoutPages } from '../src/xfapage.js';
import { xfaMeasurer } from '../src/xfaconvert.js';
import { isDict } from '../src/types.js';
import { MASTER_FILES, loadMasterPdf, masterGoldens } from './helpers/xfa-dynamic.js';

// d3mq: pdf.js lays these two dynamic DoD forms out across several pages and
// copies each page area's background onto every page that instantiates it
// (XFA 3.3 p. 288). Our master layout of that page area must put each field
// where pdf.js put it, on every page. The BODY is not compared: pdf.js's goldens
// hold page areas only, which is why this compares layout boxes rather than a
// converted document (the bodies' end-to-end state is pinned below, bkdi).
//
// Precision: Chrome holds lengths in 1/64 px, so a box comes back within
// ~0.02pt of the exact sum (164g.6).
const TOL = 0.05;

describe('master-page layout, against pdf.js (d3mq)', () => {
  const g = masterGoldens();
  for (const file of MASTER_FILES) {
    it(`${file}: every page-area field pdf.js placed is where our master layout puts it`, () => {
      const bytes = loadMasterPdf(file);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(g.files[file].sha256);
      const doc = Document.Open(bytes);
      const acro = doc.resolve(doc.catalog().get('AcroForm'));
      const set = decodeXfaPackets(isDict(acro) ? acro : undefined, (o) => doc.resolve(o), (s) => decodeStream(s));
      if ('reason' in set) throw new Error(set.reason);
      const datasets = set.packets.get('datasets');
      const tpl = parseXfaTemplate(set.packets.get('template')!, parseXfaDataGroups(datasets));
      const values = datasets ? parseXfaDatasets(datasets) : new Map<string, string | string[]>();
      const areas = tpl.body!.pageSet!.pageAreas;
      const measure = xfaMeasurer(doc, tpl, values);
      const laid = new Map(areas.map((a, k) => [k, a.master ? layoutPage(a.master, measure, []) : new Map()]));

      let compared = 0;
      for (const node of g.files[file].nodes) {
        if (node.kind !== 'field') continue;
        const m = /^#pageArea\[([^\]]+)\]\.(.+)$/.exec(node.som)!;
        const k = areas.findIndex((a) => a.name === m[1]);
        expect(k, `${node.som}: page area`).toBeGreaterThanOrEqual(0);
        const f = tpl.masterPageFields.find((x) => x.master?.pageArea === k && x.master.rest === m[2]);
        expect(f, `${node.som}: no master field of ours by that name`).toBeDefined();
        const p = laid.get(k)!.get(f!.name);
        expect(p && 'box' in p, `${node.som} on page ${String(node.page)}: ${p && 'reason' in p ? p.reason : 'not laid out'}`).toBe(true);
        const b = (p as { box: { x: number; y: number; w: number; h: number } }).box;
        for (const [ours, theirs, what] of [[b.x, node.x, 'x'], [b.y, node.y, 'y'], [b.w, node.w, 'w'], [b.h, node.h, 'h']] as const)
          expect(Math.abs(ours - theirs), `${node.som} p${String(node.page)} ${what}`).toBeLessThanOrEqual(TOL);
        compared += 1;
      }
      // Several pages, each carrying its page area's fields: the multi-instance claim.
      expect(g.files[file].pages).toBeGreaterThan(1);
      expect(compared).toBeGreaterThan(g.files[file].pages - 1);
    });
  }
});

// bkdi: DD 2875's body is lr-tb lines of mixed heights, refused until bkdi laid
// that wrap out. It now converts end to end onto as many pages as pdf.js lays it
// out on. The BODY positions have no oracle (the goldens hold page areas only),
// so this pins the page count and that nothing is refused at the wrap. DD 1494's
// body is one tb subform taller than a page; since 164g.8 it splits between its
// children onto pdf.js's pages.
describe('dynamic DD bodies end to end (bkdi)', () => {
  const g = masterGoldens();
  it("dod-dd2875.pdf: lays out on pdf.js's page count, with no wrap refused", () => {
    const doc = Document.Open(loadMasterPdf('dod-dd2875.pdf'));
    const report = doc.ConvertXfaToAcroForm({ removeXfa: false });
    expect(report.pagesCreated).toBe(g.files['dod-dd2875.pdf'].pages);
    expect(report.skipped.filter((s) => /mixed heights/.test(s.reason))).toEqual([]);
    expect(report.fields.filter((f) => f.route === 'positioned').length).toBeGreaterThan(0);
  });

  // 164g.8: pdf.js splits TopForm > P1..P6 between their children onto 14
  // pages, applying the breakBefore on P2-P6's front and P5/P6's lineDiagramPg
  // on the way. Fields are joined by DATA path, which is what pdf.js's som
  // spells (fdq3); each page's page area comes from the page-area nodes on it.
  it("dod-dd1494.pdf: every body field lands on pdf.js's page and box, every page on its page area", () => {
    const gold = g.files['dod-dd1494.pdf'];
    const doc = Document.Open(loadMasterPdf('dod-dd1494.pdf'));
    const acro = doc.resolve(doc.catalog().get('AcroForm'));
    const set = decodeXfaPackets(isDict(acro) ? acro : undefined, (o) => doc.resolve(o), (s) => decodeStream(s));
    if ('reason' in set) throw new Error(set.reason);
    const datasets = set.packets.get('datasets');
    const tpl = parseXfaTemplate(set.packets.get('template')!, parseXfaDataGroups(datasets));
    const values = datasets ? parseXfaDatasets(datasets) : new Map<string, string | string[]>();
    const laid = layoutPages(tpl.body!, xfaMeasurer(doc, tpl, values), []);
    expect(laid.pages.length).toBe(gold.pages);

    const areaOf = new Map<number, string>();
    for (const n of gold.nodes) areaOf.set(n.page, /^#pageArea\[([^\]]+)\]/.exec(n.som)![1]);
    const names = tpl.body!.pageSet!.pageAreas.map((a) => a.name);
    expect(laid.pages.map((p) => names[p.pageArea]), 'page areas')
      .toEqual(laid.pages.map((_, i) => areaOf.get(i + 1)));

    const where = new Map<string, { page: number; box: { x: number; y: number; w: number; h: number } }>();
    laid.pages.forEach((p, i) => { for (const [k, v] of p.placed) if ('box' in v) where.set(k, { page: i + 1, box: v.box }); });
    const nameOf = (som: string): string => tpl.fields.find((f) => f.dataPath === som)?.name ?? som;
    const fields = gold.body!.filter((n) => n.kind === 'field');
    let compared = 0;
    for (const n of fields) {
      const ours = where.get(nameOf(n.som));
      expect(ours, `${n.som}: not placed (${laid.refused.get(nameOf(n.som)) ?? 'no reason'})`).toBeDefined();
      expect(ours!.page, `${n.som} page`).toBe(n.page);
      for (const [a, b, what] of [[ours!.box.x, n.x, 'x'], [ours!.box.y, n.y, 'y'], [ours!.box.w, n.w, 'w'], [ours!.box.h, n.h, 'h']] as const)
        expect(Math.abs(a - b), `${n.som} ${what}`).toBeLessThanOrEqual(TOL);
      compared += 1;
    }
    expect(compared).toBe(fields.length);
    expect(compared).toBeGreaterThan(290);
  });

  it("dod-dd1494.pdf: splits onto pdf.js's page count, with nothing refused for splitting (164g.8)", () => {
    const doc = Document.Open(loadMasterPdf('dod-dd1494.pdf'));
    const report = doc.ConvertXfaToAcroForm({ removeXfa: false });
    expect(report.pagesCreated).toBe(g.files['dod-dd1494.pdf'].pages);
    expect(report.skipped.filter((s) => /mixed heights|would need splitting|needs splitting/.test(s.reason))).toEqual([]);
  });
});
