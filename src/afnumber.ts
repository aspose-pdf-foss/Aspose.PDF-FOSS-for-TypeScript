// src/afnumber.ts
/**
 * AForm number and percent semantics (jzn8), transcribed from pdf.js
 * `src/scripting_api/aform.js` and the `%,<sep>.<dec>f` path of `util.printf`,
 * commit d52fdf411a6e4d338180687456e0df019e28475e (Apache-2.0). Checked against
 * goldens generated from that code (`test/fixtures/aform/`).
 *
 * A pure leaf. `undefined` from a formatter means the arguments are ones pdf.js
 * would throw on; the caller treats the call as unrecognised.
 */

/** util.printf's separator styles 0-4: [thousands, decimal]. */
const SEPARATORS: readonly (readonly [string, string])[] = [
  [',', '.'], ['', '.'], ['.', ','], ['', ','], ["'", '.'],
];

const clampSep = (s: number): number => Math.min(Math.max(Math.floor(s), 0), 4);

/** AFMakeNumber: trim, the FIRST comma becomes a dot, parseFloat; non-finite is null. */
export function makeNumber(v: string | number): number | null {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return null;
  const n = parseFloat(v.trim().replace(',', '.'));
  return Number.isNaN(n) || !Number.isFinite(n) ? null : n;
}

/** util.printf's `%,<sep>.<dec>f`: the only conversion AForm formats numbers with. */
export function printfFixed(sep: number, dec: number, arg: number): string {
  const [thousandSep, decimalSep] = SEPARATORS[sep];
  let intPart = Math.trunc(arg);
  let decPart = Math.abs(arg - intPart).toFixed(dec);
  if (decPart.length > 2) {
    if (/^1\.0+$/.test(decPart)) {
      intPart += Math.sign(arg);
      decPart = `${decimalSep}${decPart.split('.')[1]}`;
    } else {
      decPart = `${decimalSep}${decPart.substring(2)}`;
    }
  } else {
    if (decPart === '1') intPart += Math.sign(arg);
    decPart = '';
  }
  let sign = '';
  if (intPart < 0) { sign = '-'; intPart = -intPart; }
  let ip: string;
  if (thousandSep && intPart >= 1000) {
    const buf: string[] = [];
    for (;;) {
      buf.push((intPart % 1000).toString().padStart(3, '0'));
      intPart = Math.trunc(intPart / 1000);
      if (intPart < 1000) { buf.push(intPart.toString()); break; }
    }
    ip = buf.reverse().join(thousandSep);
  } else {
    ip = intPart.toString();
  }
  return `${sign}${ip}${decPart}`;
}

/** AFNumber_Format. Negative styles 1 and 3 turn the text red in a viewer; that
 *  colour is not applied here (a stated divergence), the parentheses are. */
export function numberFormat(
  value: string, nDec: number, sepStyle: number, negStyle: number,
  _currStyle: number, strCurrency: string, prepend: boolean,
): string | undefined {
  // pdf.js splices strCurrency into a printf FORMAT string, so a '%' there is
  // read as a conversion; and toFixed throws outside 0..100.
  if (!Number.isInteger(nDec) || nDec < 0 || nDec > 100 || strCurrency.includes('%')) return undefined;
  let v = makeNumber(value);
  if (v === null) return '';
  const sign = Math.sign(v);
  let out = '';
  if (sign === -1 && prepend && negStyle === 0) out += '-';
  const paren = (negStyle === 2 || negStyle === 3) && sign === -1;
  if (paren) out += '(';
  if (prepend) out += strCurrency;
  if ((negStyle !== 0 || prepend) && sign === -1) v = -v;
  out += printfFixed(clampSep(sepStyle), nDec, v);
  if (!prepend) out += strCurrency;
  if (paren) out += ')';
  return out;
}

/** AFNumber_Keystroke (and AFPercent_Keystroke) at commit time. */
export function numberKeystroke(value: string, sepStyle: number): boolean {
  if (!value) return true;
  const v = value.trim();
  const re = sepStyle > 1 ? /^[+-]?(\d+(,\d*)?|,\d+)$/ : /^[+-]?(\d+(\.\d*)?|\.\d+)$/;
  return re.test(v);
}

/** AFPercent_Format. */
export function percentFormat(value: string, nDec: number, sepStyle: number, prepend = false): string | undefined {
  if (nDec < 0) return undefined;
  if (nDec > 512) return '%';
  const dec = Math.floor(nDec);
  if (dec > 100) return undefined;
  const v = makeNumber(value);
  if (v === null) return '%';
  const s = printfFixed(clampSep(sepStyle), dec, v * 100);
  return prepend ? `%${s}` : `${s}%`;
}
