import { inflateSync } from 'node:zlib';
import { parseSfnt, SfntFont } from './sfnt.js';
import { STD14_DATA } from './std14data.js';
import type { StdFont } from './metrics.js';
import { rethrowLimit } from './errors.js';
import { LoadLimits } from './loadlimits.js';
import type { FontWork } from './fontwork.js';
import { DecodeBudget } from './decodebudget.js';

// Parsed-font cache: null marks a face that failed to load (do not retry).
const cache = new Map<StdFont, SfntFont | null>();

/** Lazily inflate + parse the bundled substitute for a Standard-14 face.
 *  Returns undefined (never throws) when data is missing or unparseable. */
export function getStd14Sfnt(std: StdFont, options?: { limits?: LoadLimits; work?: FontWork; decode?: DecodeBudget }): SfntFont | undefined {
  if (options) {
    const b64 = STD14_DATA[std];
    if (!b64) return undefined;
    const limits = options.limits ?? LoadLimits.defaults;
    const decode = options.decode ?? new DecodeBudget(limits);
    // The committed substitute faces are below this fixed native allocation cap.
    const encoded = Math.floor(b64.length * 3 / 4), cap = Math.min(1024 * 1024, decode.cap(encoded).bytes);
    options.work?.allocate(64 + encoded + cap + 1, 'bundled font inflation');
    options.work?.work(encoded, 'bundled font inflation');
    let bytes: Uint8Array;
    try { bytes = inflateSync(Buffer.from(b64, 'base64'), { maxOutputLength: Math.max(1, cap + 1) }); }
    catch (caught) { rethrowLimit(caught);
      if ((caught as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') decode.check(cap + 1, encoded);
      throw caught;
    }
    decode.check(bytes.length, encoded); decode.chargeBytes(bytes.length);
    return parseSfnt(bytes, 0, limits, { work: options.work, strict: true });
  }
  const hit = cache.get(std);
  if (hit !== undefined) return hit ?? undefined;
  let font: SfntFont | null = null;
  try {
    const b64 = STD14_DATA[std];
    if (b64) font = parseSfnt(new Uint8Array(inflateSync(Buffer.from(b64, 'base64'))));
  } catch (caught) { rethrowLimit(caught);
    font = null;
  }
  cache.set(std, font);
  return font ?? undefined;
}
