import type { Document } from './document.js';
import {
  PdfDict, PdfObject, PdfStream, isArray, isDict, isName, isRef, isStream, isString, name,
} from './types.js';
import { UnsupportedFeatureError } from './errors.js';
import { hasSignatureField } from './signature.js';
import { parseContentStream, serializeContentStream } from './content.js';
import { inflateStream } from './flate.js';
import { resolveColorSpace } from './colorspace.js';
import { colorOps, type SpaceLookup } from './colorops.js';
import {
  convertComps, grayNum, targetComponents, targetName,
  type CmykTransform, type GraySpace, type TargetSpace,
} from './colorrule.js';
import { convertImageSpace } from './colorimage.js';
import { repointSpotSpace, spotSpaceArray } from './colorsep.js';
import { convertShadingSpace } from './colorshading.js';
import { ImageInfo } from './image.js';

/**
 * Document-wide colour conversion.
 *
 * The approach is operator-level *neutralization*, not colour-space
 * retargeting: every colour-setting operator becomes the target's operator
 * carrying the converted colour, and named `/ColorSpace` resources are left
 * unreferenced rather than rewritten. That is what makes the two passes below
 * order-independent -- the content pass READS colour-space resources that no
 * pass WRITES. Retargeting would have had the content pass resolving spaces the
 * object pass had already moved out from under it.
 *
 * The one exception is `retargetPatternSpaces`, and it is safe precisely
 * because a `[/Pattern base]` array is referenced by nothing but `cs` + `scn`.
 */

export interface ColorConvertOptions {
  /** IJG quality for re-encoded DCT images, 1..100. Default 90. */
  quality?: number;
}

export interface ConvertColorsOptions extends ColorConvertOptions {
  /** The device space to convert to. Required: an implicit default would make
   *  `ConvertColors()` a second spelling of `ConvertToGrayscale`. */
  to: TargetSpace;
  /**
   * The RGB->CMYK leg, for a caller who is colour managed (85l8.3).
   *
   * The bundled default is naive maximum-black removal with NO destination
   * profile, so its numbers are structurally CMYK and not colorimetrically
   * correct. This does not make the library colour managed — it lets a caller
   * who has the profile and a CMS hand the right numbers in. It reaches image
   * samples, shading functions and mesh vertices as well as content
   * operators, so a converted document has no naive ink left anywhere.
   *
   * Only meaningful with `to: 'cmyk'`; passing it with another target throws
   * rather than being ignored. Declaring which output condition the numbers
   * are FOR is a different job, and `ConvertToPdfX` already owns it — an
   * `/OutputIntent` is a standards claim this call is in no position to make.
   */
  transform?: CmykTransform;
  /**
   * Keep a Separation or DeviceN as a spot colour instead of flattening it
   * (`ixxw.4`). Default false, which is what every caller got before it
   * existed.
   *
   * Off, `/Sep cs 1 scn` becomes `1 0 0 rg`: the page looks the same and the
   * NAMED COLORANT is gone, so a print workflow that would have separated it
   * onto its own plate no longer can. On, the SPACE is rebuilt instead — its
   * kind, colorant names and component count all survive and only the
   * alternate and tint transform move, so every content stream selecting it is
   * untouched (see `colorsep.ts`).
   *
   * Off by default because `ConvertToGrayscale` means it: a document asked to
   * be grey should not still carry a spot colorant a RIP would ink. PDF/A
   * conversion sets it, where the point is conformance rather than colour
   * reduction.
   */
  preserveSpotColors?: boolean;
}

/**
 * Validate a caller's transform ONCE, before anything is converted, so a
 * rejected call leaves the document byte-identical — `checkTarget`'s rule.
 *
 * The probe cannot prove a transform well behaved for every input, so the
 * returned wrapper also clamps: a component outside 0..1 is clipped and a
 * non-finite one becomes 0. That is not belt-and-braces — a `NaN` reaching a
 * content stream is a CORRUPT FILE rather than a wrong colour, and
 * `clamp01(NaN)` is `NaN`, so the range test alone would let it through.
 */
