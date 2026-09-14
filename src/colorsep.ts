import {
  PdfObject, PdfDict, PdfStream, isArray, isName, isDict, name,
} from './types.js';
import { parseFunction } from './pdffunction.js';
import { resolveColorSpace } from './colorspace.js';
import {
  convertComps, targetName, targetComponents,
  type TargetSpace, type CmykTransform,
} from './colorrule.js';

/**
 * Repointing a Separation or DeviceN over a device alternate (`ixxw.4`).
 *
 * Converting a document's colour used to FLATTEN a spot: `/Sep cs 1 scn`
 * became `1 0 0 rg`, so the named colorant — the thing a print workflow
 * separates onto its own plate — was gone, replaced by process colour that
 * merely looks the same. This rebuilds the SPACE instead.
 *
 * PDF has no way to compose a tint transform with an alternate-space
 * conversion: a `/Separation`'s fourth element is one function and there is no
 * "then convert" to hang off it. So the composition is RESAMPLED into a type 0
 * (sampled) function running straight from tint to the target.
 *
 * **Invariant:** the space keeps its KIND, its colorant NAMES and its
 * component COUNT. That is what makes this safe to do document-wide — every
 * `cs`/`scn` selecting it is untouched and a Separation image keeps its tint
 * samples byte for byte. Only the alternate and the tint function move.
 *
 * **Invariant:** a pure leaf. `resolve`/`inflate` arrive as arguments (the
 * `colorimage.ts` seam) and NOTHING is allocated — a type 0 function is a
 * STREAM and so must be an indirect object, which only a `Document` can mint,
 * so the stream comes back for `colorconvert.ts` to give a number. Every rule
 * here is drivable from hand-built arrays with no document.
 *
 * **Invariant:** the alternate is evaluated through `resolveColorSpace`'s own
 * `ColorConverter` — the one `raster.ts` renders with — so the resampled
 * function reproduces what the page already showed. Re-deriving the
 * alternate's conversion here would be a second answer to a question the
 * renderer already answers.
 *
 * **Invariant:** it never throws. A space it cannot rebuild is `undefined`
 * and the caller leaves the document alone.
 */

type Resolve = (o: PdfObject | undefined) => PdfObject;
type Inflate = (s: { dict: PdfDict; raw: Uint8Array }) => Uint8Array;

/**
 * Samples per axis for a single-colorant space.
 *
 * 256 is one byte of tint resolution, which is what a Separation operand
 * carries in practice; a linear tint then lands ON the sample points, so the
 * rebuilt function is exact rather than approximate.
 */
export const SPOT_SAMPLE_BUDGET = 256;

/** Total samples a multi-colorant grid may spend — one axis per colorant
 *  against a fixed total, so a 4-colorant DeviceN samples coarsely rather
 *  than exploding to 256^4. */
const TOTAL_BUDGET = 4096;

export interface SpotRepoint {
  family: 'Separation' | 'DeviceN';
  /** The colorant name, or the array of them — carried through VERBATIM. */
  names: PdfObject;
  /** A DeviceN attributes dictionary, carried through verbatim. */
  attrs?: PdfObject;
  /** The resampled tint transform. The caller allocates it. */
  fn: PdfStream;
  /** Samples per axis, one per colorant — the function's `/Size`. */
  grid: number[];
}

