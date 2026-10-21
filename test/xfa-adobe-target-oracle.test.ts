// test/xfa-adobe-target-oracle.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { isDict } from '../src/types.js';
import { decodeXfaPackets } from '../src/xfapacket.js';
import { decodeStream } from '../src/filters.js';
import { parseXfaTemplate } from '../src/xfatemplate.js';
import { parseXfaDatasets, parseXfaDataGroups } from '../src/xfadata.js';
import { layoutPages, type XfaLayoutResult } from '../src/xfapage.js';
import { xfaFieldLines, xfaMeasurer } from '../src/xfaconvert.js';
import { TARGET_PROBES, targetGoldens, loadAdobeProbe } from './helpers/xfa-adobe.js';

/**
 * The Adobe Reader oracle for `<overflow target>` (164g.30): each probe in
 * test/fixtures/xfa-adobe/ laid out from its template, and the page area of
 * every page and the page and top of every draw and field compared with what
 * Reader 26.1 reported (adobe-target.json; spec
 * docs/superpowers/specs/2026-10-21-xfa-overflow-target-design.md).
 *
 * Its ceiling: one producer, one version, hand transcription.
 */
const g = targetGoldens();
const TOL = 0.05;

function laidOut(name: string): { doc: Document; r: XfaLayoutResult; names: string[] } {
  const doc = Document.Open(loadAdobeProbe(name));
  const acro = doc.resolve(doc.catalog().get('AcroForm'));
  const set = decodeXfaPackets(isDict(acro) ? acro : undefined, (o) => doc.resolve(o), (s) => decodeStream(s));
  if ('reason' in set) throw new Error(set.reason);
  const datasets = set.packets.get('datasets');
  const tpl = parseXfaTemplate(set.packets.get('template')!, parseXfaDataGroups(datasets));
  const values = datasets ? parseXfaDatasets(datasets) : new Map<string, string | string[]>();
  const r = layoutPages(tpl.body!, xfaMeasurer(doc, tpl, values), [], xfaFieldLines(doc, tpl, values).grid);
  const names = tpl.body!.pageSet!.pageAreas.map((pa) => pa.name ?? '?');
  return { doc, r, names };
}

for (const name of TARGET_PROBES) {
  const probe = g.probes[name];
  describe(`Adobe target oracle: ${name} (${probe.note})`, () => {
    const { r, names } = laidOut(name);
    it("lays out Adobe's page areas, page by page", () => {
      expect(r.pages.map((p) => names[p.pageArea])).toEqual(probe.areas);
    });
    it("puts every draw and field on Adobe's page and top", () => {
      const got = new Map<string, Array<[number, number, number]>>();
      r.pages.forEach((p, i) => {
        for (const n of p.nodes) {
          if (!('box' in n)) continue;
          const key = n.node.label.replace(/\[0\]$/, '');
          if (!(key in probe.nodes)) continue;
          (got.get(key) ?? got.set(key, []).get(key)!).push([i + 1, n.box.y, n.box.h]);
        }
      });
      const wrong: string[] = [];
      for (const [k, want] of Object.entries(probe.nodes)) {
        const have = got.get(k) ?? [];
        const same = have.length === want.length && want.every((w, j) =>
          w[0] === have[j][0] && Math.abs(w[1] - have[j][1]) <= TOL && Math.abs(w[2] - have[j][2]) <= TOL);
        if (!same) wrong.push(`${k}: want ${JSON.stringify(want)} got ${JSON.stringify(have)}`);
      }
      expect(wrong).toEqual([]);
    });
  });
}