function checkTransform(transform: CmykTransform, to: TargetSpace): CmykTransform {
  if (typeof transform !== 'function') {
    throw new TypeError('ConvertColors: transform must be a function');
  }
  if (to !== 'cmyk') {
    throw new RangeError(
      `ConvertColors: transform is the RGB->CMYK leg and has no meaning for `
      + `target '${to}'; omit it or pass to: 'cmyk'`);
  }
  // Three corners plus a midpoint: enough to catch a transform that returns
  // the wrong shape at all, which is what this can honestly check.
  for (const probe of [[0, 0, 0], [1, 1, 1], [1, 0, 0], [0.5, 0.5, 0.5]]) {
    const out = transform(probe[0] as number, probe[1] as number, probe[2] as number);
    if (!Array.isArray(out) || out.length !== 4 || !out.every(Number.isFinite)) {
      throw new TypeError(
        'ConvertColors: transform must return four finite numbers; '
        + `it returned ${JSON.stringify(out)} for [${probe.join(', ')}]`);
    }
  }
  return (r, g, b) => {
    const out = transform(r, g, b);
    const at = (i: number): number => {
      const v = out[i] as number;
      return Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0;
    };
    return [at(0), at(1), at(2), at(3)];
  };
}

const TARGETS: readonly TargetSpace[] = ['gray', 'rgb', 'cmyk'];

/**
 * Reject an unknown target BEFORE anything is converted.
 *
 * A typo'd `'CMYK'` that quietly converted nothing while reporting
 * `skipped: []` is the failure worth preventing -- the caller reads a clean
 * report and believes the document converted. `RangeError` rather than
 * `TypeError` because the value is outside an allowed set rather than the
 * wrong kind of thing, which is `formcreate.ts`'s split.
 */
function checkTarget(to: TargetSpace): void {
  if (!TARGETS.includes(to)) {
    throw new RangeError(
      `ConvertColors: unknown target ${JSON.stringify(to)}; `
      + `expected one of ${TARGETS.map((t) => `'${t}'`).join(', ')}`);
  }
}

export interface ColorImageResult {
  objNum: number;
  /** The colour space it came from, e.g. 'DeviceRGB', 'Indexed'. */
  from: string;
  route: 'palette' | 'jpeg' | 'jpeg-exact' | 'flate';
  /** Negative when the converted image is smaller. */
  bytesDelta: number;
}

export interface ColorSkipped {
  /** The object that could not be converted -- or, for `inline-image`, the
   *  content stream that DREW it, an inline image having no object of its own. */
  objNum?: number;
  what: 'image' | 'shading' | 'content' | 'inline-image' | 'annotation';
  /**
   * Which operator, for an `inline-image` — the index of its `BI` within the
   * stream `objNum` names (85l8.6). Absent for every other kind, which
   * addresses an object rather than an op inside one.
   *
   * Together with `objNum` this is exact: a stream may draw several inline
   * images, and the stream alone cannot say which one was left in colour.
   * Resolve it with `parseContentStream(inflateStream(obj))[opIndex]`.
   */
  opIndex?: number;
  reason: string;
}

export interface ColorConvertReport {
  /** Content streams rewritten. */
  streams: number;
  /** Colour operators changed across all of them. */
  operators: number;
  images: ColorImageResult[];
  shadings: number;
  annotations: number;
  /** What could not be converted, and why. The first place to look when a
   *  converted document still shows colour. */
  skipped: ColorSkipped[];
  /** True when any image was re-encoded through JPEG: the output is no longer
   *  a lossless greying of the original. */
  lossy: boolean;
  bytesDelta: number;
  /** Which RGB->CMYK leg ran (85l8.3). Absent for a target that has none —
   *  naming one would state something about work that never happened. */
  cmykTransform?: 'naive' | 'supplied';
  /**
   * Spot colour spaces rebuilt over the target (`ixxw.4`), empty unless
   * `preserveSpotColors` was asked for.
   *
   * `grid` is the resampled function's samples per axis. It is reported rather
   * than assumed exact on purpose: a LINEAR tint lands on the sample points
   * and round-trips exactly, while a curved one is right to within a step or
   * two per channel, and a caller comparing renders deserves to know which.
   */
  spotSpaces: SpotSpaceResult[];
}

