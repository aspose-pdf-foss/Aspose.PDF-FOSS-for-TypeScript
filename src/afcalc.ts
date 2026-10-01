// src/afcalc.ts
/**
 * AFSimple_Calculate and AFRange_Validate (jzn8), transcribed from pdf.js
 * `aform.js`, commit d52fdf411a6e4d338180687456e0df019e28475e (Apache-2.0).
 *
 * pdf.js sums with `Math.sumPrecise`, which is exactly rounded and absent from
 * Node 24. `exactSum` is Shewchuk's summation (Python's `math.fsum`): exactly
 * rounded by a DIFFERENT algorithm from the golden generator's BigInt one, so
 * the two cannot share a rounding bug.
 */
import { makeNumber } from './afnumber.js';

/** Exactly rounded sum (Shewchuk). Inputs are finite. */
export function exactSum(xs: readonly number[]): number {
  const partials: number[] = [];
  for (let x of xs) {
    let i = 0;
    for (let y of partials) {
      if (Math.abs(x) < Math.abs(y)) [x, y] = [y, x];
      const hi = x + y;
      const lo = y - (hi - x);
      if (lo !== 0) partials[i++] = lo;
      x = hi;
    }
    partials.length = i;
    partials.push(x);
  }
  let n = partials.length;
  if (n === 0) return 0;
  let hi = partials[--n];
  let lo = 0;
  while (n > 0) {
    const x = hi;
    const y = partials[--n];
    hi = x + y;
    const yr = hi - x;
    lo = y - yr;
    if (lo !== 0) break;
  }
  if (n > 0 && ((lo < 0 && partials[n - 1] < 0) || (lo > 0 && partials[n - 1] > 0))) {
    const y = lo * 2;
    const x = hi + y;
    const yr = x - hi;
    if (y === yr) hi = x;
  }
  return hi;
}

/** AFSimple_Calculate's arithmetic over the operand values. Unparseable counts
 *  as 0; no operands is 0; the result is rounded to 6 decimals. */
export function simpleCalculate(op: string, values: readonly string[]): number | undefined {
  if (op !== 'SUM' && op !== 'AVG' && op !== 'PRD' && op !== 'MIN' && op !== 'MAX') return undefined;
  if (values.length === 0) return 0;
  const nums = values.map((v) => makeNumber(v) ?? 0);
  let res: number;
  switch (op) {
    case 'AVG': res = exactSum(nums) / nums.length; break;
    case 'SUM': res = exactSum(nums); break;
    case 'PRD': res = nums.reduce((acc, v) => acc * v, 1); break;
    case 'MIN': res = Math.min(...nums); break;
    default: res = Math.max(...nums);
  }
  return Math.round(1e6 * res) / 1e6;
}

/** AFRange_Validate. Note pdf.js's final branch compares against nLess even
 *  when bLess is false; transcribed as found. */
export function rangeValidate(value: string, bGreater: boolean, nGreater: number, bLess: boolean, nLess: number): boolean {
  if (!value) return true;
  const v = makeNumber(value);
  if (v === null) return true;
  if (bGreater && bLess) return !(v < nGreater || v > nLess);
  if (bGreater) return !(v < nGreater);
  return !(v > nLess);
}
