import {
  PdfDict, PdfObject, PdfStream, isArray, isName, isStream, isString, name,
} from './types.js';
import { resolveColorSpace } from './colorspace.js';
import {
  convertComps, targetComponents, targetName, type CmykTransform,
  type GraySpace, type TargetSpace,
} from './colorrule.js';
import { decodeJpeg } from './jpeg.js';
import { encodeJpeg, type JpegKind } from './jpegencode.js';
import { greyJpegFromCoefficients } from './jpegtranscode.js';
import { encodeStream } from './filters.js';
import { colorKeyStencil } from './colorkey.js';

export type Resolve = (o: PdfObject | undefined) => PdfObject;

/**
 * Decoded bytes for a stream.
 *
 * Codec-aware, NOT plain decompression: for a `DCTDecode` image this must hand
 * back the JPEG bytes themselves (unwrapping any preceding filter), because
 * that is what `decodeJpeg` wants -- `ImageInfo.Decode()`'s contract, and the
 * caller is expected to route through it. A plain inflate silently fails on
 * every JPEG in the document while every Flate image still converts, which is
 * exactly the shape of bug a unit test with a hand-built callback cannot see.
 */
export type Inflate = (s: PdfStream) => Uint8Array;

export interface GrayImageOptions {
  /** IJG quality for re-encoded DCT images, 1..100. Default 90. */
  quality?: number;
  /** The caller-supplied RGB->CMYK leg (85l8.3). It must reach IMAGE SAMPLES
   *  and not only content operators, or a colour-managed document still has
   *  naive ink in every picture. */
  toCmyk?: CmykTransform;
}

export type GrayImageOutcome =
  | { kind: 'converted'; stream: PdfStream; from: string;
      route: 'palette' | 'jpeg' | 'jpeg-exact' | 'flate';
      /** The stencil replacing a colour-key /Mask. The caller allocates it and
       *  sets it as /Mask -- this module never touches a `Document`. */
      mask?: PdfStream }
  /** Nothing to convert -- an /ImageMask, an already-grey image. Belongs in
   *  neither report list: a skip list padded with non-gaps is unreadable. */
  | { kind: 'none' }
  | { kind: 'skip'; reason: string };

const nm = (resolve: Resolve, o: PdfObject | undefined): string | undefined => {
  const r = resolve(o);
  return isName(r) ? r.name : undefined;
};

/** The head name of a colour space: 'DeviceRGB', 'Indexed', 'ICCBased', ... */
function csHead(resolve: Resolve, cs: PdfObject | undefined): string {
  const r = resolve(cs);
  if (isName(r)) return r.name;
  if (isArray(r) && r.length > 0) return nm(resolve, r[0]) ?? '';
  return '';
}

/** True when the space already delivers exactly the target's components.
 *  Asked through `kindOf`, the module's one reading of "what device family is
 *  this space" -- an Indexed or otherwise unsupported space yields a reason
 *  object, which is never equal to a target, so it is correctly never
 *  "already there". */
function alreadyTarget(resolve: Resolve, cs: PdfObject | undefined, to: TargetSpace): boolean {
  return kindOf(resolve, cs) === to;
}

/** A reason this image must not be converted, or undefined when it may be. */
function guard(resolve: Resolve, dict: PdfDict): string | undefined {
  const mask = resolve(dict.get('Mask'));
  // A colour-key range is NOT re-derivable in grey -- two colours can share a
  // luma, so any grey range covering one covers the other. It is converted
  // instead, by recording which pixels it actually matched as a stencil; see
  // `colorkey.ts`. What cannot be converted is an image carrying an
  // /SMask as well: 32000-1 makes the two mutually exclusive, so replacing one
  // and leaving the other produces a file no two viewers agree about.
  if (isArray(mask) && dict.get('SMask') !== undefined) {
    return 'has both a colour-key /Mask and an /SMask, which 32000-1 makes '
      + 'mutually exclusive';
  }
  if (dict.has('Decode')) {
    return 'has /Decode (sample inversion the conversion would not reproduce)';
  }
  return undefined;
}

/** The stencil as an image XObject, ready for the caller to allocate. */
function stencilStream(packed: Uint8Array, width: number, height: number): PdfStream {
  const flate = encodeStream(packed, 'FlateDecode');
  const dict: PdfDict = new Map<string, PdfObject>([
    ['Type', name('XObject')], ['Subtype', name('Image')],
    ['Width', width], ['Height', height],
    ['ImageMask', true], ['BitsPerComponent', 1], ['Decode', [0, 1]],
    ['Filter', name('FlateDecode')], ['Length', flate.raw.length],
  ]);
  return { kind: 'stream', dict, raw: flate.raw };
}