/** One Separation or DeviceN rebuilt over the target. */
export interface SpotSpaceResult {
  /** The `/Resources /ColorSpace` key it was found under. */
  colorant: string;
  family: 'Separation' | 'DeviceN';
  /** Samples per axis of the resampled tint transform. */
  grid: number[];
}

const MAX_DEPTH = 32;

/** The object number an indirect entry points at, or undefined for a direct one. */
const refNum = (o: PdfObject | undefined): number | undefined =>
  (o !== undefined && isRef(o) ? o.num : undefined);

const dictOf = (doc: Document, o: PdfObject | undefined): PdfDict | undefined => {
  const r = doc.resolve(o);
  return isDict(r) ? r : undefined;
};

const nameOf = (doc: Document, o: PdfObject | undefined): string | undefined => {
  const r = doc.resolve(o);
  return isName(r) ? r.name : undefined;
};

function baseSpace(doc: Document, cs: PdfObject | undefined): GraySpace {
  const r = doc.resolve(cs);
  if (isName(r)) {
    if (r.name === 'DeviceGray' || r.name === 'G' || r.name === 'CalGray') return { kind: 'gray' };
    if (r.name === 'DeviceRGB' || r.name === 'RGB') return { kind: 'rgb' };
    if (r.name === 'DeviceCMYK' || r.name === 'CMYK') return { kind: 'cmyk' };
  }
  return {
    kind: 'other',
    converter: resolveColorSpace(
      r, (o) => doc.resolve(o), (s) => inflateStream(s as PdfStream)),
  };
}

/**
 * Build the `/Resources /ColorSpace` lookup for one content scope.
 *
 * Everything non-device funnels through `resolveColorSpace`, which is what
 * keeps ICCBased, Indexed, Separation, DeviceN and Lab from needing cases of
 * their own -- and holds this feature to the repo's rule that "what colour is
 * this operand" has exactly one owner.
 */
function spaceLookup(doc: Document, resources: PdfDict | undefined): SpaceLookup {
  const csDict = dictOf(doc, resources?.get('ColorSpace'));
  const cache = new Map<string, GraySpace | undefined>();
  return (key: string): GraySpace | undefined => {
    if (cache.has(key)) return cache.get(key);
    let out: GraySpace | undefined;
    const entry = csDict?.get(key);
    if (entry !== undefined) {
      const cs = doc.resolve(entry);
      if (isArray(cs) && cs.length > 0 && nameOf(doc, cs[0]) === 'Pattern') {
        out = cs.length > 1
          ? { kind: 'pattern', base: baseSpace(doc, cs[1]), resourceName: key }
          : { kind: 'pattern' };
      } else {
        out = baseSpace(doc, entry);
      }
    }
    cache.set(key, out);
    return out;
  };
}

/** One content stream and the resources in force for it. */
interface Scope { objNum: number; stream: PdfStream; resources: PdfDict | undefined }

/**
 * Every content stream in the document, with its effective resources.
 *
 * Six sources: page /Contents, Form XObjects, tiling patterns, Type 3
 * /CharProcs, annotation /AP streams (/N /R /D, including the per-state dict
 * form) and ExtGState /SMask /G groups. Deduped by object number -- a
 * correctness rule, not an optimization: a form reached through two pages
 * would otherwise be rewritten twice, the second time from the first write's
 * output.
 */
