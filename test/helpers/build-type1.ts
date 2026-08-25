// Builds a Type 1 font program: clear header, eexec-encrypted private portion
// with /Subrs and /CharStrings, and the conventional 512-zero trailer. The
// encryption here is the inverse of src/type1.ts's, which is exactly why the
// real-font fixture in test/type1-real.test.ts exists as well — this builder
// and that parser could agree with each other and both disagree with the format.
const C1 = 52845, C2 = 22719;

export function t1num(n: number): number[] {
  if (n >= -107 && n <= 107) return [n + 139];
  if (n >= 108 && n <= 1131) { const v = n - 108; return [(v >> 8) + 247, v & 0xff]; }
  if (n <= -108 && n >= -1131) { const v = -n - 108; return [(v >> 8) + 251, v & 0xff]; }
  return [255, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}
export const t1cs = (...parts: (number[] | number)[]): Uint8Array =>
  Uint8Array.from(parts.flatMap((p) => (typeof p === 'number' ? [p] : p)));

function bytes(s: string): Uint8Array { return Uint8Array.from(s, (ch) => ch.charCodeAt(0) & 0xff); }
function concat(parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** The inverse of type1.ts's `decrypt`, with `pad` leading plaintext bytes. */
function encrypt(plain: Uint8Array, r0: number, pad: number, padByte = 0x55): Uint8Array {
  const src = new Uint8Array(plain.length + pad);
  src.fill(padByte, 0, pad);
  src.set(plain, pad);
  let r = r0;
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const cph = (src[i] ^ (r >> 8)) & 0xff;
    r = ((cph + r) * C1 + C2) & 0xffff;
    out[i] = cph;
  }
  return out;
}

const isHexByte = (b: number): boolean =>
  (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66);

/** Encrypt the private portion, choosing a pad byte whose ciphertext does not
 *  open with four hex digits — that shape is how a reader tells a binary eexec
 *  section from a hex one, and a real font's random pad avoids it by luck. */
function encryptEexec(plain: Uint8Array): Uint8Array {
  for (let padByte = 0x55; padByte < 0x80; padByte++) {
    const out = encrypt(plain, 55665, 4, padByte);
    if (![0, 1, 2, 3].every((k) => isHexByte(out[k]))) return out;
  }
  throw new Error('build-type1: no pad byte yielded a non-hex-looking eexec prefix');
}

export interface Type1Spec {
  /** glyph name -> PLAINTEXT charstring; order becomes the glyph order. */
  charstrings: Record<string, Uint8Array>;
  /** Plaintext subrs, indexed as the font numbers them. */
  subrs?: Uint8Array[];
  /** The program's own /Encoding. Omit => it declares StandardEncoding. */
  encoding?: Record<number, string>;
  lenIV?: number;
  hexEexec?: boolean;
  pfb?: boolean;
  fontMatrix?: number[];
  rdToken?: 'RD' | '-|';
  /** /FontName. Default 'TestFont'. */
  fontName?: string;
  /** /FamilyName. Omit => the header states none. */
  familyName?: string;
  /** /Weight. Omit => the header states none. */
  weight?: string;
  /** /ItalicAngle. Omit => the header states none. */
  italicAngle?: number;
  /** /FontBBox, in braces as real fonts write it. Default [0, 0, 1000, 1000]. */
  fontBBox?: [number, number, number, number];
}

export function buildType1(spec: Type1Spec): Uint8Array {
  const lenIV = spec.lenIV ?? 4;
  const rd = spec.rdToken ?? 'RD';
  const nd = rd === 'RD' ? 'ND' : '|-';
  const np = rd === 'RD' ? 'NP' : '|';
  const fm = spec.fontMatrix ?? [0.001, 0, 0, 0.001, 0, 0];

  const encLines = spec.encoding
    ? ['/Encoding 256 array', '0 1 255 {1 index exch /.notdef put} for',
      ...Object.entries(spec.encoding).map(([code, name]) => `dup ${code} /${name} put`),
      'readonly def']
    : ['/Encoding StandardEncoding def'];

  const bbox = spec.fontBBox ?? [0, 0, 1000, 1000];
  const info: string[] = [];
  if (spec.familyName !== undefined) info.push(`/FamilyName (${spec.familyName}) readonly def`);
  if (spec.weight !== undefined) info.push(`/Weight (${spec.weight}) readonly def`);
  if (spec.italicAngle !== undefined) info.push(`/ItalicAngle ${spec.italicAngle} def`);

  const clear = bytes([
    '%!PS-AdobeFont-1.0: TestFont 001.000',
    ...info,
    `/FontName /${spec.fontName ?? 'TestFont'} def`,
    `/FontMatrix [${fm.join(' ')}] readonly def`,
    '/FontType 1 def',
    `/FontBBox {${bbox.join(' ')}} readonly def`,
    ...encLines,
    'currentdict end',
    'currentfile eexec',
    '',
  ].join('\n'));

  // Private portion, plaintext. Binary payloads are spliced in after building
  // the surrounding text, so a length is never guessed.
  const parts: Uint8Array[] = [];
  const push = (s: string): void => { parts.push(bytes(s)); };
  push(`dup /Private 8 dict dup begin\n/lenIV ${lenIV} def\n`);

  const subrs = spec.subrs ?? [];
  if (subrs.length) {
    push(`/Subrs ${subrs.length} array\n`);
    subrs.forEach((cs, i) => {
      const enc = encrypt(cs, 4330, lenIV);
      push(`dup ${i} ${enc.length} ${rd} `);
      parts.push(enc);
      push(` ${np}\n`);
    });
    push('ND\n');
  }

  const names = Object.keys(spec.charstrings);
  push(`2 index /CharStrings ${names.length} dict dup begin\n`);
  for (const name of names) {
    const enc = encrypt(spec.charstrings[name], 4330, lenIV);
    push(`/${name} ${enc.length} ${rd} `);
    parts.push(enc);
    push(` ${nd}\n`);
  }
  push('end\nend\nmark currentfile closefile\n');

  let priv = encryptEexec(concat(parts));
  if (spec.hexEexec) {
    const hex = Array.from(priv, (b) => b.toString(16).padStart(2, '0')).join('');
    const wrapped = hex.replace(/(.{64})/g, '$1\n');
    priv = bytes(wrapped.endsWith('\n') ? wrapped : `${wrapped}\n`);
  }

  const trailer = bytes(`${'0'.repeat(64)}\n`.repeat(8) + 'cleartomark\n');
  if (!spec.pfb) return concat([clear, priv, trailer]);

  const seg = (type: number, data: Uint8Array): Uint8Array => {
    const h = new Uint8Array(6);
    h[0] = 0x80; h[1] = type;
    new DataView(h.buffer).setUint32(2, data.length, true);
    return concat([h, data]);
  };
  return concat([seg(1, clear), seg(2, priv), seg(1, trailer), Uint8Array.from([0x80, 3])]);
}

/** Byte offset just past `eexec` and the whitespace following it — where the
 *  encrypted portion begins. */
export function eexecStart(program: Uint8Array): number {
  const marker = bytes('eexec');
  let at = -1;
  outer: for (let i = 0; i + marker.length <= program.length; i++) {
    for (let k = 0; k < marker.length; k++) if (program[i + k] !== marker[k]) continue outer;
    at = i; break;
  }
  if (at < 0) throw new Error('build-type1: no eexec in program');
  let p = at + marker.length;
  while (p < program.length && (program[p] === 0x0d || program[p] === 0x0a || program[p] === 0x20 || program[p] === 0x09)) p++;
  return p;
}

/** The three PDF `/FontFile` lengths for a program built above. */
export function fontFileLengths(program: Uint8Array): { l1: number; l2: number; l3: number } {
  const l1 = eexecStart(program);
  const zeros = bytes('0'.repeat(64));
  let t = program.length;
  outer: for (let i = l1; i + zeros.length <= program.length; i++) {
    for (let k = 0; k < zeros.length; k++) if (program[i + k] !== zeros[k]) continue outer;
    t = i; break;
  }
  return { l1, l2: t - l1, l3: program.length - t };
}
