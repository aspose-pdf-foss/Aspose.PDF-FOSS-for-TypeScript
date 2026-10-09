import { readFileSync } from 'node:fs';
import { Document } from '../../src/document.js';
import { isDict, type PdfDict } from '../../src/types.js';
import { decodeStream } from '../../src/filters.js';
import { decodeXfaPackets } from '../../src/xfapacket.js';
import { parseXfaTemplate, type XfaUiKind } from '../../src/xfatemplate.js';
import { chainIsPositioned } from '../../src/xfageom.js';

/**
 * The FLOW-LAYOUT oracle a hybrid XFA form carries (`164g.5`).
 *
 * A static save from LiveCycle Designer runs Adobe's own layout engine over the
 * template and writes the result into `/AcroForm` -- including for fields whose
 * container chain is FLOWED (`tb`, `lr-tb`, `table`, `row`), which the
 * converter cannot place today. So every such field has two independent
 * descriptions: the template, which states the flow and no position, and
 * Adobe's widget rect, which states where the flow put it. This helper pairs
 * them, reading the rect from the ORIGINAL file, so a layout engine tested
 * against it cannot see the answer.
 *
 * Nothing here is generated or cached: the vendored PDF is the one source of
 * truth, as in `test/xfa-real.test.ts`.
 */
export interface FlowOracleEntry {
  /** SOM path, occurrence indices included -- the name Adobe wrote too. */
  name: string;
  ui: XfaUiKind;
  /** The template's container layouts, page origin outward to the field. */
  layouts: string[];
  /** Adobe's widget rect, `[llx, lly, urx, ury]` in default user space. */
  adobe: [number, number, number, number];
  /** 1-based page the widget sits on, from `/Annots` membership. */
  page: number;
}

export interface FlowOracle {
  /** Fields whose chain is NOT all `position`, each with Adobe's rect. */
  flowed: FlowOracleEntry[];
  /** Fields whose chain IS all `position` -- `xfa-real.test.ts`'s territory. */
  positioned: number;
  /** Template fields with no Adobe widget at all. Empty for both forms. */
  unmatched: string[];
}

const load = (file: string) =>
  new Uint8Array(readFileSync(new URL(`../fixtures/xfa/${file}`, import.meta.url)));

export function xfaFlowOracle(file: string): FlowOracle {
  const doc = Document.Open(load(file));
  const acro = doc.resolve(doc.catalog().get('AcroForm'));
  const packets = decodeXfaPackets(
    isDict(acro) ? acro : undefined, (o) => doc.resolve(o), (s) => decodeStream(s),
  );
  if ('reason' in packets) throw new Error(`${file}: ${packets.reason}`);
  const tplNode = packets.packets.get('template');
  if (!tplNode) throw new Error(`${file}: no template packet`);
  const tpl = parseXfaTemplate(tplNode);

  // Widget dict -> 1-based page, by identity. Every Designer field is a merged
  // field/widget dict or a parent whose kids are widgets; either way the dict
  // that carries /Rect is the one listed in some page's /Annots.
  const pageOf = new Map<PdfDict, number>();
  doc.Pages.forEach((p, i) => {
    const annots = doc.resolve(p.Dict.get('Annots'));
    if (!Array.isArray(annots)) return;
    for (const a of annots) {
      const d = doc.resolve(a);
      if (isDict(d)) pageOf.set(d, i + 1);
    }
  });
  const adobe = new Map<string, { rect: number[]; page: number | undefined }>();
  for (const f of doc.Form.Fields) {
    const rect = doc.resolve(f.Dict.get('Rect'));
    if (Array.isArray(rect))
      adobe.set(f.FullName, { rect: rect as number[], page: pageOf.get(f.Dict) });
  }

  const out: FlowOracle = { flowed: [], positioned: 0, unmatched: [] };
  for (const f of tpl.fields) {
    const a = adobe.get(f.name);
    if (!a || a.page === undefined) { out.unmatched.push(f.name); continue; }
    if (chainIsPositioned(f.layouts)) { out.positioned++; continue; }
    out.flowed.push({
      name: f.name, ui: f.ui, layouts: [...f.layouts],
      adobe: a.rect.slice(0, 4) as FlowOracleEntry['adobe'], page: a.page,
    });
  }
  return out;
}