function collectScopes(doc: Document): Scope[] {
  const out: Scope[] = [];
  const seen = new Set<number>();

  const addStream = (o: PdfObject | undefined, resources: PdfDict | undefined,
                     depth: number): void => {
    const num = refNum(o);
    const s = doc.resolve(o);
    if (!isStream(s) || num === undefined || seen.has(num) || depth > MAX_DEPTH) return;
    seen.add(num);
    const own = dictOf(doc, s.dict.get('Resources')) ?? resources;
    out.push({ objNum: num, stream: s, resources: own });
    walkResources(own, depth + 1);
  };

  const walkResources = (resources: PdfDict | undefined, depth: number): void => {
    if (!resources || depth > MAX_DEPTH) return;

    const xo = dictOf(doc, resources.get('XObject'));
    if (xo) {
      for (const [, v] of xo) {
        const s = doc.resolve(v);
        if (isStream(s) && nameOf(doc, s.dict.get('Subtype')) === 'Form')
          addStream(v, resources, depth);
      }
    }

    const pat = dictOf(doc, resources.get('Pattern'));
    if (pat) {
      for (const [, v] of pat) {
        const s = doc.resolve(v);
        if (isStream(s) && doc.resolve(s.dict.get('PatternType')) === 1)
          addStream(v, resources, depth);
      }
    }

    const fonts = dictOf(doc, resources.get('Font'));
    if (fonts) {
      for (const [, v] of fonts) {
        const f = dictOf(doc, v);
        const procs = f ? dictOf(doc, f.get('CharProcs')) : undefined;
        if (!procs) continue;
        const fontRes = f ? dictOf(doc, f.get('Resources')) : undefined;
        for (const [, p] of procs) addStream(p, fontRes ?? resources, depth);
      }
    }

    const gs = dictOf(doc, resources.get('ExtGState'));
    if (gs) {
      for (const [, v] of gs) {
        const g = dictOf(doc, v);
        const sm = g ? dictOf(doc, g.get('SMask')) : undefined;
        if (sm) addStream(sm.get('G'), resources, depth);
      }
    }
  };

  for (const page of doc.Pages) {
    // `page.Resources`, NOT `page.Dict.get('Resources')`: /Resources is an
    // INHERITABLE page attribute (32000-1 7.7.3.4), and the raw read misses one
    // held on the /Pages node -- which is where Ghostscript, Word and others put
    // it. With no resources the whole walk degrades at once: every named colour
    // space falls to the unknown branch, and the form XObjects, tiling patterns,
    // Type 3 charprocs and SMask groups hanging off them are never reached, so a
    // greyscaled document went on painting blue with skipped: [] reported.
    const resources = page.Resources;
    const contents = page.Dict.get('Contents');
    const c = doc.resolve(contents);
    if (isArray(c)) for (const e of c) addStream(e, resources, 0);
    else addStream(contents, resources, 0);
    walkResources(resources, 0);

    const annots = doc.resolve(page.Dict.get('Annots'));
    if (isArray(annots)) {
      for (const a of annots) {
        const ad = dictOf(doc, a);
        const ap = ad ? dictOf(doc, ad.get('AP')) : undefined;
        if (!ap) continue;
        for (const key of ['N', 'R', 'D']) {
          const entry = ap.get(key);
          const r = doc.resolve(entry);
          if (isStream(r)) addStream(entry, resources, 0);
          else if (isDict(r)) for (const [, st] of r) addStream(st, resources, 0);
        }
      }
    }
  }
  return out;
}

/** Rewrite a `[/Pattern base]` colour space in place to `[/Pattern /DeviceGray]`.
 *  The sole colour-space resource this design retargets -- safe because such an
 *  array is referenced by nothing but `cs` + `scn`, never by an image. */
function retargetPatternSpaces(
  doc: Document, resources: PdfDict | undefined, keys: Set<string>, to: TargetSpace,
): void {
  if (keys.size === 0) return;
  const csDict = dictOf(doc, resources?.get('ColorSpace'));
  if (!csDict) return;
  for (const key of keys) {
    const arr = doc.resolve(csDict.get(key));
    if (isArray(arr) && arr.length > 1) csDict.set(key, [arr[0], name(targetName(to))]);
  }
}

/**
 * Rebuild each named Separation/DeviceN over the target (`ixxw.4`).
 *
 * The same shape as `retargetPatternSpaces` above and safe for the same
 * reason: `colorOps` reports the resource keys whose operators it LEFT ALONE,
 * and only those arrays are rewritten. The function stream is allocated HERE —
 * `colorsep.ts` is a pure leaf that cannot mint an object number.
 *
 * A space it declines is left exactly as written. That keeps its CMYK
 * alternate, which is what `preserveSpotColors` asked for: the colorant
 * survives and the page renders unchanged either way.
 */
