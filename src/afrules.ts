// src/afrules.ts
/**
 * Which native AForm semantics a field script names (jzn8). A pure dispatch
 * over `afcall.ts`'s recognition: a script is either one recognised call in the
 * right slot, handed to its semantics module, or `undefined`. Nothing is
 * executed. The public report types for Recalculate and CheckValues live here
 * too, so `afform.ts` and `formfield.ts` share one vocabulary.
 */
import { parseAfCall, type AfName } from './afcall.js';
import { numberFormat, numberKeystroke, percentFormat } from './afnumber.js';
import { DATE_FORMATS, TIME_FORMATS, dateFormat, dateKeystroke } from './afdate.js';
import { specialFormat, specialKeystroke, specialKeystrokeEx } from './afspecial.js';
import { rangeValidate } from './afcalc.js';
import type { FieldActions } from './actions.js';

/** A field script that is not one recognised AForm call in its slot. */
export interface UnrecognisedScript {
  readonly field: string;
  readonly trigger: 'keystroke' | 'validate' | 'calculate';
  readonly script: string;
}

/** A field value its own recognised keystroke or validate rule rejects. */
export interface ValueRejection {
  readonly field: string;
  readonly trigger: 'keystroke' | 'validate';
  readonly rule: AfName;
  readonly value: string;
  readonly message: string;
}

/** What `Form.CheckValues()` found. */
export interface ValueCheckReport {
  readonly rejected: readonly ValueRejection[];
  readonly unrecognised: readonly UnrecognisedScript[];
}

/** One value `Form.Recalculate()` changed. */
export interface RecalculatedValue { readonly field: string; readonly from: string; readonly to: string }

/** What `Form.Recalculate()` did. */
export interface RecalculateReport {
  readonly changed: readonly RecalculatedValue[];
  readonly unrecognised: readonly UnrecognisedScript[];
  /** Fields with a calculate script that /AcroForm /CO does not list. Acrobat
   *  never runs those, so neither does Recalculate. */
  readonly notInOrder: readonly string[];
}

const n = (a: unknown): number => a as number;
const s = (a: unknown): string => a as string;
const b = (a: unknown): boolean => a as boolean;

/** The value as the script's recognised format function would display it, or
 *  undefined when the script is not one recognised format call. */
export function formatValue(script: string, value: string): string | undefined {
  const c = parseAfCall(script);
  if (c === undefined) return undefined;
  const a = c.args;
  switch (c.name) {
    case 'AFNumber_Format': return numberFormat(value, n(a[0]), n(a[1]), n(a[2]), n(a[3]), s(a[4]), b(a[5]));
    case 'AFPercent_Format': return percentFormat(value, n(a[0]), n(a[1]), (a[2] as boolean | undefined) ?? false);
    case 'AFDate_FormatEx': case 'AFTime_FormatEx': return dateFormat(value, s(a[0]));
    case 'AFDate_Format': { const f = DATE_FORMATS[n(a[0])]; return f === undefined ? undefined : dateFormat(value, f); }
    case 'AFTime_Format': { const f = TIME_FORMATS[n(a[0])]; return f === undefined ? undefined : dateFormat(value, f); }
    case 'AFSpecial_Format': return specialFormat(value, n(a[0]));
    default: return undefined;
  }
}

/** Whether a commit-time keystroke rule or a validate rule accepts the value,
 *  or undefined when the script is not one recognised call for that slot. */
export function checkValue(
  trigger: 'keystroke' | 'validate', script: string, value: string,
): { ok: boolean; rule: AfName } | undefined {
  const c = parseAfCall(script);
  if (c === undefined) return undefined;
  const a = c.args;
  const res = (ok: boolean | undefined): { ok: boolean; rule: AfName } | undefined =>
    (ok === undefined ? undefined : { ok, rule: c.name });
  if (trigger === 'validate') return c.name === 'AFRange_Validate' ? res(rangeValidate(value, b(a[0]), n(a[1]), b(a[2]), n(a[3]))) : undefined;
  switch (c.name) {
    case 'AFNumber_Keystroke': case 'AFPercent_Keystroke': return res(numberKeystroke(value, n(a[1])));
    case 'AFDate_KeystrokeEx': case 'AFTime_KeystrokeEx': return res(dateKeystroke(value, s(a[0])));
    case 'AFDate_Keystroke': { const f = DATE_FORMATS[n(a[0])]; return res(f === undefined ? true : dateKeystroke(value, f)); }
    case 'AFTime_Keystroke': { const f = TIME_FORMATS[n(a[0])]; return res(f === undefined ? true : dateKeystroke(value, f)); }
    case 'AFSpecial_Keystroke': return res(specialKeystroke(value, n(a[0])));
    case 'AFSpecial_KeystrokeEx': return res(specialKeystrokeEx(value, s(a[0])));
    default: return undefined;
  }
}

/** Check a value against a field's keystroke and validate scripts. Actions
 *  that are not JavaScript have nothing to evaluate and are skipped. */
export function evaluateRules(field: string, actions: FieldActions, value: string): ValueCheckReport {
  const rejected: ValueRejection[] = [];
  const unrecognised: UnrecognisedScript[] = [];
  for (const trigger of ['keystroke', 'validate'] as const) {
    const act = actions[trigger];
    if (act === undefined || act.type !== 'javascript') continue;
    const r = checkValue(trigger, act.script, value);
    if (r === undefined) { unrecognised.push({ field, trigger, script: act.script }); continue; }
    if (!r.ok) rejected.push({ field, trigger, rule: r.rule, value, message: `${r.rule} rejected "${value}"` });
  }
  return { rejected, unrecognised };
}
