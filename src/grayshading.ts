import {
  PdfDict, PdfObject, PdfStream, isArray, isDict, isName, isStream, name,
} from './types.js';
import { parseFunction } from './pdffunction.js';
import { encodeStream } from './filters.js';
import { respliceMesh, type MeshLayout } from './graymesh.js';
import { resolveColorSpace, type ColorConverter } from './colorspace.js';
import { grayNum, luma } from './grayscale.js';
import type { Resolve, Inflate } from './grayimage.js';

export type ShadingOutcome =
  /** `raw` is present only for a mesh, whose per-vertex colour lives in the
   *  stream data rather than in a `/Function`: the caller must write it back
   *  instead of carrying the original bytes over. */
  | { kind: 'converted'; dict: PdfDict; raw?: Uint8Array }
  | { kind: 'none' }
  | { kind: 'skip'; reason: string };

/** Samples per axis. One input is a gradient ramp; two is a function-based
 *  shading's Domain rectangle, where 256x256 would be 64KB for no visible gain. */
const SAMPLES_1D = 256;
const SAMPLES_2D = 64;

const numbers = (o: PdfObject | undefined): number[] =>
  isArray(o) ? o.filter((v): v is number => typeof v === 'number') : [];

/**
 * The converter for a shading's colour space.
 *
 * When no space is available -- `grayscaleFunction` called on a bare function,
 * which is how the unit tests drive it -- the component COUNT is authoritative
 * instead: a function that emits four values is CMYK, not "RGB with a stray
 * operand". Defaulting to DeviceGray there would silently keep only the first
 * component and produce a plausible, entirely wrong ramp.
 */
function converterFor(
  space: PdfObject | undefined, n: number, resolve: Resolve, inflate: Inflate,
): ColorConverter {
  const cs = space !== undefined ? resolve(space) : undefined;
  if (cs === undefined || cs === null) {
    return resolveColorSpace(
      name(n === 1 ? 'DeviceGray' : n === 4 ? 'DeviceCMYK' : 'DeviceRGB'),
      resolve, (s) => inflate(s as PdfStream));
  }
  return resolveColorSpace(cs, resolve, (s) => inflate(s as PdfStream));
}

/** The luma of one colour stated in `space`, via the one owner of that rule. */
function greyComponent(
  comps: number[], space: PdfObject | undefined, resolve: Resolve, inflate: Inflate,
): number {
  const [r, g, b] = converterFor(space, comps.length, resolve, inflate).toRgb(comps);
  return grayNum(luma(r / 255, g / 255, b / 255));
}

/**
 * Convert a function's colour output to a single grey component.
 *
 * Exact where exactness is free -- type 2 through /C0 and /C1, type 3 by
 * recursion -- and resampled otherwise. `inputs` is the function's input arity:
 * 1 for shading types 2-7, 2 for a type 1 (function-based) shading. Assuming 1
 * for a 2-in function emits a flat grey wash, which renders as a plausible
 * design choice rather than as a fault.
 */
export function grayscaleFunction(
  fn: PdfObject, resolve: Resolve, inflate: Inflate, inputs: number,
  space?: PdfObject,
): PdfObject {
  // An ARRAY of n one-output functions is not a recursion case but a joining
  // case: the whole array describes one colour, so it collapses to one function.
  if (isArray(fn)) return resample(fn, resolve, inflate, inputs, space);

  const r = resolve(fn);
  const dict = isStream(r) ? r.dict : isDict(r) ? r : undefined;
  if (!dict) return fn;
  const type = resolve(dict.get('FunctionType'));

  if (type === 2) {
    const out: PdfDict = new Map(dict);
    for (const key of ['C0', 'C1'] as const) {
      const c = numbers(resolve(dict.get(key)));
      const comps = c.length > 0 ? c : (key === 'C0' ? [0] : [1]);
      out.set(key, [greyComponent(comps, space, resolve, inflate)]);
    }
    return out;
  }

  if (type === 3) {
    const subs = resolve(dict.get('Functions'));
    if (!isArray(subs)) return resample(fn, resolve, inflate, inputs, space);
    const out: PdfDict = new Map(dict);
    out.set('Functions',
      subs.map((s) => grayscaleFunction(s, resolve, inflate, inputs, space)));
    return out;
  }

  return resample(fn, resolve, inflate, inputs, space);
}

