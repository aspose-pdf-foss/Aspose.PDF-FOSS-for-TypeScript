import { PdfDict, PdfObject, isDict, isArray, isStream } from './types.js';
import { evalPostScript, parsePostScriptFunction, type PsProgram } from './psfunc.js';

export type PdfFunction = (input: number[]) => number[];

type Resolve = (o: PdfObject | undefined) => PdfObject;
type Inflate = (s: { dict: PdfDict; raw: Uint8Array }) => Uint8Array;

function nums(o: PdfObject | undefined, resolve: Resolve): number[] {
  const r = resolve(o);
  return isArray(r) ? r.map((x) => resolve(x)).filter((x): x is number => typeof x === 'number') : [];
}
function n(o: PdfObject | undefined, resolve: Resolve, dflt: number): number {
  const r = resolve(o);
  return typeof r === 'number' ? r : dflt;
}
function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
function interp(x: number, x0: number, x1: number, y0: number, y1: number): number {
  return x1 === x0 ? y0 : y0 + ((x - x0) * (y1 - y0)) / (x1 - x0);
}

/** Parse a PDF function (dict or stream) into a numeric map. Arrays of functions
 *  are each single-output and concatenated. */
export function parseFunction(obj: PdfObject, resolve: Resolve, inflate: Inflate): PdfFunction {
  const r = resolve(obj);
  if (isArray(r)) {
    const fns = r.map((e) => parseFunction(e, resolve, inflate));
    return (input) => fns.flatMap((f) => f(input));
  }
  const dict = isStream(r) ? r.dict : isDict(r) ? r : undefined;
  if (!dict) return () => [0];
  const type = n(dict.get('FunctionType'), resolve, -1);
  const domain = nums(dict.get('Domain'), resolve);
  const clampDomain = (input: number[]) =>
    input.map((v, i) => clamp(v, domain[2 * i] ?? 0, domain[2 * i + 1] ?? 1));

  if (type === 2) {
    const c0 = nums(dict.get('C0'), resolve); const c1 = nums(dict.get('C1'), resolve);
    const exp = n(dict.get('N'), resolve, 1);
    const a = c0.length ? c0 : [0]; const b = c1.length ? c1 : [1];
    return (input) => {
      const x = clampDomain(input)[0] ?? 0;
      const t = Math.pow(x, exp);
      return a.map((v, i) => v + t * ((b[i] ?? 0) - v));
    };
  }

  if (type === 3) {
    const subDicts = resolve(dict.get('Functions'));
    const fns = isArray(subDicts) ? subDicts.map((f) => parseFunction(f, resolve, inflate)) : [];
    const bounds = nums(dict.get('Bounds'), resolve);
    const encode = nums(dict.get('Encode'), resolve);
    const d0 = domain[0] ?? 0; const d1 = domain[1] ?? 1;
    return (input) => {
      const x = clampDomain(input)[0] ?? 0;
      let k = 0;
      while (k < bounds.length && x >= bounds[k]) k++;
      const lo = k === 0 ? d0 : bounds[k - 1];
      const hi = k === bounds.length ? d1 : bounds[k];
      const e0 = encode[2 * k] ?? 0; const e1 = encode[2 * k + 1] ?? 1;
      const xe = interp(x, lo, hi, e0, e1);
      return fns[k] ? fns[k]([xe]) : [0];
    };
  }

  if (type === 0 && isStream(r)) {
    const size = nums(dict.get('Size'), resolve);
    const bps = n(dict.get('BitsPerSample'), resolve, 8);
    const range = nums(dict.get('Range'), resolve);
    const encode = nums(dict.get('Encode'), resolve);
    const decode = nums(dict.get('Decode'), resolve);
    const m = size.length; const nOut = range.length / 2;
    const samples = inflate(r);
    const maxIn = (1 << bps) - 1 || 1;
    // 1-D fast path (the common shading case); higher-D falls back to nearest.
    const read = (flatIndex: number, out: number): number => {
      const bitPos = (flatIndex * nOut + out) * bps;
      let val = 0;
      for (let b = 0; b < bps; b++) {
        const bit = bitPos + b;
        val = (val << 1) | ((samples[bit >> 3] >> (7 - (bit & 7))) & 1);
      }
      return val;
    };
    return (input) => {
      const clamped = clampDomain(input);
      const idx: number[] = [];
      for (let i = 0; i < m; i++) {
        const e0 = encode[2 * i] ?? 0; const e1 = encode[2 * i + 1] ?? (size[i] - 1);
        const enc = interp(clamped[i], domain[2 * i] ?? 0, domain[2 * i + 1] ?? 1, e0, e1);
        idx[i] = Math.round(clamp(enc, 0, size[i] - 1));
      }
      let flat = 0; let mul = 1;
      for (let i = 0; i < m; i++) { flat += idx[i] * mul; mul *= size[i]; }
      const out: number[] = [];
      for (let o = 0; o < nOut; o++) {
        const raw = read(flat, o) / maxIn;
        const dl = decode[2 * o] ?? range[2 * o] ?? 0;
        const dh = decode[2 * o + 1] ?? range[2 * o + 1] ?? 1;
        out.push(dl + raw * (dh - dl));
      }
      return out;
    };
  }

  const range = nums(dict.get('Range'), resolve);
  const outN = range.length / 2 || 1;
  const midpoint: number[] = [];
  for (let o = 0; o < outN; o++) midpoint.push(((range[2 * o] ?? 0) + (range[2 * o + 1] ?? 1)) / 2);

  if (type === 4 && isStream(r) && range.length >= 2) {
    const nOut = range.length / 2;
    // Typed explicitly: a bare `let prog;` is implicitly `any` under `strict`.
    // The try guards `inflate`, which throws on a corrupt stream;
    // parsePostScriptFunction itself reports failure by returning undefined.
    let prog: PsProgram | undefined;
    try { prog = parsePostScriptFunction(inflate(r)); } catch { prog = undefined; }
    if (prog) {
      // A tint transform runs per pixel for an image in a Separation or DeviceN
      // space, so an interpreted program would be re-run millions of times. The
      // function is pure, so memoizing on the input tuple is unobservable; a
      // 1-input Separation over 8-bit samples has only 256 distinct inputs.
      const cache = new Map<string, number[]>();
      const p = prog;
      return (input) => {
        const clamped = clampDomain(input);
        const key = clamped.join(',');
        const hit = cache.get(key);
        if (hit) return hit;
        const raw = evalPostScript(p, clamped, nOut);
        const out = raw
          ? raw.map((v, i) => clamp(v, range[2 * i], range[2 * i + 1]))
          : midpoint;
        if (cache.size >= 4096) cache.clear();
        cache.set(key, out);
        return out;
      };
    }
  }

  // Anything left — an unsupported function type, or a type 4 program we could
  // not read — is a constant midpoint of /Range. This is the only remaining
  // caller of that fallback; before type 4 was implemented it also answered for
  // every PostScript function in every file, which is how a PostScript-driven
  // shading came to paint one flat colour with no error raised anywhere.
  return () => midpoint;
}