/** A palette stream's dict with its filter dropped (we write raw bytes). */
function stripFilter(src: PdfDict, length: number): PdfDict {
  const d: PdfDict = new Map(src);
  d.delete('Filter');
  d.delete('DecodeParms');
  d.delete('DP');
  d.set('Length', length);
  return d;
}

/**
 * The Indexed route: rewrite the lookup table, leave the samples alone.
 *
 * The best route available and the only one that works below 8 bits per
 * component -- a decode hands sub-8-bpc samples back still packed, so the
 * sample routes cannot touch them, while an index is an index whatever its
 * width. It is also lossless and shrinks the palette.
 */
function convertIndexed(
  stream: PdfStream, resolve: Resolve, inflate: Inflate, to: TargetSpace,
  toCmyk?: CmykTransform,
): GrayImageOutcome {
  const cs = resolve(stream.dict.get('ColorSpace'));
  if (!isArray(cs) || cs.length < 4) {
    return { kind: 'skip', reason: 'malformed Indexed colourspace' };
  }

  const base = resolve(cs[1]);
  if (alreadyTarget(resolve, base, to)) return { kind: 'none' };

  const converter = resolveColorSpace(base, resolve, (s) => inflate(s as PdfStream));
  const nc = converter.components;

  const lookupObj = resolve(cs[3]);
  let table: Uint8Array;
  if (isString(lookupObj)) table = lookupObj.bytes;
  else if (isStream(lookupObj)) table = inflate(lookupObj);
  else return { kind: 'skip', reason: 'Indexed /Lookup is neither a string nor a stream' };

  // Route each entry through the BASE converter, so a CMYK, Lab or ICCBased
  // palette converts by the same rule as everything else rather than by a
  // second reading of the same bytes.
  const space: GraySpace = { kind: 'other', converter };
  const outNc = targetComponents(to);
  const count = Math.floor(table.length / nc);
  const out = new Uint8Array(count * outNc);
  const comps = new Array<number>(nc);
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < nc; k++) comps[k] = (table[i * nc + k] ?? 0) / 255;
    const conv = convertComps(comps, space, to, toCmyk);
    for (let k = 0; k < outNc; k++) out[i * outNc + k] = Math.round((conv[k] ?? 0) * 255);
  }

  const lookup: PdfObject = isStream(lookupObj)
    ? { kind: 'stream', dict: stripFilter(lookupObj.dict, out.length), raw: out }
    : { kind: 'string', bytes: out };

  const dict: PdfDict = new Map(stream.dict);
  dict.set('ColorSpace', [cs[0], name(targetName(to)), cs[2], lookup]);
  return { kind: 'converted', stream: { ...stream, dict }, from: 'Indexed', route: 'palette' };
}

const CHANNELS: Record<JpegKind, number> = { gray: 1, rgb: 3, cmyk: 4 };

const DCT_FILTERS: ReadonlySet<string> = new Set(['DCTDecode', 'DCT']);
const SAMPLE_FILTERS: ReadonlySet<string> = new Set([
  'FlateDecode', 'Fl', 'LZWDecode', 'LZW', 'RunLengthDecode', 'RL', 'JPXDecode',
]);

/** Terminal (codec) filter of a chain: the last entry, or the single name. */
function terminalFilter(resolve: Resolve, dict: PdfDict): string | undefined {
  const f = resolve(dict.get('Filter'));
  if (isName(f)) return f.name;
  if (isArray(f) && f.length > 0) return nm(resolve, f[f.length - 1]);
  return undefined;
}

/** The JpegKind a colour space implies, or a reason it has none. */
function kindOf(resolve: Resolve, cs: PdfObject | undefined): JpegKind | { reason: string } {
  const head = csHead(resolve, cs);
  switch (head) {
    case 'DeviceGray': case 'CalGray': case 'G': return 'gray';
    case 'DeviceRGB': case 'CalRGB': case 'RGB': return 'rgb';
    case 'DeviceCMYK': case 'CMYK': return 'cmyk';
    case 'ICCBased': {
      const arr = resolve(cs);
      const s = isArray(arr) ? resolve(arr[1]) : undefined;
      const n = isStream(s) ? resolve(s.dict.get('N')) : undefined;
      if (n === 1) return 'gray';
      if (n === 3) return 'rgb';
      if (n === 4) return 'cmyk';
      return { reason: `ICCBased with unsupported /N ${String(n)}` };
    }
    default: return { reason: `unsupported colourspace: ${head || '(absent)'}` };
  }
}

/**
 * Interleaved samples retargeted, through the one rule.
 *
 * `convertComps` rather than the formula inlined per source family: nine
 * source/target pairs written out by hand is nine chances to disagree with the
 * operator rewriter about one colour. The scratch input array is reused across
 * pixels so the per-pixel cost is one small output allocation, not two.
 */