function repointSpotSpaces(
  doc: Document, resources: PdfDict | undefined, keys: Set<string>,
  to: TargetSpace, toCmyk: CmykTransform | undefined, report: ColorConvertReport,
): void {
  if (keys.size === 0) return;
  const csDict = dictOf(doc, resources?.get('ColorSpace'));
  if (!csDict) return;
  for (const key of keys) {
    const arr = doc.resolve(csDict.get(key));
    if (!isArray(arr)) continue;
    const rep = repointSpotSpace(
      arr, (o) => doc.resolve(o), (s) => inflateStream(s as PdfStream), to, toCmyk);
    if (!rep) continue;
    const fnRef = doc.allocObject(rep.fn);
    csDict.set(key, spotSpaceArray(rep, fnRef, to));
    report.spotSpaces.push({ colorant: key, family: rep.family, grid: rep.grid });
  }
}

/** Rewrite every content stream. */
function convertContent(
  doc: Document, report: ColorConvertReport, to: TargetSpace,
  toCmyk?: CmykTransform, preserveSpot = false,
): void {
  for (const scope of collectScopes(doc)) {
    let ops;
    try {
      ops = parseContentStream(inflateStream(scope.stream));
    } catch (e) {
      report.skipped.push({
        objNum: scope.objNum, what: 'content',
        reason: `content stream would not parse: ${(e as Error).message}`,
      });
      continue;
    }
    const r = colorOps(ops, spaceLookup(doc, scope.resources), to, toCmyk, preserveSpot);
    retargetPatternSpaces(doc, scope.resources, r.patternSpaces, to);
    repointSpotSpaces(doc, scope.resources, r.spotSpaces, to, toCmyk, report);
    // BEFORE the no-change bail, not after: a stream whose only colour is an
    // inline image that declined changes nothing, and that is precisely the
    // stream whose skip the caller must hear about.
    for (const s of r.skipped) {
      report.skipped.push({
        objNum: scope.objNum, what: 'inline-image', opIndex: s.opIndex,
        reason: s.reason,
      });
    }
    // A colour space no lookup could resolve. Its operators were left as the
    // document wrote them, so this is the one entry that means colour SURVIVES
    // in the output -- the honest cost of refusing to convert from a space
    // nobody established.
    for (const key of r.unresolvedSpaces) {
      report.skipped.push({
        objNum: scope.objNum, what: 'content',
        reason: `colour space /${key} is not in the resources; `
          + 'its colour operators were left unconverted',
      });
    }
    if (r.changed === 0) continue;

    const raw = serializeContentStream(r.ops);
    const dict: PdfDict = new Map(scope.stream.dict);
    dict.delete('Filter');            // we wrote raw (uncompressed) bytes
    dict.delete('DecodeParms');
    dict.delete('DP');
    dict.set('Length', raw.length);
    doc.replaceObject(scope.objNum, { kind: 'stream', dict, raw });

    report.streams++;
    report.operators += r.changed;
    report.bytesDelta += raw.length - scope.stream.raw.length;
  }
}

/** An /SMask's /Matte is an array in the PARENT image's colour space, so it
 *  greys alongside the parent -- and must be read from the parent's ORIGINAL
 *  space, before the conversion retargets it. The /SMask stream itself is
 *  DeviceGray by specification and is left alone. */
function convertMatte(
  doc: Document, original: PdfStream, to: TargetSpace, toCmyk?: CmykTransform,
): void {
  const sm = doc.resolve(original.dict.get('SMask'));
  if (!isStream(sm)) return;
  const matte = doc.resolve(sm.dict.get('Matte'));
  if (!isArray(matte) || matte.length <= 1) return;
  const comps = matte.filter((v): v is number => typeof v === 'number');
  if (comps.length === 0) return;
  sm.dict.set('Matte',
    convertComps(comps, baseSpace(doc, original.dict.get('ColorSpace')), to, toCmyk)
      .map(grayNum));
}

