import type { ContentOp } from './content.js';
import { isName, name, type PdfObject } from './types.js';
import {
  convertComps, grayNum, isTarget, targetComponents, targetName,
  type CmykTransform, type GraySpace, type TargetSpace,
} from './colorrule.js';

/** Resolve a `/Resources /ColorSpace` key to a space. Undefined = unknown. */
export type SpaceLookup = (resourceName: string) => GraySpace | undefined;

export interface GrayOpsResult {
  ops: ContentOp[];
  changed: number;
  /** `/ColorSpace` keys holding a `[/Pattern base]` array whose base must be
   *  retargeted to `/DeviceGray`. Reported here, rewritten by the caller --
   *  this module allocates nothing and touches no dict. */
  patternSpaces: Set<string>;
  /**
   * Inline images that carried colour this module could not convert, in the
   * order they are drawn (85l8.4).
   *
   * An inline image lives in the content stream and in no object, so
   * `colorimage.ts` never sees one and this is the only place that can report
   * it. Reported here and attributed to a containing stream by the caller --
   * the same split `colorimage.ts` makes, and what keeps this module free of a
   * `Document`. Each carries the index of its own `BI` op (85l8.6), relative
   * to THIS op list — which is what lets the caller pair it with the object
   * number it knows while this module goes on knowing no object numbers at all.
   */
  skipped: InlineSkipAt[];
  /**
   * `/ColorSpace` resource keys a `cs`/`CS` named that no lookup could resolve,
   * deduped (85l8.5). Their colour operators were LEFT as the document wrote
   * them; the caller reports them.
   *
   * A `Set` of resource names rather than reasons, which is `patternSpaces`'
   * shape a few lines up and for the same reason: this module hands back what
   * it FOUND and the caller decides what that means for a report it owns.
   */
  unresolvedSpaces: Set<string>;
}

/**
 * A colour space as the `q`/`Q` stack holds it, or `'unknown'` for one whose
 * `/ColorSpace` resource could not be resolved.
 *
 * Local to this module ON PURPOSE. `colorrule.ts` is the leaf every colour
 * rule is tested from, and `GraySpace` is shared with `colorimage.ts` and
 * `colorshading.ts`, which resolve a space from a dict they were handed and so
 * can never produce this -- a kind only one of three consumers can construct
 * would be a case the other two carry for nothing.
 */
type StateSpace = GraySpace | 'unknown';

const GRAY: GraySpace = { kind: 'gray' };

/** Colour-space names a `cs` operand may carry without a resource entry. */
const DEVICE: Readonly<Record<string, GraySpace>> = {
  DeviceGray: GRAY, G: GRAY, CalGray: GRAY,
  DeviceRGB: { kind: 'rgb' }, RGB: { kind: 'rgb' }, CalRGB: { kind: 'rgb' },
  DeviceCMYK: { kind: 'cmyk' }, CMYK: { kind: 'cmyk' },
  Pattern: { kind: 'pattern' },
};

const nums = (operands: readonly PdfObject[]): number[] =>
  operands.filter((o): o is number => typeof o === 'number');

/** Inline-image colour spaces, abbreviated and spelled out (32000-1 8.9.5.2). */
const INLINE_SPACE: Readonly<Record<string, { space: GraySpace; nc: number }>> = {
  G: { space: GRAY, nc: 1 },
  DeviceGray: { space: GRAY, nc: 1 },
  RGB: { space: { kind: 'rgb' }, nc: 3 },
  DeviceRGB: { space: { kind: 'rgb' }, nc: 3 },
  CMYK: { space: { kind: 'cmyk' }, nc: 4 },
  DeviceCMYK: { space: { kind: 'cmyk' }, nc: 4 },
};

/** The abbreviated `CS` name a target is written as inside an inline image.
 *  Abbreviations rather than the full spellings because that is what an inline
 *  image's dict wants; `inlinedict.ts` expands them for every reader. */
const INLINE_NAME: Readonly<Record<TargetSpace, string>> = {
  gray: 'G', rgb: 'RGB', cmyk: 'CMYK',
};

/** An inline image this module declined to convert, and why. */
interface InlineSkip { reason: string }

/**
 * One of those, plus WHICH `BI` op it was.
 *
 * An op index rather than a `ContentAddr`, and that is structural rather than
 * a shortcut. `ContentAddr.path` is an XObject chain — `cowXObject` resolves
 * every segment through `/Resources /XObject` — while `colorconvert.ts` also
 * walks tiling patterns, Type 3 `/CharProcs` and ExtGState `/SMask /G` groups,
 * any of which may hold a `BI` and none of which such a path can name. A
 * `ContentAddr` is also PAGE-relative where the scope walk dedupes by object
 * number, so a form reached from two pages has no single page to name. An
 * object number plus an op index has neither problem.
 */
export interface InlineSkipAt extends InlineSkip { opIndex: number }

const declined = (reason: string): InlineSkip => ({ reason });