/** Evaluate any function (or array of them) and emit a 1-output type 0. */
function resample(
  fn: PdfObject, resolve: Resolve, inflate: Inflate, inputs: number,
  space: PdfObject | undefined,
): PdfObject {
  const inflateFn = (s: { dict: PdfDict; raw: Uint8Array }): Uint8Array =>
    inflate(s as PdfStream);

  // An array of n one-output functions evaluates as one n-output function.
  const evalAt: (x: number[]) => number[] = isArray(fn)
    ? (() => {
        const parts = fn.map((f) => parseFunction(f, resolve, inflateFn));
        return (x: number[]) => parts.map((p) => p(x)[0] ?? 0);
      })()
    : parseFunction(fn, resolve, inflateFn);

  const src = resolve(fn);
  const srcDict = isStream(src) ? src.dict : isDict(src) ? src : undefined;
  const domain = numbers(srcDict ? resolve(srcDict.get('Domain')) : undefined);
  const dom = domain.length >= inputs * 2 ? domain.slice(0, inputs * 2)
    : Array.from({ length: inputs * 2 }, (_, i) => (i % 2 === 0 ? 0 : 1));

  const size = inputs === 1 ? [SAMPLES_1D] : new Array(inputs).fill(SAMPLES_2D) as number[];
  const total = size.reduce((a, b) => a * b, 1);
  const raw = new Uint8Array(total);

  const converter = converterFor(space, evalAt(
    Array.from({ length: inputs }, (_, k) => dom[k * 2] ?? 0)).length,
    resolve, inflate);

  // Sample index -> input coordinates. The FIRST input varies fastest, which is
  // 32000-1 7.10.2's ordering for a type 0 sample table.
  for (let i = 0; i < total; i++) {
    const x: number[] = [];
    let rest = i;
    for (let k = 0; k < inputs; k++) {
      const n = size[k];
      const j = rest % n;
      rest = Math.floor(rest / n);
      const lo = dom[k * 2] ?? 0, hi = dom[k * 2 + 1] ?? 1;
      x.push(lo + (hi - lo) * (n === 1 ? 0 : j / (n - 1)));
    }
    const [r, g, b] = converter.toRgb(evalAt(x));
    raw[i] = Math.round(luma(r / 255, g / 255, b / 255) * 255);
  }

  const dict: PdfDict = new Map<string, PdfObject>([
    ['FunctionType', 0],
    ['Domain', dom],
    ['Range', [0, 1]],
    ['Size', size],
    ['BitsPerSample', 8],
    ['Length', raw.length],
  ]);
  return { kind: 'stream', dict, raw };
}

/** True when the space already delivers a single grey component. */
function alreadyGray(resolve: Resolve, cs: PdfObject | undefined): boolean {
  const r = resolve(cs);
  if (isName(r)) return r.name === 'DeviceGray' || r.name === 'CalGray' || r.name === 'G';
  if (isArray(r) && r.length > 0) {
    const head = resolve(r[0]);
    if (isName(head) && head.name === 'CalGray') return true;
    if (isName(head) && head.name === 'ICCBased') {
      const s = resolve(r[1]);
      return isStream(s) && resolve(s.dict.get('N')) === 1;
    }
  }
  return false;
}

/**
 * Rewrite a function-less mesh's bit-packed per-vertex colour.
 *
 * A mesh states its colour in the stream data, not in a `/Function`, so this is
 * the one shading route that has to write bytes back. The splice itself is
 * `graymesh.ts`'s; everything decided here is what a colour space and a `/Decode`
 * mean, which that module deliberately does not know.
 */