/**
 * Convert every image XObject once, keyed by object number.
 *
 * Walks the whole object map rather than the page resources: an image reached
 * through three placements, or from inside a form XObject, is one object and
 * must convert once. `replaceObject` installs at the same number so every
 * referrer follows untouched -- `imageopt.ts`'s rule.
 */
function convertImages(
  doc: Document, report: ColorConvertReport, to: TargetSpace,
  opts: ColorConvertOptions & { toCmyk?: CmykTransform },
): void {
  const resolve = (o: PdfObject | undefined): PdfObject => doc.resolve(o);
  // Codec-aware, not plain inflation: ImageInfo.Decode() is a passthrough for
  // DCTDecode (which is what decodeJpeg wants) and handles CCITT, JPX and
  // JBIG2 besides. inflateStream here converts every Flate image and silently
  // fails on every JPEG.
  const inflate = (s: PdfStream): Uint8Array => new ImageInfo(doc, '', s).Decode();

  const targets: Array<[number, PdfStream]> = [];
  for (const [ref, obj] of doc.objectEntries()) {
    if (!isStream(obj)) continue;
    if (nameOf(doc, obj.dict.get('Subtype')) === 'Image') targets.push([ref.num, obj]);
  }

  for (const [objNum, stream] of targets) {
    const r = convertImageSpace(stream, resolve, inflate, to,
      { quality: opts.quality, toCmyk: opts.toCmyk });
    if (r.kind === 'none') continue;
    if (r.kind === 'skip') {
      report.skipped.push({ objNum, what: 'image', reason: r.reason });
      continue;
    }
    convertMatte(doc, stream, to, opts.toCmyk);          // the ORIGINAL space, not the new one
    // A colour-key /Mask became a stencil, which needs an object of its own.
    // `colorimage.ts` builds it and never sees a `Document` -- the same split
    // `imageembed.ts` makes when it attaches an /SMask.
    if (r.mask) r.stream.dict.set('Mask', doc.allocObject(r.mask));
    doc.replaceObject(objNum, r.stream);
    const bytesDelta = r.stream.raw.length - stream.raw.length;
    report.images.push({ objNum, from: r.from, route: r.route, bytesDelta });
    report.bytesDelta += bytesDelta;
    if (r.route === 'jpeg') report.lossy = true;
  }
}

/**
 * Convert every shading, reached from `/Resources /Shading` and from a shading
 * pattern's `/Shading`.
 *
 * Deduped by dict IDENTITY rather than object number: a shading is very often a
 * direct dict inside a pattern, so it has no object number to key on. A direct
 * dict is written back through its holder; an indirect one is replaced at its
 * own number so every referrer follows.
 */
function convertShadings(
  doc: Document, report: ColorConvertReport, to: TargetSpace, toCmyk?: CmykTransform,
): void {
  const resolve = (o: PdfObject | undefined): PdfObject => doc.resolve(o);
  const inflate = (s: PdfStream): Uint8Array => inflateStream(s);
  const seen = new Set<PdfDict>();

  const convert = (holder: PdfDict, key: string): void => {
    const entry = holder.get(key);
    const target = doc.resolve(entry);
    const dict = isStream(target) ? target.dict : isDict(target) ? target : undefined;
    if (!dict || seen.has(dict)) return;
    seen.add(dict);

    const r = convertShadingSpace(
      isStream(target) ? target : dict, resolve, inflate, to, toCmyk);
    if (r.kind === 'none') return;
    if (r.kind === 'skip') {
      report.skipped.push({ objNum: refNum(entry), what: 'shading', reason: r.reason });
      return;
    }
    const num = refNum(entry);
    // `raw` is present only for a mesh, whose per-vertex colour was re-spliced:
    // carrying the original bytes over there would leave the colour untouched
    // while the dict claimed DeviceGray, which renders as garbage rather than
    // as colour.
    const replacement: PdfObject = isStream(target)
      ? { kind: 'stream', dict: r.dict, raw: r.raw ?? target.raw }
      : r.dict;
    if (isStream(target) && r.raw) report.bytesDelta += r.raw.length - target.raw.length;
    if (num !== undefined) doc.replaceObject(num, replacement);
    else holder.set(key, replacement);
    report.shadings++;
  };

  // A shading PATTERN is its own object, so the object map finds it wherever it
  // lives. A named shading is not: it sits in a /Resources /Shading sub-dict,
  // and /Resources is usually a direct dict on the page -- invisible to a scan
  // of the object map, which is what made this pass convert the pattern and
  // silently miss every `sh`.
  for (const [, obj] of doc.objectEntries()) {
    const dict = isStream(obj) ? obj.dict : isDict(obj) ? obj : undefined;
    if (dict && doc.resolve(dict.get('PatternType')) === 2) convert(dict, 'Shading');
  }
  const resources = new Set<PdfDict>();
  for (const page of doc.Pages) {
    const r = page.Resources;          // inherited; see collectScopes
    if (r) resources.add(r);
  }
  for (const scope of collectScopes(doc)) if (scope.resources) resources.add(scope.resources);
  for (const res of resources) {
    const shDict = dictOf(doc, res.get('Shading'));
    if (shDict) for (const [k] of shDict) convert(shDict, k);
  }
}

