import type { Document } from './document.js';
import {
  PdfDict, PdfObject, PdfStream, isArray, isDict, isName, isRef, isStream, isString, name,
} from './types.js';
import { UnsupportedFeatureError } from './errors.js';
import { hasSignatureField } from './signature.js';
import { parseContentStream, serializeContentStream } from './content.js';
import { inflateStream } from './flate.js';
import { resolveColorSpace } from './colorspace.js';
import { grayscaleOps, type SpaceLookup } from './grayops.js';
import { grayNum, grayOf, type GraySpace } from './grayscale.js';
import { grayscaleImage } from './grayimage.js';
import { grayscaleShading } from './grayshading.js';
import { ImageInfo } from './image.js';

/**
 * Document-wide grayscale conversion.
 *
 * The approach is operator-level *neutralization*, not colour-space
 * retargeting: every colour-setting operator becomes `g`/`G` carrying the luma
 * of the colour it set, and named `/ColorSpace` resources are left unreferenced
 * rather than rewritten. That is what makes the two passes below
 * order-independent -- the content pass READS colour-space resources that no
 * pass WRITES. Retargeting would have had the content pass resolving spaces the
 * object pass had already moved out from under it.
 *
 * The one exception is `retargetPatternSpaces`, and it is safe precisely
 * because a `[/Pattern base]` array is referenced by nothing but `cs` + `scn`.
 */

export interface GrayscaleOptions {
  /** IJG quality for re-encoded DCT images, 1..100. Default 90. */
  quality?: number;
}

export interface GrayImageResult {
  objNum: number;
  /** The colour space it came from, e.g. 'DeviceRGB', 'Indexed'. */
  from: string;
  route: 'palette' | 'jpeg' | 'jpeg-exact' | 'flate';
  /** Negative when the converted image is smaller. */
  bytesDelta: number;
}

export interface GraySkipped {
  objNum?: number;
  what: 'image' | 'shading' | 'content' | 'annotation';
  reason: string;
}

export interface GrayscaleReport {
  /** Content streams rewritten. */
  streams: number;
  /** Colour operators changed across all of them. */
  operators: number;
  images: GrayImageResult[];
  shadings: number;
  annotations: number;
  /** What could not be converted, and why. The first place to look when a
   *  converted document still shows colour. */
  skipped: GraySkipped[];
  /** True when any image was re-encoded through JPEG: the output is no longer
   *  a lossless greying of the original. */
  lossy: boolean;
  bytesDelta: number;
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
    const resources = dictOf(doc, page.Dict.get('Resources'));
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
  doc: Document, resources: PdfDict | undefined, keys: Set<string>,
): void {
  if (keys.size === 0) return;
  const csDict = dictOf(doc, resources?.get('ColorSpace'));
  if (!csDict) return;
  for (const key of keys) {
    const arr = doc.resolve(csDict.get(key));
    if (isArray(arr) && arr.length > 1) csDict.set(key, [arr[0], name('DeviceGray')]);
  }
}

