// src/afform.ts
/**
 * Running the recognised AForm scripts over a live form (jzn8):
 * `Form.Recalculate()` and `Form.CheckValues()`. The one module of the feature
 * that holds a `Document`; `Document`, `Form` and `Field` are imported as TYPES
 * only, so this closes no import cycle. Nothing is executed: a script is one
 * recognised call or it is reported unrecognised.
 */
import type { Document } from './document.js';
import type { Field } from './formfield.js';
import { isArray, isDict } from './types.js';
import { parseAfCall } from './afcall.js';
import { simpleCalculate } from './afcalc.js';
import {
  evaluateRules,
  type RecalculateReport, type RecalculatedValue, type UnrecognisedScript,
  type ValueCheckReport, type ValueRejection,
} from './afrules.js';

const calcScript = (f: Field): string | undefined => {
  const c = f.Actions.calculate;
  return c !== undefined && c.type === 'javascript' ? c.script : undefined;
};
const textOf = (f: Field): string => { const v = f.Value; return typeof v === 'string' ? v : ''; };
/** AFMakeArrayFromList: a string splits on a comma and an optional space. */
const listOf = (v: string | readonly string[]): string[] => (typeof v === 'string' ? v.split(/, ?/g) : [...v]);

/** Recompute every /CO-listed field whose calculate script is a recognised
 *  AFSimple_Calculate, once, in /CO order — Acrobat's model. */
export function recalculate(doc: Document, fields: readonly Field[]): RecalculateReport {
  const changed: RecalculatedValue[] = [];
  const unrecognised: UnrecognisedScript[] = [];
  const notInOrder: string[] = [];

  const acro = doc.resolve(doc.catalog().get('AcroForm'));
  const co = isDict(acro) ? doc.resolve(acro.get('CO')) : undefined;
  const byDict = new Map(fields.map((f) => [f.Dict, f] as const));
  const ordered: Field[] = [];
  const listed = new Set<Field>();
  if (isArray(co)) {
    for (const e of co) {
      const d = doc.resolve(e);
      const f = isDict(d) ? byDict.get(d) : undefined;
      if (f !== undefined && !listed.has(f)) { listed.add(f); ordered.push(f); }
    }
  }
  for (const f of fields) if (!listed.has(f) && calcScript(f) !== undefined) notInOrder.push(f.FullName);

  for (const f of ordered) {
    const script = calcScript(f);
    if (script === undefined) continue;
    const call = parseAfCall(script);
    if (call === undefined || call.name !== 'AFSimple_Calculate' || f.Type !== 'text') {
      unrecognised.push({ field: f.FullName, trigger: 'calculate', script });
      continue;
    }
    const values: string[] = [];
    for (const name of listOf(call.args[1] as string | readonly string[])) {
      // A name covers itself and its subtree, never a mere string prefix.
      for (const x of fields) if (x.FullName === name || x.FullName.startsWith(`${name}.`)) values.push(textOf(x));
    }
    const result = simpleCalculate(call.args[0] as string, values);
    if (result === undefined) { unrecognised.push({ field: f.FullName, trigger: 'calculate', script }); continue; }
    const to = String(result);
    const from = textOf(f);
    if (to !== from) {
      f.storeValue(to);
      changed.push({ field: f.FullName, from, to });
    }
  }
  return { changed, unrecognised, notInOrder };
}

/** Check every text field's value against its recognised keystroke and
 *  validate rules. */
export function checkValues(fields: readonly Field[]): ValueCheckReport {
  const rejected: ValueRejection[] = [];
  const unrecognised: UnrecognisedScript[] = [];
  for (const f of fields) {
    if (f.Type !== 'text') continue;
    const r = evaluateRules(f.FullName, f.Actions, textOf(f));
    rejected.push(...r.rejected);
    unrecognised.push(...r.unrecognised);
  }
  return { rejected, unrecognised };
}