/** What `greyColorArray` did: rewrote it, had nothing to do, or could not read
 *  it at all -- which the caller reports rather than guessing past. */
type ColorArrayOutcome = 'changed' | 'unchanged' | { reason: string };

/**
 * Collapse a 1-, 3- or 4-component colour array to the target's components.
 *
 * An annotation colour array states its space by its LENGTH (32000-1 12.5.2):
 * 1 is gray, 3 is RGB, 4 is CMYK. An EMPTY array is legal and means *no
 * colour* -- it must stay empty, or a border appears where the document asked
 * for none, and it must report NOTHING, or every annotation that asked for no
 * border produces a record.
 *
 * Any OTHER width states no colour this can read, and is reported rather than
 * guessed at (85l8.4). Guessing is what it used to do, in both directions: a
 * two-number array fell through to the RGB arm and was rewritten as RGB with
 * blue 0, and one holding no numbers at all was left in the document with
 * nothing said. Both leave a colour the report denied.
 */
function greyColorArray(
  doc: Document, holder: PdfDict, key: string, to: TargetSpace,
  label = `/${key}`, toCmyk?: CmykTransform,
): ColorArrayOutcome {
  const arr = doc.resolve(holder.get(key));
  if (!isArray(arr) || arr.length === 0) return 'unchanged';
  const comps = arr.filter((v): v is number => typeof v === 'number');
  // Already the target's width means there is nothing to do -- which was
  // `<= 1` while the target was always gray.
  if (comps.length === targetComponents(to)) return 'unchanged';
  if (comps.length !== 1 && comps.length !== 3 && comps.length !== 4) {
    return { reason: `${label} states ${comps.length} components, expected 1, 3 or 4` };
  }
  const space: GraySpace =
    comps.length === 4 ? { kind: 'cmyk' } : comps.length === 1 ? { kind: 'gray' }
      : { kind: 'rgb' };
  holder.set(key, convertComps(comps, space, to, toCmyk).map(grayNum));
  return 'changed';
}

/** Rewrite a `/DA` string through the CONTENT rewriter.
 *  Not `parseDA`, which reduces a /DA to { fontName, size, color } and would
 *  drop every operator it does not recognise on re-emission. A /DA is a
 *  content-stream fragment and deserves the content rewriter: one rewriter,
 *  two consumers. */
function greyDA(
  doc: Document, holder: PdfDict, to: TargetSpace, toCmyk?: CmykTransform,
): boolean {
  const da = doc.resolve(holder.get('DA'));
  if (!isString(da)) return false;
  let ops;
  try { ops = parseContentStream(da.bytes); } catch { return false; }
  const r = colorOps(ops, () => undefined, to, toCmyk);
  if (r.changed === 0) return false;
  // serializeContentStream ends each operator with a newline; a /DA is a
  // one-liner, so fold them back to spaces.
  const text = new TextDecoder().decode(serializeContentStream(r.ops))
    .replace(/\s*\n\s*/g, ' ').trim();
  holder.set('DA', { kind: 'string', bytes: new TextEncoder().encode(text) });
  return true;
}