function convertSamples(
  src: Uint8Array, pixels: number, from: JpegKind, to: TargetSpace,
  toCmyk?: CmykTransform,
): Uint8Array {
  const nc = CHANNELS[from];
  const outNc = targetComponents(to);
  const space: GraySpace = { kind: from };
  const out = new Uint8Array(pixels * outNc);
  const comps = new Array<number>(nc);
  for (let i = 0; i < pixels; i++) {
    const o = i * nc;
    for (let k = 0; k < nc; k++) comps[k] = (src[o + k] ?? 0) / 255;
    const conv = convertComps(comps, space, to, toCmyk);
    for (let k = 0; k < outNc; k++) out[i * outNc + k] = Math.round((conv[k] ?? 0) * 255);
  }
  return out;
}

/**
 * The replacement dict: copy the original, then override only what changed.
 *
 * A denylist, not an allowlist -- `imageopt.ts`'s rule, for its reason.
 * Synthesizing a fresh dict from what this converter knows would silently drop
 * /SMask, /OC, /Intent and /Metadata, and an image that loses its /SMask
 * renders its transparent background black with no error raised anywhere.
 */
function rebuild(
  original: PdfStream, raw: Uint8Array, filter: 'DCTDecode' | 'FlateDecode',
  to: TargetSpace,
): PdfStream {
  const dict: PdfDict = new Map(original.dict);
  dict.delete('DecodeParms');
  dict.delete('DP');
  dict.delete('Decode');                       // the guard means there was none
  // A colour-key array states ranges per component of the space this image is
  // leaving, so it cannot survive: this is a denylist, and without the delete
  // the stale array rides through and masks by the old space's component count.
  //
  // Measured, and recorded rather than overclaimed: in the CURRENT flow every
  // route that reaches `rebuild` with an array also produces a stencil, and
  // `colorconvert.ts` overwrites the entry with it -- so the delete is
  // belt-and-braces and its only fence is the unit assertion on the outcome
  // itself, not the end-to-end test. It stays because the outcome must be
  // self-consistent whatever the caller does with it.
  dict.delete('Mask');
  dict.set('ColorSpace', name(targetName(to)));
  dict.set('BitsPerComponent', 8);
  dict.set('Filter', name(filter));
  dict.set('Length', raw.length);
  return { kind: 'stream', dict, raw };
}

/**
 * Convert one image XObject to `to`.
 *
 * Pure: `resolve` and `inflate` arrive as arguments so every rule is testable
 * from a hand-built dict without building a file -- `glyphprogram.ts`'s
 * pattern.
 */