/**
 * Convert an inline image's samples in place.
 *
 * Three outcomes, and the difference between the last two is what makes
 * `skipped` worth reading. `ContentOp` is a converted image; `InlineSkip` is
 * one carrying colour this module could not convert, which the caller reports;
 * `undefined` is a decline with NOTHING TO DO -- an image mask carries no
 * colour, and one already in the target space has nothing to change. Reporting
 * those would put a record on the commonest inline image in the commonest
 * conversion, and an always-populated `skipped` says no more than an empty one.
 *
 * Only unfiltered 8-bpc device colour is converted: an inline image's payload
 * lives in the content stream and in no object, so a filtered one would have to
 * be decoded and re-encoded here, in a module that deliberately imports no
 * codec. Everything else is returned untouched -- and, being drawn content,
 * stays visible to the rendered-pixel check rather than disappearing quietly.
 */
function convertInlineImage(
  op: ContentOp, to: TargetSpace, toCmyk?: CmykTransform,
): ContentOp | InlineSkip | undefined {
  const img = op.inlineImage;
  if (!img) return undefined;
  const d = img.dict;
  if (d.get('IM') === true || d.get('ImageMask') === true) return undefined;

  // The space is read FIRST, and the target check OUTRANKS every reason below
  // it. `/CS` is in the dict rather than the payload, so an image already in
  // the target space needs nothing decoded and cannot fail to convert however
  // it is coded -- put the filter test first and every filtered gray inline
  // image reports a skip for work there was none of.
  const csObj = d.get('CS') ?? d.get('ColorSpace');
  if (csObj === undefined) return declined('inline image has no /CS');
  if (!isName(csObj)) return declined('inline image colourspace is not a device space');
  const entry = INLINE_SPACE[csObj.name];
  // A name outside the six is a `/Resources /ColorSpace` key or an abbreviated
  // Indexed array -- convertible in principle, and not by a module that
  // resolves no resources.
  if (!entry) {
    return declined(`inline image colourspace ${csObj.name} is not a device space`);
  }
  // Already in the target space: nothing to do. This was `nc === 1`, which is
  // the same test only while the target is gray.
  if (isTarget(entry.space, to)) return undefined;

  if (d.has('F') || d.has('Filter')) return declined('inline image is filtered');
  if (d.has('D') || d.has('Decode')) return declined('inline image has a /Decode array');

  const bpc = d.get('BPC') ?? d.get('BitsPerComponent');
  if (bpc !== 8) {
    return declined(
      `inline image BitsPerComponent ${String(bpc ?? '(absent)')} is not 8`);
  }

  const w = d.get('W') ?? d.get('Width');
  const h = d.get('H') ?? d.get('Height');
  if (typeof w !== 'number' || typeof h !== 'number') {
    return declined('inline image has missing or invalid /W or /H');
  }
  const pixels = w * h;
  if (img.data.length < pixels * entry.nc) {
    return declined(`inline image has ${img.data.length} sample bytes, `
      + `expected ${pixels * entry.nc}`);
  }

  const outNc = targetComponents(to);
  const out = new Uint8Array(pixels * outNc);
  for (let i = 0; i < pixels; i++) {
    const comps: number[] = [];
    for (let k = 0; k < entry.nc; k++) comps.push((img.data[i * entry.nc + k] ?? 0) / 255);
    const conv = convertComps(comps, entry.space, to, toCmyk);
    for (let k = 0; k < outNc; k++) out[i * outNc + k] = Math.round((conv[k] ?? 0) * 255);
  }

  const dict = new Map(d);
  dict.delete('ColorSpace');
  dict.set('CS', name(INLINE_NAME[to]));
  dict.set('BPC', 8);
  if (dict.has('L')) dict.set('L', out.length);
  if (dict.has('Length')) dict.set('Length', out.length);
  return { ...op, inlineImage: { dict, data: out } };
}

/** The direct colour-setting operator pair for a target: fill, then stroke. */
const SET_OP: Readonly<Record<TargetSpace, readonly [string, string]>> = {
  gray: ['g', 'G'], rgb: ['rg', 'RG'], cmyk: ['k', 'K'],
};

/** `comps` read in `from`, as operands in `to`, rounded for emission. */
const operandsFor = (
  comps: readonly number[], from: GraySpace, to: TargetSpace, toCmyk?: CmykTransform,
): PdfObject[] => convertComps(comps, from, to, toCmyk).map(grayNum);

/**
 * Rewrite a content stream's colour operators to `to`.
 *
 * Never throws: a damaged operator is left exactly as it was. The graphics
 * state is a `q`/`Q` stack of the fill and stroke spaces, both starting at
 * DeviceGray -- PDF's initial colour is black in DeviceGray, which is a fact
 * about the format and NOT about the target, so it is seeded the same way
 * whatever `to` is -- and an unbalanced `Q` clamps at the bottom rather than
 * failing, the rule the four non-object grammars in this repo already follow.
 *
 * Note `g`/`G` stops being a no-op once the target is not gray. That is the
 * operator a gray-shaped rewrite most easily leaves behind, and a document
 * still carrying its `g` operators under `to: 'cmyk'` is one that did not
 * convert.
 */
