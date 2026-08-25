import { brotliDecompressSync } from 'node:zlib';
import { CidCMap, CMapParts } from './cidcmap.js';
import { decodeCMapGeometry } from './cmapcodec.js';
import { CMAP_DATA, CMAP_META, CMAP_ORDERINGS } from './cmapdata.js';

/**
 * The predefined Adobe CMaps, bundled (cmapdata.ts) and served on demand.
 *
 * A composite font may name one instead of embedding a CMap stream —
 * `/Encoding /UniJIS-UCS2-H` — and until these were bundled such a font had no
 * code-to-CID mapping at all, so a large class of real CJK documents extracted
 * as garbage and rendered blank.
 *
 * **Invariant:** a CMap is inflated when a document first names it, and only
 * then. The corpus is 195 CMaps and 385,860 ranges; the loader is the whole
 * reason the data is stored as one compressed blob per name rather than one
 * stream, so that opening a Japanese document costs the one CMap it uses and a
 * document with no CJK in it costs nothing.
 */

/** What a predefined CMap declares, without inflating its ranges. */
export interface PredefinedCMapInfo {
  readonly name: string;
  /** `/CIDSystemInfo /Ordering` of the collection: `Japan1`, `GB1`, ... */
  readonly ordering: string;
  readonly supplement: number;
  /** 0 horizontal, 1 vertical. */
  readonly wmode: 0 | 1;
  /** The CMap this one extends, if any. */
  readonly usecmap?: string;
}

/** Parsed CMaps, by name. `null` marks one that failed to load (do not retry). */
const cache = new Map<string, CidCMap | null>();

/** Own-property test. A document chooses the name, so `/Encoding /constructor`
 *  or `/Encoding /__proto__` would otherwise find an inherited value and be
 *  treated as a CMap that exists. */
function has(table: Record<string, string>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(table, name);
}

/** True when `name` is one of the bundled predefined CMaps. */
export function isPredefinedCMapName(name: string): boolean {
  return has(CMAP_META, name);
}

/** Every bundled CMap name. */
export function predefinedCMapNames(): string[] {
  return Object.keys(CMAP_META);
}

/** A predefined CMap's declarations, or undefined when the name is not one. */
export function predefinedCMapInfo(name: string): PredefinedCMapInfo | undefined {
  if (!has(CMAP_META, name)) return undefined;
  const [ord, sup, wm, use] = CMAP_META[name].split(',');
  return {
    name,
    ordering: CMAP_ORDERINGS[Number(ord)] ?? 'Unknown',
    supplement: Number(sup) || 0,
    wmode: wm === '1' ? 1 : 0,
    usecmap: use || undefined,
  };
}

/**
 * The predefined CMap called `name`, with its `usecmap` chain resolved, or
 * undefined when no such CMap is bundled.
 *
 * Never throws: a name that is not predefined and a blob that will not inflate
 * are both reported as "no CMap", leaving the caller to fall back rather than
 * failing the document over its choice of encoding.
 */
export function getPredefinedCMap(name: string): CidCMap | undefined {
  return load(name, new Set());
}

function load(name: string, pending: Set<string>): CidCMap | undefined {
  const hit = cache.get(name);
  if (hit !== undefined) return hit ?? undefined;
  if (!has(CMAP_META, name)) return undefined;

  // A `usecmap` cycle cannot occur in Adobe's own data, but the chain is walked
  // by name and a cycle would recur until the stack died. Break it by treating
  // the second visit as a CMap with no parent.
  if (pending.has(name)) return undefined;
  pending.add(name);

  let cmap: CidCMap | null = null;
  try {
    const info = predefinedCMapInfo(name)!;
    const parent = info.usecmap ? load(info.usecmap, pending) : undefined;
    const blob = has(CMAP_DATA, name) ? CMAP_DATA[name] : '';
    const geometry = decodeCMapGeometry(
      new Uint8Array(brotliDecompressSync(Buffer.from(blob, 'base64'))));
    const parts: CMapParts = {
      ...geometry,
      name,
      wmode: info.wmode,
      usecmap: info.usecmap,
      registry: 'Adobe',
      ordering: info.ordering,
      supplement: info.supplement,
    };
    cmap = new CidCMap(parts, parent);
  } catch {
    cmap = null;
  }

  pending.delete(name);
  cache.set(name, cmap);
  return cmap ?? undefined;
}