/** Rewrite every content stream. */
function convertContent(doc: Document, report: GrayscaleReport): void {
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
    const r = grayscaleOps(ops, spaceLookup(doc, scope.resources));
    retargetPatternSpaces(doc, scope.resources, r.patternSpaces);
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
function convertMatte(doc: Document, original: PdfStream): void {
  const sm = doc.resolve(original.dict.get('SMask'));
  if (!isStream(sm)) return;
  const matte = doc.resolve(sm.dict.get('Matte'));
  if (!isArray(matte) || matte.length <= 1) return;
  const comps = matte.filter((v): v is number => typeof v === 'number');
  if (comps.length === 0) return;
  sm.dict.set('Matte',
    [grayNum(grayOf(comps, baseSpace(doc, original.dict.get('ColorSpace'))))]);
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
  doc: Document, report: GrayscaleReport, opts: GrayscaleOptions,
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
    const r = grayscaleImage(stream, resolve, inflate, { quality: opts.quality });
    if (r.kind === 'none') continue;
    if (r.kind === 'skip') {
      report.skipped.push({ objNum, what: 'image', reason: r.reason });
      continue;
    }
    convertMatte(doc, stream);              // the ORIGINAL space, not the new one
    // A colour-key /Mask became a stencil, which needs an object of its own.
    // `grayimage.ts` builds it and never sees a `Document` -- the same split
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
function convertShadings(doc: Document, report: GrayscaleReport): void {
  const resolve = (o: PdfObject | undefined): PdfObject => doc.resolve(o);
  const inflate = (s: PdfStream): Uint8Array => inflateStream(s);
  const seen = new Set<PdfDict>();

  const convert = (holder: PdfDict, key: string): void => {
    const entry = holder.get(key);
    const target = doc.resolve(entry);
    const dict = isStream(target) ? target.dict : isDict(target) ? target : undefined;
    if (!dict || seen.has(dict)) return;
    seen.add(dict);

    const r = grayscaleShading(isStream(target) ? target : dict, resolve, inflate);
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
    const r = dictOf(doc, page.Dict.get('Resources'));
    if (r) resources.add(r);
  }
  for (const scope of collectScopes(doc)) if (scope.resources) resources.add(scope.resources);
  for (const res of resources) {
    const shDict = dictOf(doc, res.get('Shading'));
    if (shDict) for (const [k] of shDict) convert(shDict, k);
  }
}

/** Collapse a 1-, 3- or 4-component colour array to one grey component.
 *  An EMPTY array is legal and means *no colour* -- it must stay empty, or a
 *  border appears where the document asked for none. */
function greyColorArray(doc: Document, holder: PdfDict, key: string): boolean {
  const arr = doc.resolve(holder.get(key));
  if (!isArray(arr) || arr.length === 0) return false;
  const comps = arr.filter((v): v is number => typeof v === 'number');
  if (comps.length <= 1) return false;                  // already one component
  const space: GraySpace = comps.length === 4 ? { kind: 'cmyk' } : { kind: 'rgb' };
  holder.set(key, [grayNum(grayOf(comps, space))]);
  return true;
}

/** Rewrite a `/DA` string through the CONTENT rewriter.
 *  Not `parseDA`, which reduces a /DA to { fontName, size, color } and would
 *  drop every operator it does not recognise on re-emission. A /DA is a
 *  content-stream fragment and deserves the content rewriter: one rewriter,
 *  two consumers. */
function greyDA(doc: Document, holder: PdfDict): boolean {
  const da = doc.resolve(holder.get('DA'));
  if (!isString(da)) return false;
  let ops;
  try { ops = parseContentStream(da.bytes); } catch { return false; }
  const r = grayscaleOps(ops, () => undefined);
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
function convertAnnotations(doc: Document, report: GrayscaleReport): void {
  for (const page of doc.Pages) {
    const annots = doc.resolve(page.Dict.get('Annots'));
    if (!isArray(annots)) continue;
    for (const a of annots) {
      const ad = dictOf(doc, a);
      if (!ad) continue;
      let touched = false;
      touched = greyColorArray(doc, ad, 'C') || touched;
      touched = greyColorArray(doc, ad, 'IC') || touched;
      touched = greyDA(doc, ad) || touched;
      const mk = dictOf(doc, ad.get('MK'));
      if (mk) {
        touched = greyColorArray(doc, mk, 'BG') || touched;
        touched = greyColorArray(doc, mk, 'BC') || touched;
      }
      if (touched) report.annotations++;
    }
  }

  // The form-wide default appearance gets the same treatment.
  const acro = dictOf(doc, doc.catalog().get('AcroForm'));
  if (acro) greyDA(doc, acro);
}

/** Convert a document's colour to DeviceGray. See the module docs above. */
export function convertToGrayscale(
  doc: Document, opts: GrayscaleOptions = {},
): GrayscaleReport {
  if (hasSignatureField(doc)) {
    throw new UnsupportedFeatureError(
      'ConvertToGrayscale: the document is signed; converting it would '
      + 'invalidate the signature and Save() would discard the change');
  }
  const report: GrayscaleReport = {
    streams: 0, operators: 0, images: [], shadings: 0, annotations: 0,
    skipped: [], lossy: false, bytesDelta: 0,
  };
  convertImages(doc, report, opts);
  convertShadings(doc, report);
  convertContent(doc, report);
  convertAnnotations(doc, report);
  return report;
}
