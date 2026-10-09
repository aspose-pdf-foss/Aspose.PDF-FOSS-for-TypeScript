import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Document } from '../src/document.js';
import { isDict } from '../src/types.js';
import { xfaFlowOracle } from './helpers/xfa-flow-oracle.js';

/**
 * The flow-layout oracle (`164g.5`): the fields of a hybrid XFA form whose
 * container chain is FLOWED, each paired with the rect Adobe's own layout
 * engine wrote for it. `164g.1` lays out flowed subforms, and these cases pin
 * both what the oracle contains and that the engine reproduces it exactly.
 *
 * See `test/fixtures/xfa/PROVENANCE.md` for what it does and does not cover --
 * in particular, no `tb` chain and no `<occur>`.
 */
describe('the flow oracle: IRS f1040', () => {
  const oracle = xfaFlowOracle('irs-f1040.pdf');
  const byName = new Map(oracle.flowed.map((e) => [e.name, e]));
  const rect = (short: string) =>
    byName.get(`topmostSubform[0].Page1[0].Table_Dependents[0].${short}`)!.adobe;

  // Pinned EXACTLY, so a template-parse change that moves a field across the
  // positioned/flowed line is a red build rather than a quietly smaller oracle.
  it('pairs every template field with an Adobe widget, 40 of them flowed', () => {
    expect(oracle.unmatched).toEqual([]);
    expect(oracle.positioned).toBe(159);
    expect(oracle.flowed).toHaveLength(40);
    const chains: Record<string, number> = {};
    for (const e of oracle.flowed) {
      const k = e.layouts.join('/');
      chains[k] = (chains[k] ?? 0) + 1;
    }
    expect(chains).toEqual({
      'position/position/table/row': 16,
      'position/position/table/row/position': 8,
      'position/position/table/row/lr-tb': 16,
    });
    expect(new Set(oracle.flowed.map((e) => e.page))).toEqual(new Set([1]));
  });

  // What the oracle is for: every flowed field placed, and placed where Adobe's
  // layout engine put it, to a hundredth of a point.
  it('is reproduced exactly by the flow engine, all 40 fields', () => {
    const doc = Document.Open(
      new Uint8Array(readFileSync(new URL('./fixtures/xfa/irs-f1040.pdf', import.meta.url))),
    );
    const acro = doc.resolve(doc.catalog().get('AcroForm'));
    if (isDict(acro)) acro.set('Fields', []);
    for (const p of doc.Pages) p.Dict.delete('Annots');
    const report = doc.ConvertXfaToAcroForm({ removeXfa: false });
    const route = new Map(report.fields.map((f) => [f.name, f]));
    let worst = 0;
    for (const e of oracle.flowed) {
      expect(route.get(e.name)?.route).toBe('positioned');
      expect(route.get(e.name)?.page).toBe(e.page);
      const got = doc.resolve(doc.Form.Get(e.name)!.Dict.get('Rect')) as number[];
      worst = Math.max(worst, ...[0, 1, 2, 3].map((i) => Math.abs(got[i] - e.adobe[i])));
    }
    expect(worst).toBeLessThanOrEqual(0.01);
  });

  // Evidence the oracle reads a TABLE, rather than four fields that happen to
  // sit near each other: the text rows abut (to a hundredth of a point, the
  // precision xfa-real.test.ts compares at) (each bottom is the next
  // top), every row is the same 12pt tall, and the four columns align across
  // all four rows with no cell overlapping the next.
  it('describes a table: abutting rows, aligned columns', () => {
    const rows = [1, 2, 3, 4].map((r) =>
      [0, 1, 2, 3].map((c) => rect(`Row${r}[0].f1_${31 + (r - 1) * 4 + c}[0]`)));
    for (let r = 0; r < 4; r++) {
      for (const cell of rows[r]) {
        expect(cell[1]).toBeCloseTo(rows[r][0][1], 2);
        expect(cell[3] - cell[1]).toBeCloseTo(12, 2);
      }
      for (let c = 0; c < 3; c++) expect(rows[r][c][2]).toBeLessThan(rows[r][c + 1][0]);
      if (r > 0) expect(rows[r][0][3]).toBeCloseTo(rows[r - 1][0][1], 2);
      for (let c = 0; c < 4; c++) {
        expect(rows[r][c][0]).toBeCloseTo(rows[0][c][0], 2);
        expect(rows[r][c][2]).toBeCloseTo(rows[0][c][2], 2);
      }
    }
  });

  // The lr-tb half: inside Dependent1 of Row6 and of Row7, two 8x8 buttons
  // flow left to right on one line.
  it('describes lr-tb: two buttons side by side in each cell', () => {
    for (const [row, a, b] of [
      ['Row6', 'c1_20[0]', 'c1_21[0]'],
      ['Row7', 'c1_28[0]', 'c1_28[1]'],
    ]) {
      const l = rect(`${row}[0].Dependent1[0].${a}`);
      const r = rect(`${row}[0].Dependent1[0].${b}`);
      expect(r[1]).toBeCloseTo(l[1], 2);
      expect(r[0]).toBeGreaterThan(l[2]);
      expect(l[2] - l[0]).toBeCloseTo(8, 2);
      expect(r[2] - r[0]).toBeCloseTo(8, 2);
    }
  });
});

describe('the flow oracle: IRS fw9', () => {
  // fw9's `tb` subforms hold no fields, so it contributes nothing here: every
  // one of its 23 fields has a positioned chain, and it reaches `dataOnly` only
  // through the pageArea-count rule. Pinned so that reading does not drift.
  it('has no flowed field', () => {
    const o = xfaFlowOracle('irs-fw9.pdf');
    expect(o.unmatched).toEqual([]);
    expect(o.flowed).toEqual([]);
    expect(o.positioned).toBe(23);
  });
});
