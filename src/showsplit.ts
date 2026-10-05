// One show operator rewritten so a run in another font can sit inside it
// (u3l5.2). Pure over ContentOps: the caller has already chosen fonts,
// encoded every piece and registered every foreign font's resource key.
import type { ContentOp } from './content.js';
import { isString, name, type PdfObject } from './types.js';

/** What one show operator draws, in order, once its edits are applied. */
export type ShowPiece =
  | { kind: 'bytes'; bytes: Uint8Array }
  | { kind: 'kern'; value: PdfObject }
  | {
    kind: 'foreign'; bytes: Uint8Array;
    /** The font to switch to; absent keeps the operator's own (u3l5.3). */
    key?: string;
    /** The `Tf` size; absent keeps the original size. */
    size?: number;
    /** A fill to set before the run and the operators that restore the old. */
    fill?: { set: ContentOp; restore: readonly ContentOp[] };
  };

/** The `Tf` that puts the original font back: its resource key and size. */
export interface FontRestore { key: string; size: number }

/**
 * Rewrite `op` as `pieces`, switching font around every foreign piece with
 * `/key size Tf … Tj /restore.key size Tf`.
 *
 * **Invariant:** a foreign run is drawn at the ORIGINAL size and every other
 * text-state parameter carries on, so it takes the replaced text's spacing and
 * colour — unless the piece states a `size` or a `fill` (u3l5.3), each of
 * which is put back right after the run. The original font is restored after EACH foreign run, so whatever
 * follows in the text object is drawn as before.
 *
 * **Invariant:** the line move of `'` and `"` belongs to the operator, so the
 * FIRST piece keeps the original operator — with `"`'s `aw ac` operands, and
 * even when its string is empty — and everything after is written as `Tj`/`TJ`,
 * so the move and the spacing apply once. An empty `Tj` piece is omitted (it
 * would draw and move nothing); a `TJ` piece holding only kerns is kept, since
 * a kern moves the pen.
 */
export function splitShowOp(op: ContentOp, pieces: ShowPiece[], restore: FontRestore): ContentOp[] {
  const out: ContentOp[] = [];
  let cur: PdfObject[] = [];
  let first = true;
  const str = (bytes: Uint8Array): PdfObject => ({ kind: 'string', bytes });
  const bytesOf = (els: PdfObject[]): Uint8Array => {
    const parts = els.filter(isString).map((e) => e.bytes);
    const joined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { joined.set(p, at); at += p.length; }
    return joined;
  };
  const flush = (): void => {
    // A kern (u3l5.4) can only be written in a TJ: a `Tj` holding one becomes
    // a TJ, and a `'`/`"` keeps its line move with an EMPTY string and draws
    // through a TJ after it.
    const kerned = cur.some((e) => !isString(e));
    if (first && op.operator === "'") {
      out.push({ operator: "'", operands: [str(kerned ? new Uint8Array(0) : bytesOf(cur))] });
      if (kerned) out.push({ operator: 'TJ', operands: [cur] });
    } else if (first && op.operator === '"') {
      out.push({ operator: '"', operands: [op.operands[0], op.operands[1], str(kerned ? new Uint8Array(0) : bytesOf(cur))] });
      if (kerned) out.push({ operator: 'TJ', operands: [cur] });
    } else if (op.operator === 'TJ' || kerned) { if (cur.length > 0) out.push({ operator: 'TJ', operands: [cur] }); }
    else { const t = bytesOf(cur); if (t.length > 0) out.push({ operator: 'Tj', operands: [str(t)] }); }
    cur = [];
    first = false;
  };
  for (const p of pieces) {
    if (p.kind === 'foreign') {
      flush();
      // A `Tf` only when the font or the size changes: a colour-only run
      // needs none, and may sit where no `Tf` key can be named (u3l5.3).
      const switches = (p.key !== undefined && p.key !== restore.key)
        || (p.size !== undefined && p.size !== restore.size);
      if (p.fill) out.push(p.fill.set);
      if (switches) out.push({ operator: 'Tf', operands: [name(p.key ?? restore.key), p.size ?? restore.size] });
      out.push({ operator: 'Tj', operands: [str(p.bytes)] });
      if (switches) out.push({ operator: 'Tf', operands: [name(restore.key), restore.size] });
      if (p.fill) out.push(...p.fill.restore);
    } else if (p.kind === 'kern') {
      cur.push(p.value);
    } else if (p.bytes.length > 0) {
      const last = cur[cur.length - 1];
      if (last !== undefined && isString(last)) {
        const joined = new Uint8Array(last.bytes.length + p.bytes.length);
        joined.set(last.bytes); joined.set(p.bytes, last.bytes.length);
        cur[cur.length - 1] = str(joined);
      } else cur.push(str(p.bytes));
    }
  }
  flush();
  return out;
}
