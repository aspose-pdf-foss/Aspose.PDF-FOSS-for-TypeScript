// test/xfa-linesep.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { isDict } from '../src/types.js';
import { decodeXfaPackets } from '../src/xfapacket.js';
import { decodeStream } from '../src/filters.js';
import { parseXfaTemplate } from '../src/xfatemplate.js';
import { parseXfaDatasets, parseXfaDataGroups } from '../src/xfadata.js';
import { layoutPages } from '../src/xfapage.js';
import { xfaFieldLines, xfaMeasurer } from '../src/xfaconvert.js';
import { plainParas } from '../src/xfarich.js';
import { loadAdobeProbe } from './helpers/xfa-adobe.js';

/**
 * U+2028 LINE SEPARATOR in an XFA text value (164g.23). XFA 3.3 p. 56 names
 * only the newline and U+2029, but Adobe Reader 26.1 breaks the line there:
 * probe t91 (test/fixtures/xfa-adobe/) reports, for growable 10pt Courier New
 * leaves, `A<LS>B` in a plain draw, a rich draw and a field each 22pt tall --
 * exactly the `A\nB` control -- against 10pt for `AB`.
 *
 * Since 164g.32 the ABSOLUTE heights are compared too: a line is measured off
 * its font size, as Reader does (10 and 22), not off hhea (11.33 and 22.66).
 */
describe('U+2028 in XFA text (164g.23, Adobe t91)', () => {
  const doc = Document.Open(loadAdobeProbe('t91'));
  const acro = doc.resolve(doc.catalog().get('AcroForm'));
  const set = decodeXfaPackets(isDict(acro) ? acro : undefined, (o) => doc.resolve(o), (s) => decodeStream(s));
  if ('reason' in set) throw new Error(set.reason);
  const ds = set.packets.get('datasets');
  const tpl = parseXfaTemplate(set.packets.get('template')!, parseXfaDataGroups(ds));
  const values = ds ? parseXfaDatasets(ds) : new Map<string, string | string[]>();
  const r = layoutPages(tpl.body!, xfaMeasurer(doc, tpl, values), [], xfaFieldLines(doc, tpl, values).count);
  const h = (label: string): number => {
    const n = r.pages[0].nodes.find((x) => x.node.label === label);
    if (!n || !('box' in n)) throw new Error(`${label} not placed`);
    return n.box.h;
  };

  it('breaks the line in a plain draw, a rich draw and a field, as tall as A\\nB', () => {
    expect(r.refused.size).toBe(0);
    expect(h('nl')).toBeGreaterThan(1.5 * h('one'));
    for (const l of ['ls', 'rich', 'f[0]']) expect(h(l)).toBeCloseTo(h('nl'), 6);
  });

  it("is exactly as tall as Reader reports: 10pt for one line, 22pt for two", () => {
    expect(h('one')).toBeCloseTo(10, 6);
    for (const l of ['nl', 'ls', 'rich', 'f[0]']) expect(h(l)).toBeCloseTo(22, 6);
  });

  it('is a line break inside its paragraph, not a paragraph break', () => {
    const base = { typeface: 'Courier New', size: 10, weight: 'normal', posture: 'normal' } as never;
    const ps = plainParas('A B C', base, {} as never);
    expect(ps.map((p) => p.runs.map((x) => x.text))).toEqual([['A\nB'], ['C']]);
  });
});
