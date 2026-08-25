import type { ContentOp } from './content.js';
import { isName, name, type PdfObject } from './types.js';
import { grayOf, grayNum, type GraySpace } from './grayscale.js';

/** Resolve a `/Resources /ColorSpace` key to a space. Undefined = unknown. */
export type SpaceLookup = (resourceName: string) => GraySpace | undefined;

export interface GrayOpsResult {
  ops: ContentOp[];
  changed: number;
  /** `/ColorSpace` keys holding a `[/Pattern base]` array whose base must be
   *  retargeted to `/DeviceGray`. Reported here, rewritten by the caller --
   *  this module allocates nothing and touches no dict. */
  patternSpaces: Set<string>;
}

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

/**
 * Grey an inline image's samples in place, or undefined to leave it alone.
 *
 * Only unfiltered 8-bpc device colour is converted: an inline image's payload
 * lives in the content stream and in no object, so a filtered one would have to
 * be decoded and re-encoded here, in a module that deliberately imports no
 * codec. Everything else is returned untouched -- and, being drawn content,
 * stays visible to the rendered-pixel check rather than disappearing quietly.
 */
function grayInlineImage(op: ContentOp): ContentOp | undefined {
  const img = op.inlineImage;
  if (!img) return undefined;
  const d = img.dict;
  if (d.get('IM') === true || d.get('ImageMask') === true) return undefined;
  if (d.has('F') || d.has('Filter')) return undefined;
  if (d.has('D') || d.has('Decode')) return undefined;

  const bpc = d.get('BPC') ?? d.get('BitsPerComponent');
  if (bpc !== 8) return undefined;

  const csObj = d.get('CS') ?? d.get('ColorSpace');
  if (!isName(csObj)) return undefined;
  const entry = INLINE_SPACE[csObj.name];
  if (!entry || entry.nc === 1) return undefined;

  const w = d.get('W') ?? d.get('Width');
  const h = d.get('H') ?? d.get('Height');
  if (typeof w !== 'number' || typeof h !== 'number') return undefined;
  const pixels = w * h;
  if (img.data.length < pixels * entry.nc) return undefined;

  const out = new Uint8Array(pixels);
  for (let i = 0; i < pixels; i++) {
    const comps: number[] = [];
    for (let k = 0; k < entry.nc; k++) comps.push((img.data[i * entry.nc + k] ?? 0) / 255);
    out[i] = Math.round(grayOf(comps, entry.space) * 255);
  }

  const dict = new Map(d);
  dict.delete('ColorSpace');
  dict.set('CS', name('G'));
  dict.set('BPC', 8);
  if (dict.has('L')) dict.set('L', out.length);
  if (dict.has('Length')) dict.set('Length', out.length);
  return { ...op, inlineImage: { dict, data: out } };
}

/**
 * Rewrite a content stream's colour operators to DeviceGray.
 *
 * Never throws: a damaged operator is left exactly as it was. The graphics
 * state is a `q`/`Q` stack of the fill and stroke spaces, both starting at
 * DeviceGray -- PDF's initial colour is black in DeviceGray -- and an
 * unbalanced `Q` clamps at the bottom rather than failing, the rule the four
 * non-object grammars in this repo already follow.
 */
export function grayscaleOps(
  ops: readonly ContentOp[], lookup: SpaceLookup,
): GrayOpsResult {
  const patternSpaces = new Set<string>();
  let changed = 0;
  let cur: { fill: GraySpace; stroke: GraySpace } = { fill: GRAY, stroke: GRAY };
  const stack: Array<{ fill: GraySpace; stroke: GraySpace }> = [];

  const out = ops.map((op): ContentOp => {
    switch (op.operator) {
      case 'q':
        stack.push(cur);
        return op;
      case 'Q':
        // Clamp rather than throw: damaged content must not take the
        // conversion down, and the worst case is one wrong space downstream.
        cur = stack.pop() ?? cur;
        return op;

      case 'g': case 'G':
        cur = op.operator === 'g' ? { ...cur, fill: GRAY } : { ...cur, stroke: GRAY };
        return op;

      case 'rg': case 'RG': case 'k': case 'K': {
        const fill = op.operator === 'rg' || op.operator === 'k';
        const space: GraySpace = op.operator === 'k' || op.operator === 'K'
          ? { kind: 'cmyk' } : { kind: 'rgb' };
        cur = fill ? { ...cur, fill: GRAY } : { ...cur, stroke: GRAY };
        const n = nums(op.operands);
        if (n.length === 0) return op;
        changed++;
        return { operator: fill ? 'g' : 'G', operands: [grayNum(grayOf(n, space))] };
      }

      case 'cs': case 'CS': {
        const a = op.operands[0];
        if (!isName(a)) return op;                       // malformed; leave it
        const space = DEVICE[a.name] ?? lookup(a.name) ?? GRAY;
        const fill = op.operator === 'cs';
        cur = fill ? { ...cur, fill: space } : { ...cur, stroke: space };
        if (space.kind === 'pattern') {
          // Keep the name: it must stay resolvable for the scn that follows.
          if (space.base && space.resourceName) patternSpaces.add(space.resourceName);
          return op;
        }
        if (a.name === 'DeviceGray') return op;
        changed++;
        return { ...op, operands: [name('DeviceGray')] };
      }

      case 'sc': case 'scn': case 'SC': case 'SCN': {
        const fill = op.operator === 'sc' || op.operator === 'scn';
        const space = fill ? cur.fill : cur.stroke;
        const last = op.operands[op.operands.length - 1];
        const n = nums(op.operands);

        if (isName(last)) {
          // A pattern. Coloured (no numbers) takes its colour from the
          // pattern's own content stream, which the caller converts separately.
          if (n.length === 0) return op;
          const base = space.kind === 'pattern' && space.base ? space.base : space;
          changed++;
          return { ...op, operands: [grayNum(grayOf(n, base)), last] };
        }
        if (n.length === 0 || space.kind === 'gray') return op;
        changed++;
        return { operator: fill ? 'g' : 'G', operands: [grayNum(grayOf(n, space))] };
      }

      case 'BI': {
        const converted = grayInlineImage(op);
        if (!converted) return op;
        changed++;
        return converted;
      }

      default:
        return op;
    }
  });

  return { ops: out, changed, patternSpaces };
}