export function convertImageSpace(
  stream: PdfStream, resolve: Resolve, inflate: Inflate, to: TargetSpace,
  opts: GrayImageOptions = {},
): GrayImageOutcome {
  const dict = stream.dict;
  if (resolve(dict.get('ImageMask')) === true) return { kind: 'none' };

  const cs = dict.get('ColorSpace');
  if (cs === undefined) return { kind: 'skip', reason: 'missing /ColorSpace' };
  if (alreadyTarget(resolve, cs, to)) return { kind: 'none' };

  const g = guard(resolve, dict);
  if (g) return { kind: 'skip', reason: g };

  const head = csHead(resolve, cs);
  if (head === 'Indexed' || head === 'I') return convertIndexed(stream, resolve, inflate, to, opts.toCmyk);

  const bpc = resolve(dict.get('BitsPerComponent'));
  if (bpc !== 8) {
    return { kind: 'skip',
      reason: `BitsPerComponent ${String(bpc ?? '(absent)')} is not 8 and the `
        + 'space is not Indexed, so the samples arrive still packed' };
  }

  const kind = kindOf(resolve, cs);
  if (typeof kind !== 'string') return { kind: 'skip', reason: kind.reason };

  const w = resolve(dict.get('Width'));
  const h = resolve(dict.get('Height'));
  if (typeof w !== 'number' || typeof h !== 'number' || w < 1 || h < 1) {
    return { kind: 'skip', reason: 'missing or invalid /Width or /Height' };
  }

  const filter = terminalFilter(resolve, dict);
  const isDct = filter !== undefined && DCT_FILTERS.has(filter);
  if (!isDct && (filter === undefined || !SAMPLE_FILTERS.has(filter))) {
    return { kind: 'skip', reason: `unsupported filter ${filter ?? '(none)'}` };
  }

  // A colour-key /Mask converts by recording WHICH PIXELS it matched, which
  // needs the samples -- so the ranges are read here and the stencil is built
  // by whichever route decodes them. Note an Indexed image never reaches this
  // point: its array keys index values, which the palette route leaves
  // untouched, so the array stays correct and needs no conversion at all.
  const maskArr = resolve(dict.get('Mask'));
  let keyRanges: number[] | undefined;
  if (isArray(maskArr)) {
    const nums = maskArr.filter((v): v is number => typeof v === 'number');
    if (nums.length < CHANNELS[kind] * 2) {
      return { kind: 'skip',
        reason: `colour-key /Mask states ${nums.length} bounds, `
          + `${CHANNELS[kind]} components need ${CHANNELS[kind] * 2}` };
    }
    keyRanges = nums;
  }
  const stencilFor = (samples: Uint8Array): PdfStream | undefined =>
    keyRanges === undefined ? undefined
      : stencilStream(colorKeyStencil(samples, w, h, CHANNELS[kind], keyRanges), w, h);

  // The exact route, tried first. A YCbCr JPEG's Y channel IS Rec. 601 luma,
  // so keeping its quantized coefficients greys it with no decode, no
  // requantization and no generation loss -- and `opts.quality` has nothing to
  // govern. Anything it will not take (CMYK, 12-bit, lossless, an 'R','G','B'
  // -id file whose component 0 is red) declines and falls through to the
  // sample route below, which is a route CHOICE and not a failure: it is
  // deliberately NOT reported in `skipped`.
  //
  // A decline costs a second parse of these bytes. Sharing the frame would mean
  // moving JPEG internals into this module; one extra entropy decode on the
  // uncommon path is the cheaper price.
  // GRAY ONLY, and that is structural rather than a policy: the route works
  // because a YCbCr JPEG's Y channel IS Rec. 601 luma. No such identity exists
  // for rgb or cmyk, so for any other target it must not run at all.
  if (to === 'gray' && isDct && CHANNELS[kind] === 3) {
    try {
      const t = greyJpegFromCoefficients(inflate(stream));
      // A geometry disagreement falls through on purpose, so the code below
      // produces its own `JPEG geometry ... disagrees with the dict ...` skip
      // rather than a second message saying the same thing.
      if (t.kind === 'ok' && t.width === w && t.height === h) {
        // A colour-key mask needs the SAMPLES to record which pixels it
        // matched, so a masked JPEG pays one extra decode here -- and still
        // keeps the exact route for the image itself, which is independent of
        // it. Forcing such an image down the sample route would be simpler and
        // strictly worse.
        const mask = keyRanges && stencilFor(decodeJpeg(inflate(stream)).data);
        return { kind: 'converted', stream: rebuild(stream, t.data, 'DCTDecode', to),
          from: head, route: 'jpeg-exact', mask };
      }
    } catch { /* fall through; the sample route reports the failure properly */ }
  }

  let src: Uint8Array;
  try {
    if (isDct) {
      const j = decodeJpeg(inflate(stream));
      if (j.width !== w || j.height !== h) {
        return { kind: 'skip',
          reason: `JPEG geometry ${j.width}x${j.height} disagrees with the dict ${w}x${h}` };
      }
      if (j.comps !== CHANNELS[kind]) {
        return { kind: 'skip',
          reason: `JPEG has ${j.comps} components, colourspace implies ${CHANNELS[kind]}` };
      }
      src = j.data;
    } else {
      src = inflate(stream);
      const want = w * h * CHANNELS[kind];
      if (src.length !== want) {
        return { kind: 'skip', reason: `decoded ${src.length} bytes, expected ${want}` };
      }
    }
  } catch (e) {
    return { kind: 'skip', reason: `decode failed: ${(e as Error).message}` };
  }

  const out = convertSamples(src, w * h, kind, to, opts.toCmyk);
  const from = head;
  const mask = stencilFor(src);
  try {
    if (isDct) {
      const jpeg = encodeJpeg(w, h, out, to, { quality: opts.quality ?? 90 });
      return { kind: 'converted', stream: rebuild(stream, jpeg, 'DCTDecode', to), from, route: 'jpeg', mask };
    }
    const flate = encodeStream(out, 'FlateDecode');
    return { kind: 'converted', stream: rebuild(stream, flate.raw, 'FlateDecode', to), from, route: 'flate', mask };
  } catch (e) {
    return { kind: 'skip', reason: `re-encode failed: ${(e as Error).message}` };
  }
}

/** The DeviceGray specialization of `convertImageSpace`, and the name every
 *  existing caller uses. */
export function grayscaleImage(
  stream: PdfStream, resolve: Resolve, inflate: Inflate,
  opts: GrayImageOptions = {},
): GrayImageOutcome {
  return convertImageSpace(stream, resolve, inflate, 'gray', opts);
}