export function colorOps(
  ops: readonly ContentOp[], lookup: SpaceLookup, to: TargetSpace,
  toCmyk?: CmykTransform,
): GrayOpsResult {
  const patternSpaces = new Set<string>();
  const skipped: InlineSkipAt[] = [];
  const unresolvedSpaces = new Set<string>();
  const [fillOp, strokeOp] = SET_OP[to];
  const target = targetName(to);
  let changed = 0;
  let cur: { fill: StateSpace; stroke: StateSpace } = { fill: GRAY, stroke: GRAY };
  const stack: Array<{ fill: StateSpace; stroke: StateSpace }> = [];

  const out = ops.map((op, opIndex): ContentOp => {
    switch (op.operator) {
      case 'q':
        stack.push(cur);
        return op;
      case 'Q':
        // Clamp rather than throw: damaged content must not take the
        // conversion down, and the worst case is one wrong space downstream.
        cur = stack.pop() ?? cur;
        return op;

      case 'g': case 'G': case 'rg': case 'RG': case 'k': case 'K': {
        const fill = op.operator === 'g' || op.operator === 'rg' || op.operator === 'k';
        const space: GraySpace =
          op.operator === 'g' || op.operator === 'G' ? GRAY
            : op.operator === 'rg' || op.operator === 'RG' ? { kind: 'rgb' }
              : { kind: 'cmyk' };
        // The operator states its own space, so what the state records is the
        // space the REWRITTEN operator sets -- the target, always.
        const after: GraySpace = { kind: to } as GraySpace;
        cur = fill ? { ...cur, fill: after } : { ...cur, stroke: after };
        const n = nums(op.operands);
        if (n.length === 0 || isTarget(space, to)) return op;
        changed++;
        return { operator: fill ? fillOp : strokeOp, operands: operandsFor(n, space, to, toCmyk) };
      }

      case 'cs': case 'CS': {
        const a = op.operands[0];
        if (!isName(a)) return op;                       // malformed; leave it
        const resolved = DEVICE[a.name] ?? lookup(a.name);
        // A name no lookup answers used to fall back to DeviceGray and convert
        // as though the document had said so, which is wrong two ways at once:
        // to a non-gray target the following `sc 1 0 0` is read as ONE grey
        // component and comes out white, and to gray the `cs` is retargeted
        // while `isTarget` leaves the `sc` alone, emitting `/DeviceGray cs
        // 1 0 0 sc` -- three operands in a one-component space. Both write a
        // colour nobody established, so neither operator is touched and the
        // name is reported instead.
        if (!resolved) {
          unresolvedSpaces.add(a.name);
          cur = op.operator === 'cs'
            ? { ...cur, fill: 'unknown' } : { ...cur, stroke: 'unknown' };
          return op;
        }
        const space = resolved;
        const fill = op.operator === 'cs';
        cur = fill ? { ...cur, fill: space } : { ...cur, stroke: space };
        if (space.kind === 'pattern') {
          // Keep the name: it must stay resolvable for the scn that follows.
          if (space.base && space.resourceName) patternSpaces.add(space.resourceName);
          return op;
        }
        if (a.name === target) return op;
        changed++;
        return { ...op, operands: [name(target)] };
      }

      case 'sc': case 'scn': case 'SC': case 'SCN': {
        const fill = op.operator === 'sc' || op.operator === 'scn';
        const space = fill ? cur.fill : cur.stroke;
        // Before every branch below, the pattern one included: with no space
        // there is nothing to read these operands IN.
        if (space === 'unknown') return op;
        const last = op.operands[op.operands.length - 1];
        const n = nums(op.operands);

        if (isName(last)) {
          // A pattern. Coloured (no numbers) takes its colour from the
          // pattern's own content stream, which the caller converts separately.
          if (n.length === 0) return op;
          const base = space.kind === 'pattern' && space.base ? space.base : space;
          changed++;
          return { ...op, operands: [...operandsFor(n, base, to, toCmyk), last] };
        }
        if (n.length === 0 || isTarget(space, to)) return op;
        changed++;
        return { operator: fill ? fillOp : strokeOp, operands: operandsFor(n, space, to, toCmyk) };
      }

      case 'BI': {
        const converted = convertInlineImage(op, to, toCmyk);
        if (!converted) return op;
        if ('reason' in converted) {
          skipped.push({ opIndex, reason: converted.reason });
          return op;
        }
        changed++;
        return converted;
      }

      default:
        return op;
    }
  });

  return { ops: out, changed, patternSpaces, skipped, unresolvedSpaces };
}

/** The DeviceGray specialization of `colorOps`, and the name every existing
 *  caller uses. */
export function grayscaleOps(
  ops: readonly ContentOp[], lookup: SpaceLookup,
): GrayOpsResult {
  return colorOps(ops, lookup, 'gray');
}
