import { inflateSync } from 'node:zlib';
import { parseSfnt, SfntFont } from './sfnt.js';
import { STD14_DATA } from './std14data.js';
import type { StdFont } from './metrics.js';

// Parsed-font cache: null marks a face that failed to load (do not retry).
const cache = new Map<StdFont, SfntFont | null>();

/** Lazily inflate + parse the bundled substitute for a Standard-14 face.
 *  Returns undefined (never throws) when data is missing or unparseable. */
export function getStd14Sfnt(std: StdFont): SfntFont | undefined {
  const hit = cache.get(std);
  if (hit !== undefined) return hit ?? undefined;
  let font: SfntFont | null = null;
  try {
    const b64 = STD14_DATA[std];
    if (b64) font = parseSfnt(new Uint8Array(inflateSync(Buffer.from(b64, 'base64'))));
  } catch {
    font = null;
  }
  cache.set(std, font);
  return font ?? undefined;
}
