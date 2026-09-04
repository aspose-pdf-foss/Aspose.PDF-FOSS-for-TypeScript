import type { Document } from './document.js';
import type { Page } from './page.js';
import { EditableContent } from './editcontent.js';
import { isName, name, type PdfObject } from './types.js';
import type { ContentOp } from './content.js';
import { rgbToCmyk } from './colorrule.js';

/** The RGB → CMYK transform. It MOVED to `colorrule.ts` in `85l8.1` (then named `grayscale.ts`), because
 *  `ConvertColors({ to: 'cmyk' })` needs it from a leaf and this module is not
 *  one. Re-exported so this stays its import path for every existing caller;
 *  `export … from` creates no local binding, so `rewriteOps` below imports it
 *  beside this — `resprune.ts`'s arrangement against `redact.ts`. */
export { rgbToCmyk } from './colorrule.js';

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