function grayscaleMesh(
  target: PdfDict | PdfStream, out: PdfDict, type: number,
  cs: PdfObject, resolve: Resolve, inflate: Inflate,
): ShadingOutcome {
  const why = (reason: string): ShadingOutcome =>
    ({ kind: 'skip', reason: `mesh shading type ${type}: ${reason}` });

  // Types 4-7 are defined as streams; a dict carrying one of those types has no
  // vertex data at all, so there is nothing to rewrite.
  if (!isStream(target)) return why('a function-less mesh must be a stream');

  const dict = target.dict;
  const bits = (key: string): number => {
    const v = resolve(dict.get(key));
    return typeof v === 'number' && v > 0 ? v : 0;
  };
  const bitsPerCoordinate = bits('BitsPerCoordinate');
  const bitsPerComponent = bits('BitsPerComponent');
  const bitsPerFlag = bits('BitsPerFlag');
  if (bitsPerCoordinate === 0 || bitsPerComponent === 0) {
    return why('missing /BitsPerCoordinate or /BitsPerComponent');
  }
  // Type 5 is the lattice form and states its row width instead; every other
  // mesh type prefixes each record with a flag we must copy through.
  if (bitsPerFlag === 0 && type !== 5) return why('missing /BitsPerFlag');

  // The converter is built ONCE and the luma taken inline: `greyComponent`
  // resolves the colour space on every call, which a mesh would pay per vertex.
  const conv = converterFor(cs, 3, resolve, inflate);
  const components = conv.components;

  // A mesh's /Decode is the coordinate ranges followed by one range per COLOUR
  // component -- it is where a Lab a* or an Indexed index learns its scale, so
  // without it the raw integers are not interpretable as colour at all.
  const decode = numbers(resolve(dict.get('Decode')));
  if (decode.length < 4 + components * 2) {
    return why('/Decode does not state a range for every colour component');
  }

  const layout: MeshLayout = {
    type, bitsPerCoordinate, bitsPerComponent, bitsPerFlag, components,
    colorDecode: decode.slice(4, 4 + components * 2),
  };
  const spliced = respliceMesh(inflate(target), layout, (comps) => {
    const [r, g, b] = conv.toRgb(comps);
    return luma(r / 255, g / 255, b / 255);
  });
  if (spliced.kind === 'error') return why(spliced.reason);

  // The coordinate half survives untouched -- the geometry did not move -- and
  // the colour half collapses to the one grey range the samples now carry.
  out.set('Decode', [...decode.slice(0, 4), 0, 1]);
  const raw = encodeStream(spliced.data, 'FlateDecode').raw;
  out.set('Filter', name('FlateDecode'));
  out.delete('DecodeParms');
  out.delete('DP');
  out.set('Length', raw.length);
  return { kind: 'converted', dict: out, raw };
}

/**
 * Convert one shading to DeviceGray.
 *
 * Takes the whole object rather than its dict because a mesh's colour lives in
 * the stream data: a dict alone cannot express the types this function must
 * handle.
 */
export function grayscaleShading(
  target: PdfDict | PdfStream, resolve: Resolve, inflate: Inflate,
): ShadingOutcome {
  const dict = isStream(target) ? target.dict : target;
  const cs = dict.get('ColorSpace');
  if (cs === undefined) return { kind: 'skip', reason: 'shading has no /ColorSpace' };
  if (alreadyGray(resolve, cs)) return { kind: 'none' };

  const type = resolve(dict.get('ShadingType'));
  const fn = dict.get('Function');

  const out: PdfDict = new Map(dict);
  out.set('ColorSpace', name('DeviceGray'));

  const bg = numbers(resolve(dict.get('Background')));
  if (bg.length > 0) out.set('Background', [greyComponent(bg, cs, resolve, inflate)]);

  if (typeof type === 'number' && type >= 4 && fn === undefined) {
    return grayscaleMesh(target, out, type, cs, resolve, inflate);
  }

  if (fn !== undefined) {
    // A type 1 (function-based) shading's function takes TWO inputs, over its
    // /Domain rectangle. Every other shading type's takes one.
    const inputs = type === 1 ? 2 : 1;
    out.set('Function', grayscaleFunction(fn, resolve, inflate, inputs, cs));
  }
  return { kind: 'converted', dict: out };
}
