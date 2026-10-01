// src/afspecial.ts
/**
 * AForm special formats (jzn8): zip, zip+4, phone and SSN, and the masked
 * keystroke checks. Transcribed from pdf.js `aform.js` (AFSpecial_*) and
 * `util.js` (printx), commit d52fdf411a6e4d338180687456e0df019e28475e
 * (Apache-2.0). Keystroke checks are commit-time only; pdf.js's commit path
 * also pads the value with the rest of the mask, which is a rewrite, and this
 * module only accepts or rejects.
 */

const upper = (x: string): string => x.toUpperCase();
const lower = (x: string): string => x.toLowerCase();
const same = (x: string): string => x;
const isAlpha = (c: string): boolean => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
const isDigit = (c: string): boolean => c >= '0' && c <= '9';

/** util.printx. */
export function printx(mask: string, source: string): string {
  const src = source ?? '';
  const buf: string[] = [];
  let i = 0;
  let currCase = same;
  let escaped = false;
  for (const command of mask) {
    if (escaped) { buf.push(command); escaped = false; continue; }
    if (i >= src.length) break;
    switch (command) {
      case '?': buf.push(currCase(src.charAt(i++))); break;
      case 'X':
        while (i < src.length) { const c = src.charAt(i++); if (isAlpha(c) || isDigit(c)) { buf.push(currCase(c)); break; } }
        break;
      case 'A':
        while (i < src.length) { const c = src.charAt(i++); if (isAlpha(c)) { buf.push(currCase(c)); break; } }
        break;
      case '9':
        while (i < src.length) { const c = src.charAt(i++); if (isDigit(c)) { buf.push(c); break; } }
        break;
      case '*': while (i < src.length) buf.push(currCase(src.charAt(i++))); break;
      case '\\': escaped = true; break;
      case '>': currCase = upper; break;
      case '<': currCase = lower; break;
      case '=': currCase = same; break;
      default: buf.push(command);
    }
  }
  return buf.join('');
}

/** AFSpecial_Format. */
export function specialFormat(value: string, psf: number): string | undefined {
  if (!value) return value;
  let fmt: string;
  switch (psf) {
    case 0: fmt = '99999'; break;
    case 1: fmt = '99999-9999'; break;
    case 2: fmt = printx('9999999999', value).length >= 10 ? '(999) 999-9999' : '999-9999'; break;
    case 3: fmt = '999-99-9999'; break;
    default: return undefined;
  }
  return printx(fmt, value);
}

const CHECKERS: Record<string, (c: string) => boolean> = {
  9: isDigit,
  A: isAlpha,
  O: (c) => isAlpha(c) || isDigit(c),
  X: () => true,
};

function valid(value: string, mask: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const m = mask.charAt(i);
    const c = value.charAt(i);
    if (Object.hasOwn(CHECKERS, m)) { if (!CHECKERS[m](c)) return false; } else if (m !== c) return false;
  }
  return true;
}

/** #AFSpecial_KeystrokeEx_helper at commit time. */
function commit(mask: string, value: string): boolean {
  if (!mask || !value) return true;
  if (value.length !== mask.length) return false;
  return valid(value, mask);
}

/** AFSpecial_KeystrokeEx at commit time. */
export function specialKeystrokeEx(value: string, mask: string): boolean {
  if (commit(mask.replace(/[^9AOX]/g, ''), value)) return true;
  return commit(mask, value);
}

/** AFSpecial_Keystroke at commit time; undefined for an unknown psf. */
export function specialKeystroke(value: string, psf: number): boolean | undefined {
  let first: string;
  let second: string | undefined;
  switch (psf) {
    case 0: first = '99999'; break;
    case 1: first = '99999-9999'; break;
    case 2: first = '999-9999'; second = '(999) 999-9999'; break;
    case 3: first = '999-99-9999'; break;
    default: return undefined;
  }
  const formats = second !== undefined ? [first, second] : [first];
  for (const f of formats) if (commit(f, value)) return true;
  const re = /[-()\s]+/g;
  const stripped = value.replace(re, '');
  // pdf.js's helper falls back to the EVENT value when handed an empty string.
  for (const f of formats) if (commit(f.replace(re, ''), stripped || value)) return true;
  const digits = (second !== undefined && stripped.match(/\d/g)) || [];
  return specialKeystrokeEx(value, digits.length > 7 && second !== undefined ? second : first);
}