/** Every annotation's own colour: /C, /IC, /MK /BG and /BC, and /DA.
 *  Appearance streams are already in the content enumeration, so a widget's
 *  drawn colour and its /MK cannot end up disagreeing. */
function convertAnnotations(
  doc: Document, report: ColorConvertReport, to: TargetSpace, toCmyk?: CmykTransform,
): void {
  for (const page of doc.Pages) {
    const annots = doc.resolve(page.Dict.get('Annots'));
    if (!isArray(annots)) continue;
    for (const a of annots) {
      const ad = dictOf(doc, a);
      if (!ad) continue;
      // The annotation's own object number, so a caller can find the one it
      // could not read. `refNum` is undefined for a direct dict in /Annots,
      // which is legal and leaves the entry unattributed rather than absent.
      const objNum = refNum(a);
      const apply = (holder: PdfDict, key: string, label?: string): boolean => {
        const out = greyColorArray(doc, holder, key, to, label, toCmyk);
        if (out === 'changed') return true;
        if (out !== 'unchanged') {
          report.skipped.push({ objNum, what: 'annotation', reason: out.reason });
        }
        return false;
      };
      let touched = false;
      touched = apply(ad, 'C') || touched;
      touched = apply(ad, 'IC') || touched;
      touched = greyDA(doc, ad, to, toCmyk) || touched;
      const mk = dictOf(doc, ad.get('MK'));
      if (mk) {
        touched = apply(mk, 'BG', '/MK /BG') || touched;
        touched = apply(mk, 'BC', '/MK /BC') || touched;
      }
      if (touched) report.annotations++;
    }
  }

  // The form-wide default appearance gets the same treatment.
  const acro = dictOf(doc, doc.catalog().get('AcroForm'));
  if (acro) greyDA(doc, acro, to, toCmyk);
}

/**
 * Convert a document's colour to `to`. See the module docs above.
 *
 * The target is validated FIRST, so a rejected call leaves the document
 * byte-identical -- the rule `formcreate.ts` and `imageedit.ts`'s `Replace`
 * already follow.
 */
export function convertColors(
  doc: Document, to: TargetSpace, opts: Omit<ConvertColorsOptions, 'to'> = {},
): ColorConvertReport {
  checkTarget(to);
  // Both checks run BEFORE any conversion, so a rejected call leaves the
  // document byte-identical.
  const toCmyk = opts.transform === undefined
    ? undefined : checkTransform(opts.transform, to);
  if (hasSignatureField(doc)) {
    throw new UnsupportedFeatureError(
      `ConvertColors: the document is signed; converting it to ${targetName(to)} `
      + 'would invalidate the signature and Save() would discard the change');
  }
  const report: ColorConvertReport = {
    streams: 0, operators: 0, images: [], shadings: 0, annotations: 0,
    skipped: [], lossy: false, bytesDelta: 0, spotSpaces: [],
    ...(to === 'cmyk'
      ? { cmykTransform: toCmyk ? ('supplied' as const) : ('naive' as const) }
      : {}),
  };
  convertImages(doc, report, to, { ...opts, toCmyk });
  convertShadings(doc, report, to, toCmyk);
  convertContent(doc, report, to, toCmyk, opts.preserveSpotColors === true);
  convertAnnotations(doc, report, to, toCmyk);
  return report;
}

/** Convert a document's colour to DeviceGray -- the specialization behind
 *  `Document.ConvertToGrayscale`, and the name every existing caller uses. */
export function convertToGrayscale(
  doc: Document, opts: ColorConvertOptions = {},
): ColorConvertReport {
  if (hasSignatureField(doc)) {
    // Worded for the entry point the caller actually used.
    throw new UnsupportedFeatureError(
      'ConvertToGrayscale: the document is signed; converting it would '
      + 'invalidate the signature and Save() would discard the change');
  }
  return convertColors(doc, 'gray', opts);
}