function gridFor(n: number): number[] {
  if (n <= 1) return [SPOT_SAMPLE_BUDGET];
  const k = Math.max(2, Math.floor(TOTAL_BUDGET ** (1 / n)));
  return Array.from({ length: n }, () => k);
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Rebuild `arr` over `to`, or undefined when there is nothing to do.
 *
 * Declines a space that is not Separation/DeviceN, one too short to read, and
 * — deliberately — one whose alternate ALREADY is the target: rebuilding it
 * would trade an exact transform for a sampled one for no gain.
 */
export function repointSpotSpace(
  arr: readonly PdfObject[], resolve: Resolve, inflate: Inflate,
  to: TargetSpace, toCmyk?: CmykTransform,
): SpotRepoint | undefined {
  if (arr.length < 4) return undefined;
  const head = resolve(arr[0]);
  if (!isName(head)) return undefined;
  if (head.name !== 'Separation' && head.name !== 'DeviceN') return undefined;
  const family = head.name;

  const names = resolve(arr[1]);
  const n = family === 'Separation' ? 1 : isArray(names) ? names.length : 0;
  if (n < 1) return undefined;

  const altObj = resolve(arr[2]);
  if (isName(altObj) && altObj.name === targetName(to)) return undefined;

  let tint;
  let alt;
  try {
    tint = parseFunction(arr[3] as PdfObject, resolve, inflate);
    alt = resolveColorSpace(altObj, resolve, inflate);
  } catch { return undefined; }

  const grid = gridFor(n);
  const total = grid.reduce((a, b) => a * b, 1);
  const comps = targetComponents(to);
  const out = new Uint8Array(total * comps);
  const idx = new Array<number>(n).fill(0);
  try {
    for (let s = 0; s < total; s++) {
      // The FIRST axis varies FASTEST in a type 0 sample stream (32000-1
      // 7.10.2), which `pdffunction.ts`'s reader implements as
      // `flat = idx[0] + idx[1]*Size[0] + …`.
      //
      // **This is the OPPOSITE of an ICC CLUT**, where `icclut.ts` records the
      // first input channel varying SLOWEST — two sampled-table conventions
      // that look alike and run in opposite directions. Walking it the ICC way
      // yields a perfectly smooth surface with the colorants TRANSPOSED, which
      // is why this is pinned by a DeviceN whose two inputs do different
      // things rather than by any single-colorant case.
      let rest = s;
      for (let a = 0; a < n; a++) {
        const k = grid[a] as number;
        idx[a] = rest % k;
        rest = Math.floor(rest / k);
      }
      const tintIn = idx.map((i, a) => i / ((grid[a] as number) - 1 || 1));
      const rgb255 = alt.toRgb(tint(tintIn));
      const rgb01 = [(rgb255[0] ?? 0) / 255, (rgb255[1] ?? 0) / 255, (rgb255[2] ?? 0) / 255];
      const vals = to === 'rgb' ? rgb01 : convertComps(rgb01, { kind: 'rgb' }, to, toCmyk);
      for (let c = 0; c < comps; c++) {
        out[s * comps + c] = Math.round(clamp01(vals[c] ?? 0) * 255);
      }
    }
  } catch { return undefined; }

  const dict: PdfDict = new Map<string, PdfObject>([
    ['FunctionType', 0],
    ['Domain', grid.flatMap(() => [0, 1])],
    ['Range', Array.from({ length: comps * 2 }, (_, i) => i % 2)],
    ['Size', grid],
    ['BitsPerSample', 8],
    ['Length', out.length],
  ]);
  const rep: SpotRepoint = {
    family, names, fn: { kind: 'stream', dict, raw: out }, grid,
  };
  const attrs = arr[4];
  if (attrs !== undefined && isDict(resolve(attrs))) rep.attrs = attrs;
  return rep;
}

/** The rebuilt colour-space array, once the caller has allocated `fn`. */
export function spotSpaceArray(
  rep: SpotRepoint, fnRef: PdfObject, to: TargetSpace,
): PdfObject[] {
  const arr: PdfObject[] = [name(rep.family), rep.names, name(targetName(to)), fnRef];
  if (rep.attrs !== undefined) arr.push(rep.attrs);
  return arr;
}

/** True when `cs` is a Separation or DeviceN array. */
export function isSpotSpace(cs: PdfObject, resolve: Resolve): boolean {
  if (!isArray(cs) || cs.length === 0) return false;
  const head = resolve(cs[0]);
  return isName(head) && (head.name === 'Separation' || head.name === 'DeviceN');
}
