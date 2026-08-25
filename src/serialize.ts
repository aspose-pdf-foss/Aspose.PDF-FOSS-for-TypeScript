import { PdfObject, PdfDict, PdfArray, PdfStream, isRef, isName, isDict, isArray, isStream } from './types.js';

export const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

export function serializeObject(o: PdfObject): Uint8Array {
  if (isStream(o)) return serializeStream(o);
  return enc(serializeValue(o));
}

export function serializeValue(o: PdfObject): string {
  if (o === null) return 'null';
  if (typeof o === 'boolean') return o ? 'true' : 'false';
  if (typeof o === 'number') return String(o);
  if (isRef(o)) return `${o.num} ${o.gen} R`;
  if (isName(o)) return `/${escapeName(o.name)}`;
  if (isArray(o)) return `[${(o as PdfArray).map(serializeValue).join(' ')}]`;
  if (isDict(o)) return serializeDict(o);
  if ((o as any).kind === 'string') return serializeString((o as any).bytes);
  throw new Error('cannot serialize object');
}

export function serializeDict(d: PdfDict): string {
  let s = '<<';
  for (const [k, v] of d) s += ` /${escapeName(k)} ${serializeValue(v)}`;
  return s + ' >>';
}

function serializeStream(s: PdfStream): Uint8Array {
  const dict: PdfDict = new Map(s.dict);
  dict.set('Length', s.raw.length); // recompute to match verbatim payload
  const head = enc(serializeDict(dict) + '\nstream\n');
  const tail = enc('\nendstream');
  const out = new Uint8Array(head.length + s.raw.length + tail.length);
  out.set(head, 0); out.set(s.raw, head.length); out.set(tail, head.length + s.raw.length);
  return out;
}

export function escapeName(n: string): string {
  let out = '';
  for (const ch of n) {
    const c = ch.charCodeAt(0);
    if (c < 0x21 || c > 0x7e || '()<>[]{}/%#'.includes(ch)) out += '#' + c.toString(16).padStart(2, '0');
    else out += ch;
  }
  return out;
}

export function serializeString(bytes: Uint8Array): string {
  let s = '(';
  for (const b of bytes) {
    if (b === 40 || b === 41 || b === 92) s += '\\' + String.fromCharCode(b);
    else if (b === 10) s += '\\n';
    else if (b === 13) s += '\\r';
    else if (b < 32 || b > 126) s += '\\' + b.toString(8).padStart(3, '0');
    else s += String.fromCharCode(b);
  }
  return s + ')';
}
