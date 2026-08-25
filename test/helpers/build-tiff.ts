/**
 * Synthesize TIFF files for the decoder tests, in EITHER byte order.
 *
 * Deliberately dumb: it lays bytes out from the caller's numbers and decodes
 * nothing, so it cannot "agree" with the decoder about a misreading. Building
 * the same image as `II` and as `MM` and asserting the two decode identically
 * is the one differential available for this format -- see the note in
 * test/tiff.test.ts about TIFF having no published hex dump to anchor on.
 */
export interface TiffTag {
  tag: number;
  /** 1 BYTE, 3 SHORT, 4 LONG. Other types are not needed by the decoder. */
  type: 1 | 3 | 4;
  values: number[];
}

export interface BuildTiffOptions {
  /** false writes "MM" (big-endian). Default true. */
  le?: boolean;
  /** One entry per image (IFD). Each is its tag list plus its pixel blocks. */
  pages: Array<{ tags: TiffTag[]; blocks: Uint8Array[] }>;
  /**
   * Tag receiving each page's block offsets. 273 = StripOffsets (default),
   * 324 = TileOffsets.
   */
  offsetsTag?: number;
  /** Tag receiving each page's block byte counts. 279 default, 325 for tiles. */
  countsTag?: number;
}

const SIZE: Record<number, number> = { 1: 1, 3: 2, 4: 4 };

export function buildTiff(o: BuildTiffOptions): Uint8Array {
  const le = o.le ?? true;
  const offsetsTag = o.offsetsTag ?? 273;
  const countsTag = o.countsTag ?? 279;

  const parts: number[] = [];
  const put8 = (v: number) => { parts.push(v & 0xff); };
  const put16 = (v: number) => {
    if (le) { put8(v); put8(v >> 8); } else { put8(v >> 8); put8(v); }
  };
  const put32 = (v: number) => {
    if (le) { put16(v & 0xffff); put16(v >>> 16); }
    else { put16(v >>> 16); put16(v & 0xffff); }
  };
  const patch32 = (at: number, v: number) => {
    const b = le
      ? [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]
      : [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
    b.forEach((x, i) => { parts[at + i] = x; });
  };

  put8(le ? 0x49 : 0x4d); put8(le ? 0x49 : 0x4d);
  put16(42);
  const firstIfdAt = parts.length;
  put32(0);

  // Blocks first, so their offsets are known when the IFDs are written.
  const blockPos: number[][] = [];
  for (const p of o.pages) {
    const positions: number[] = [];
    for (const b of p.blocks) {
      positions.push(parts.length);
      for (const x of b) put8(x);
      if (parts.length & 1) put8(0);           // keep IFDs word-aligned
    }
    blockPos.push(positions);
  }

  let prevNextAt = firstIfdAt;
  o.pages.forEach((p, pi) => {
    const tags: TiffTag[] = [
      ...p.tags,
      { tag: offsetsTag, type: 4 as const, values: blockPos[pi] },
      { tag: countsTag, type: 4 as const, values: p.blocks.map((b) => b.length) },
    ].sort((a, b) => a.tag - b.tag);          // TIFF requires ascending tags

    const ifdAt = parts.length;
    patch32(prevNextAt, ifdAt);
    put16(tags.length);
    const patchSites: Array<{ at: number; t: TiffTag }> = [];
    for (const t of tags) {
      put16(t.tag); put16(t.type); put32(t.values.length);
      const bytes = SIZE[t.type] * t.values.length;
      if (bytes <= 4) {
        // Inline and LEFT-justified: the value starts at the field's first byte.
        const before = parts.length;
        for (const v of t.values) {
          if (t.type === 1) put8(v); else if (t.type === 3) put16(v); else put32(v);
        }
        while (parts.length - before < 4) put8(0);
      } else {
        patchSites.push({ at: parts.length, t });
        put32(0);
      }
    }
    prevNextAt = parts.length;
    put32(0);
    for (const { at, t } of patchSites) {
      patch32(at, parts.length);
      for (const v of t.values) {
        if (t.type === 1) put8(v); else if (t.type === 3) put16(v); else put32(v);
      }
      if (parts.length & 1) put8(0);
    }
  });

  return Uint8Array.from(parts);
}

/** The tags every fixture needs. `photometric` has no default in TIFF. */
export function baseTags(
  width: number, height: number, photometric: number,
  extra: TiffTag[] = [],
): TiffTag[] {
  return [
    { tag: 256, type: 4, values: [width] },
    { tag: 257, type: 4, values: [height] },
    { tag: 262, type: 3, values: [photometric] },
    ...extra,
  ];
}
