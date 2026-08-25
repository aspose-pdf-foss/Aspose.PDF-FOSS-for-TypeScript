import type { ShapedRun } from './shape.js';
import { num } from './pagecontent.js';

function hex4(n: number): string { return (n & 0xffff).toString(16).padStart(4, '0'); }

/** 2-byte Identity-H codes for every glyph across all runs, in visual order. */
export function encodeGids(runs: ShapedRun[]): Uint8Array {
  const out: number[] = [];
  for (const r of runs) for (const g of r.glyphs) out.push((g.gid >> 8) & 0xff, g.gid & 0xff);
  return Uint8Array.from(out);
}

interface Item { gid: number; pre: number; post: number; rise: number; }

/** Show-operators for one positioned line. See plan §Emission model.
 *  `unitsPerEm` scales font-design units to the PDF /1000-em convention;
 *  `naturalAdvance(gid)` gives the glyph's /W advance in the SAME font units. */
export function emitLine(
  runs: ShapedRun[], fontSize: number, unitsPerEm: number,
  naturalAdvance: (gid: number) => number,
): string {
  const k = 1000 / (unitsPerEm || 1000);
  const items: Item[] = [];
  for (const r of runs) for (const g of r.glyphs) {
    const w = naturalAdvance(g.gid);
    items.push({
      gid: g.gid,
      pre: -(g.xOffset * k),
      post: (g.xOffset + w - g.xAdvance) * k,
      rise: g.yOffset * (fontSize / (unitsPerEm || 1000)),
    });
  }
  const trivial = items.every((it) => it.pre === 0 && it.post === 0 && it.rise === 0);
  if (trivial) return `<${items.map((it) => hex4(it.gid)).join('')}> Tj\n`;

  // Build a TJ array, splitting around any glyph that needs a text rise.
  let s = '';
  let arr: string[] = [];
  const flush = () => { if (arr.length) { s += `[${arr.join(' ')}] TJ\n`; arr = []; } };
  let curRise = 0;
  for (const it of items) {
    if (it.rise !== curRise) { flush(); s += `${num(it.rise)} Ts\n`; curRise = it.rise; }
    // Pre-adjust placement: a leading TJ number moves the pen before the glyph.
    if (it.pre !== 0) arr.push(num(it.pre));
    // Append the glyph, merging into the previous hex string only when there is no
    // pre-adjust and the previous element is itself a hex string.
    const last = arr[arr.length - 1];
    if (it.pre === 0 && last && last.startsWith('<')) arr[arr.length - 1] = last.slice(0, -1) + hex4(it.gid) + '>';
    else arr.push(`<${hex4(it.gid)}>`);
    if (it.post !== 0) arr.push(num(it.post));
  }
  if (curRise !== 0) { flush(); s += '0 Ts\n'; } else flush();
  return s;
}
