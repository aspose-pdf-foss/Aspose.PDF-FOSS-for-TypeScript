import type { Document } from './document.js';
import type { Page } from './page.js';
import { EditableContent } from './editcontent.js';
import { isName, name, type PdfObject } from './types.js';
import type { ContentOp } from './content.js';

/** Naive RGB → CMYK with maximum black removal and no color management. The
 *  result is **not** colorimetrically correct: without the destination profile
 *  there is no way to know what ink these values produce. It exists so a
 *  document can reach PDF/X-1a's structural requirements, not to produce
 *  accurate print output. */
export function rgbToCmyk(r: number, g: number, b: number): [number, number, number, number] {
  const k = 1 - Math.max(r, g, b);
  if (k >= 1) return [0, 0, 0, 1];
  const d = 1 - k;
  return [(1 - r - k) / d, (1 - g - k) / d, (1 - b - k) / d, k];
}

/** Round to 4 decimals; PDF numbers gain nothing from more. */
const num = (v: number): number => Number(v.toFixed(4));

/** Rewrite one operator list, returning the new list and how many ops changed. */
function rewriteOps(ops: readonly ContentOp[]): { ops: ContentOp[]; changed: number } {
  let changed = 0;
  const out = ops.map((op) => {
    if ((op.operator === 'rg' || op.operator === 'RG')
        && op.operands.length === 3 && op.operands.every((o) => typeof o === 'number')) {
      const [r, g, b] = op.operands as number[];
      changed++;
      return {
        ...op,
        operator: op.operator === 'rg' ? 'k' : 'K',
        operands: rgbToCmyk(r, g, b).map(num) as PdfObject[],
      };
    }
    if (op.operator === 'cs' || op.operator === 'CS') {
      const a = op.operands[0];
      if (isName(a) && (a.name === 'DeviceRGB' || a.name === 'RGB')) {
        changed++;
        return { ...op, operands: [name('DeviceCMYK')] };
      }
    }
    // sc/scn with three numeric operands is a color set in an RGB-like space.
    if ((op.operator === 'sc' || op.operator === 'scn' || op.operator === 'SC' || op.operator === 'SCN')
        && op.operands.length === 3 && op.operands.every((o) => typeof o === 'number')) {
      const [r, g, b] = op.operands as number[];
      changed++;
      return { ...op, operands: rgbToCmyk(r, g, b).map(num) as PdfObject[] };
    }
    return op;
  });
  return { ops: out, changed };
}

/** Rewrite a page's DeviceRGB color operators to DeviceCMYK across every
 *  top-level content stream. Returns the number of operators changed.
 *
 *  Form XObject content is **not** rewritten: reaching it means copy-on-writing
 *  every XObject just to look inside, which would clone them even when nothing
 *  changes. RGB inside an XObject stays, and the validator reports it. */
export function rewriteRgbToCmyk(doc: Document, page: Page): number {
  const edit = new EditableContent(doc, page);
  let changed = 0;
  for (let i = 0; i < edit.streamCount; i++) {
    const r = rewriteOps(edit.topOps(i));
    if (r.changed > 0) { edit.setTopOps(i, r.ops); changed += r.changed; }
  }
  if (changed > 0) edit.commit();
  return changed;
}
